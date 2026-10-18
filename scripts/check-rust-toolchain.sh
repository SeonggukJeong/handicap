#!/usr/bin/env bash
# Rust 툴체인 고정 정합 검사(spec toolchain-pin §3.2).
# 원천 = rust-toolchain.toml의 channel(정확 버전 X.Y.Z여야 한다 — `stable` 금지).
# 거울 = .github/workflows/*.yml의 모든 `dtolnay/rust-toolchain@<ref>` + deploy/Dockerfile의 모든 `FROM rust:<ver>-…`.
# 불일치를 전부 출력한 뒤 1로 종료한다(check-release-versions.sh 관례). 승급은 `just bump-rust <ver>`.
# bash 3.2 호환(mapfile/연관배열 금지).
set -euo pipefail
cd "$(dirname "$0")/.."   # 전 경로가 repo-root 상대다

fail=0
channel="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' rust-toolchain.toml | head -n 1)"

if printf '%s\n' "$channel" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf 'ok        %-44s %s\n' "rust-toolchain.toml channel" "$channel"
else
  printf 'MISMATCH  %-44s %s (정확 버전 X.Y.Z여야 함)\n' "rust-toolchain.toml channel" "${channel:-<없음>}"
  fail=1
fi

check() { # <file:line> <actual>
  if [ "$2" = "$channel" ]; then
    printf 'ok        %-44s %s\n' "$1" "$2"
  else
    printf 'MISMATCH  %-44s %s (기대 %s)\n' "$1" "${2:-<없음>}" "$channel"
    fail=1
  fi
}

# <label> <grep-ERE> <sed-ERE 추출식> <file...> — 출현마다 check, 0개면 실패(검사 공허 방지).
# `/dev/null`을 붙여 파일이 1개여도 grep이 파일명을 찍게 한다. while은 heredoc으로 먹여
# 서브셸을 피한다(파이프면 fail=1이 사라진다).
mirrors() {
  local label="$1" pat="$2" extract="$3" n=0 hit loc ver
  shift 3
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    loc="$(printf '%s\n' "$hit" | cut -d: -f1,2)"
    ver="$(printf '%s\n' "$hit" | cut -d: -f3- | sed -E "$extract")"
    check "$loc" "$ver"
    n=$((n + 1))
  done <<EOF
$(grep -nE "$pat" "$@" /dev/null || true)
EOF
  if [ "$n" -eq 0 ]; then
    printf 'MISMATCH  %-44s %s\n' "$label" "출현 0개 — 패턴이 바뀌어 검사가 공허하다"
    fail=1
  fi
}

mirrors ".github/workflows/*.yml" 'dtolnay/rust-toolchain@' \
  's/.*dtolnay\/rust-toolchain@([^[:space:]]+).*/\1/' .github/workflows/*.yml
mirrors "deploy/Dockerfile" '^FROM[[:space:]]+rust:' \
  's/^FROM[[:space:]]+rust:([^-[:space:]]+).*/\1/' deploy/Dockerfile

exit "$fail"
