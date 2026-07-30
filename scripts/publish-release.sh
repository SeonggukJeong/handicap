#!/usr/bin/env bash
# 릴리즈 게시(spec R8). 재실행 멱등: 릴리즈가 있으면 upload --clobber, 없으면 create.
# 오류 분류 없음 — gh는 HTTP 상태를 노출하지 않는다(spec 실측 §7). 유한 재시도만.
# bash 3.2 호환(mapfile 금지).
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <tag> <assets-dir>" >&2; exit 2; }
tag="$1"
assets_dir="$2"
notes_file="docs/release-notes/${tag}.md"

# 존재하는 파일만 수집 — 매치 없는 glob이 게시를 죽이면 안 된다(macOS dmg 실패 시 3종만 올린다).
assets=()
while IFS= read -r f; do
  assets+=("$f")
done < <(find "$assets_dir" -type f \( -name '*.exe' -o -name '*.msi' -o -name '*.dmg' \) | sort)

[ "${#assets[@]}" -gt 0 ] || { echo "게시할 에셋이 없습니다: $assets_dir" >&2; exit 1; }
echo "에셋 ${#assets[@]}개:"
printf '  %s\n' "${assets[@]}"
for want in x64-setup.exe x64_en-US.msi x64-portable.exe aarch64.dmg x64.dmg; do
  printf '%s\n' "${assets[@]}" | grep -q -- "$want" || echo "  (누락: *$want)"
done

# 최대 5회 시도(최초 1회 + 4회), 지연 10/20/40/80초. 테스트용 env 오버라이드.
retry() {
  local delays i=0
  delays=(${PUBLISH_RETRY_DELAYS:-10 20 40 80})
  until "$@"; do
    if [ "$i" -ge "${#delays[@]}" ]; then
      echo "재시도 소진(5회): $*" >&2
      return 1
    fi
    echo "실패 — ${delays[$i]}초 후 재시도 ($((i + 2))/5): $*" >&2
    sleep "${delays[$i]}"
    i=$((i + 1))
  done
}

generate_notes_to() { # <outfile>  — gh release edit엔 --generate-notes가 없다(실측 §8)
  gh api --method POST "repos/${GITHUB_REPOSITORY}/releases/generate-notes" \
    -f "tag_name=${tag}" --jq .body > "$1"
}

if gh release view "$tag" >/dev/null 2>&1; then
  echo "릴리즈 $tag 존재 → 에셋 덮어쓰기(재실행 멱등)"
  retry gh release upload "$tag" "${assets[@]}" --clobber
  if [ -f "$notes_file" ]; then
    retry gh release edit "$tag" --notes-file "$notes_file"
  elif [ -z "$(gh release view "$tag" --json body -q .body)" ]; then
    # 바이트 수로 판정하지 말 것: 빈 본문은 `-q .body | wc -c` = 1(개행)이다.
    draft="$(mktemp)"
    retry generate_notes_to "$draft"
    retry gh release edit "$tag" --notes-file "$draft"
  else
    echo "노트 파일 없음 + 기존 본문 있음 → 본문 유지"
  fi
else
  echo "릴리즈 $tag 신규 생성"
  if [ -f "$notes_file" ]; then
    retry gh release create "$tag" --title "Handicap ${tag}" \
      --notes-file "$notes_file" "${assets[@]}"
  else
    retry gh release create "$tag" --title "Handicap ${tag}" \
      --generate-notes "${assets[@]}"
  fi
fi
echo "게시 완료: $tag"
