import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import type { LatencyStats, Report } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { classifyChange, cutDirection, metricRows } from "../change";
import { mkStats } from "./fixtures";

type Summary = Report["summary"];

const BEFORE = {
  count: 144000,
  errors: 3744,
  rps: 240,
  duration_seconds: 600,
  mean_ms: 840,
  p50_ms: 500,
  p95_ms: 2400,
  p99_ms: 12400,
} as Summary;
const AFTER = {
  count: 144900,
  errors: 435,
  rps: 253,
  duration_seconds: 600,
  mean_ms: 620,
  p50_ms: 400,
  p95_ms: 1600,
  p99_ms: 3100,
} as Summary;
const OPTS = { errorRateReference: false, incomparable: false };

function row(rows: ReturnType<typeof metricRows>, key: string) {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
}

describe("classifyChange", () => {
  it("분류 표", () => {
    expect(classifyChange("lower", 0.026, 0.003, 0.0005)).toBe("better");
    expect(classifyChange("lower", 0.0001, 0.0002, 0.0005)).toBe("similar");
    expect(classifyChange("lower", 1000, 1050, 5)).toBe("similar");
    expect(classifyChange("lower", 1000, 1051, 5)).toBe("worse");
    expect(classifyChange("lower", 3, 7, 5)).toBe("similar");
    expect(classifyChange("lower", 0, 12, 5)).toBe("worse");
    expect(classifyChange("lower", 0, 0, 5)).toBe("similar");
    expect(classifyChange("higher", 240, 253, 0)).toBe("better");
    expect(classifyChange("higher", 240, 200, 0)).toBe("worse");
    expect(classifyChange("neutral", 144000, 180000, 0)).toBe("up");
    expect(classifyChange("neutral", 144000, 100000, 0)).toBe("down");
    expect(classifyChange("neutral", 144000, 144900, 0)).toBe("similar");
  });
});

describe("classifyChange 경계값", () => {
  it("십진수로 정확히 5%는 비슷", () => {
    expect(classifyChange("lower", 0.02, 0.021, 0.0005)).toBe("similar");
    expect(classifyChange("lower", 0.2, 0.21, 0.0005)).toBe("similar");
    expect(classifyChange("lower", 1000, 1050, 5)).toBe("similar");
  });
  it("5%를 조금이라도 넘으면 나빠짐", () => {
    expect(classifyChange("lower", 0.02, 0.0211, 0.0005)).toBe("worse");
  });
  it("차이가 하한과 정확히 같으면 비슷이 아니다", () => {
    expect(classifyChange("lower", 0.0026, 0.0031, 0.0005)).toBe("worse");
    expect(classifyChange("lower", 0.0041, 0.0046, 0.0005)).toBe("worse");
    expect(classifyChange("lower", 0.0044, 0.0049, 0.0005)).toBe("worse");
    expect(classifyChange("lower", 0.0026, 0.003, 0.0005)).toBe("similar");
  });
});

