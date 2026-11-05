import { describe, expect, it } from "vitest";
import {
  criteriaHasAny,
  criterionName,
  criterionValue,
  expandCriteria,
  kpiCards,
  limitOtherRows,
  matchVerdict,
  otherCriteriaOneLine,
  otherCriteriaRows,
  verdictBox,
  type BoxState,
  type Matched,
  type OtherRow,
} from "../verdict";
import type { Criteria, Report, Verdict } from "../../api/schemas";

type Row = Verdict["criteria"][number];
const vrow = (over: Partial<Row> & { metric: string }): Row => ({
  direction: "max",
  threshold: 0,
  actual: 0,
  passed: true,
  ...over,
});
const verdict = (rows: Row[]): Verdict => ({ passed: rows.every((r) => r.passed), criteria: rows });

const summary = (over: Partial<Report["summary"]> = {}): Report["summary"] => ({
  count: 144000,
  errors: 3720,
  rps: 240,
  duration_seconds: 600,
  mean_ms: 800,
  p50_ms: 500,
  p95_ms: 2400,
  p99_ms: 4000,
  ...over,
});

describe("criteriaHasAny", () => {
  it("has_any_mirrors_server", () => {
    expect(criteriaHasAny(null)).toBe(false);
    expect(criteriaHasAny(undefined)).toBe(false);
    expect(criteriaHasAny({})).toBe(false);
    expect(criteriaHasAny({ rps_warmup_seconds: 5 })).toBe(false);
    expect(criteriaHasAny({ step_criteria: [] })).toBe(false);
    expect(criteriaHasAny({ max_4xx_count: 0 })).toBe(true);
    expect(
      criteriaHasAny({
        step_criteria: [{ metric: "p95_ms", op: "max", threshold: 100, target: "s1" }],
      }),
    ).toBe(true);
  });
});

describe("verdictBox", () => {
  const crit: Criteria = { max_p95_ms: 3000 };
  const v3 = verdict([
    vrow({ metric: "p95_ms" }),
    vrow({ metric: "error_rate" }),
    vrow({ metric: "rps", direction: "min" }),
  ]);
  it("box_states", () => {
    expect(verdictBox({ count: 0, status: "completed", criteria: crit, verdict: v3 })).toEqual({
      kind: "notJudged",
      reason: "zero",
    });
    const f = verdict([
      vrow({ metric: "p95_ms" }),
      vrow({ metric: "error_rate", passed: false }),
      vrow({ metric: "rps", direction: "min" }),
    ]);
    expect(verdictBox({ count: 10, status: "completed", criteria: crit, verdict: f })).toEqual({
      kind: "fail",
      evaluated: 3,
      failed: 1,
    });
    expect(verdictBox({ count: 10, status: "completed", criteria: crit, verdict: v3 })).toEqual({
      kind: "pass",
      evaluated: 3,
    });
    expect(verdictBox({ count: 10, status: "aborted", criteria: crit, verdict: null })).toEqual({
      kind: "notJudged",
      reason: "aborted",
    });
    expect(verdictBox({ count: 10, status: "failed", criteria: crit, verdict: undefined })).toEqual(
      { kind: "notJudged", reason: "failed" },
    );
    expect(verdictBox({ count: 10, status: "completed", criteria: crit, verdict: null })).toEqual({
      kind: "notEvaluable",
    });
    expect(verdictBox({ count: 10, status: "completed", criteria: {}, verdict: null })).toEqual({
      kind: "noCriteria",
    });
  });
});

describe("expandCriteria / matchVerdict", () => {
  const crit: Criteria = {
    max_p95_ms: 3000,
    min_window_rps: 10,
    step_criteria: [{ metric: "error_rate", op: "max", threshold: 0.01, target: "s1" }],
  };
  it("expand order and ops", () => {
    expect(expandCriteria(crit)).toEqual([
      { metric: "p95_ms", op: "max", threshold: 3000, target: null },
      { metric: "min_window_rps", op: "min", threshold: 10, target: null },
      { metric: "error_rate", op: "max", threshold: 0.01, target: "s1" },
    ]);
    expect(expandCriteria({ min_rps: 5, max_p50_ms: 1 }).map((s) => s.metric)).toEqual([
      "p50_ms",
      "rps",
    ]);
    expect(expandCriteria(null)).toEqual([]);
  });
  it("match_by_key", () => {
    const p95 = vrow({ metric: "p95_ms", threshold: 3000, actual: 2400 });
    const er = vrow({
      metric: "error_rate",
      threshold: 0.01,
      target: "s1",
      actual: 0.02,
      passed: false,
    });
    const m = matchVerdict(expandCriteria(crit), verdict([p95, er]));
    expect(m.map((x) => x.row)).toEqual([p95, null, er]);
  });
  it("no verdict -> all null rows", () => {
    expect(matchVerdict(expandCriteria(crit), undefined).map((x) => x.row)).toEqual([
      null,
      null,
      null,
    ]);
  });
  it("duplicate specs consume rows one at a time", () => {
    const specs = expandCriteria({
      step_criteria: [
        { metric: "p95_ms", op: "max", threshold: 100, target: "s1" },
        { metric: "p95_ms", op: "max", threshold: 100, target: "s1" },
      ],
    });
    const r1 = vrow({ metric: "p95_ms", threshold: 100, target: "s1", actual: 1 });
    const m = matchVerdict(specs, verdict([r1]));
    expect(m[0].row).toBe(r1);
    expect(m[1].row).toBeNull();
  });
});

