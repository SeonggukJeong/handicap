#!/usr/bin/env bash
# Linux 전용 게이트: handicap-tui 바이너리의 glibc 심볼 상한(<=2.27)과 NEEDED 집합 검사. binutils 필요.
# 사용: scripts/tui-linux-gates.sh <binary>
# exit: 0 통과 · 1 위반(또는 검사 결과 없음) · 2 도구/바이너리 누락.
set -uo pipefail
bin="${1:?usage: $0 <binary>}"
MAX="2.27"
for t in objdump readelf; do
  command -v "$t" >/dev/null 2>&1 || { echo "오류: $t 없음 (binutils 필요)"; exit 2; }
done
[ -f "$bin" ] || { echo "오류: 바이너리 없음: $bin"; exit 2; }
fail=0
# ① GLIBC_x.y 최댓값
dyn="$(objdump -T "$bin")" || { echo "오류: objdump -T 실패"; exit 2; }
maxver="$(printf '%s\n' "$dyn" | grep -o 'GLIBC_[0-9]*\.[0-9]*\(\.[0-9]*\)\?' | sed 's/GLIBC_//' | sort -uV | tail -1)"
echo "max GLIBC symbol version: ${maxver:-none}"
if [ -z "$maxver" ]; then
  echo "위반: GLIBC 심볼 버전을 찾지 못함 (동적 glibc 바이너리가 아님?)"
  fail=1
elif [ "$(printf '%s\n%s\n' "$MAX" "$maxver" | sort -V | tail -1)" != "$MAX" ]; then
  echo "위반: GLIBC_$maxver > $MAX 심볼:"
  printf '%s\n' "$dyn" | grep -F "(GLIBC_$maxver)"
  fail=1
fi
# ② NEEDED 집합
dynsec="$(readelf -d "$bin")" || { echo "오류: readelf -d 실패"; exit 2; }
needed="$(printf '%s\n' "$dynsec" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')"
echo "NEEDED:"
echo "$needed"
if [ -z "$needed" ]; then
  echo "위반: NEEDED 항목이 없음"
  fail=1
fi
while IFS= read -r n; do
  [ -z "$n" ] && continue
  case "$n" in
    libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libutil.so.*|libgcc_s.so.*|ld-linux*.so.*) ;;
    *) echo "위반: 허용되지 않은 NEEDED $n"; fail=1 ;;
  esac
done <<< "$needed"
if [ "$fail" = 0 ]; then echo "게이트 통과"; else echo "게이트 실패"; fi
exit "$fail"
