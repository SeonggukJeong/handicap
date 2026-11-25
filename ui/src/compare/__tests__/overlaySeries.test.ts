import { describe, it, expect } from "vitest";
import { overlaySeries } from "../overlaySeries";
import { runColor, runShortLabel } from "../runLabel";
import type { Report } from "../../api/schemas";

function rep(
  id: string,
  windows: Array<{ ts_second: number; count: number; error_count: number; p95_ms: number }>,
  label?: string,
): Report {
  // 응답 시간은 서버 latency_by_second에서 온다 — 창 p95_ms를 µs로 옮긴 항목(평균은 p95+1ms).
  const latency_by_second = windows.map((w) => ({
    ts_second: w.ts_second,
    n: w.count,
    mean_us: (w.p95_ms + 1) * 1000,
    p95_us: w.p95_ms * 1000,
  }));
  // 스키마상 status_counts는 필수 — 창의 요청은 전부 보낸 것으로 둔다.
  return {
    run: { id, label },
    latency_by_second,
    windows: windows.map((w) => ({ ...w, status_counts: { "200": w.count } })),
  } as unknown as Report;
}

describe("runShortLabel", () => {
  it("is the hash + last 6 chars of the id", () => {
    expect(runShortLabel("01HXXXXXXXXXXABCDEF")).toBe("#ABCDEF");
  });
});

describe("overlaySeries — 값 없는 초", () => {
  it("p95가 null인 초는 null 그대로 넘긴다", () => {
    const r = {
      run: { id: "aaaaaa111111" },
      windows: [
        { ts_second: 1, count: 3, error_count: 3, p95_ms: 0, status_counts: { "500": 3 } },
        { ts_second: 2, count: 3, error_count: 0, p95_ms: 7, status_counts: { "200": 3 } },
      ],
      latency_by_second: [
        { ts_second: 1, n: 0 },
        { ts_second: 2, n: 3, mean_us: 8000, p95_us: 7000 },
      ],
      sample: { selected: "passed", default: "passed", split: true },
    } as unknown as Report;
    const { rows } = overlaySeries([r], 0, "p95");
    expect(rows.map((row) => row.run0)).toEqual([null, 7]);
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

  it("mean: run마다 각 리포트의 mean_ms", () => {
    const a = rep("aaaaaa111111", [{ ts_second: 1000, count: 10, error_count: 0, p95_ms: 7 }]);
    const b = rep("bbbbbb222222", [{ ts_second: 5000, count: 20, error_count: 0, p95_ms: 9 }]);
    const { rows } = overlaySeries([a, b], 0, "mean");
    expect(rows).toEqual([{ elapsed: 0, run0: 8, run1: 10 }]);
  });

  it("uses run.label when present, falls back to runShortLabel otherwise (run-identity Task 9)", () => {
    const labeled = rep(
      "aaaaaa111111",
      [{ ts_second: 1000, count: 10, error_count: 0, p95_ms: 5 }],
      "커넥션 풀 2배 후",
    );
    const unlabeled = rep("bbbbbb222222", [
      { ts_second: 1000, count: 20, error_count: 0, p95_ms: 9 },
    ]);
    const { runs } = overlaySeries([labeled, unlabeled], 0, "rps");
    expect(runs[0].label).toBe("커넥션 풀 2배 후");
    expect(runs[1].label).toBe("#222222");
  });
});
