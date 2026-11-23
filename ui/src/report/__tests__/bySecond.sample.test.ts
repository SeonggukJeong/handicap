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

function rep(windows: W[], selected: "passed" | "all" = "passed"): Report {
  return { windows, sample: { selected, default: selected, split: true } } as unknown as Report;
}

describe("bySecond — 값이 없는 초", () => {
  it("passed: 그 초의 모든 창이 전부 실패면 null, 섞인 초는 값", () => {
    const out = bySecond(
      rep([
        { ts_second: 1, count: 5, error_count: 5, p95_ms: 0, status_counts: { "500": 5 } },
        { ts_second: 2, count: 5, error_count: 5, p95_ms: 0, status_counts: { "500": 5 } },
        {
          ts_second: 2,
          count: 4,
          error_count: 1,
          p95_ms: 40,
          status_counts: { "200": 3, "500": 1 },
        },
      ]),
    );
    expect(out.map((s) => s.p95_ms)).toEqual([null, 40]);
  });

  it("all: 하나도 보내지 않은 초는 null", () => {
    const out = bySecond(
      rep([{ ts_second: 1, count: 5, error_count: 5, p95_ms: 0, status_counts: {} }], "all"),
    );
    expect(out[0].p95_ms).toBeNull();
  });
});
