#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-handicap:dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building image $IMAGE"
docker build \
  -f "$ROOT/deploy/Dockerfile" \
  -t "$IMAGE" \
  "$ROOT"

echo "==> Smoke: controller --help"
docker run --rm "$IMAGE" /usr/local/bin/controller --help >/dev/null
echo "==> Smoke: worker --help"
docker run --rm "$IMAGE" /usr/local/bin/worker --help >/dev/null
echo "==> Smoke: UI assets present"
docker run --rm "$IMAGE" /bin/sh -c "test -s /srv/ui/index.html"
echo "==> Smoke: binaries owned by uid 65532"
docker run --rm "$IMAGE" /bin/sh -c '[ "$(id -u)" = "65532" ]'
echo "==> OK"
