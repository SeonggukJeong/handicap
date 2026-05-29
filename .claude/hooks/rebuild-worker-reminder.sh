#!/usr/bin/env bash
# PostToolUse(Write|Edit): after editing engine / worker-core / proto sources,
# remind that `cargo run -p handicap-controller` does NOT rebuild the worker
# binary the subprocess dispatcher spawns. Debounced to once / 5 min so a burst
# of edits during a task doesn't spam. Non-blocking (always exits 0).
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0
[[ "$file" =~ /crates/(engine|worker-core|proto)/ ]] || exit 0

marker="${TMPDIR:-/tmp}/handicap-worker-rebuild-reminder"
now=$(date +%s)
if [[ -f "$marker" ]]; then
  last=$(cat "$marker" 2>/dev/null || echo 0)
  ((now - last < 300)) && exit 0
fi
printf '%s' "$now" >"$marker" 2>/dev/null || true

msg="⚠ engine/worker-core/proto changed. The subprocess worker runs target/debug/worker, which 'cargo run -p handicap-controller' does NOT rebuild. Before any manual/local run: cargo build -p handicap-worker (else the run hangs in 'running' with 0 requests). Unit/integration tests are unaffected."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
