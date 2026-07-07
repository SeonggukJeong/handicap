#!/usr/bin/env bash
# PostToolUse(Write|Edit): after a CLAUDE.md path git has NEVER tracked before
# is touched (i.e. genuinely new/just-moved-here, not a routine one-line edit
# to an already-committed file), remind that it must be load-verified with a
# FRESH subagent (e.g. Explore) that Reads a file in the same directory and
# reports whether a <system-reminder> with "Contents of <dir>/CLAUDE.md"
# appeared. Self-verifying by directly Read/Edit-ing the CLAUDE.md yourself
# gives a false negative — the harness dedups directories the model has
# already viewed directly, so a real miss and a self-caused miss look
# identical. Gating on git-untracked (not just "any CLAUDE.md touch") is the
# point: an already-committed CLAUDE.md being edited routinely is `git status`
# "M", not "??", so it never fires this. Debounced to once / 10 min so a burst
# of edits while authoring a brand-new file doesn't spam. Non-blocking
# (always exits 0).
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0
[[ "$file" == */CLAUDE.md || "$file" == "CLAUDE.md" ]] || exit 0

dir=$(dirname "$file")
status=$(cd "$dir" 2>/dev/null && git status --porcelain -- "$(basename "$file")" 2>/dev/null)
[[ "$status" == \?\?* ]] || exit 0

marker="${TMPDIR:-/tmp}/handicap-claude-md-split-reminder"
now=$(date +%s)
if [[ -f "$marker" ]]; then
  last=$(cat "$marker" 2>/dev/null || echo 0)
  ((now - last < 600)) && exit 0
fi
printf '%s' "$now" >"$marker" 2>/dev/null || true

msg="ℹ 새(git-untracked) CLAUDE.md 감지: $file. 이 디렉토리가 실제로 자동 로드되는지 확인할 것 — 본인이 직접 Read/Edit한 파일로는 검증 불가(하니스가 이미 본 디렉토리는 재주입을 skip해 거짓 미스가 난다). Agent 툴로 fresh 서브에이전트(Explore 타입 충분)를 띄워 같은 디렉토리의 다른 파일을 Read시키고, <system-reminder>에 'Contents of <경로>/CLAUDE.md'가 떴는지 보고받을 것."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
