# Performance bench — §4.3 acceptance

This document tracks the manual-bench numbers for MVP §4.3 acceptance:
- Single worker sustains ≥ 5,000 RPS against a 1 KB JSON GET
- Metrics-on vs metrics-off throughput delta ≤ 5 %
- Controller idle RSS ≤ 256 MB, in-run RSS ≤ 512 MB
- Report page initial render ≤ 2 s for 10k metric rows

## Procedure

1. Start wiremock in a terminal: `docker run --rm -p 9001:8080 wiremock/wiremock:3.5.4`
2. Stub a 1 KB JSON GET (see `scripts/wiremock-stub.sh` once Task 17 lands).
3. Run `just bench-throughput` (lands in Task 17).
4. Record numbers in the table below.

## History

| Date | Slice | Variant | RPS | p50 ms | p95 ms | p99 ms | Ctrl RSS | Worker RSS | Notes |
|---|---|---|---:|---:|---:|---:|---|---|---|
| 2026-05-28 | pre-6 | host process | 18326 | 1 | 6 | 10 | 14 MB | 33 MB | Baseline. 100 VUs / 30 s / `GET /ping` (small JSON, not the 1 KB target — Task 17 will switch). Last-20s mean RPS. Worker RSS sampled mid-run (process exits on terminal). Wiremock 3.5.4 on `:19001`, controller on `:18080/:18081`. |

## Why this is manual, not CI

Performance tests on shared CI runners are flaky (noisy neighbors). We document
the procedure and a `just bench-throughput` recipe so any engineer can
reproduce locally, and we record regressions when they happen.
