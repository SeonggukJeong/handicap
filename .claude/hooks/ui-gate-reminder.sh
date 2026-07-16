#!/usr/bin/env bash
# PostToolUse(Bash): after a `git commit` that includes ui/ files (fresh HEAD, or still-staged for
# background/rejected commits), remind about the UI gate. Since 2026-06-13 pre-commit DOES run the
# UI gate when ui/ (non-.md) is staged — but it gracefully SKIPS when ui/node_modules is missing
# (fresh worktree), and CI doesn't run without a remote (documented hole: a react-hooks/
# exhaustive-deps warning slipped through pre-2026-06-13). This is the backstop for the skip case.
# Non-blocking, always exits 0. (Message accuracy fixed 2026-07-16 — it used to claim pre-commit
# was cargo-only, which misled sessions into re-verifying the gate.)
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[[ "$cmd" == *git* && "$cmd" == *commit* ]] || exit 0

dir=$(printf '%s' "$input" | jq -r '.cwd // empty')
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then dir="${BASH_REMATCH[1]}"; fi
[[ -n "$dir" ]] || exit 0
git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# staged (commit in progress / rejected) + just-landed HEAD (<5 min old)
files=$(git -C "$dir" diff --cached --name-only 2>/dev/null)
last_ct=$(git -C "$dir" log -1 --format=%ct 2>/dev/null || echo 0)
now=$(date +%s)
if ((now - last_ct < 300)); then
  files+=$'\n'$(git -C "$dir" show --name-only --format= HEAD 2>/dev/null)
fi
printf '%s\n' "$files" | grep -E '^ui/' | grep -qvE '\.md$' || exit 0

msg="이 커밋에 ui/ 변경 포함 — pre-commit이 ui/ staged면 UI 게이트(lint+test+build)를 돌리지만 ui/node_modules 없으면 graceful skip이고 CI(remote 미설정)는 안 돈다. 커밋이 게이트 없이 지나갔을 수 있으면(fresh 워크트리 등) 수동 1회: cd ui && pnpm lint && pnpm test && pnpm build (lint는 --max-warnings=0, 머지 전 필수 게이트)."
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
