#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DURATION="${DURATION:-30}"
VUS="${VUS:-200}"
# SCENARIO_KIND=flat (default) is one bare GET; SCENARIO_KIND=loop wraps that
# same GET in a one-iteration loop, so the request count is identical and only
# the recursion / Box::pin path differs — an A/B for loop overhead (Slice 7).
SCENARIO_KIND="${SCENARIO_KIND:-flat}"
LOOP_CAP="${LOOP_CAP:-0}"   # 0 = loop_breakdown off (default); >0 = cap per-loop-index rows
WIREMOCK_PORT="${WIREMOCK_PORT:-9001}"
CTRL_REST="${CTRL_REST:-127.0.0.1:18080}"
CTRL_GRPC="${CTRL_GRPC:-127.0.0.1:18081}"
# --- stair A/B (stage-auto-stop spec 7.2/7.3); defaults keep the old behaviour ---
PROFILE_KIND="${PROFILE_KIND:-vus}"        # vus (default) | stair
STAIR_TARGETS="${STAIR_TARGETS:-100,200}"  # comma list
STAIR_HOLD="${STAIR_HOLD:-30}"
STAIR_RAMP="${STAIR_RAMP:-5}"
STAIR_DISCARD="${STAIR_DISCARD:-10}"
MAX_IN_FLIGHT="${MAX_IN_FLIGHT:-500}"
WORKERS="${WORKERS:-1}"                    # open-loop worker_count
AUTO_STOP="${AUTO_STOP:-absent}"           # off | on | absent (absent = no auto_stop key, master)
BIN_DIR="${BIN_DIR:-}"                     # set = skip cargo build, use $BIN_DIR/{controller,worker}
RSS_EVERY="${RSS_EVERY:-0}"                # seconds; 0 = once at the end
RESPONDER_URL="${RESPONDER_URL:-}"         # set = no docker; target this URL (caller runs the responder)
if [[ -n "$RESPONDER_URL" ]]; then RESPONDER_PATH="${RESPONDER_PATH:-/}"; else RESPONDER_PATH="${RESPONDER_PATH:-/big}"; fi
OUT_DIR="${OUT_DIR:-/tmp/handicap-bench}"

cleanup() {
  set +e
  [[ -n "${CTRL_PID:-}" ]] && kill "$CTRL_PID" 2>/dev/null
  [[ -n "${CPU_PID:-}" ]] && kill "$CPU_PID" 2>/dev/null
  [[ -z "$RESPONDER_URL" ]] && docker rm -f handicap-bench-wm >/dev/null 2>&1
  wait 2>/dev/null
}
trap cleanup EXIT

cd "$ROOT"

if [[ -z "$RESPONDER_URL" ]]; then
  echo "==> starting wiremock on :$WIREMOCK_PORT"
  docker rm -f handicap-bench-wm >/dev/null 2>&1 || true
  docker run -d --rm --name handicap-bench-wm -p "$WIREMOCK_PORT:8080" wiremock/wiremock:3.5.4 --verbose >/dev/null
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$WIREMOCK_PORT/__admin/health" >/dev/null; then break; fi
    sleep 1
  done
  curl -sX POST "http://127.0.0.1:$WIREMOCK_PORT/__admin/mappings" \
    -H 'Content-Type: application/json' \
    -d '{"request":{"method":"GET","url":"/ping"},"response":{"status":200,"jsonBody":{"ok":true,"payload":"AAAAAAAA…"}}}' >/dev/null
  # pad to ~1 KB:
  curl -sX POST "http://127.0.0.1:$WIREMOCK_PORT/__admin/mappings" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"request":{"method":"GET","url":"/big"},"response":{"status":200,"body":"%s"}}' "$(head -c 1024 < /dev/urandom | base64)")" >/dev/null

fi

echo "==> starting controller (subprocess mode)"
if [[ -n "$BIN_DIR" ]]; then
  CTRL_BIN="$BIN_DIR/controller"; WORKER_BIN="$BIN_DIR/worker"
else
  cargo build -p handicap-controller -p handicap-worker --release
  CTRL_BIN="$ROOT/target/release/controller"; WORKER_BIN="$ROOT/target/release/worker"
