#!/usr/bin/env bash
# 릴리즈 publish 게이트(spec toolchain-pin §3.4): 태그 커밋의 ci 워크플로 **최신 run**이
# success일 때만 0. 진행 중이면 대기하고, 빨강·run 없음·대기 초과·gh 실패는 사유+해소법과 함께 1.
# 읽기 전용(gh run list만). bash 3.2 호환. 테스트용 env: CI_GATE_POLL_SECONDS·CI_GATE_MAX_WAIT_SECONDS.
set -euo pipefail

# 40자 전체 SHA만 받는다 — `gh run list --commit <단축>`은 []를 돌려 "run 없음"으로 오판된다.
if [ $# -ne 1 ] || ! printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "usage: $0 <40자 commit SHA>   (단축 SHA 불가 — gh가 []를 돌려준다)" >&2
  exit 2
fi
sha="$1"
poll="${CI_GATE_POLL_SECONDS:-30}"
max_wait="${CI_GATE_MAX_WAIT_SECONDS:-1800}"

# push·workflow_dispatch run만 본다 — pull_request run은 태그 트리가 아닌 merge 커밋을 검사한다.
# 최신 run 1개(createdAt 기준 — 배열 순서에 기대지 않는다)를 "status conclusion url" 한 줄로. run 0개면 빈 줄.
latest_run() {
  gh run list ${GITHUB_REPOSITORY:+--repo "$GITHUB_REPOSITORY"} \
    --workflow ci --commit "$sha" --limit 20 \
    --json event,status,conclusion,createdAt,url \
    --jq 'map(select(.event == "push" or .event == "workflow_dispatch")) | sort_by(.createdAt) | last
          | if . == null then ""
            else "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.url)" end'
}

start=$SECONDS
while :; do
  if ! out="$(latest_run)"; then
    echo "gh run list 실패 — fail-closed. 워크플로에서 403이면 publish 잡 permissions의 actions: read 누락." >&2
    exit 1
  fi
  if [ -z "$out" ]; then
    cat >&2 <<EOF
ci run 없음: $sha
ci는 push의 head 커밋에서만 돈다 — 한 push에 여러 커밋을 올리면 중간 커밋엔 run이 없다.
해소: gh workflow run ci --ref <태그>  → 녹색 확인 → 이 publish 잡만 재실행.
EOF
    exit 1
  fi
  status="${out%% *}"
  rest="${out#* }"
  conclusion="${rest%% *}"
  url="${rest#* }"
  if [ "$status" = "completed" ]; then
    if [ "$conclusion" = "success" ]; then
      echo "ci green: $url"
      exit 0
    fi
    cat >&2 <<EOF
ci $conclusion: $url
해소: flake면 ci 재실행 → 녹색 확인 → 이 publish 잡만 재실행 / 진짜 실패면 수정 커밋 + 새 태그.
EOF
    exit 1
  fi
  waited=$((SECONDS - start))
  if [ "$waited" -ge "$max_wait" ]; then
    echo "ci 대기 상한 ${max_wait}s 초과(status=$status): $url — ci가 끝난 뒤 이 publish 잡만 재실행." >&2
    exit 1
  fi
  echo "ci $status — ${poll}s 후 재조회(경과 ${waited}s/${max_wait}s): $url"
  sleep "$poll"
done
