#!/usr/bin/env python3
"""handicap-tui --check 스모크(호스트 직접 실행 — docker 없음). Windows 릴리즈 잡용, macOS/Linux에서도 돈다.

사용: python scripts/tui-check-smoke.py <binary> <fixture.json>
빈 디렉토리를 http.server로 서빙(`/`만 200)하고, fixture의 __BASE__를 치환해 `<binary> --check`를 실행한다.
NO_RESPONDER=1 이면 응답기를 띄우지 않는다(이빨 실증용 — '✖ 실패'가 나와 exit 1이어야 정상).
exit: 0 통과 · 1 실패 · 2 도구/입력 누락.
Linux 19.04(glibc 2.27) 호환 확인은 scripts/tui-linux-smoke.sh(컨테이너) 몫이다.
"""

import functools
import http.server
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class _Server(http.server.ThreadingHTTPServer):
    # 기본 backlog 5는 동시 연결에서 가짜 전송 실패를 낸다(crates/tui/CLAUDE.md).
    request_queue_size = 64


def main() -> int:
    # Windows 러너의 기본 stdout 인코딩(cp1252)은 '✔'를 못 찍는다.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <binary> <fixture>", file=sys.stderr)
        return 2
    binary, fixture = sys.argv[1], sys.argv[2]
    if not os.path.isfile(binary):
        print(f"오류: 바이너리 없음: {binary}", file=sys.stderr)
        return 2
    if not os.path.isfile(fixture):
        print(f"오류: fixture 없음: {fixture}", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="tui-smoke-")
    server = None
    try:
        empty = os.path.join(work, "empty")
        os.mkdir(empty)
        no_responder = os.environ.get("NO_RESPONDER", "0") == "1"
        if no_responder:
            # 아무도 듣지 않는 포트 — bind 후 바로 닫는다.
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
            s.close()
        else:
            handler = functools.partial(_Quiet, directory=empty)
            server = _Server(("127.0.0.1", 0), handler)
            port = server.server_address[1]
            threading.Thread(target=server.serve_forever, daemon=True).start()

        base = f"http://127.0.0.1:{port}"
        with open(fixture, encoding="utf-8") as f:
            text = f.read().replace("__BASE__", base)
        board = os.path.join(work, "board.json")
        with open(board, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

        print(f"대상: {base} (NO_RESPONDER={'1' if no_responder else '0'})")
        try:
            p = subprocess.run(
                [binary, "--check", board],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            print("스모크 실패: --check 120초 초과", file=sys.stderr)
            return 1
        out = p.stdout.decode("utf-8", errors="replace")
        print(out)
        print(f"check exit={p.returncode}")
        if p.returncode != 0:
            print(f"스모크 실패: --check exit {p.returncode}", file=sys.stderr)
            return 1
        if "✔ 정상" not in out:
            print("스모크 실패: 출력에 '✔ 정상' 없음", file=sys.stderr)
            return 1
        print("스모크 통과")
        return 0
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