fi
[[ -x "$CTRL_BIN" && -x "$WORKER_BIN" ]] || { echo "missing binaries: $CTRL_BIN / $WORKER_BIN" >&2; exit 1; }
if lsof -nP -iTCP:"${CTRL_REST##*:}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "REST port ${CTRL_REST##*:} already listening - refusing to start" >&2; exit 1
fi
mkdir -p "$OUT_DIR"
RUN_TAG="$(date +%s)-$$"
DB="$OUT_DIR/bench-$RUN_TAG.db"; CTRL_LOG="$OUT_DIR/ctrl-$RUN_TAG.log"; CPU_FILE="$OUT_DIR/cpu-$RUN_TAG.txt"
"$CTRL_BIN" --db "$DB" \
  --rest "$CTRL_REST" --grpc "$CTRL_GRPC" \
  --worker-bin "$WORKER_BIN" --worker-mode subprocess >"$CTRL_LOG" 2>&1 &
CTRL_PID=$!
for _ in $(seq 1 30); do
  if curl -sf "http://$CTRL_REST/api/health" >/dev/null; then break; fi
  sleep 1
done

echo "==> seeding scenario (kind=$SCENARIO_KIND)"
# Both variants hit the SAME /big endpoint exactly once per VU iteration. The
# loop variant wraps that GET in a repeat:1 loop so request counts are identical
# and only the engine's recursion/Box::pin path differs.
if [[ -n "$RESPONDER_URL" ]]; then TARGET_URL="${RESPONDER_URL%/}$RESPONDER_PATH"; else TARGET_URL="http://127.0.0.1:$WIREMOCK_PORT$RESPONDER_PATH"; fi
if [[ "$SCENARIO_KIND" == "loop" ]]; then
  STEPS_YAML="steps:\n  - id: l\n    name: loop\n    type: loop\n    repeat: 1\n    do:\n      - id: g\n        name: get\n        type: http\n        request:\n          method: GET\n          url: \\\"$TARGET_URL\\\"\n        assert:\n          - status: 200\n"
else
  STEPS_YAML="steps:\n  - id: g\n    name: get\n    type: http\n    request:\n      method: GET\n      url: \\\"$TARGET_URL\\\"\n    assert:\n      - status: 200\n"
fi
SCN=$(curl -sf -XPOST "http://$CTRL_REST/api/scenarios" -H 'Content-Type: application/json' \
  -d "$(cat <<EOF
{
  "name":"bench",
  "yaml":"version: 1\nname: bench\nvariables: {}\n$STEPS_YAML"
}
EOF
)" | tee /dev/stderr | grep -o '"id":"[^"]*"' | head -1 | cut -d\" -f4)

if [[ "$PROFILE_KIND" == "stair" ]]; then
  case "$AUTO_STOP" in
    on) AS=',"auto_stop":{"saturation":"two_fails","emergency":{"error_rate_pct":50,"p99_ms":600000,"consecutive_seconds":60,"min_requests":20}}' ;;
    off) AS=',"auto_stop":{"saturation":null,"emergency":null}' ;;
    absent) AS='' ;;
    *) echo "AUTO_STOP must be off|on|absent" >&2; exit 1 ;;
  esac
  STAIR_TOTAL=0
  IFS=',' read -r -a _T <<<"$STAIR_TARGETS"
  for _ in "${_T[@]}"; do STAIR_TOTAL=$(( STAIR_TOTAL + STAIR_RAMP + STAIR_HOLD )); done
  PROFILE="{\"max_in_flight\":$MAX_IN_FLIGHT,\"duration_seconds\":0,\"worker_count\":$WORKERS,\"stair\":{\"targets\":[$STAIR_TARGETS],\"hold_seconds\":$STAIR_HOLD,\"ramp_seconds\":$STAIR_RAMP,\"discard_seconds\":$STAIR_DISCARD$AS}}"
  POLL_MAX=$(( STAIR_TOTAL + 60 ))
  echo "==> creating stair run: targets=[$STAIR_TARGETS] total=${STAIR_TOTAL}s workers=$WORKERS auto_stop=$AUTO_STOP"
else
  PROFILE="{\"vus\":$VUS,\"ramp_up_seconds\":2,\"duration_seconds\":$DURATION,\"loop_breakdown_cap\":$LOOP_CAP}"
  POLL_MAX=$(( DURATION + 20 ))
  echo "==> creating run: $VUS VUs / $DURATION s / LOOP_CAP=$LOOP_CAP"
