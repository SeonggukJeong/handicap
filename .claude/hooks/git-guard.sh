#!/usr/bin/env bash
# PreToolUse(Bash): block documented git footguns (root CLAUDE.md):
#  - `git commit … | …`      → pipe masks git's exit code; a pre-commit reject looks like success
#  - `git commit --no-verify` → hook bypass is forbidden without an explicit user request
#  - `git checkout/switch/stash` → breaks a worktree's attached HEAD (reviews are read-only via
#    diff/show; merges use `git -C <main> merge --ff-only`; branching uses EnterWorktree) → "ask"
# Applies to the main agent AND every subagent's Bash calls. Always exits 0 (decision via JSON).
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0
case "$cmd" in *git*) ;; *) exit 0 ;; esac

# Heredoc bodies (commit messages etc.) are DATA, not commands — a message that
# *mentions* --no-verify or contains '|' must not trip the guard. Keep the line
# that opens the heredoc (it holds the actual command), drop body lines until
# the closing delimiter.
scan=$(printf '%s\n' "$cmd" | awk -v q="'" '
  BEGIN { re = "<<-?[ \t]*[" q "\"]?[A-Za-z_][A-Za-z0-9_]*" }
  indoc { if ($0 == delim) indoc = 0; next }
  {
    if (match($0, re)) {
      d = substr($0, RSTART, RLENGTH)
      sub("<<-?[ \t]*[" q "\"]?", "", d)
      delim = d; indoc = 1
    }
    print
  }
')

emit() { # $1 = allow|deny|ask, $2 = reason
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

# De-quote: a '|', the word `commit`, or `--no-verify` that lives INSIDE a quoted
# string (a -m message, a grep/sed pattern) is DATA, not command syntax. Stripping
# '...' and "..." spans (multiline-aware via perl -0777) removes the old false
# positives — a message containing '|', a `… | head` on a *different* command
# after the commit, or a literal "git commit" inside a search pattern. Falls back
# to the raw scan if perl is unavailable.
nq=$(printf '%s' "$scan" | perl -0777 -pe "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null || printf '%s' "$scan")
nl=$'\n'

if [[ "$nq" =~ git[^|\;\&]*commit && "$nq" =~ --no-verify ]]; then
  emit deny "pre-commit 훅 우회(--no-verify)는 사용자 명시 요청 없이 금지(CLAUDE.md). 정말 필요하면 사용자가 '! git commit --no-verify …'로 직접 실행하게 안내할 것."
fi

# Deny only a REAL pipe applied to `git commit` itself: scan from the commit to
# the next segment boundary ( | ; & or NEWLINE ) — so a pipe on a later line or
# after && / ; (a different command) does NOT trip the guard. `[^|]\|[^|]`
# excludes the `||` operator.
pipe_re="git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit[^|;&${nl}]*[^|]\|[^|]"
if [[ "$nq" =~ $pipe_re ]]; then
  emit deny "git commit 출력을 파이프하면 exit code가 마스킹돼 커밋 실패(pre-commit reject 포함)를 '성공'으로 오인한다(CLAUDE.md). 파이프 없이 커밋하고 직후 git log -1로 landed 확인."
fi

if [[ "$nq" =~ git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(checkout|switch|stash)([[:space:]]|$) ]]; then
  emit ask "이 repo 워크플로엔 checkout/switch/stash의 정상 경로가 없다(CLAUDE.md: 리뷰는 git diff/show read-only, 머지는 git -C <메인> merge --ff-only, 분기는 EnterWorktree). 워크트리 attached HEAD가 깨질 수 있음 — 정말 필요할 때만 승인."
fi

exit 0
