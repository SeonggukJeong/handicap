#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${NS:-handicap}"
RELEASE="${RELEASE:-handicap}"
WM_NS="handicap-test"

HELM_EXTRA_ARGS="--set worker.capacityVus=25" "$ROOT/scripts/deploy-kind.sh"

echo "==> applying wiremock"
kubectl apply -f "$ROOT/deploy/kind/wiremock.yaml"
kubectl -n "$WM_NS" rollout status deploy/wiremock --timeout=120s

# Discover the controller Service name from the rendered helm manifest. The
# template expands to "{Release.Name}-handicap-controller" today, but pulling
# from the manifest keeps the script robust to nameOverride / fullnameOverride
# changes without depending on yq.
CTRL_SVC="$(helm get manifest "$RELEASE" -n "$NS" \
  | awk '
      /^kind: Service$/ { in_svc = 1; next }
      in_svc && /^kind: / { in_svc = 0 }
      in_svc && /^  name:/ { print $2; exit }
    ')"
if [[ -z "$CTRL_SVC" ]]; then
  echo "could not discover controller Service name from helm manifest" >&2
  exit 1
fi
echo "==> controller service = $CTRL_SVC"

echo "==> port-forwarding controller REST"
kubectl -n "$NS" port-forward "svc/$CTRL_SVC" 18080:8080 >/tmp/pf-controller.log 2>&1 &
PF_CTRL=$!
PF_WM=""
trap 'kill $PF_CTRL 2>/dev/null || true; [[ -n "$PF_WM" ]] && kill $PF_WM 2>/dev/null || true' EXIT
# Wait for the port-forward
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18080/api/health >/dev/null; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:18080/api/health >/dev/null || { echo "controller port-forward not ready"; exit 1; }

echo "==> port-forwarding wiremock"
kubectl -n "$WM_NS" port-forward svc/wiremock 19001:8080 >/tmp/pf-wm.log 2>&1 &
PF_WM=$!
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:19001/__admin/health >/dev/null; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:19001/__admin/health >/dev/null || { echo "wiremock port-forward not ready"; exit 1; }

# Run the driver in the BACKGROUND so we can observe the worker Job WHILE the run
# is live. A3c wires dispatcher.cleanup() to delete the Job the instant the run
# reports Completed, so asserting after the driver returns would race (and usually
# lose) against Job deletion. The Job's completionMode/completions are static at
# creation, so capturing them mid-run is race-free; the driver succeeding then
# proves all N=2 workers registered AND completed (the A3a completion gate).
echo "==> running e2e driver (background; asserting Job fan-out while run is live)"
HANDICAP_BASE=http://127.0.0.1:18080 \
WIREMOCK_ADMIN_BASE=http://127.0.0.1:19001 \
WIREMOCK_CLUSTER_BASE=http://wiremock.handicap-test.svc.cluster.local:8080 \
cargo run -p handicap-controller --bin e2e_kind_driver &
DRIVER_PID=$!

echo "==> verifying Indexed Job fan-out (N=2) while run is active"
MODE="" COMP=""
# Poll across the build+run window; break early if the driver exits (Job gone).
for _ in $(seq 1 180); do
  JOB="$(kubectl -n "$NS" get jobs -l app.kubernetes.io/component=worker \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "$JOB" ]]; then
    MODE="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completionMode}' 2>/dev/null || true)"
    COMP="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completions}' 2>/dev/null || true)"
    [[ "$MODE" == "Indexed" && "$COMP" == "2" ]] && break
  fi
  kill -0 "$DRIVER_PID" 2>/dev/null || break   # driver finished → Job already cleaned up
  sleep 1
done
echo "    job=${JOB:-<none>} mode=${MODE:-<none>} completions=${COMP:-<none>}"
[[ "$MODE" == "Indexed" ]] || { echo "expected Indexed Job, got '${MODE:-<none>}'"; kill "$DRIVER_PID" 2>/dev/null || true; exit 1; }
[[ "$COMP" == "2" ]] || { echo "expected completions=2, got '${COMP:-<none>}'"; kill "$DRIVER_PID" 2>/dev/null || true; exit 1; }

# Driver success ⟹ both N=2 workers registered and reported Completed ⟹ fan-out ran.
wait "$DRIVER_PID" || { echo "e2e driver failed"; exit 1; }

echo "==> e2e-kind PASSED"
