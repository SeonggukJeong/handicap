import { describe, it, expect } from "vitest";
import { bySecond } from "../bySecond";
import type { Report } from "../../api/schemas";

type W = {
  ts_second: number;
  count: number;
  error_count: number;
  p95_ms: number;
  status_counts: Record<string, number>;
};
type L = { ts_second: number; n: number; mean_us?: number; p95_us?: number };

function rep(windows: W[], latency: L[], selected: "passed" | "all" = "passed"): Report {
  return {
    windows,
    latency_by_second: latency,
    sample: { selected, default: selected, split: true },
  } as unknown as Report;
}

describe("bySecond — 값이 없는 초", () => {
  it("passed: 서버가 n:0으로 준 초는 null, 값이 있는 초는 그 값", () => {
    const out = bySecond(
      rep(
        [
          { ts_second: 1, count: 5, error_count: 5, p95_ms: 0, status_counts: { "500": 5 } },
          {
            ts_second: 2,
            count: 4,
            error_count: 1,
            p95_ms: 40,
            status_counts: { "200": 3, "500": 1 },
          },
        ],
        [
          { ts_second: 1, n: 0 },
          { ts_second: 2, n: 3, mean_us: 30000, p95_us: 40000 },
        ],
      ),
    );
    expect(out.map((s) => s.p95_ms)).toEqual([null, 40]);
    expect(out.map((s) => s.mean_ms)).toEqual([null, 30]);
  });

  it("all: 하나도 보내지 않은 초(n:0)는 null", () => {
    const out = bySecond(
      rep(
        [{ ts_second: 1, count: 5, error_count: 5, p95_ms: 0, status_counts: {} }],
        [{ ts_second: 1, n: 0 }],
        "all",
      ),
    );
    expect(out[0].p95_ms).toBeNull();
  });
});
