#!/usr/bin/env bash
# PreToolUse(Bash): block `cargo run -p handicap-controller` without `--bin`.
# The handicap-controller package ships TWO binaries (controller + e2e_kind_driver),
# so a bare `cargo run -p handicap-controller …` fails with
#   error: `cargo run` could not determine which binary to run …
# (root CLAUDE.md "로컬 dev 실행 함정"). This is a daily footgun for local
# verification. Deny with the exact fix. Applies to the main agent AND every
# subagent's Bash calls. Always exits 0 (decision via JSON).
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0
case "$cmd" in *cargo*) ;; *) exit 0 ;; esac

emit() { # $1 = allow|deny|ask, $2 = reason
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

# A `cargo run` that targets the handicap-controller package but omits --bin.
# Matches `-p handicap-controller` / `--package handicap-controller`, and
# accepts --bin in both `--bin controller` and `--bin=controller` forms.
if [[ "$cmd" =~ [[:space:]]run([[:space:]]) ]] \
   && [[ "$cmd" =~ (-p|--package)[[:space:]]+handicap-controller($|[^a-zA-Z0-9]) ]] \
   && [[ ! "$cmd" =~ --bin([[:space:]]|=) ]]; then
  emit deny "handicap-controller엔 바이너리가 둘(controller·e2e_kind_driver)이라 'cargo run -p handicap-controller'는 'could not determine which binary to run'으로 깨진다(CLAUDE.md). --bin controller를 붙일 것: cargo run -p handicap-controller --bin controller -- … (또는 just run-controller / run-controller-with-ui)."
fi

exit 0