describe("criterionName / criterionValue", () => {
  it("names and particles", () => {
    expect(criterionName("p95_ms")).toEqual({ name: "95% 응답시간", subj: "이" });
    expect(criterionName("4xx_count")).toEqual({ name: "4xx 응답 수", subj: "가" });
    expect(criterionName("min_window_rps")).toEqual({ name: "가장 낮은 1초 처리량", subj: "이" });
    expect(criterionName("weird")).toEqual({ name: "weird", subj: "(이)가" });
  });
  it("values", () => {
    expect(criterionValue("p95_ms", 3000)).toBe("3.0초");
    expect(criterionValue("error_rate", 0.01)).toBe("1.0%");
    expect(criterionValue("rps", 200)).toBe("200건/초");
    expect(criterionValue("5xx_count", 1234)).toBe("1,234건");
    expect(criterionValue("weird", 7)).toBe("7");
  });
});

const matched = (crit: Criteria, rows: Row[]): Matched[] =>
  matchVerdict(expandCriteria(crit), verdict(rows));

describe("kpiCards", () => {
  const crit: Criteria = { max_p95_ms: 3000, max_error_rate: 0.01, min_rps: 200 };
  const rows = [
    vrow({ metric: "p95_ms", threshold: 3000, actual: 2400 }),
    vrow({ metric: "error_rate", threshold: 0.01, actual: 0.026, passed: false }),
    vrow({ metric: "rps", direction: "min", threshold: 200, actual: 240 }),
  ];
  const box: BoxState = { kind: "fail", evaluated: 3, failed: 1 };
  it("kpi_targets", () => {
    const cards = kpiCards(summary(), matched(crit, rows), box);
    expect(cards.map((c) => c.key)).toEqual(["rps", "mean", "p95", "errorRate"]);
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(by.p95.target).toBe("목표 3.0초 이하 ● 달성");
    expect(by.p95.bad).toBe(false);
    expect(by.errorRate.target).toBe("목표 1.0% 이하 ✕ 미달");
    expect(by.errorRate.bad).toBe(true);
    expect(by.mean.target).toBe("목표 없음 (참고값)");
    expect(by.rps.target).toBe("목표 200건/초 이상 ● 달성");
    expect(by.errorRate.explain).toBe("전체 요청 중 실패한 비율. 실패 3,720건 / 전체 144,000건");
    expect(by.rps.explain).toBe("1초에 처리한 요청 수. 클수록 많이 감당합니다.");
    expect(by.mean.explain).toBe("요청을 보내고 답을 받기까지 걸린 시간의 평균.");
    expect(by.p95.explain).toBe("100번 중 95번은 이 시간 안에 답을 받았습니다.");
    expect(by.p95.label).toBe("95% 응답시간");
    expect(by.p95.value).toBe("2.4초");
    expect(by.errorRate.value).toBe("2.6%");
    expect(by.rps.value).toBe("240");
    expect(by.rps.unit).toBe("건/초");
  });
  it("not judged / not evaluable / no row", () => {
    const m = matched(crit, rows);
    const nj = kpiCards(summary(), m, { kind: "notJudged", reason: "aborted" });
    expect(nj.find((c) => c.key === "p95")?.target).toBe("목표 3.0초 이하 (판정 안 함)");
    const ne = kpiCards(summary(), m, { kind: "notEvaluable" });
    expect(ne.find((c) => c.key === "p95")?.target).toBe("목표 3.0초 이하 (평가 불가)");
    const noRow = kpiCards(summary(), matched(crit, [rows[1], rows[2]]), box);
    expect(noRow.find((c) => c.key === "p95")?.target).toBe("목표 3.0초 이하 (평가 불가)");
    const none = kpiCards(summary(), [], { kind: "noCriteria" });
    expect(none.every((c) => c.target === "목표 없음 (참고값)")).toBe(true);
  });
});

