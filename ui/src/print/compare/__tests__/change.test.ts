import { describe, expect, it } from "vitest";
import type { Report } from "../../../api/schemas";
import { classifyChange, metricRows } from "../change";

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
      "mean_ms",
      "rps",
      "count",
    ]);
    expect(rows.map((r) => r.major)).toEqual([true, true, true, true, true, false]);
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

  it("같은 글자 방지: 응답시간", () => {
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

  it("요청 0건인 쪽은 오류율·응답시간을 '–'로, 건수·처리량은 0으로, 막대는 0", () => {
    const zero = { ...BEFORE, count: 0, errors: 0, rps: 0, mean_ms: 0, p95_ms: 0, p99_ms: 7 };
    const opts = { ...OPTS, incomparable: true };
    const texts = (rows: ReturnType<typeof metricRows>, side: "beforeText" | "afterText") =>
      Object.fromEntries(rows.map((r) => [r.key, r[side]]));

    const left = metricRows(zero, AFTER, opts);
    expect(texts(left, "beforeText")).toEqual({
      error_rate: "–",
      p99_ms: "–",
      p95_ms: "–",
      mean_ms: "–",
      rps: "0건/초",
      count: "0",
    });
    expect(texts(left, "afterText")).toEqual({
      error_rate: "0.3%",
      p99_ms: "3.1초",
      p95_ms: "1.6초",
      mean_ms: "0.62초",
      rps: "253건/초",
      count: "144,900",
    });
    for (const r of left) {
      expect(r.barBefore, r.key).toBe(0);
      expect(r.barAfter, r.key).toBe(1);
    }

    const right = metricRows(AFTER, zero, opts);
    expect(texts(right, "afterText")).toEqual({
      error_rate: "–",
      p99_ms: "–",
      p95_ms: "–",
      mean_ms: "–",
      rps: "0건/초",
      count: "0",
    });
    expect(row(right, "p99_ms").beforeText).toBe("3.1초");
    for (const r of right) {
      expect(r.barAfter, r.key).toBe(0);
      expect(r.barBefore, r.key).toBe(1);
    }
  });

  it("완전히 같은 요약", () => {
    for (const r of metricRows(BEFORE, BEFORE, OPTS)) {
      expect(r.cls).toBe("similar");
      expect(r.barBefore).toBe(1);
      expect(r.barAfter).toBe(1);
    }
    const zero = { ...BEFORE, count: 0, errors: 0, rps: 0, mean_ms: 0, p95_ms: 0, p99_ms: 0 };
    for (const r of metricRows(zero, zero, OPTS)) {
      expect(r.barBefore).toBe(0);
      expect(r.barAfter).toBe(0);
      expect([r.beforeText, r.afterText, r.changeText].join("|")).not.toMatch(/∞|NaN|Infinity/);
    }
  });
});
