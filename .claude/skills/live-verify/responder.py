#!/usr/bin/env python3
"""Latency-configurable 200 responder for handicap live verification.

Usage: python3 responder.py [port] [delay_ms]
  port      default 9999
  delay_ms  default 50  -- a non-zero delay makes report p50_ms > 0, so
            sizing / latency-phase / test-run-measure paths don't hit their
            zero-guards (the localhost sub-ms trap). ThreadingHTTPServer
            handles ~10k rps on localhost.
"""
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
DELAY_S = (int(sys.argv[2]) if len(sys.argv) > 2 else 50) / 1000.0


class H(BaseHTTPRequestHandler):
    def _respond(self):
        if DELAY_S:
            time.sleep(DELAY_S)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    do_GET = _respond
    do_POST = _respond
    do_PUT = _respond

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"responder on 127.0.0.1:{PORT} delay={DELAY_S*1000:.0f}ms", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
