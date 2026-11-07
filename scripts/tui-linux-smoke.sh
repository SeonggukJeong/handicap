#!/usr/bin/env bash
# handicap-tui --check 스모크: Ubuntu 19.04(amd64) 컨테이너에서 실제 HTTP 점검 1회가 통과하는지 확인.
# 사용: scripts/tui-linux-smoke.sh <binary> <fixture.json>
# 호스트에서 빈 디렉토리를 python http.server로 서빙(`/`만 200)하고, fixture의 __BASE__를 치환해 컨테이너에서 실행.
# NO_RESPONDER=1 이면 응답기를 띄우지 않는다(이빨 실증용 — 출력에 '✖ 실패'가 나와 exit 1이어야 정상).
# exit: 0 통과 · 1 실패 · 2 도구/입력 누락.
set -uo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <binary> <fixture>" >&2; exit 2; }
bin="$1"; fixture="$2"
[ -f "$bin" ] || { echo "오류: 바이너리 없음: $bin" >&2; exit 2; }
[ -f "$fixture" ] || { echo "오류: fixture 없음: $fixture" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "오류: docker 없음" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "오류: python3 없음" >&2; exit 2; }

work="$(mktemp -d)"
srv_pid=""
cleanup() {
  if [ -n "$srv_pid" ]; then
    kill "$srv_pid" 2>/dev/null
    wait "$srv_pid" 2>/dev/null
  fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/empty" "$work/b"
cp "$bin" "$work/b/handicap-tui"
chmod +x "$work/b/handicap-tui"

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
if [ "$(uname -s)" = "Linux" ]; then
  # CI: host 네트워크 + 루프백
  net=(--network host)
  host="127.0.0.1"
else
  # macOS Docker Desktop: host 네트워크 기본 꺼짐 → 기본 네트워크 + host.docker.internal
  net=()
  host="host.docker.internal"
fi
base="http://${host}:${port}"
sed "s#__BASE__#${base}#g" "$fixture" > "$work/b/board.json"

if [ "${NO_RESPONDER:-0}" != "1" ]; then
  (cd "$work/empty" && exec python3 -m http.server "$port" --bind 0.0.0.0 >/dev/null 2>&1) &
  srv_pid=$!
  for _ in $(seq 1 50); do
    python3 -c "import socket,sys; s=socket.socket(); s.settimeout(0.2); sys.exit(0 if s.connect_ex(('127.0.0.1',$port))==0 else 1)" && break
    sleep 0.1
  done
fi

# 참고: ubuntu:19.04는 EOL로 보관(archived)된 Docker Hub 태그다 — pull이 실패하기 시작하면 그것이 원인이다.
echo "대상: $base (NO_RESPONDER=${NO_RESPONDER:-0})"
out="$(docker run --rm --platform linux/amd64 ${net[@]+"${net[@]}"} -v "$work/b:/b" ubuntu:19.04 /b/handicap-tui --check /b/board.json 2>&1)"
rc=$?
echo "$out"
echo "check exit=$rc"
if [ "$rc" -ne 0 ]; then
  echo "스모크 실패: --check exit $rc" >&2
  exit 1
fi
if ! printf '%s\n' "$out" | grep -q '✔ 정상'; then
  echo "스모크 실패: 출력에 '✔ 정상' 없음" >&2
  exit 1
fi
echo "스모크 통과"
