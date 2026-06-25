import { describe, it, expect } from "vitest";
import { bySecond } from "../bySecond";
import type { Report } from "../../api/schemas";

function rep(
  windows: Array<{ ts_second: number; count: number; error_count: number; p95_ms: number }>,
): Report {
  return { windows } as unknown as Report;
}

describe("bySecond", () => {
  it("sums count/errors across steps in the same second and takes max p95", () => {
    const out = bySecond(
      rep([
        { ts_second: 100, count: 5, error_count: 1, p95_ms: 50 },
        { ts_second: 100, count: 3, error_count: 0, p95_ms: 80 },
        { ts_second: 101, count: 2, error_count: 2, p95_ms: 40 },
      ]),
    );
    expect(out).toEqual([
      { ts_second: 100, count: 8, errors: 1, p95_ms: 80 },
      { ts_second: 101, count: 2, errors: 2, p95_ms: 40 },
    ]);
  });

  it("returns empty for no windows and sorts ascending by second", () => {
    expect(bySecond(rep([]))).toEqual([]);
    const out = bySecond(
      rep([
        { ts_second: 200, count: 1, error_count: 0, p95_ms: 10 },
        { ts_second: 100, count: 1, error_count: 0, p95_ms: 10 },
      ]),
    );
    expect(out.map((s) => s.ts_second)).toEqual([100, 200]);
  });
});
