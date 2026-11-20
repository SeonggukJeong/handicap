import { describe, expect, it } from "vitest";
import {
  ReportSchema,
  SpeedBandsSchema,
  type Criteria,
  type Report,
  type SpeedBands,
} from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { stepNo } from "../format";
import { stepStatus, type RankedRow } from "../stepStatus";
import type { StepRow } from "../stepTable";
import { expandCriteria, matchVerdict, type Matched } from "../verdict";
import { ALLOWED, buildSpeedModel, exceedsAllowance, type Seg } from "../speedBands";

const threeBand = {
  slow_ms: 3000,
  basis: "p95",
  own: false,
  fast: 10,
  within: 5,
  over: 2,
};
const twoBand = { ...threeBand, slow_ms: 800, fast: null };

const base = {
  run: {
    id: "R",
    scenario_id: "S",
    status: "completed",
    profile: {},
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: x\nsteps: []\n",
  summary: {
    count: 5,
    errors: 0,
    rps: 2.5,
    duration_seconds: 2,
    mean_ms: 22,
    p50_ms: 20,
    p95_ms: 30,
    p99_ms: 30,
  },
  windows: [],
  steps: [],
  status_distribution: { "200": 5 },
  dropped: 0,
};

describe("SpeedBandsSchema", () => {
  it("fast: null 행과 단계 행(step_id 포함)을 통과시킨다", () => {
    const r = SpeedBandsSchema.safeParse({
      overall: twoBand,
      steps: [{ step_id: "A", ...threeBand, own: true }],
    });
    expect(r.success).toBe(true);
  });

  it("모르는 키·모르는 basis·fast 누락을 거부한다", () => {
    expect(
      SpeedBandsSchema.safeParse({ overall: { ...threeBand, extra: 1 }, steps: [] }).success,
    ).toBe(false);
    expect(
      SpeedBandsSchema.safeParse({ overall: { ...threeBand, basis: "p90" }, steps: [] }).success,
    ).toBe(false);
    const noFast: Record<string, unknown> = { ...threeBand };
    delete noFast.fast;
    expect(SpeedBandsSchema.safeParse({ overall: noFast, steps: [] }).success).toBe(false);
    expect(
      SpeedBandsSchema.safeParse({
        overall: threeBand,
        steps: [{ step_id: "A", ...threeBand, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it("ReportSchema는 speed_bands 부재·존재 모두 통과", () => {
    expect(ReportSchema.safeParse(base).success).toBe(true);
    const withBands = { ...base, speed_bands: { overall: threeBand, steps: [] } };
    const r = ReportSchema.safeParse(withBands);
    expect(r.success).toBe(true);
    expect(r.success && r.data.speed_bands?.overall.over).toBe(2);
  });
});

// ── 구간 모델 ─────────────────────────────────────────────────────────────

type BandIn = {
  slow_ms: number;
  basis: "p95" | "p99" | "p50" | "default";
  own?: boolean;
  fast: number | null;
  within: number;
  over: number;
};
const band = (b: BandIn) => ({ own: false, ...b });

function rr(
  index: number,
  name: string,
  o: { count?: number; errorCount?: number; executed?: boolean; notSent?: number },
  criteria: Criteria | null,
): RankedRow {
  const base: StepRow = {
    index,
    no: stepNo(index),
    stepId: `s${index + 1}`,
    name,
    requestLine: null,
    executed: o.executed ?? true,
    count: o.count ?? 1000,
    errorCount: o.errorCount ?? 0,
    p95Ms: 100,
    perCode: [],
    cells: {},
    residual: 0,
    notSent: o.notSent ?? 0,
    residualUncertain: false,
    factsKnown: true,
  };
  return { ...base, status: stepStatus(base, criteria) };
}

/** failing: 미달 행 키 — run 수준은 metric, 단계 기준은 `${target}:${metric}`. null = 서버 판정 없음. */
function matchedOf(criteria: Criteria | null, failing: string[] | null): Matched[] {
  const specs = expandCriteria(criteria);
  if (failing === null) return matchVerdict(specs, null);
  const rows = specs.map((s) => ({
    metric: s.metric,
    direction: s.op,
    threshold: s.threshold,
    actual: 0,
    passed: !failing.includes(s.target ? `${s.target}:${s.metric}` : s.metric),
    target: s.target ?? undefined,
  }));
  return matchVerdict(specs, { passed: failing.length === 0, criteria: rows });
}

const summ = (count: number, errors: number): Report["summary"] => ({
  count,
  errors,
  rps: 10,
  duration_seconds: 10,
  mean_ms: 20,
  p50_ms: 10,
  p95_ms: 30,
  p99_ms: 40,
});

const joined = (segs: Seg[]): string => segs.map((g) => g.text).join("");
const SP = ko.print.speed;

function build(a: {
  bands: SpeedBands;
  ranked: RankedRow[];
  summary: Report["summary"];
  criteria: Criteria | null;
  failing: string[] | null;
  anyNotSent?: boolean;
}) {
  return buildSpeedModel({
    bands: a.bands,
    ranked: a.ranked,
    summary: a.summary,
    matched: matchedOf(a.criteria, a.failing),
    criteria: a.criteria,
    anyNotSent: a.anyNotSent ?? false,
  });
}

describe("exceedsAllowance (컨트롤러 exceeds_allowance와 같은 표)", () => {
  it.each([
    ["p95", 5, 100, false],
    ["p95", 6, 100, true],
    ["p99", 1, 100, false],
    ["p99", 2, 100, true],
    ["p50", 50, 100, false],
    ["p50", 51, 100, true],
    ["default", 100, 100, false],
  ] as const)("%s over=%i total=%i → %s", (basis, over, total, want) => {
    expect(exceedsAllowance(basis, over, total)).toBe(want);
  });

  it("ALLOWED는 글자용 허용 몫", () => {
    expect(ALLOWED).toEqual({ p95: 0.05, p99: 0.01, p50: 0.5 });
  });
});

describe("buildSpeedModel", () => {
  it("경우 1: 고른 표·p95 3000·미달", () => {
    const criteria: Criteria = { max_p95_ms: 3000, max_error_rate: 0.01 };
    const p95 = (fast: number, within: number, over: number) =>
      band({ slow_ms: 3000, basis: "p95", fast, within, over });
    const bands: SpeedBands = {
      overall: p95(7240, 2060, 700),
      steps: [
        { step_id: "s1", ...p95(960, 40, 0) },
        { step_id: "s2", ...p95(820, 180, 0) },
        { step_id: "s3", ...p95(740, 258, 2) },
        { step_id: "s4", ...p95(220, 460, 320) },
        { step_id: "s5", ...p95(880, 90, 30) },
      ],
    };
    const ranked = [
      rr(0, "로그인", {}, criteria),
      rr(1, "민원 목록", {}, criteria),
      rr(2, "민원 상세", { errorCount: 3 }, criteria),
      rr(3, "첨부 업로드", {}, criteria),
      rr(4, "신청 제출", { errorCount: 266 }, criteria),
    ];
    const m = build({
      bands,
      ranked,
      summary: summ(10000, 540),
      criteria,
      failing: ["p95_ms", "error_rate"],
    });
    expect(m.twoBand).toBe(false);
    expect(m.head).toEqual({
      fast: "1초 미만",
      within: "1초–3초",
      over: "3초 초과",
      overSub: "기준 넘음",
    });
    expect(m.legend).toEqual([
      { band: "fast", text: "1초 미만" },
      { band: "within", text: "1초–3초" },
      { band: "over", text: "3초 초과 (기준 넘음)" },
    ]);
    expect(m.rows.map((r) => r.key)).toEqual(["s1", "s2", "s3", "s4", "s5", "total"]);
    expect(m.rows[0].label).toBe("① 로그인");
    expect(m.rows[0].bar).toEqual([
      { band: "fast", pct: 96 },
      { band: "within", pct: 4 },
    ]);
    expect(m.rows[0].over).toMatchObject({ text: "0.0%", muted: true, mark: "none" });
    expect(m.rows[2].over).toMatchObject({ text: "0.2%", mark: "none" });
    expect(m.rows[2].fail).toMatchObject({ text: "0.3%", mark: "none", glyph: "" });
    expect(m.rows[3].over).toMatchObject({ text: "32.0%", mark: "warn", glyph: "▲" });
    expect(m.rows[4].fail).toMatchObject({ text: "26.6%", mark: "bad", glyph: "✕" });
    expect(m.rows[4].rowBad).toBe(true);
    expect(m.rows[3].rowBad).toBe(false);
    const total = m.rows[5];
    expect(total.total).toBe(true);
    expect(total.label).toBe("전체 요청");
    expect(total.over).toMatchObject({ text: "7.0%", mark: "bad", glyph: "" });
    expect(total.fail).toMatchObject({ text: "5.4%", mark: "bad", glyph: "" });
    expect(total.ownNote).toBeNull();
    expect(m.rule?.fail).toBe(true);
    expect(m.ruleBoxFail).toBe(true);
    const rule = joined(m.rule?.segs ?? []);
    expect(rule).toBe(
      "기준 「95% 응답시간 3,000ms 이하」는 3초 초과가 5% 이하여야 통과입니다. 이번 측정은 전체 요청의 7.00%가 3초를 넘어 이 기준은 미달입니다.",
    );
    expect(rule).not.toContain("넘어 미달");
    expect(m.rule?.segs.find((g) => g.text === "이 기준은 미달")).toMatchObject({
      strong: true,
      bad: true,
    });
    expect(m.stepRules).toEqual([]);
    expect(m.notes).toHaveLength(1);
    expect(joined(m.notes[0])).toBe(
      "※ 막대에는 실패한 응답의 시간도 들어 있습니다. ✕ ⑤ 신청 제출은(는) 요청의 26.6%가 실패했고, 실패한 응답은 금방 돌아오는 경우가 많아 막대가 빠르게 보일 수 있습니다. 어떤 응답 코드였는지는 2절 표를 보십시오.",
    );
    expect(m.notes[0].find((g) => g.text === "✕ ⑤ 신청 제출")?.strong).toBe(true);
  });

  it("경우 2: 섞인 표 — 자기 기준 단계", () => {
    const criteria: Criteria = {
      max_p95_ms: 3000,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 5000, target: "s4" }],
    };
    const p95 = (fast: number, within: number, over: number) =>
      band({ slow_ms: 3000, basis: "p95", fast, within, over });
    const bands: SpeedBands = {
      overall: p95(740, 229, 31),
      steps: [
        { step_id: "s1", ...p95(970, 30, 0) },
        {
          step_id: "s4",
          ...band({ slow_ms: 5000, basis: "p95", own: true, fast: 200, within: 660, over: 140 }),
        },
      ],
    };
    const ranked = [
      rr(0, "로그인", {}, criteria),
      rr(1, "민원 목록", {}, criteria),
      rr(2, "민원 상세", {}, criteria),
      rr(3, "첨부 업로드", {}, criteria),
    ];
    const m = build({
      bands,
      ranked,
      summary: summ(1000, 0),
      criteria,
      failing: ["s4:p95_ms"],
    });
    expect(m.head).toEqual({
      fast: "1초 미만",
      within: "1초–기준",
      over: "기준 초과",
      overSub: "3초 (따로 적힌 단계 제외)",
    });
    expect(m.legend.map((l) => l.text)).toEqual(["1초 미만", "1초–기준", "기준 초과"]);
    const s4 = m.rows[3];
    expect(s4.ownNote).toBe("이 단계 기준 5초");
    expect(s4.over).toMatchObject({ text: "14.0%", mark: "warn", glyph: "▲" });
    expect(m.rows[0].ownNote).toBeNull();
    expect(m.stepRules).toHaveLength(1);
    expect(joined(m.stepRules[0])).toBe(
      "단계 기준 「④ 첨부 업로드 95% 응답시간 5,000ms 이하」: 5초 초과 14.00% — 미달.",
    );
    const lastSeg = m.stepRules[0].find((g) => g.text === "미달");
    expect(lastSeg).toMatchObject({ strong: true, bad: true });
    expect(m.rule?.fail).toBe(false);
    expect(joined(m.rule?.segs ?? [])).toContain("3.10%가 3초를 넘어 이 기준은 통과입니다.");
    expect(m.ruleBoxFail).toBe(false);
  });

  it("경우 3: 기준 없음", () => {
    const p = (fast: number, within: number, over: number) =>
      band({ slow_ms: 3000, basis: "default", fast, within, over });
    const bands: SpeedBands = {
      overall: p(590, 250, 160),
      steps: [
        { step_id: "s1", ...p(960, 40, 0) },
        { step_id: "s2", ...p(220, 460, 320) },
      ],
    };
    const ranked = [rr(0, "로그인", {}, null), rr(1, "첨부 업로드", {}, null)];
    const m = build({ bands, ranked, summary: summ(1000, 0), criteria: null, failing: null });
    expect(m.rule).toBeNull();
    expect(m.ruleBoxFail).toBe(false);
    expect(m.head).toEqual({
      fast: "1초 미만",
      within: "1초–3초",
      over: "3초 초과",
      overSub: null,
    });
    expect(m.rows.every((r) => r.over.mark === "none" && r.over.glyph === "")).toBe(true);
    expect(m.rows[1].over.text).toBe("32.0%");
    expect(m.legend[2].text).toBe("3초 초과");
    expect(m.notes[0]).toEqual([{ text: SP.noteDefault }]);
    expect(SP.noteDefault).toBe(
      "※ 이 측정에는 응답 시간 기준이 없어 1초·3초로 나눠 보였습니다(판정과 무관).",
    );
  });

  it("경우 4: 두 구간", () => {
    const criteria: Criteria = { max_p95_ms: 800 };
    const p = (within: number, over: number) =>
      band({ slow_ms: 800, basis: "p95", fast: null, within, over });
    const bands: SpeedBands = {
      overall: p(956, 44),
      steps: [
        { step_id: "s1", ...p(988, 12) },
        { step_id: "s2", ...p(910, 90) },
      ],
    };
    const ranked = [rr(0, "조회", {}, criteria), rr(1, "저장", { errorCount: 4 }, criteria)];
    const m = build({ bands, ranked, summary: summ(1000, 2), criteria, failing: [] });
    expect(m.twoBand).toBe(true);
    expect(m.head).toEqual({
      fast: null,
      within: "800ms 이내",
      over: "800ms 초과",
      overSub: "기준 넘음",
    });
    expect(m.legend).toEqual([
      { band: "fast", text: "800ms 이내" },
      { band: "over", text: "800ms 초과 (기준 넘음)" },
    ]);
    expect(m.rows[0].fast).toBeNull();
    expect(m.rows[0].merged).toBe(false);
    expect(m.rows[0].within.text).toBe("98.8%");
    expect(m.rows[0].bar).toEqual([
      { band: "fast", pct: 98.8 },
      { band: "over", pct: 1.2 },
    ]);
    expect(m.rows[1].over).toMatchObject({ text: "9.0%", mark: "warn", glyph: "▲" });
    expect(joined(m.rule?.segs ?? [])).toContain("800ms 초과가 5% 이하여야 통과입니다");
    expect(joined(m.rule?.segs ?? [])).toContain("4.40%가 800ms를 넘어 이 기준은 통과입니다.");
  });

  it("경우 6: 아슬아슬한 값과 기준 없는 실패", () => {
    const criteria: Criteria = { max_p95_ms: 3000 };
    const p = (fast: number, within: number, over: number) =>
      band({ slow_ms: 3000, basis: "p95", fast, within, over });
    const bands: SpeedBands = {
      overall: p(7830, 1820, 350),
      steps: [
        { step_id: "s1", ...p(7000, 2504, 496) },
        { step_id: "s2", ...p(6800, 2696, 504) },
        { step_id: "s3", ...p(9700, 260, 40) },
      ],
    };
    const ranked = [
      rr(0, "목록 조회", { count: 10000 }, criteria),
      rr(1, "상세 조회", { count: 1000, errorCount: 3 }, criteria),
      rr(2, "신청 제출", { count: 1000, errorCount: 900 }, criteria),
    ];
    const m = build({
      bands,
      ranked,
      summary: summ(10000, 3010),
      criteria,
      failing: [],
    });
    expect(m.rows[0].over).toMatchObject({ text: "4.96%", mark: "none", glyph: "" });
    expect(m.rows[1].over).toMatchObject({ text: "5.04%", mark: "warn", glyph: "▲" });
    expect(m.rows[1].fail).toMatchObject({ text: "0.3%", mark: "warn", glyph: "▲" });
    expect(m.rows[1].rowBad).toBe(false);
    expect(m.rows[2].fail).toMatchObject({ text: "90.0%", mark: "warn", glyph: "▲" });
    expect(m.rows[3].fail).toMatchObject({ text: "30.1%", mark: "none" });
    expect(m.rows[3].over).toMatchObject({ text: "3.5%", mark: "none" });
    expect(joined(m.notes[0])).toContain("▲ ③ 신청 제출은(는) 요청의 90.0%가 실패했고");
    expect(joined(m.notes[0])).not.toContain("② 상세 조회");
    expect(joined(m.notes[0])).not.toContain("외 ");
    expect(joined(m.rule?.segs ?? [])).toContain("3.50%가 3초를 넘어 이 기준은 통과입니다.");
  });

  it("경우 7: 단계 기준만 있는 run", () => {
    const criteria: Criteria = {
      max_error_rate: 0.006999999999999999,
      step_criteria: [
        { metric: "p95_ms", op: "max", threshold: 800, target: "s1" },
        { metric: "p95_ms", op: "max", threshold: 5000, target: "s2" },
      ],
    };
    const d = (fast: number, within: number, over: number) =>
      band({ slow_ms: 3000, basis: "default", fast, within, over });
    const bands: SpeedBands = {
      overall: d(610, 362, 28),
      steps: [
        {
          step_id: "s1",
          ...band({ slow_ms: 800, basis: "p95", own: true, fast: null, within: 910, over: 90 }),
        },
        {
          step_id: "s2",
          ...band({ slow_ms: 5000, basis: "p95", own: true, fast: 200, within: 772, over: 28 }),
        },
        { step_id: "s3", ...d(740, 245, 15) },
        { step_id: "s4", ...d(600, 380, 20) },
        { step_id: "s5", ...d(880, 110, 10) },
      ],
    };
    const ranked = [
      rr(0, "로그인", {}, criteria),
      rr(1, "첨부 업로드", {}, criteria),
      rr(2, "민원 상세", {}, criteria),
      rr(3, "신청 제출", { errorCount: 7 }, criteria),
      rr(4, "결과 확인", { errorCount: 400 }, criteria),
      rr(5, "로그아웃", { executed: false, count: 0 }, criteria),
    ];
    const m = build({
      bands,
      ranked,
      summary: summ(1000, 4),
      criteria,
      failing: ["s1:p95_ms"],
      anyNotSent: true,
    });
    expect(m.twoBand).toBe(false);
    expect(m.head.overSub).toBe("기준 없는 단계는 3초");
    expect(m.head.within).toBe("1초–기준");
    expect(m.rule).toBeNull();
    expect(m.ruleBoxFail).toBe(false);
    expect(m.stepRules.map(joined)).toEqual([
      "단계 기준 「① 로그인 95% 응답시간 800ms 이하」: 800ms 초과 9.00% — 미달.",
      "단계 기준 「② 첨부 업로드 95% 응답시간 5,000ms 이하」: 5초 초과 2.80% — 통과.",
    ]);
    const s1 = m.rows[0];
    expect(s1.merged).toBe(true);
    expect(s1.fast).toBeNull();
    expect(s1.within.text).toBe("800ms 이내 91.0%");
    expect(s1.bar).toEqual([
      { band: "fast", pct: 91 },
      { band: "over", pct: 9 },
    ]);
    expect(s1.ownNote).toBe("이 단계 기준 800ms");
    expect(s1.over).toMatchObject({ text: "9.0%", mark: "warn", glyph: "▲" });
    expect(m.rows[1].over).toMatchObject({ text: "2.8%", mark: "none" });
    expect(m.rows[2].over).toMatchObject({ text: "1.5%", mark: "none" });
    const s4 = m.rows[3];
    expect(s4.fail).toMatchObject({ text: "0.7%", mark: "bad", glyph: "✕", star: true });
    expect(s4.rowBad).toBe(true);
    expect(m.rows[4].fail).toMatchObject({ text: "40.0%", mark: "bad", glyph: "✕", star: false });
    const s6 = m.rows[5];
    expect(s6.bar).toBeNull();
    expect(s6.fast).toMatchObject({ text: "—" });
    expect(s6.within.text).toBe("—");
    expect(s6.over.text).toBe("—");
    expect(s6.fail.text).toBe("—");
    expect(m.notes[0]).toEqual([{ text: SP.noteDefaultMixed }]);
    expect(joined(m.notes[1])).toContain("✕ ⑤ 결과 확인은(는) 요청의 40.0%가 실패했고");
    expect(m.notes[2]).toEqual([{ text: SP.noteNotSent }]);
    expect(m.notes[3]).toEqual([{ text: SP.noteStar }]);
    expect(m.notes).toHaveLength(4);
  });

  it("서버 판정 없는 run(중단): 낱말 없는 안내 줄, ▲는 유지", () => {
    const criteria: Criteria = {
      max_p95_ms: 3000,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 5000, target: "s2" }],
    };
    const bands: SpeedBands = {
      overall: band({ slow_ms: 3000, basis: "p95", fast: 7000, within: 2300, over: 700 }),
      steps: [
        {
          step_id: "s2",
          ...band({ slow_ms: 5000, basis: "p95", own: true, fast: 200, within: 660, over: 140 }),
        },
      ],
    };
    const ranked = [rr(0, "로그인", {}, criteria), rr(1, "첨부 업로드", {}, criteria)];
    const m = build({ bands, ranked, summary: summ(10000, 0), criteria, failing: null });
    const rule = joined(m.rule?.segs ?? []);
    expect(rule.endsWith("전체 요청의 7.00%가 3초를 넘었습니다.")).toBe(true);
    expect(rule).not.toContain("이 기준은");
    expect(rule).not.toContain("미달");
    expect(m.rule?.fail).toBe(false);
    expect(m.ruleBoxFail).toBe(false);
    expect(m.rows[2].over).toMatchObject({ text: "7.0%", mark: "none", glyph: "" });
    expect(m.rows[1].over).toMatchObject({ mark: "warn", glyph: "▲" });
    const sr = joined(m.stepRules[0]);
    expect(sr.endsWith("5초 초과 14.00%.")).toBe(true);
    expect(sr).not.toContain("미달");
    expect(sr).not.toContain("통과");
    expect(m.stepRules[0].some((g) => g.bad)).toBe(false);
  });

  it("단계 줄 순서: 미달 먼저", () => {
    const criteria: Criteria = {
      step_criteria: [
        { metric: "p95_ms", op: "max", threshold: 5000, target: "s1" },
        { metric: "p95_ms", op: "max", threshold: 5000, target: "s2" },
      ],
    };
    const own = (over: number) =>
      band({ slow_ms: 5000, basis: "p95", own: true, fast: 100, within: 900 - over, over });
    const bands: SpeedBands = {
      overall: band({ slow_ms: 3000, basis: "default", fast: 200, within: 1700, over: 100 }),
      steps: [
        { step_id: "s1", ...own(10) },
        { step_id: "s2", ...own(140) },
      ],
    };
    const ranked = [rr(0, "통과 단계", {}, criteria), rr(1, "미달 단계", {}, criteria)];
    const m = build({
      bands,
      ranked,
      summary: summ(2000, 0),
      criteria,
      failing: ["s2:p95_ms"],
    });
    expect(joined(m.stepRules[0])).toContain("② 미달 단계");
    expect(joined(m.stepRules[1])).toContain("① 통과 단계");
  });

  it("두 구간 섞인 표 (run 800ms + 단계 500ms)", () => {
    const criteria: Criteria = {
      max_p95_ms: 800,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 500, target: "s2" }],
    };
    const bands: SpeedBands = {
      overall: band({ slow_ms: 800, basis: "p95", fast: null, within: 960, over: 40 }),
      steps: [
        {
          step_id: "s1",
          ...band({ slow_ms: 800, basis: "p95", fast: null, within: 990, over: 10 }),
        },
        {
          step_id: "s2",
          ...band({ slow_ms: 500, basis: "p95", own: true, fast: null, within: 900, over: 100 }),
        },
      ],
    };
    const ranked = [rr(0, "조회", {}, criteria), rr(1, "저장", {}, criteria)];
    const m = build({ bands, ranked, summary: summ(1000, 0), criteria, failing: [] });
    expect(m.twoBand).toBe(true);
    expect(m.head).toEqual({
      fast: null,
      within: "기준 이내",
      over: "기준 초과",
      overSub: "800ms (따로 적힌 단계 제외)",
    });
    expect(m.legend).toEqual([
      { band: "fast", text: "기준 이내" },
      { band: "over", text: "기준 초과" },
    ]);
    expect(m.rows.every((r) => r.bar?.[0].band === "fast")).toBe(true);
  });

  it("자기 기준이 run 값과 같으면 고른 표", () => {
    const criteria: Criteria = {
      max_p95_ms: 3000,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 3000, target: "s1" }],
    };
    const bands: SpeedBands = {
      overall: band({ slow_ms: 3000, basis: "p95", fast: 700, within: 250, over: 50 }),
      steps: [
        {
          step_id: "s1",
          ...band({ slow_ms: 3000, basis: "p95", own: true, fast: 700, within: 250, over: 50 }),
        },
      ],
    };
    const m = build({
      bands,
      ranked: [rr(0, "로그인", {}, criteria)],
      summary: summ(1000, 0),
      criteria,
      failing: [],
    });
    expect(m.head.over).toBe("3초 초과");
    expect(m.head.overSub).toBe("기준 넘음");
    expect(m.rows[0].ownNote).toBe("이 단계 기준 3초");
  });

  it("실패 칸은 오류율 기준과 구분되게", () => {
    const criteria: Criteria = { max_error_rate: 0.01 };
    const p = band({ slow_ms: 3000, basis: "default", fast: 9000, within: 1000, over: 0 });
    const bands: SpeedBands = {
      overall: p,
      steps: [
        { step_id: "s1", ...p },
        { step_id: "s2", ...p },
      ],
    };
    const ranked = [
      rr(0, "넘음", { count: 10000, errorCount: 104 }, criteria),
      rr(1, "안 넘음", { count: 10000, errorCount: 96 }, criteria),
    ];
    const m = build({ bands, ranked, summary: summ(20000, 200), criteria, failing: [] });
    expect(m.rows[0].fail).toMatchObject({ text: "1.04%", mark: "bad", glyph: "✕" });
    expect(m.rows[1].fail).toMatchObject({ text: "0.96%", mark: "none", glyph: "" });
  });

  it("단계 기준 6개 → 5줄 + 나머지 줄", () => {
    const criteria: Criteria = {
      step_criteria: [0, 1, 2, 3, 4, 5].map((i) => ({
        metric: "p95_ms",
        op: "max" as const,
        threshold: 5000,
        target: `s${i + 1}`,
      })),
    };
    const own = band({ slow_ms: 5000, basis: "p95", own: true, fast: 100, within: 880, over: 20 });
    const bands: SpeedBands = {
      overall: band({ slow_ms: 3000, basis: "default", fast: 600, within: 360, over: 120 }),
      steps: [0, 1, 2, 3, 4, 5].map((i) => ({ step_id: `s${i + 1}`, ...own })),
    };
    const ranked = [0, 1, 2, 3, 4, 5].map((i) => rr(i, `단계${i}`, {}, criteria));
    const m = build({ bands, ranked, summary: summ(6000, 0), criteria, failing: [] });
    expect(m.stepRules).toHaveLength(5);
    expect(m.stepRulesRest).toBe("그 밖의 단계 기준 1건은 「그 밖의 기준」 표를 보십시오.");
    const bandsFive: SpeedBands = { ...bands, steps: bands.steps.slice(0, 5) };
    const five = build({
      bands: bandsFive,
      ranked: ranked.slice(0, 5),
      summary: summ(6000, 0),
      criteria,
      failing: [],
    });
    expect(five.stepRules).toHaveLength(5);
    expect(five.stepRulesRest).toBeNull();
  });

  it("표본 없는 단계·분모 0에서 NaN이 없다", () => {
    const criteria: Criteria = { max_p95_ms: 3000, max_error_rate: 0.01 };
    const zero = band({ slow_ms: 3000, basis: "p95", fast: 0, within: 0, over: 0 });
    const bands: SpeedBands = {
      overall: zero,
      steps: [{ step_id: "s1", ...zero }],
    };
    const ranked = [
      rr(0, "빈 단계", { count: 0 }, criteria),
      rr(1, "표본 없음", { count: 0, errorCount: 0, notSent: 5 }, criteria),
    ];
    const m = build({ bands, ranked, summary: summ(0, 0), criteria, failing: null });
    const bad: string[] = [];
    const scan = (v: unknown, path: string) => {
      if (typeof v === "number" && !Number.isFinite(v)) bad.push(path);
      else if (typeof v === "string" && /NaN|Infinity/.test(v)) bad.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
      else if (v && typeof v === "object")
        Object.entries(v).forEach(([k, x]) => scan(x, `${path}.${k}`));
    };
    scan(m, "model");
    expect(bad).toEqual([]);
    expect(m.rows[0].bar).toBeNull();
    expect(m.rows[2].bar).toBeNull();
    expect(m.rows[1].within.text).toBe("—");
    expect(m.rows[2].fail.text).toBe("—");
  });

  it("경계 0·소수 기준 글자", () => {
    const criteria: Criteria = {
      max_p95_ms: 0,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 0, target: "s1" }],
    };
    const bands: SpeedBands = {
      overall: band({ slow_ms: 0, basis: "p95", fast: null, within: 0, over: 100 }),
      steps: [
        {
          step_id: "s1",
          ...band({ slow_ms: 0, basis: "p95", own: true, fast: null, within: 0, over: 100 }),
        },
      ],
    };
    const m = build({
      bands,
      ranked: [rr(0, "로그인", {}, criteria)],
      summary: summ(100, 0),
      criteria,
      failing: [],
    });
    expect(m.head.over).toBe("0ms 초과");
    expect(m.rows[0].ownNote).toBe("이 단계 기준 0ms");

    const frac: Criteria = {
      max_p95_ms: 3000,
      step_criteria: [{ metric: "p95_ms", op: "max", threshold: 2999.5, target: "s1" }],
    };
    const b2: SpeedBands = {
      overall: band({ slow_ms: 3000, basis: "p95", fast: 900, within: 90, over: 10 }),
      steps: [
        {
          step_id: "s1",
          ...band({ slow_ms: 2999, basis: "p95", own: true, fast: 900, within: 90, over: 10 }),
        },
      ],
    };
    const m2 = build({
      bands: b2,
      ranked: [rr(0, "로그인", {}, frac)],
      summary: summ(1000, 0),
      criteria: frac,
      failing: [],
    });
    expect(m2.rows[0].ownNote).toBe("이 단계 기준 2,999ms");
    expect(joined(m2.stepRules[0])).toContain("2,999.5ms 이하」: 2,999ms 초과");
  });

  it("이름 각주의 실패 비율은 실패 칸과 같은 글자", () => {
    const criteria: Criteria = { max_p95_ms: 3000, max_error_rate: 0.1 };
    const p = band({ slow_ms: 3000, basis: "p95", fast: 9000, within: 1000, over: 0 });
    const m = build({
      bands: { overall: p, steps: [{ step_id: "s1", ...p }] },
      ranked: [rr(0, "신청 제출", { count: 10000, errorCount: 1004 }, criteria)],
      summary: summ(10000, 1004),
      criteria,
      failing: [],
    });
    expect(m.rows[0].fail).toMatchObject({ text: "10.04%", mark: "bad", glyph: "✕" });
    const note = joined(m.notes[0]);
    expect(note).toContain("요청의 10.04%가 실패했고");
    expect(note).not.toContain("10.0%가");
  });

  it("각주에 이름이 오를 단계가 둘이면 큰 쪽 + 외 1단계", () => {
    const criteria: Criteria = { max_p95_ms: 3000, max_error_rate: 0.1 };
    const p = band({ slow_ms: 3000, basis: "p95", fast: 9000, within: 1000, over: 0 });
    const m = build({
      bands: {
        overall: p,
        steps: [
          { step_id: "s1", ...p },
          { step_id: "s2", ...p },
        ],
      },
      ranked: [
        rr(0, "작은 실패", { count: 10000, errorCount: 1004 }, criteria),
        rr(1, "큰 실패", { count: 10000, errorCount: 3000 }, criteria),
      ],
      summary: summ(20000, 4004),
      criteria,
      failing: [],
    });
    const note = joined(m.notes[0]);
    expect(note).toContain("✕ ② 큰 실패은(는) 요청의 30.0%가 실패했고");
    expect(note).not.toContain("① 작은 실패");
    expect(note).toContain("외 1단계도 실패 비율이 10% 이상입니다.");
  });

  it("p50만 건 run: 허용 50%·정수식 2*over > total", () => {
    const criteria: Criteria = { max_p50_ms: 2000 };
    const p = (within: number, over: number) =>
      band({ slow_ms: 2000, basis: "p50", fast: 1000 - within - over, within, over });
    const m = build({
      bands: {
        overall: p(100, 500),
        steps: [
          { step_id: "s1", ...p(100, 500) },
          { step_id: "s2", ...p(100, 501) },
        ],
      },
      ranked: [rr(0, "가", {}, criteria), rr(1, "나", {}, criteria)],
      summary: summ(2000, 0),
      criteria,
      failing: [],
    });
    const rule = joined(m.rule?.segs ?? []);
    expect(rule).toContain("50% 응답시간 2,000ms 이하");
    expect(rule).toContain("2초 초과가 50% 이하여야 통과");
    expect(m.rows[0].over.mark).toBe("none");
    expect(m.rows[1].over).toMatchObject({ mark: "warn", glyph: "▲" });
  });

  it("p99만 건 run: 허용 1%·정수식 100*over > total", () => {
    const criteria: Criteria = { max_p99_ms: 3000 };
    const p = (over: number) =>
      band({ slow_ms: 3000, basis: "p99", fast: 900 - over, within: 100, over });
    const m = build({
      bands: {
        overall: p(10),
        steps: [
          { step_id: "s1", ...p(10) },
          { step_id: "s2", ...p(11) },
        ],
      },
      ranked: [rr(0, "가", {}, criteria), rr(1, "나", {}, criteria)],
      summary: summ(2000, 0),
      criteria,
      failing: [],
    });
    const rule = joined(m.rule?.segs ?? []);
    expect(rule).toContain("99% 응답시간 3,000ms 이하");
    expect(rule).toContain("3초 초과가 1% 이하여야 통과");
    expect(m.rows[0].over.mark).toBe("none");
    expect(m.rows[1].over).toMatchObject({ mark: "warn", glyph: "▲" });
  });
});
