#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${NS:-handicap}"
RELEASE="${RELEASE:-handicap}"
WM_NS="handicap-test"

"$ROOT/scripts/deploy-kind.sh"

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

echo "==> e2e-kind PASSED"
