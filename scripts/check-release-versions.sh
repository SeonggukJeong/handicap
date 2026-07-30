#!/usr/bin/env bash
# 릴리즈 태그와 레포 내 버전 문자열들의 정합을 검사한다(spec R6).
# 불일치는 전부 출력한 뒤 1로 종료한다(첫 항목에서 멈추지 않는다 — 한 번에 다 고치게).
# bash 3.2 호환(mapfile/연관배열 금지).
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <tag>   (예: $0 v0.7.0)" >&2; exit 2; }
tag="$1"
# 선행 v만 제거한다. `0.7.0`처럼 v 없는 입력도 **통과시키는 것이 의도**다 —
# 잘못된 태그의 실제 가드는 워크플로의 actions/checkout이 `ref: 0.7.0`(없는 ref)에서
# 실패하는 것이지 이 스크립트가 아니다. 여기서 태그 형식을 거부하도록 "고치지" 말 것.
want="${tag#v}"
fail=0

check() { # <label> <actual>
  if [ "${2:-}" != "$want" ]; then
    printf 'MISMATCH  %-44s %s (기대 %s)\n' "$1" "${2:-<없음>}" "$want"
    fail=1
  else
    printf 'ok        %-44s %s\n' "$1" "$2"
  fi
}

# TOML의 [section] 안 version. 섹션 스코프가 load-bearing —
# 루트 Cargo.toml엔 [workspace.dependencies.wiremock]의 version이 열 0에 있어
# naive `grep '^version'`은 틀린 줄을 읽는다.
toml_section_version() { # <file> <section>
  awk -v want="$2" '
    /^\[/ { in_s = ($0 == "[" want "]"); next }
    in_s && /^[[:space:]]*version[[:space:]]*=/ {
      if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "$1"
}

# Cargo.lock의 [[package]] name = "<pkg>" 블록의 version.
lock_version() { # <lockfile> <pkg>
  awk -v pkg="$2" '
    $0 == "name = \"" pkg "\"" { found = 1; next }
    found && /^version = / {
      if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "$1"
}

check "Cargo.toml [workspace.package]" "$(toml_section_version Cargo.toml workspace.package)"
check "desktop/src-tauri/Cargo.toml [package]" \
  "$(toml_section_version desktop/src-tauri/Cargo.toml package)"
check "desktop/src-tauri/tauri.conf.json" "$(jq -r .version desktop/src-tauri/tauri.conf.json)"

for pkg in handicap-engine handicap-proto handicap-worker-core handicap-worker handicap-controller; do
  check "Cargo.lock $pkg" "$(lock_version Cargo.lock "$pkg")"
  check "desktop lock $pkg" "$(lock_version desktop/src-tauri/Cargo.lock "$pkg")"
done

# v0.2.1이 실제로 stale이던 항목. 루트 락엔 desktop 항목이 없다(별도 워크스페이스).
check "desktop lock desktop" "$(lock_version desktop/src-tauri/Cargo.lock desktop)"

notes="docs/release-notes/${tag}.md"
if [ -f "$notes" ]; then
  echo "notes: present ($notes)"
else
  echo "notes: absent ($notes — 자동 초안으로 발행됩니다)"
fi

exit "$fail"
