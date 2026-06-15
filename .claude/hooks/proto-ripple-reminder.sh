#!/usr/bin/env bash
# PostToolUse(Write|Edit): after editing a .proto file, remind that prost
# structs are EXHAUSTIVE — `..Default::default()` does not work on them, so a
# new/changed field breaks EVERY struct-literal site across the workspace
# (worker main.rs, controller api/grpc, and test literals). Easy to miss because
# the build error surfaces far from the .proto edit. Debounced to once / 5 min so
# a burst of edits during a task doesn't spam. Non-blocking (always exits 0).
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0
[[ "$file" == *.proto ]] || exit 0

marker="${TMPDIR:-/tmp}/handicap-proto-ripple-reminder"
now=$(date +%s)
if [[ -f "$marker" ]]; then
  last=$(cat "$marker" 2>/dev/null || echo 0)
  ((now - last < 300)) && exit 0
fi
printf '%s' "$now" >"$marker" 2>/dev/null || true

msg="⚠ .proto changed. prost structs are exhaustive (no ..Default::default()) — a new/changed field breaks EVERY struct-literal site. grep all construction sites for the changed message type and update each: grep -rn '<MsgType> {' crates/ (common ones: MetricBatch / RunAssignment / ServerMessage / Profile → worker/src/main.rs, controller api/runs.rs + grpc/coordinator.rs, and test literals). The proto oneof is named 'payload', not 'msg'. Then rebuild both binaries: cargo build -p handicap-worker && cargo build --workspace (rust-analyzer may show STALE codegen — trust the cargo build, not the inline diagnostics)."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