describe("otherCriteriaRows", () => {
  const crit: Criteria = {
    max_p95_ms: 3000,
    max_p99_ms: 5000,
    min_window_rps: 10,
    step_criteria: [
      { metric: "p95_ms", op: "max", threshold: 2000, target: "s1" },
      { metric: "rps", op: "min", threshold: 5, target: "s2" },
    ],
  };
  const rows = [
    vrow({ metric: "p95_ms", threshold: 3000, actual: 100 }),
    vrow({ metric: "p99_ms", threshold: 5000, actual: 6000, passed: false }),
    vrow({ metric: "p95_ms", threshold: 2000, target: "s1", actual: 2500, passed: false }),
  ];
  const name = (id: string) => (id === "s1" ? "로그인" : id);
  it("other_rows", () => {
    const out = otherCriteriaRows(
      matched(crit, rows),
      { kind: "fail", evaluated: 3, failed: 2 },
      name,
    );
    expect(out).toEqual([
      { name: "99% 응답시간", target: "5.0초 이하", actual: "6.0초", judgement: "fail" },
      {
        name: "가장 낮은 1초 처리량",
        target: "10건/초 이상",
        actual: "–",
        judgement: "notEvaluable",
      },
      { name: "로그인 · 95% 응답시간", target: "2.0초 이하", actual: "2.5초", judgement: "fail" },
      { name: "s2 · 처리량", target: "5건/초 이상", actual: "–", judgement: "notEvaluable" },
    ]);
  });
  it("notJudged box", () => {
    const out = otherCriteriaRows(
      matched({ max_p99_ms: 5000 }, []),
      { kind: "notJudged", reason: "zero" },
      name,
    );
    expect(out[0].judgement).toBe("notJudged");
  });
});

const orow = (judgement: OtherRow["judgement"], i: number): OtherRow => ({
  name: `r${i}`,
  target: "t",
  actual: "a",
  judgement,
});

describe("limitOtherRows / oneLine", () => {
  const eight = [
    orow("pass", 0),
    orow("fail", 1),
    orow("pass", 2),
    orow("notEvaluable", 3),
    orow("pass", 4),
    orow("fail", 5),
    orow("pass", 6),
    orow("pass", 7),
  ];
  it("limit_rows standard", () => {
    const r = limitOtherRows(eight, "standard");
    expect(r.shown.map((x) => x.name)).toEqual(["r1", "r5", "r3", "r0", "r2", "r4"]);
    expect(r.restLine).toBe("외 2개 기준 모두 달성");
    expect(r.truncated).toBe(true);
  });
  it("standard mixed rest", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => orow("fail", i)),
      orow("pass", 6),
      orow("fail", 7),
      orow("notJudged", 8),
    ];
    const r = limitOtherRows(rows, "standard");
    expect(r.restLine).toBe("외 3개 기준(달성 1 · 미달 1 · 판정 안 함 1) — 부록 참조");
  });
  it("standard small untouched", () => {
    const r = limitOtherRows(eight.slice(0, 6), "standard");
    expect(r.shown).toHaveLength(6);
    expect(r.restLine).toBeNull();
    expect(r.truncated).toBe(false);
  });
  it("summary modes", () => {
    const four = [
      orow("fail", 0),
      orow("fail", 1),
      orow("fail", 2),
      orow("fail", 3),
      orow("pass", 4),
    ];
    const s3 = limitOtherRows(four, "summary3");
    expect(s3.shown).toHaveLength(3);
    expect(s3.restLine).toBe("외 미달 1개 — 표준판 참조");
    expect(s3.truncated).toBe(true);
    const s1 = limitOtherRows(four, "summary1");
    expect(s1.shown).toHaveLength(1);
    expect(s1.restLine).toBe("외 미달 3개 — 표준판 참조");
    const ok = limitOtherRows([orow("pass", 0)], "summary3");
    expect(ok.shown).toEqual([]);
    expect(ok.restLine).toBeNull();
    expect(ok.truncated).toBe(false);
  });
  it("one_line", () => {
    expect(otherCriteriaOneLine(eight)).toBe("그 밖의 기준 8개 중 2개 미달 — 표준판 참조");
    expect(otherCriteriaOneLine([orow("pass", 0)])).toBeNull();
    expect(otherCriteriaOneLine([])).toBeNull();
  });
});
