#!/usr/bin/env bash
# PostToolUse(Write|Edit): format ONLY the single file Claude just touched.
# rustfmt for Rust, prettier for UI TS/JS. Best-effort — never blocks an edit.
# Mirrors the pre-commit `cargo fmt --check` gate so commits don't fail on fmt.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$file" || ! -f "$file" ]] && exit 0

case "$file" in
  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt --edition 2024 "$file" >/dev/null 2>&1
    ;;
  */ui/src/*.ts | */ui/src/*.tsx | */ui/src/*.js | */ui/src/*.jsx)
    # Resolve the file's own worktree root so prettier picks the right config
    # and node_modules even when editing inside .claude/worktrees/<name>/.
    root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
    [[ -d "$root/ui/node_modules" ]] &&
      pnpm --dir "$root/ui" exec prettier --write "$file" >/dev/null 2>&1
    ;;
esac
exit 0