fi
RUN=$(curl -sf -XPOST "http://$CTRL_REST/api/runs" -H 'Content-Type: application/json' \
  -d "{\"scenario_id\":\"$SCN\",\"profile\":$PROFILE,\"env\":{}}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d\" -f4)
echo "    run id = $RUN"

sum_cpu() { # $1 = pid list (space separated) -> total %cpu
  [[ -z "$1" ]] && { echo 0; return; }
  ps -o %cpu= -p "$(echo $1 | tr ' ' ',')" 2>/dev/null | awk '{s+=$1} END{printf "%.1f", s+0}'
}
if [[ "$PROFILE_KIND" == "stair" ]]; then
  # 1 s samples of controller + worker CPU (and RSS when RSS_EVERY>0) while the run is active.
  (
    t=0
    while true; do
      c=$(sum_cpu "$CTRL_PID")
      w=$(sum_cpu "$(pgrep -f "$WORKER_BIN" 2>/dev/null | tr '\n' ' ' || true)")
      echo "$c $w" >>"$CPU_FILE"
      if (( RSS_EVERY > 0 && t % RSS_EVERY == 0 )); then
        echo "RSS t=$t mb=$(ps -o rss= -p "$CTRL_PID" | awk '{printf "%.1f", $1/1024}')"
      fi
      t=$(( t + 1 )); sleep 1
    done
  ) &
  CPU_PID=$!
fi

echo "==> polling"
for _ in $(seq 1 "$POLL_MAX"); do
  S=$(curl -sf "http://$CTRL_REST/api/runs/$RUN" | grep -o '"status":"[^"]*"' | cut -d\" -f4)
  if [[ "$S" == "completed" || "$S" == "failed" || "$S" == "aborted" ]]; then break; fi
  sleep 1
done
RSS_END=$(ps -o rss= -p "$CTRL_PID" | awk '{printf "%.1f", $1/1024}')
if [[ -n "${CPU_PID:-}" ]]; then kill "$CPU_PID" 2>/dev/null || true; wait "$CPU_PID" 2>/dev/null || true; CPU_PID=""; fi
echo "==> fetching report"
REPORT=$(curl -sf "http://$CTRL_REST/api/runs/$RUN/report")
echo "$REPORT" | python3 -c "
import json, sys
r = json.load(sys.stdin)
s = r['summary']
print('  count       = {}'.format(s['count']))
print('  rps_avg     = {}'.format(s.get('rps', s.get('rps_avg', 'n/a'))))
print('  p50_ms      = {}'.format(s['p50_ms']))
print('  p95_ms      = {}'.format(s['p95_ms']))
print('  p99_ms      = {}'.format(s['p99_ms']))
print('  duration_s  = {}'.format(s.get('duration_seconds', 'n/a')))
"
echo "==> controller RSS"
ps -o rss= -p "$CTRL_PID" | awk '{printf "  RSS = %.1f MB\n", $1/1024}'

if [[ "$PROFILE_KIND" == "stair" ]]; then
  ACH=$(echo "$REPORT" | python3 -c "
import json, sys
st = json.load(sys.stdin).get('stair') or {}
print(','.join('na' if x.get('achieved') is None else '{:.1f}'.format(x['achieved']) for x in st.get('steps', [])))
")
  HEAD=$(echo "$REPORT" | python3 -c "
import json, sys
st = json.load(sys.stdin).get('stair') or {}
print((st.get('headline') or {}).get('kind', 'na'))
")
  CPUS=$(awk '{c+=$1; w+=$2; n++} END{if(n) printf "%.2f %.2f", c/n, w/n; else printf "na na"}' "$CPU_FILE" 2>/dev/null || echo "na na")
  QMAX=$(grep -o 'queue_max=[0-9]*' "$CTRL_LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  # tracing may colour/quote the field; fall back to a looser match on the finish line.
  [[ -z "$QMAX" ]] && QMAX=$(grep 'auto-stop monitor finished' "$CTRL_LOG" 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g' | grep -oE 'queue_max[= ]+[0-9]+' | tail -1 | grep -oE '[0-9]+$' || true)
  echo "RESULT status=$S steps_achieved=$ACH headline=$HEAD ctrl_cpu_avg=${CPUS% *} worker_cpu_avg=${CPUS#* } queue_max=${QMAX:-na} rss_mb_end=$RSS_END"
fi
