#!/usr/bin/env bash
# PostToolUse(Bash): say "run the gate by hand" ONLY when pre-commit did not gate the code.
#
# Two holes (verified 2026-11-20 in a scratch repo with an echoing pre-commit):
#   (1) `git commit` with ui/ (non-.md) staged but ui/node_modules missing — pre-commit skips
#       the UI gate (fresh worktree before `pnpm install`).
#   (2) every commit `git rebase` writes (clean pick or `--continue` after a conflict) and every
#       clean `git cherry-pick` / `git revert` pick skips pre-commit, so those commits land with
#       no UI or cargo gate at all. Only `cherry-pick --continue` / `revert --continue` after a
#       conflict go through a normal commit and DO run pre-commit (reflog "commit (cherry-pick):"
#       / "commit:") — those are not counted.
# A plain `git commit` in a tree with node_modules WAS gated — a failing gate aborts the commit —
# so stay silent then (the old ui-gate-reminder fired on every ui commit, and on any command
# merely containing the words "git" and "commit", e.g. a grep of .githooks/pre-commit).
# Non-blocking, always exits 0.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[[ -n "$cmd" ]] || exit 0

# A real git invocation: at the start, or after whitespace / ; & | ( — with optional -C/-c opts.
pre='(^|[[:space:];&|(])git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+'
mode=""
if [[ "$cmd" =~ ${pre}commit([[:space:]]|$) ]]; then
  mode=commit
elif [[ "$cmd" =~ ${pre}(rebase|cherry-pick|revert)([[:space:]]|$) ]]; then
  # --abort / --quit create nothing.
  [[ "$cmd" =~ --(abort|quit)([[:space:]]|$) ]] && exit 0
  mode=rewrite
fi
[[ -n "$mode" ]] || exit 0

dir=$(printf '%s' "$input" | jq -r '.cwd // empty')
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then dir="${BASH_REMATCH[1]}"; fi
[[ -n "$dir" ]] || exit 0
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
gitdir=$(git -C "$top" rev-parse --absolute-git-dir 2>/dev/null) || exit 0

ui_changed() { grep -E '^ui/' | grep -vqE '\.md$'; }
cargo_changed() {
  grep -E '^(crates/|Cargo\.toml$|Cargo\.lock$|rust-toolchain\.toml$|\.cargo/)' | grep -vqE '\.md$'
}
emit() { jq -n --arg m "$1" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'; }
UI_GATE='cd ui && pnpm lint && pnpm test && pnpm build'
CARGO_GATE='just build && just lint && just test'

if [[ "$mode" == commit ]]; then
  [[ -d "$top/ui/node_modules" ]] && exit 0 # pre-commit ran the UI gate (or the commit failed)
  # staged (rejected commit) + just-landed HEAD (<5 min old)
  files=$(git -C "$top" diff --cached --name-only 2>/dev/null)
  last_ct=$(git -C "$top" log -1 --format=%ct 2>/dev/null || echo 0)
  if (($(date +%s) - last_ct < 300)); then
    files+=$'\n'$(git -C "$top" show --name-only --format= HEAD 2>/dev/null)
  fi
  printf '%s\n' "$files" | ui_changed || exit 0
  emit "ui/node_modules가 없어 pre-commit이 이 커밋의 UI 게이트를 건너뛰었다. pnpm -C ui install 후 수동 1회: $UI_GATE (lint는 --max-warnings=0, 머지 전 필수)."
  exit 0
fi

# rewrite: stopped on a conflict → wait for --continue to finish.
for p in rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD sequencer; do
  [[ -e "$gitdir/$p" ]] && exit 0
done
# Commits this operation created = the newest consecutive reflog entries it wrote.
now=$(date +%s)
hashes=()
while IFS=$'\t' read -r h ts subj; do
  ts=${ts#HEAD@\{}
  ts=${ts%\}}
  ((now - ts < 300)) || break
  case "$subj" in
    "rebase (finish)"* | "commit (cherry-pick)"*) continue ;; # finish = no commit; --continue = gated
    "rebase (pick)"* | "rebase (continue)"* | "rebase (squash)"* | "rebase (fixup)"* | \
      "rebase (reword)"* | "rebase (edit)"* | "cherry-pick"* | "revert"*) hashes+=("$h") ;;
    *) break ;;
  esac
done < <(git -C "$top" reflog -n 200 --date=unix --format=$'%H\t%gd\t%gs' 2>/dev/null)
((${#hashes[@]} > 0)) || exit 0

files=$(for h in "${hashes[@]}"; do git -C "$top" show --name-only --format= "$h" 2>/dev/null; done)
need=()
printf '%s\n' "$files" | ui_changed && need+=("ui/ → $UI_GATE")
printf '%s\n' "$files" | cargo_changed && need+=("cargo 경로 → $CARGO_GATE")
((${#need[@]} > 0)) || exit 0
list=$(printf '%s; ' "${need[@]}")
emit "방금 rebase/cherry-pick/revert가 만든 커밋 ${#hashes[@]}개는 pre-commit을 거치지 않았다(이 명령들은 pre-commit을 안 돌린다). 합쳐진 코드로 수동 1회: ${list%; }."
exit 0
