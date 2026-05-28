#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
CHART="$ROOT/deploy/helm/handicap"
SNAPS="$CHART/tests/__snapshots__"

render() {
  local name=$1
  shift
  helm template handicap "$CHART" "$@"
}

check_or_update() {
  local snap=$1
  local rendered=$2
  if [[ "${UPDATE_SNAPSHOTS:-}" == "1" ]]; then
    cp "$rendered" "$snap"
    echo "  updated $snap"
  else
    diff -u "$snap" "$rendered" || {
      echo "  FAIL: $snap does not match rendered output"
      echo "  run UPDATE_SNAPSHOTS=1 just chart-snapshot to refresh"
      exit 1
    }
    echo "  OK   $snap"
  fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "==> default values"
render default --namespace handicap > "$tmp/default.yaml"
check_or_update "$SNAPS/default.yaml" "$tmp/default.yaml"

echo "==> custom values"
render custom --namespace load-testing -f "$CHART/tests/custom_values.yaml" > "$tmp/custom_values.yaml"
check_or_update "$SNAPS/custom_values.yaml" "$tmp/custom_values.yaml"

echo "==> all snapshots match"