describe("metricRows", () => {
  it("순서와 major", () => {
    const rows = metricRows(BEFORE, AFTER, OPTS);
    expect(rows.map((r) => r.key)).toEqual([
      "error_rate",
      "p99_ms",
      "p95_ms",
      "p90_ms",
      "mean_ms",
      "max_ms",
      "rps",
      "count",
    ]);
    expect(rows.map((r) => r.major)).toEqual([true, true, true, false, true, false, true, false]);
  });

  it("시안 숫자", () => {
    const rows = metricRows(BEFORE, AFTER, OPTS);
    const er = row(rows, "error_rate");
    expect(er.cls).toBe("better");
    expect(er.arrow).toBe("▼");
    expect(er.changeText).toContain("88%");
    expect(er.changeText).toContain("감소");
    expect(er.wordText).toBe("좋아짐");
    expect(er.beforeText).toBe("2.6%");
    expect(er.afterText).toBe("0.3%");
    expect(row(rows, "p99_ms").changeText).toContain("75%");
    expect(row(rows, "p99_ms").changeText).toContain("단축");
    expect(row(rows, "rps").arrow).toBe("▲");
    expect(row(rows, "rps").wordText).toBe("좋아짐");
    expect(row(rows, "count").cls).toBe("similar");
  });

  it("오류율 참고용", () => {
    const er = row(metricRows(BEFORE, AFTER, { ...OPTS, errorRateReference: true }), "error_rate");
    expect(er.cls).toBe("reference");
    expect(er.wordText).toBe("참고용");
    expect(er.arrow).toBe("–");
    expect(er.changeText).toBe("");
  });

  it("비교 불가", () => {
    const rows = metricRows(BEFORE, AFTER, { ...OPTS, incomparable: true });
    for (const r of rows) {
      expect(r.cls).toBe("none");
      expect(r.wordText).toBe("–");
      expect(r.arrow).toBe("–");
    }
    expect(row(rows, "p99_ms").beforeText).toBe("12.4초");
  });

  it("비슷의 글자", () => {
    const small = metricRows({ ...BEFORE, p95_ms: 3 }, { ...AFTER, p95_ms: 7 }, OPTS);
    expect(row(small, "p95_ms").cls).toBe("similar");
    expect(row(small, "p95_ms").changeText).toBe("차이 작음");
    const pct = metricRows({ ...BEFORE, p95_ms: 1000 }, { ...AFTER, p95_ms: 1050 }, OPTS);
    expect(row(pct, "p95_ms").changeText).toBe("±5% 이내");
  });

  it("같은 글자 방지: 응답 시간", () => {
    const worse = row(
      metricRows({ ...BEFORE, p95_ms: 1060 }, { ...AFTER, p95_ms: 1140 }, OPTS),
      "p95_ms",
    );
    expect(worse.cls).toBe("worse");
    expect(worse.beforeText).toBe("1,060ms");
    expect(worse.afterText).toBe("1,140ms");
    const sim = row(
      metricRows({ ...BEFORE, p95_ms: 1060 }, { ...AFTER, p95_ms: 1090 }, OPTS),
      "p95_ms",
    );
    expect(sim.cls).toBe("similar");
    expect(sim.beforeText).toBe("1.1초");
    expect(sim.afterText).toBe("1.1초");
  });

  it("같은 글자 방지: 처리량은 자릿수를 늘린다", () => {
    const r = row(metricRows({ ...BEFORE, rps: 0.51 }, { ...AFTER, rps: 0.54 }, OPTS), "rps");
    expect(r.cls).toBe("better");
    expect(r.beforeText).toBe("0.51건/초");
    expect(r.afterText).toBe("0.54건/초");
  });

  it("같은 글자 방지: 오류율은 자릿수를 늘린다", () => {
    const r = row(
      metricRows(
        { ...BEFORE, count: 100000, errors: 1 },
        { ...BEFORE, count: 100000, errors: 60 },
        OPTS,
      ),
      "error_rate",
    );
    expect(r.cls).toBe("worse");
    expect(r.beforeText).toBe("0.01% 미만");
    expect(r.afterText).toBe("0.06%");
  });

  it("같은 글자 방지: 오류율 일반 경우", () => {
    const r = row(
      metricRows(
        { ...BEFORE, count: 100000, errors: 260 },
        { ...BEFORE, count: 100000, errors: 310 },
        OPTS,
      ),
      "error_rate",
    );
    expect(r.cls).toBe("worse");
    expect(r.beforeText).toBe("0.26%");
    expect(r.afterText).toBe("0.31%");
  });

  it("새로 생김", () => {
    const rows = metricRows({ ...BEFORE, errors: 0 }, { ...AFTER, errors: 725 }, OPTS);
    const er = row(rows, "error_rate");
    expect(er.isNew).toBe(true);
    expect(er.pct).toBeNull();
    expect(er.changeText).toBe("새로 생김");
    for (const r of rows) {
      const all = [r.beforeText, r.afterText, r.changeText, r.wordText].join("|");
      expect(all).not.toMatch(/∞|NaN|Infinity/);
    }
  });

  it("이전 0에서 하한 안쪽으로만 늘면 비슷이고 새로 생김이 아니다", () => {
    const r = row(metricRows({ ...BEFORE, p95_ms: 0 }, { ...AFTER, p95_ms: 3 }, OPTS), "p95_ms");
    expect(r.cls).toBe("similar");
    expect(r.isNew).toBe(false);
    expect(r.changeText).toBe("차이 작음");
    const er = row(
      metricRows(
        { ...BEFORE, count: 100000, errors: 0 },
        { ...BEFORE, count: 100000, errors: 4 },
        OPTS,
      ),
      "error_rate",
    );
    expect(er.cls).toBe("similar");
    expect(er.isNew).toBe(false);
  });

  it("요청 0건인 쪽은 오류율·응답 시간을 '–'로, 건수·처리량은 0으로, 막대는 0", () => {
    const zero = { ...BEFORE, count: 0, errors: 0, rps: 0, mean_ms: 0, p95_ms: 0, p99_ms: 7 };
    const opts = { ...OPTS, incomparable: true };
    const texts = (rows: ReturnType<typeof metricRows>, side: "beforeText" | "afterText") =>
      Object.fromEntries(rows.map((r) => [r.key, r[side]]));

    const left = metricRows(zero, AFTER, opts);
    expect(texts(left, "beforeText")).toEqual({
      error_rate: "–",
      p99_ms: "–",
      p95_ms: "–",
      p90_ms: "–",
      mean_ms: "–",
      max_ms: "–",
      rps: "0건/초",
      count: "0",
    });
    expect(texts(left, "afterText")).toEqual({
      error_rate: "0.3%",
      p99_ms: "3.1초",
      p95_ms: "1.6초",
      p90_ms: "–", // AFTER에는 통계 칸(stats)이 없다
      mean_ms: "0.62초",
      max_ms: "–",
      rps: "253건/초",
      count: "144,900",
    });
    for (const r of left.filter((x) => !x.standardOnly)) {
      expect(r.barBefore, r.key).toBe(0);
      expect(r.barAfter, r.key).toBe(1);
    }

    const right = metricRows(AFTER, zero, opts);
    expect(texts(right, "afterText")).toEqual({
      error_rate: "–",
      p99_ms: "–",
      p95_ms: "–",
      p90_ms: "–",
      mean_ms: "–",
      max_ms: "–",
      rps: "0건/초",
      count: "0",
    });
    expect(row(right, "p99_ms").beforeText).toBe("3.1초");
    for (const r of right.filter((x) => !x.standardOnly)) {
      expect(r.barAfter, r.key).toBe(0);
      expect(r.barBefore, r.key).toBe(1);
    }
  });

  it("통과한 요청이 없는 쪽은 응답 시간 칸을 「–」로, 분류·막대 없음", () => {
    const rows = metricRows(BEFORE, AFTER, {
      ...OPTS,
      latencyMissing: { before: true, after: false },
    });
    for (const k of ["p99_ms", "p95_ms", "mean_ms"]) {
      const r = row(rows, k);
      expect(r.beforeText, k).toBe("–");
      expect(r.cls, k).toBe("none");
      expect(r.arrow, k).toBe("–");
      expect(r.changeText, k).toBe("");
      expect(r.barBefore, k).toBe(0);
    }
    expect(row(rows, "p95_ms").afterText).toBe("1.6초");
    expect(row(rows, "rps").cls).not.toBe("none");
    expect(row(rows, "count").beforeText).toBe("144,000");
  });

  it("완전히 같은 요약", () => {
    for (const r of metricRows(BEFORE, BEFORE, OPTS)) {
      // 통계 칸이 없는 요약은 90%·최대를 잰 적이 없다 — 분류·막대 없음
      expect(r.cls, r.key).toBe(r.standardOnly ? "none" : "similar");
      expect(r.barBefore, r.key).toBe(r.standardOnly ? 0 : 1);
      expect(r.barAfter, r.key).toBe(r.standardOnly ? 0 : 1);
    }
    const zero = { ...BEFORE, count: 0, errors: 0, rps: 0, mean_ms: 0, p95_ms: 0, p99_ms: 0 };
    for (const r of metricRows(zero, zero, OPTS)) {
      expect(r.barBefore).toBe(0);
      expect(r.barAfter).toBe(0);
      expect([r.beforeText, r.afterText, r.changeText].join("|")).not.toMatch(/∞|NaN|Infinity/);
    }
  });
});

