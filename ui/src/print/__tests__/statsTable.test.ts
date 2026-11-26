import { describe, expect, it } from "vitest";
import type { LatencyStats, Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { buildStatsModel, printStatText } from "../statsTable";
import type { StepRow } from "../stepTable";

const DASH = ko.print.fmt.noTarget;

const stats = (over: Partial<LatencyStats> = {}): LatencyStats => ({
  min_us: 31_007,
  mean_us: 52_118,
  max_us: 402_175,
  stdev_us: 19_204,
  p50_us: 47_039,
  p90_us: 71_039,
  p95_us: 88_063,
  p99_us: 140_031,
  capped: false,
  ...over,
});

const row = (index: number, over: Partial<StepRow> = {}): StepRow => ({
  index,
  no: String(index + 1),
  stepId: `s${index}`,
  name: `단계${index}`,
  requestLine: null,
  executed: true,
  count: 100,
  errorCount: 0,
  p95Ms: 88,
  perCode: [],
  cells: {},
  residual: 0,
  residualUncertain: false,
  notSent: 0,
  factsKnown: true,
  ...over,
});

const summary = (over: Partial<Report["summary"]> = {}): Report["summary"] => ({
  count: 300,
  errors: 0,
  rps: 5,
  duration_seconds: 60,
  mean_ms: 52,
  p50_ms: 47,
  p95_ms: 88,
  p99_ms: 140,
  ...over,
});

const build = (
  rows: StepRow[],
  o: { summary?: Report["summary"]; sample?: "passed" | "all"; hasTime?: boolean } = {},
) =>
  buildStatsModel({
    rows,
    summary: o.summary ?? summary({ stats: stats() }),
    sample: o.sample ?? "passed",
    hasTime: o.hasTime ?? true,
  });

describe("printStatText", () => {
  it("1ms 미만은 µs, 그 밖은 floor/round ms, 60초 칸은 ko 글자", () => {
    expect(printStatText(350, "floor")).toBe("350µs");
    expect(printStatText(999, "round")).toBe("999µs");
    expect(printStatText(1499, "floor")).toBe("1");
    expect(printStatText(1500, "round")).toBe("2");
    expect(printStatText(1_840_000, "floor")).toBe("1,840");
    expect(printStatText(2_410_880, "round")).toBe("2,411");
    expect(printStatText(60_000_000, "floor")).toBe(ko.report.stats.capped);
  });
});

describe("buildStatsModel", () => {
  const A = row(0, { stats: stats() });
  const B = row(1, {
    stats: stats({ max_us: 60_000_000, capped: true, mean_us: 61_000_000 }),
  });
  const C = row(2, { count: 5, errorCount: 5, stats: stats() });

  it("A 행의 여덟 칸·이름·순서", () => {
    const m = build([A])!;
    expect(m.rows[0].label).toBe("1 단계0");
    expect(m.rows[0].cells).toEqual(["31", "52", "47", "71", "88", "140", "402", "19"]);
  });

  it("B: 최대 칸이 60초 칸 글자이고 안내가 켜진다", () => {
    const m = build([A, B])!;
    expect(m.rows[1].cells[6]).toBe(ko.report.stats.capped);
    expect(m.cappedNote).toBe(true);
  });

  it("C: 통과한 요청이 없으면 stats가 실려 있어도 「–」 여덟 칸", () => {
    const m = build([A, C])!;
    expect(m.rows[1].cells).toEqual(Array(8).fill(DASH));
  });

  it("합계 행 이름·캡션(표본별)", () => {
    const m = build([A])!;
    expect(m.total.label).toBe(ko.print.stats.total);
    expect(m.total.label).toBe("모든 단계");
    expect(m.total.cells).toEqual(["31", "52", "47", "71", "88", "140", "402", "19"]);
    expect(m.caption).toBe(ko.print.stats.caption("통과한 요청"));
    expect(build([A], { sample: "all" })!.caption).toBe(ko.print.stats.caption("모든 요청"));
  });

  it("60초 칸이 없으면 안내 없음", () => {
    expect(build([A])!.cappedNote).toBe(false);
  });

  it("평균만 하한(stats.capped, 모든 칸 60초 미만)이어도 안내가 켜진다", () => {
    const m = build([row(0, { stats: stats({ capped: true, mean_us: 30_007_796 }) })])!;
    expect(m.rows[0].cells.every((c) => c !== ko.report.stats.capped)).toBe(true);
    expect(m.cappedNote).toBe(true);
  });

  it("그려지지 않은 「–」 행의 capped는 안내를 켜지 않는다", () => {
    const m = build([A, row(1, { count: 5, errorCount: 5, stats: stats({ capped: true }) })])!;
    expect(m.cappedNote).toBe(false);
  });

  it("합계가 시간 없음(hasTime 거짓)이면 합계 행은 「–」", () => {
    const m = build([A], { hasTime: false })!;
    expect(m.total.cells).toEqual(Array(8).fill(DASH));
    expect(m.rows[0].cells[0]).toBe("31");
  });

  it("스텝에 stats 없음 + 합계 stats 없음이면 null (절 없음)", () => {
    expect(build([row(0), row(1)], { summary: summary() })).toBeNull();
  });

  it("스텝 stats는 없어도 합계에 있으면 표는 있고 그 스텝은 「–」", () => {
    const m = build([row(0)])!;
    expect(m.rows[0].cells).toEqual(Array(8).fill(DASH));
    expect(m.total.cells[0]).toBe("31");
  });
});
