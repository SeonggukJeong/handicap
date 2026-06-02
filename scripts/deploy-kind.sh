#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER="${CLUSTER:-handicap}"
IMAGE="${IMAGE:-handicap:dev}"
NS="${NS:-handicap}"
RELEASE="${RELEASE:-handicap}"

echo "==> Ensuring kind cluster $CLUSTER exists"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$ROOT/deploy/kind/cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

echo "==> Building image $IMAGE"
IMAGE="$IMAGE" "$ROOT/scripts/build-image.sh"

echo "==> Loading image into kind"
kind load docker-image "$IMAGE" --name "$CLUSTER"

echo "==> Helm install/upgrade"
kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"
helm upgrade --install "$RELEASE" "$ROOT/deploy/helm/handicap" \
  --namespace "$NS" \
  --set image.repository="${IMAGE%:*}" \
  --set image.tag="${IMAGE#*:}" \
  ${HELM_EXTRA_ARGS:-} \
  --wait --timeout 3m

echo "==> Waiting for controller rollout"
# Extract the deployment name from the rendered manifest. helm chart output puts
# `name:` on the line after `metadata:` so we need -A2 (kind / metadata / name).
DEPLOY_NAME="$(helm get manifest "$RELEASE" -n "$NS" | grep -A2 'kind: Deployment$' | awk '/^  name:/ {print $2; exit}')"
if [[ -z "$DEPLOY_NAME" ]]; then
  echo "  WARN: could not extract deployment name from helm manifest; skipping rollout status"
else
  kubectl -n "$NS" rollout status "deployment/$DEPLOY_NAME"
fi

echo "==> Done."
echo "    UI:  kubectl -n $NS port-forward svc/$RELEASE-controller 8080:8080  →  http://127.0.0.1:8080/"
