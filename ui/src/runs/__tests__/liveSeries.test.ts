import { describe, expect, it } from "vitest";
import { liveBySecond } from "../liveSeries";
import type { WindowSummary } from "../../api/schemas";

// 기대 ts 값은 전부 하드코딩 리터럴 — LIVE_TRIM_TRAILING_SECONDS import 금지(자기참조 공허 차단, spec §7).
function w(ts_second: number, step_id: string, count: number, error_count: number): WindowSummary {
  return { ts_second, step_id, count, error_count, status_counts: {} };
}

describe("liveBySecond", () => {
  it("같은 초의 스텝 간 count·error를 합산하고 ts 오름차순으로 정렬한다", () => {
    const out = liveBySecond([
      w(101, "b", 5, 1),
      w(100, "a", 3, 0),
      w(100, "b", 7, 2),
      w(102, "a", 4, 0), // max_ts — 트림으로 제외
    ]);
    expect(out).toEqual([
      { ts_second: 100, count: 10, errors: 2 },
      { ts_second: 101, count: 5, errors: 1 },
    ]);
  });

  it("후미 트림: max_ts 초는 표시에서 제외된다", () => {
    const out = liveBySecond([w(100, "a", 1, 0), w(101, "a", 2, 0)]);
    expect(out).toEqual([{ ts_second: 100, count: 1, errors: 0 }]);
  });

  it("빈 입력은 빈 배열", () => {
    expect(liveBySecond([])).toEqual([]);
  });

  it("단일 초 입력은 전량 트림되어 빈 배열", () => {
    expect(liveBySecond([w(100, "a", 9, 3)])).toEqual([]);
  });

  it("무-트래픽 중간 초는 채우지 않는다 (리포트 bySecond와 동일 정책)", () => {
    const out = liveBySecond([w(100, "a", 1, 0), w(105, "a", 2, 1), w(106, "a", 3, 0)]);
    expect(out).toEqual([
      { ts_second: 100, count: 1, errors: 0 },
      { ts_second: 105, count: 2, errors: 1 },
    ]);
  });
});
