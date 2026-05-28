#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DURATION="${DURATION:-30}"
VUS="${VUS:-200}"
WIREMOCK_PORT="${WIREMOCK_PORT:-9001}"
CTRL_REST="${CTRL_REST:-127.0.0.1:18080}"
CTRL_GRPC="${CTRL_GRPC:-127.0.0.1:18081}"

cleanup() {
  set +e
  [[ -n "${CTRL_PID:-}" ]] && kill "$CTRL_PID" 2>/dev/null
  docker rm -f handicap-bench-wm >/dev/null 2>&1
  wait 2>/dev/null
}
trap cleanup EXIT

cd "$ROOT"

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

echo "==> starting controller (subprocess mode)"
cargo build -p handicap-controller -p handicap-worker --release
target/release/controller --db /tmp/handicap-bench.db \
  --rest "$CTRL_REST" --grpc "$CTRL_GRPC" \
  --worker-bin target/release/worker --worker-mode subprocess >/tmp/handicap-bench-ctrl.log 2>&1 &
CTRL_PID=$!
for _ in $(seq 1 30); do
  if curl -sf "http://$CTRL_REST/api/health" >/dev/null; then break; fi
  sleep 1
done

echo "==> seeding scenario"
SCN=$(curl -sf -XPOST "http://$CTRL_REST/api/scenarios" -H 'Content-Type: application/json' \
  -d "$(cat <<EOF
{
  "name":"bench",
  "yaml":"version: 1\nname: bench\nvariables: {}\nsteps:\n  - id: g\n    name: get\n    type: http\n    request:\n      method: GET\n      url: \"http://127.0.0.1:$WIREMOCK_PORT/big\"\n    assert:\n      - status: 200\n"
}
EOF
)" | tee /dev/stderr | grep -o '"id":"[^"]*"' | head -1 | cut -d\" -f4)

echo "==> creating run: $VUS VUs / $DURATION s"
RUN=$(curl -sf -XPOST "http://$CTRL_REST/api/runs" -H 'Content-Type: application/json' \
  -d "{\"scenario_id\":\"$SCN\",\"profile\":{\"vus\":$VUS,\"ramp_up_seconds\":2,\"duration_seconds\":$DURATION},\"env\":{}}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d\" -f4)
echo "    run id = $RUN"

echo "==> polling"
for _ in $(seq 1 $(( DURATION + 20 ))); do
  S=$(curl -sf "http://$CTRL_REST/api/runs/$RUN" | grep -o '"status":"[^"]*"' | cut -d\" -f4)
  if [[ "$S" == "completed" || "$S" == "failed" || "$S" == "aborted" ]]; then break; fi
  sleep 1
done
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
