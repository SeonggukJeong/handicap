import { describe, it, expect } from "vitest";
import { bySecond } from "../bySecond";
import type { Report } from "../../api/schemas";

type W = { ts_second: number; count: number; error_count: number; p95_ms: number };
type L = { ts_second: number; n: number; mean_us?: number; p95_us?: number; capped?: boolean };

function rep(windows: W[], latency?: L[]): Report {
  // 스키마상 status_counts는 필수 — 창의 요청은 전부 보낸 것으로 둔다.
  return {
    windows: windows.map((w) => ({ ...w, status_counts: { "200": w.count } })),
    ...(latency ? { latency_by_second: latency } : {}),
  } as unknown as Report;
}

describe("bySecond", () => {
  it("count/errors는 창 합, 응답 시간은 latency_by_second의 그 초 항목(µs ÷ 1000)", () => {
    const out = bySecond(
      rep(
        [
          { ts_second: 100, count: 99, error_count: 0, p95_ms: 1 },
          { ts_second: 100, count: 1, error_count: 0, p95_ms: 100 },
        ],
        [{ ts_second: 100, n: 100, mean_us: 1990, p95_us: 1000 }],
      ),
    );
    expect(out).toEqual([
      { ts_second: 100, count: 100, errors: 0, p95_ms: 1, mean_ms: 1.99, capped: false },
    ]);
  });

  it("초 항목 n:0이면 p95_ms·mean_ms는 null (count·errors는 창 합)", () => {
    const out = bySecond(
      rep([{ ts_second: 1, count: 5, error_count: 5, p95_ms: 0 }], [{ ts_second: 1, n: 0 }]),
    );
    expect(out).toEqual([
      { ts_second: 1, count: 5, errors: 5, p95_ms: null, mean_ms: null, capped: false },
    ]);
  });

  it("capped 항목은 capped:true", () => {
    const out = bySecond(
      rep(
        [{ ts_second: 1, count: 2, error_count: 0, p95_ms: 60000 }],
        [{ ts_second: 1, n: 2, mean_us: 60000000, p95_us: 60000000, capped: true }],
      ),
    );
    expect(out[0].capped).toBe(true);
    expect(out[0].p95_ms).toBe(60000);
  });

  it("latency_by_second 키가 없으면 모든 초 null·capped:false", () => {
    const out = bySecond(
      rep([
        { ts_second: 100, count: 5, error_count: 1, p95_ms: 50 },
        { ts_second: 101, count: 2, error_count: 2, p95_ms: 40 },
      ]),
    );
    expect(out).toEqual([
      { ts_second: 100, count: 5, errors: 1, p95_ms: null, mean_ms: null, capped: false },
      { ts_second: 101, count: 2, errors: 2, p95_ms: null, mean_ms: null, capped: false },
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
