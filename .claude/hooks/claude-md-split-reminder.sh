#!/usr/bin/env bash
# PostToolUse(Write|Edit): after touching any CLAUDE.md file, remind that a
# NEW or just-split/moved nested CLAUDE.md must be load-verified with a FRESH
# subagent (e.g. Explore) that Reads a file in the same directory and reports
# whether a <system-reminder> with "Contents of <dir>/CLAUDE.md" appeared.
# Self-verifying by directly Read/Edit-ing the CLAUDE.md yourself gives a
# false negative — the harness dedups directories the model has already
# viewed directly, so a real miss and a self-caused miss look identical.
# Routine single-line "새 함정 추가" edits to an already-loading file don't
# need this — only act on it for genuinely new/relocated files. Debounced to
# once / 10 min so a burst of edits during a split doesn't spam. Non-blocking
# (always exits 0).
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" ]] && exit 0
[[ "$file" == */CLAUDE.md || "$file" == "CLAUDE.md" ]] || exit 0

marker="${TMPDIR:-/tmp}/handicap-claude-md-split-reminder"
now=$(date +%s)
if [[ -f "$marker" ]]; then
  last=$(cat "$marker" 2>/dev/null || echo 0)
  ((now - last < 600)) && exit 0
fi
printf '%s' "$now" >"$marker" 2>/dev/null || true

msg="ℹ CLAUDE.md touched ($file). 이 파일이 새로 생겼거나 다른 CLAUDE.md에서 방금 분할/이동된 거라면, 그 디렉토리가 실제로 자동 로드되는지 확인할 것 — 단, 본인이 직접 Read/Edit한 파일로는 검증 불가(하니스가 이미 본 디렉토리는 재주입을 skip해 거짓 미스가 난다). Agent 툴로 fresh 서브에이전트(Explore 타입 충분)를 띄워 같은 디렉토리의 다른 파일을 Read시키고, <system-reminder>에 'Contents of <경로>/CLAUDE.md'가 떴는지 보고받을 것. 기존 파일에 한 줄 추가하는 routine 편집이면 무시해도 된다."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
