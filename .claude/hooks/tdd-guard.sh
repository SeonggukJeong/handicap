#!/usr/bin/env bash
# TDD guard: block production-code edits unless a test change is pending.
# Fires on PreToolUse for Write|Edit. Exit 2 -> stderr is shown to the model,
# which lets implementer subagents self-correct mid-task.
set -euo pipefail

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty')
file=$(echo "$input" | jq -r '.tool_input.file_path // empty')

case "$tool" in Write|Edit) ;; *) exit 0 ;; esac
[[ -z "$file" ]] && exit 0

is_test_path() {
  local f="$1"
  [[ "$f" =~ \.test\.[jt]sx?$ ]]   && return 0   # foo.test.ts(x)
  [[ "$f" =~ \.spec\.[jt]sx?$ ]]   && return 0   # foo.spec.ts(x)
  [[ "$f" =~ /__tests__/ ]]        && return 0
  [[ "$f" =~ /tests/.+\.rs$ ]]     && return 0   # Rust integration tests
  [[ "$f" =~ _test\.rs$ ]]         && return 0
  return 1
}

# Only enforce on files we actually own. Docs / configs / ADRs are free.
is_watched_production() {
  local f="$1"
  [[ "$f" =~ /crates/.+/src/.+\.rs$ ]]         && return 0
  [[ "$f" =~ /ui/src/.+\.(ts|tsx|js|jsx)$ ]]   && return 0
  return 1
}

is_test_path "$file" && exit 0
is_watched_production "$file" || exit 0

# Rust unit tests live inline (#[cfg(test)] mod tests). Treat such files as
# test-adjacent so the implementer can edit them while red.
if [[ "$file" =~ \.rs$ && -f "$file" ]] && grep -q '#\[cfg(test)\]' "$file"; then
  exit 0
fi

# Worktree-aware: derive the git working tree from the file being edited, not
# from the hook process's cwd. Subagents may be operating in a git worktree
# under .claude/worktrees/<name>/ while the hook's cwd is still the primary
# checkout. Without this, the pending-test scan below would query the wrong
# working tree and the TDD gate would either misfire or wave edits through.
dir=$(dirname "$file")
while [[ -n "$dir" && "$dir" != "/" && ! -d "$dir" ]]; do
  dir=$(dirname "$dir")
done
git_root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
[[ -z "$git_root" ]] && exit 0
cd "$git_root"

# Any modified/untracked test file in the working tree counts as a pending RED.
pending_test=$({
  git diff --name-only HEAD 2>/dev/null || true
  git ls-files --others --exclude-standard 2>/dev/null || true
} | sort -u | while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ \.test\.[jt]sx?$ ]] \
     || [[ "$f" =~ \.spec\.[jt]sx?$ ]] \
     || [[ "$f" =~ /__tests__/ ]] \
     || [[ "$f" =~ /tests/.+\.rs$ ]] \
     || [[ "$f" =~ _test\.rs$ ]]; then
    echo "$f"; break
  fi
done)

[[ -n "$pending_test" ]] && exit 0

cat >&2 <<'EOF'
[tdd-guard] Blocked: editing production code without a pending test change.

This project enforces superpowers:test-driven-development via hook.
Before editing files under crates/*/src/ or ui/src/, you must have a
pending (modified or untracked) test file in the working tree.

Where tests live:
  Rust:  crates/<name>/tests/*.rs  |  *_test.rs  |  inline #[cfg(test)] mod
  TS:    *.test.ts(x)  |  *.spec.ts(x)  |  __tests__/*

TDD cycle:
  1. RED   - write a failing test for the new behavior
  2. Run it (cargo test / pnpm test) and confirm it fails for the right reason
  3. GREEN - make the minimal production change to turn it green

If this edit genuinely needs no test (config, generated, throwaway), stop
and confirm with the human partner before bypassing.
EOF
exit 2
