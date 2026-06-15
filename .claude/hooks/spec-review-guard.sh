#!/usr/bin/env bash
# spec-review-guard: block slice IMPLEMENTATION until its spec/plan passed review.
#
# Docs/specs/plans/configs are always free — you must be able to write the plan
# and mark it. But editing production/source (crates/*/src, ui/src) is blocked
# while THIS branch carries a slice spec/plan that has not passed the
# spec-plan-reviewer loop. "Passed" is recorded by a single marker line in the
# plan:   REVIEW-GATE: APPROVED
# The orchestrator adds it ONLY after spec-plan-reviewer returns APPROVE
# (start-slice §4). The hook can't see a subagent's verdict, so the marker is a
# proxy — same trust model as tdd-guard (a test file may exist) / --no-verify:
# it converts a silent skip into a deliberate, visible forgery.
#
# Fires on PreToolUse for Write|Edit. Exit 2 -> stderr is shown to the model,
# which lets implementer subagents self-correct mid-task. Fail-open on any
# inability to locate the repo / base branch (never brick edits on error).
set -euo pipefail

input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty')
file=$(echo "$input" | jq -r '.tool_input.file_path // empty')

case "$tool" in Write|Edit) ;; *) exit 0 ;; esac
[[ -z "$file" ]] && exit 0

# Only enforce on source we own (the set tdd-guard watches). Everything else —
# docs, specs, plans, ADRs, configs, the marker itself — is free.
is_watched_source() {
  local f="$1"
  [[ "$f" =~ /crates/.+/src/.+\.rs$ ]]       && return 0
  [[ "$f" =~ /ui/src/.+\.(ts|tsx|js|jsx)$ ]] && return 0
  return 1
}
is_watched_source "$file" || exit 0

# Worktree-aware: derive the git working tree from the edited file, not the
# hook process cwd (subagents run under .claude/worktrees/<name>/).
dir=$(dirname "$file")
while [[ -n "$dir" && "$dir" != "/" && ! -d "$dir" ]]; do dir=$(dirname "$dir"); done
git_root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
[[ -z "$git_root" ]] && exit 0          # fail-open: can't locate repo
cd "$git_root"

# Base of this branch's work = the integration branch (this repo: master).
base=master
git rev-parse --verify -q "$base" >/dev/null 2>&1 || exit 0   # fail-open: no base

# Slice docs introduced on THIS branch (committed since base + untracked),
# minus the templates themselves.
branch_docs=$({
  git diff --name-only "$base"...HEAD -- docs/superpowers/specs docs/superpowers/plans 2>/dev/null || true
  git ls-files --others --exclude-standard -- docs/superpowers/specs docs/superpowers/plans 2>/dev/null || true
} | sort -u | grep -v '/_TEMPLATE\.md$' || true)

# No slice docs on this branch -> unplanned/trivial change. Allow (consistent
# with tdd-guard waving through non-watched paths).
[[ -z "$branch_docs" ]] && exit 0

# The approval marker must be an EXACT, end-of-line-anchored token (a trailing
# HTML-comment close `-->` is allowed). This is deliberately strict so partial
# verdicts can NOT slip through as a substring of "APPROVED":
#   REVIEW-GATE: APPROVE-WITH-FIXES   -> blocked (no "APPROVED")
#   REVIEW-GATE: APPROVED-WITH-FIXES  -> blocked (text after APPROVED)
#   REVIEW-GATE: APPROVED WITH FIXES  -> blocked (text after APPROVED)
#   REVIEW-GATE: NOT APPROVED         -> blocked (APPROVED not right after the colon)
#   ...prose mentioning REVIEW-GATE: APPROVED mid-sentence -> blocked (not EOL)
#   REVIEW-GATE: APPROVED   /   <!-- REVIEW-GATE: APPROVED --> -> allowed
marker_re='REVIEW-GATE:[[:space:]]+APPROVED([[:space:]]*-->)?[[:space:]]*$'

plans=$(echo "$branch_docs" | grep -E '^docs/superpowers/plans/.+\.md$' || true)

# A branch spec with NO plan = the plan isn't written yet -> block (can't
# implement an un-planned slice). Otherwise EVERY branch plan must be approved:
# one unreviewed plan blocks the slice (a sibling approved plan does not excuse it).
block=""
if [[ -z "$plans" ]]; then
  block=1
else
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if [[ ! -f "$p" ]] || ! grep -Eq "$marker_re" "$p"; then
      block=1
      break
    fi
  done <<< "$plans"
fi

[[ -z "$block" ]] && exit 0

cat >&2 <<'EOF'
[spec-review-guard] Blocked: implementing a slice whose spec/plan has not passed review.

This branch added a spec/plan under docs/superpowers/ but no plan carries the
approval marker, so production/source edits (crates/*/src, ui/src) are blocked.

Required (start-slice §4 — the spec-plan-reviewer loop):
  1. Run spec-plan-reviewer on the spec, then the plan.
  2. Treat findings critically (receiving-code-review): fix valid ones,
     push back (with a reason) on wrong / out-of-scope ones.
  3. Re-review the revised doc until the verdict is APPROVE.
     APPROVE-WITH-FIXES / NEEDS-REWORK do NOT pass.
  4. Only THEN add this line to the plan (records spec+plan both passed):
         REVIEW-GATE: APPROVED

If this edit is genuinely outside any slice (trivial fix), it should not have a
branch-local plan — otherwise confirm with the human before bypassing.
EOF
exit 2
