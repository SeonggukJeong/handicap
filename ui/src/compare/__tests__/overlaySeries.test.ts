import { describe, it, expect } from "vitest";
import { overlaySeries } from "../overlaySeries";
import { runColor, runShortLabel } from "../runLabel";
import type { Report } from "../../api/schemas";

function rep(
  id: string,
  windows: Array<{ ts_second: number; count: number; error_count: number; p95_ms: number }>,
): Report {
  return { run: { id }, windows } as unknown as Report;
}

describe("runShortLabel", () => {
  it("is the hash + last 6 chars of the id", () => {
    expect(runShortLabel("01HXXXXXXXXXXABCDEF")).toBe("#ABCDEF");
  });
});

describe("overlaySeries", () => {
  it("normalizes each run to its own t=0 and merges by elapsed with null gaps", () => {
    const a = rep("aaaaaa111111", [
      { ts_second: 1000, count: 10, error_count: 0, p95_ms: 5 },
      { ts_second: 1001, count: 12, error_count: 0, p95_ms: 6 },
    ]);
    const b = rep("bbbbbb222222", [{ ts_second: 5000, count: 20, error_count: 0, p95_ms: 9 }]);
    const { rows, runs } = overlaySeries([a, b], 0, "rps");
    expect(rows).toEqual([
      { elapsed: 0, run0: 10, run1: 20 },
      { elapsed: 1, run0: 12, run1: null },
    ]);
    expect(runs.map((r) => r.key)).toEqual(["run0", "run1"]);
    expect(runs[0].baseline).toBe(true);
    expect(runs[1].baseline).toBe(false);
    expect(runs[0].label).toBe("#111111");
    expect(runs[1].label).toBe("#222222");
    expect(runs[0].color).not.toBe(runs[1].color);
    expect(runs[0].color).toBe(runColor(0));
    expect(runs[1].color).toBe(runColor(1));
  });

  it("selects the requested metric", () => {
    const a = rep("aaaaaa111111", [{ ts_second: 1000, count: 10, error_count: 3, p95_ms: 7 }]);
    expect(overlaySeries([a], 0, "errors").rows[0].run0).toBe(3);
    expect(overlaySeries([a], 0, "p95").rows[0].run0).toBe(7);
    expect(overlaySeries([a], 0, "rps").rows[0].run0).toBe(10);
  });
});
