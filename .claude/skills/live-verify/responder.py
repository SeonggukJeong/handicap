#!/usr/bin/env python3
"""Latency-configurable 200 responder for handicap live verification (asyncio, HTTP/1.1).

Usage: python3 responder.py [port] [delay_ms] [close]
  port      default 9999
  delay_ms  default 50  -- a non-zero delay makes report p50_ms > 0, so
            sizing / latency-phase / test-run-measure paths don't hit their
            zero-guards (the localhost sub-ms trap).
  close     optional 3rd arg. Without it the server keeps connections alive
            (mode=keepalive, default): use for normal / high-RPS / perf runs.
            With it every response carries `Connection: close` and the server
            closes the connection after it (mode=close): one new TCP connection
            per request, for connection-timing / reuse-ratio checks
            (connections_opened == requests_total, reuse_ratio = 0).

A one-connection-per-request responder collapses at a few thousand req/s
(connection setup, small backlog) and looks like SUT saturation, so measure
throughput in keep-alive mode. Any method is answered 200 text/plain `ok`;
request bodies (Content-Length) are read and discarded; nothing is logged.
"""
import asyncio
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
DELAY_S = (int(sys.argv[2]) if len(sys.argv) > 2 else 50) / 1000.0
CLOSE = len(sys.argv) > 3 and sys.argv[3] == "close"

HEAD = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n"
RESP = HEAD + (b"Connection: close\r\n" if CLOSE else b"") + b"\r\nok"


async def handle(reader, writer):
    try:
        while True:
            head = await reader.readuntil(b"\r\n\r\n")
            n = 0
            for line in head.split(b"\r\n"):
                if line[:15].lower() == b"content-length:":
                    n = int(line[15:].strip() or 0)
            if n:
                await reader.readexactly(n)
            if DELAY_S:
                await asyncio.sleep(DELAY_S)
            writer.write(RESP)
            await writer.drain()
            if CLOSE or b"connection: close" in head.lower():
                break
    except (asyncio.IncompleteReadError, ConnectionError, asyncio.LimitOverrunError, ValueError):
        pass
    finally:
        writer.close()


async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", PORT, backlog=4096)
    mode = "close" if CLOSE else "keepalive"
    print(f"responder on 127.0.0.1:{PORT} delay={DELAY_S*1000:.0f}ms mode={mode}", flush=True)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