const withStats = (
  base: Summary,
  over: Partial<LatencyStats>,
  sum: Partial<Summary> = {},
): Summary => {
  const merged = { ...base, ...sum };
  return {
    ...merged,
    stats: mkStats({
      p95_us: merged.p95_ms * 1000,
      p99_us: merged.p99_ms * 1000,
      mean_us: merged.mean_ms * 1000,
      ...over,
    }),
  } as Summary;
};

describe("cutDirection", () => {
  it("한쪽만 잘리고 방향이 확정일 때만 나쁨·좋음, 그 밖은 null", () => {
    expect(cutDirection(1000, 60_000, false, true)).toBe("worse");
    expect(cutDirection(60_000, 1000, true, false)).toBe("better");
    expect(cutDirection(30_000, 40_000, true, false)).toBeNull();
    expect(cutDirection(40_000, 30_000, false, true)).toBeNull();
    expect(cutDirection(60_000, 60_000, true, true)).toBeNull();
  });
});

describe("metricRows 응답 시간 행 다섯 + 표준판 전용 둘", () => {
  it("행 순서와 standardOnly", () => {
    const rows = metricRows(BEFORE, AFTER, OPTS);
    expect(rows.map((r) => r.key)).toEqual([
      "error_rate",
      "p99_ms",
      "p95_ms",
      "p90_ms",
      "mean_ms",
      "max_ms",
      "rps",
      "count",
    ]);
    expect(rows.filter((r) => r.standardOnly).map((r) => r.key)).toEqual(["p90_ms", "max_ms"]);
    expect(row(rows, "p90_ms").major).toBe(false);
    expect(row(rows, "max_ms").major).toBe(false);
  });

  it("p90 98_000µs → 104_000µs: 나빠짐, 글자는 정확한 ms", () => {
    const rows = metricRows(
      withStats(BEFORE, { p90_us: 98_000 }),
      withStats(AFTER, { p90_us: 104_000 }),
      OPTS,
    );
    const r = row(rows, "p90_ms");
    expect(r.cls).toBe("worse");
    expect(r.beforeText).toBe("98ms");
    expect(r.afterText).toBe("104ms");
  });

  it("p99 정수 60030 ↔ 60030은 중립, 두 글자 다 60초 이상", () => {
    const rows = metricRows(
      { ...BEFORE, p99_ms: 60030 } as Summary,
      { ...AFTER, p99_ms: 60030 } as Summary,
      OPTS,
    );
    const r = row(rows, "p99_ms");
    expect(r.cls).toBe("none");
    expect(r.beforeText).toBe(ko.print.fmt.capSec);
    expect(r.afterText).toBe(ko.print.fmt.capSec);
    expect(r.pct).toBeNull();
    expect(r.arrow).toBe("–");
    expect(r.changeText).toBe("");
    expect(r.wordText).toBe(ko.print.cmp.change.none);
  });

  it("평균: 잘린 쪽(capped) 30000 ↔ 안 잘린 40000은 방향 모름", () => {
    const rows = metricRows(
      withStats(BEFORE, { capped: true }, { mean_ms: 30000 }),
      withStats(AFTER, { capped: false }, { mean_ms: 40000 }),
      OPTS,
    );
    expect(row(rows, "mean_ms").cls).toBe("none");
  });

  it("평균: 1000 → 잘린 30000은 나빠짐, 퍼센트 없이 변화율 계산 불가", () => {
    const rows = metricRows(
      withStats(BEFORE, { capped: false }, { mean_ms: 1000 }),
      withStats(AFTER, { capped: true }, { mean_ms: 30000 }),
      OPTS,
    );
    const r = row(rows, "mean_ms");
    expect(r.cls).toBe("worse");
    expect(r.changeText).toBe(ko.print.cmp.change.cutNoPct);
    expect(r.pct).toBeNull();
    expect(r.isNew).toBe(false);
  });

  it("평균 글자: capped인 쪽만 「이상」", () => {
    const rows = metricRows(
      withStats(BEFORE, { capped: false }),
      withStats(AFTER, { capped: true }, { mean_ms: 30000 }),
      OPTS,
    );
    const r = row(rows, "mean_ms");
    expect(r.afterText).toBe("30.0초 이상");
    expect(r.beforeText).not.toContain("이상");
  });

  it("한쪽 stats 없음: p90·최대 둘 다 중립이고 그쪽 글자는 notMeasured", () => {
    const rows = metricRows(BEFORE, withStats(AFTER, {}), OPTS);
    for (const key of ["p90_ms", "max_ms"]) {
      const r = row(rows, key);
      expect(r.cls).toBe("none");
      expect(r.beforeText).toBe(ko.print.cmp.metric.notMeasured);
      expect(r.afterText).not.toBe(ko.print.cmp.metric.notMeasured);
    }
  });

  it("최대 1_840_000µs → 60_000_000µs: 나빠짐 ▲, 변화율 계산 불가", () => {
    const rows = metricRows(
      withStats(BEFORE, { max_us: 1_840_000 }),
      withStats(AFTER, { max_us: 60_000_000 }),
      OPTS,
    );
    const r = row(rows, "max_ms");
    expect(r.afterText).toBe("60초 이상");
    expect(r.cls).toBe("worse");
    expect(r.arrow).toBe("▲");
    expect(r.changeText).toBe(ko.print.cmp.change.cutNoPct);
    expect(r.pct).toBeNull();
    expect(r.isNew).toBe(false);
  });

  it("최대 60_000_000µs → 1_840_000µs: 좋아짐 ▼", () => {
    const rows = metricRows(
      withStats(BEFORE, { max_us: 60_000_000 }),
      withStats(AFTER, { max_us: 1_840_000 }),
      OPTS,
    );
    const r = row(rows, "max_ms");
    expect(r.cls).toBe("better");
    expect(r.arrow).toBe("▼");
  });

  it("최대 둘 다 60_000_000µs: 중립", () => {
    const rows = metricRows(
      withStats(BEFORE, { max_us: 60_000_000 }),
      withStats(AFTER, { max_us: 60_000_000 }),
      OPTS,
    );
    const r = row(rows, "max_ms");
    expect(r.cls).toBe("none");
    expect(r.pct).toBeNull();
    expect(r.arrow).toBe("–");
    expect(r.changeText).toBe("");
    expect(r.wordText).toBe(ko.print.cmp.change.none);
  });
});

