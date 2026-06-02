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

echo "==> running e2e driver"
HANDICAP_BASE=http://127.0.0.1:18080 \
WIREMOCK_ADMIN_BASE=http://127.0.0.1:19001 \
WIREMOCK_CLUSTER_BASE=http://wiremock.handicap-test.svc.cluster.local:8080 \
cargo run -p handicap-controller --bin e2e_kind_driver

echo "==> verifying Indexed Job fan-out (N=2)"
JOB="$(kubectl -n "$NS" get jobs -l app.kubernetes.io/component=worker \
  -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$JOB" ]] || { echo "no worker Job found"; exit 1; }
MODE="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completionMode}')"
COMP="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.spec.completions}')"
# .status.succeeded lags Pod exit — the run reports Completed over gRPC just before
# the kubelet/Job controller observe the Pods as Succeeded — so poll instead of
# reading once (mode/completions are static at Job creation; only succeeded races).
SUCC=""
for _ in $(seq 1 15); do
  SUCC="$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.succeeded}')"
  [[ "$SUCC" == "2" ]] && break
  sleep 2
done
echo "    job=$JOB mode=$MODE completions=$COMP succeeded=$SUCC"
[[ "$MODE" == "Indexed" ]] || { echo "expected Indexed Job, got '$MODE'"; exit 1; }
[[ "$COMP" == "2" ]] || { echo "expected completions=2, got '$COMP'"; exit 1; }
[[ "$SUCC" == "2" ]] || { echo "expected 2 succeeded Pods, got '$SUCC'"; exit 1; }

echo "==> e2e-kind PASSED"
