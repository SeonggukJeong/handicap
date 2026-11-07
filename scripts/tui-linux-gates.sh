#!/usr/bin/env bash
# Linux 전용 게이트: handicap-tui 바이너리의 glibc 심볼 상한(<=2.27)과 NEEDED 집합 검사. binutils 필요.
# 사용: scripts/tui-linux-gates.sh <binary>   위반 시 exit 1.
set -uo pipefail
bin="${1:?usage: $0 <binary>}"
MAX="2.27"
fail=0
# ① GLIBC_x.y 최댓값
maxver="$(objdump -T "$bin" | grep -o 'GLIBC_[0-9]*\.[0-9]*\(\.[0-9]*\)\?' | sed 's/GLIBC_//' | sort -uV | tail -1)"
echo "max GLIBC symbol version: ${maxver:-none}"
if [ -n "$maxver" ] && [ "$(printf '%s\n%s\n' "$MAX" "$maxver" | sort -V | tail -1)" != "$MAX" ]; then
  echo "위반: GLIBC_$maxver > $MAX 심볼:"
  objdump -T "$bin" | grep "GLIBC_$maxver" || true
  fail=1
fi
# ② NEEDED 집합
needed="$(readelf -d "$bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')"
echo "NEEDED:"
echo "$needed"
while IFS= read -r n; do
  [ -z "$n" ] && continue
  case "$n" in
    libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libutil.so.*|libgcc_s.so.*|ld-linux*.so.*) ;;
    *) echo "위반: 허용되지 않은 NEEDED $n"; fail=1 ;;
  esac
done <<< "$needed"
if [ "$fail" = 0 ]; then echo "게이트 통과"; else echo "게이트 실패"; fi
exit "$fail"