describe("cutDirection ↔ 공유 골든 capped 표(computeDeltaCapped와 같은 방향)", () => {
  type GoldenCapped = {
    metric: string;
    base: number;
    val: number;
    base_cut: boolean;
    val_cut: boolean;
    polarity: "good" | "bad" | "neutral";
    capped: boolean;
  };
  const golden = JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../../testdata/compare_golden.json"),
      "utf8",
    ),
  ) as { expected: { capped: GoldenCapped[] } };
  const cappedRows = golden.expected.capped.filter((r) => r.capped);
  const want = { bad: "worse", good: "better", neutral: null } as const;

  it("잘린 행이 있다(공허 방지)", () => {
    expect(cappedRows.length).toBeGreaterThan(0);
    expect(new Set(cappedRows.map((r) => r.polarity)).size).toBe(3);
  });
  for (const [i, row] of cappedRows.entries()) {
    it(`#${i} ${row.metric} ${row.base}(${row.base_cut}) → ${row.val}(${row.val_cut}): ${row.polarity}`, () => {
      expect(cutDirection(row.base, row.val, row.base_cut, row.val_cut)).toBe(want[row.polarity]);
    });
  }
});

describe("metricRows 99%·95%·평균은 stats의 µs로 계산한다 (R4)", () => {
  const sum = (over: Partial<Summary>, stats?: Partial<LatencyStats>): Summary =>
    ({ ...BEFORE, ...over, ...(stats ? { stats: mkStats(stats) } : {}) }) as Summary;

  it("95% 행은 stats의 µs로 계산한다 — 정수 칸으로는 「비슷」인 차이", () => {
    const before = sum({ p95_ms: 100 }, { p95_us: 100_000 });
    const after = sum({ p95_ms: 105 }, { p95_us: 105_400 });
    const r = row(metricRows(before, after, OPTS), "p95_ms");
    expect(r.cls).toBe("worse");
    expect(r.pct).toBeCloseTo(0.054, 9);
    expect(r.before).toBe(100);
    expect(r.after).toBe(105.4);
  });

  it("99%·평균 행도 stats에서 읽는다", () => {
    const before = sum({ p99_ms: 100, mean_ms: 100 }, { p99_us: 100_000, mean_us: 100_000 });
    const after = sum({ p99_ms: 105, mean_ms: 105 }, { p99_us: 105_400, mean_us: 105_400 });
    const rows = metricRows(before, after, OPTS);
    const p99 = row(rows, "p99_ms");
    expect(p99.cls).toBe("worse");
    expect(p99.after).toBe(105.4);
    const mean = row(rows, "mean_ms");
    expect(mean.cls).toBe("worse");
    expect(mean.after).toBe(105.4);
  });

  it("stats가 한쪽에만 있으면 각 쪽이 제 출처를 쓴다", () => {
    const before = sum({ p95_ms: 100 });
    const after = sum({ p95_ms: 105 }, { p95_us: 105_400 });
    const r = row(metricRows(before, after, OPTS), "p95_ms");
    expect(r.before).toBe(100);
    expect(r.after).toBe(105.4);
    expect(r.cls).toBe("worse");
    expect(Number.isFinite(r.pct)).toBe(true);
  });

  it("stats가 둘 다 없으면 정수 칸 그대로", () => {
    const r = row(metricRows(sum({ p95_ms: 100 }), sum({ p95_ms: 105 }), OPTS), "p95_ms");
    expect(r.cls).toBe("similar");
  });

  it("잘림은 정수 칸이 아니라 stats의 µs로 본다", () => {
    const before = sum({ p95_ms: 1000 }, { p95_us: 1_000_000 });
    const after = sum({ p95_ms: 60000 }, { p95_us: 59_999_000 });
    const r = row(metricRows(before, after, OPTS), "p95_ms");
    expect(r.pct).not.toBeNull();
    expect(r.pct).toBeCloseTo(58.999, 9);
    expect(r.changeText).not.toBe(ko.print.cmp.change.cutNoPct);
  });
});
