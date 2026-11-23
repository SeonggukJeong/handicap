import { describe, expect, it } from "vitest";
import type { Report, ReportSetup } from "../../../api/schemas";
import { partsText } from "../../../i18n/lineParts";
import { metricRows } from "../change";
import { biggestCodeChange, hasStar, stepPairs } from "../errorCells";
import { buildFairness } from "../fairness";
import { buildHeadline, cmpSummaryLines, type CmpSummaryLine } from "../headline";
import type { BoxState } from "../../verdict";
import { baseProfile } from "./fixtures";
import { sceneModel, summaryOf, type SceneRun } from "./scene";

type Over = Partial<Report["summary"]>;

const BEFORE: Over = {
  count: 1000,
  errors: 26,
  rps: 240,
  mean_ms: 840,
  p95_ms: 2400,
  p99_ms: 3000,
};
const AFTER_GOOD: Over = {
  count: 1000,
  errors: 3,
  rps: 252,
  mean_ms: 620,
  p95_ms: 1600,
  p99_ms: 1800,
};

const fail: BoxState = { kind: "fail", evaluated: 3, failed: 1 };
const pass: BoxState = { kind: "pass", evaluated: 3 };
const noCrit: BoxState = { kind: "noCriteria" };

function head(
  before: Over,
  after: Over,
  o: {
    beforeBox?: BoxState;
    afterBox?: BoxState;
    criteriaSame?: boolean;
    anyDiff?: boolean;
    incomparable?: boolean;
    errorRateReference?: boolean;
  } = {},
) {
  const rows = metricRows(summaryOf(before), summaryOf(after), {
    errorRateReference: o.errorRateReference ?? false,
    incomparable: o.incomparable ?? false,
  });
  return buildHeadline({
    rows,
    beforeBox: o.beforeBox ?? noCrit,
    afterBox: o.afterBox ?? noCrit,
    criteriaSame: o.criteriaSame ?? true,
    anyDiff: o.anyDiff ?? false,
    incomparable: o.incomparable ?? false,
  });
}

describe("buildHeadline 구조화 개수", () => {
  const nums = (c: NonNullable<ReturnType<typeof head>["counts"]>) => [
    c.total,
    c.better,
    c.similar,
    c.worse,
  ];

  it("counts는 countsLine과 같은 숫자에서 나온다", () => {
    const h = head(BEFORE, AFTER_GOOD);
    expect(h.counts).toEqual({ total: 5, better: 4, similar: 1, worse: 0 });
    expect(h.verdictChange).toBeNull();
    const c = h.counts!;
    expect(h.countsLine).toContain(`${c.total}개 중`);
    expect(h.countsLine).toContain(`${c.better}개 좋아짐`);
    expect(h.countsLine).toContain(`${c.similar}개 비슷`);
    expect(h.countsLine).toContain(`${c.worse}개 나빠짐`);
  });

  it("판정 신호가 있으면 verdictChange에 두 글리프, 없으면 null", () => {
    const good = head(BEFORE, BEFORE, { beforeBox: fail, afterBox: pass });
    expect(good.verdictChange).toEqual({ before: "✕", after: "●" });
    expect(good.countsLine.endsWith("판정 ✕ → ●")).toBe(true);
    expect(nums(good.counts!)).toEqual([5, 0, 5, 0]);
    const bad = head(BEFORE, BEFORE, { beforeBox: pass, afterBox: fail });
    expect(bad.verdictChange).toEqual({ before: "●", after: "✕" });
    const none = head(BEFORE, BEFORE, { beforeBox: fail, afterBox: pass, criteriaSame: false });
    expect(none.verdictChange).toBeNull();
  });

  it("비교 불가면 counts와 verdictChange가 null이고 글은 그대로", () => {
    const h = head(BEFORE, AFTER_GOOD, { incomparable: true });
    expect(h.counts).toBeNull();
    expect(h.verdictChange).toBeNull();
    expect(h.countsLine).toBe("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다");
  });
});

describe("buildHeadline (spec §6.3 표)", () => {
  it("좋음 4·비슷 1·나쁨 0 → 개선", () => {
    const h = head(BEFORE, AFTER_GOOD);
    expect(h.answer).toBe("improved");
    expect(h.glyph).toBe("▼");
    expect(h.word).toBe("개선");
    expect(h.countsLine).toContain("5개 중");
    expect(h.countsLine).toContain("4개 좋아짐");
    expect(h.countsLine).toContain("1개 비슷");
    expect(h.countsLine).toContain("0개 나빠짐");
    expect(h.countsLine).not.toContain("판정");
    expect(h.reference).toBe(false);
  });

  it("나쁨만 → 악화", () => {
    const h = head(BEFORE, {
      ...BEFORE,
      errors: 90,
      p95_ms: 4000,
      p99_ms: 5000,
      mean_ms: 1500,
      rps: 100,
    });
    expect(h.answer).toBe("worsened");
    expect(h.glyph).toBe("▲");
    expect(h.countsLine).toContain("0개 좋아짐");
    expect(h.countsLine).toContain("5개 나빠짐");
  });

  it("좋음 1 + 나쁨 1 → 엇갈림", () => {
    const h = head(BEFORE, { ...BEFORE, p95_ms: 1000, rps: 100 });
    expect(h.answer).toBe("mixed");
    expect(h.glyph).toBe("◆");
    expect(h.word).toBe("엇갈림");
  });

  it("모두 비슷 → 비슷", () => {
    const h = head(BEFORE, BEFORE);
    expect(h.answer).toBe("similar");
    expect(h.glyph).toBe("=");
    expect(h.countsLine).toContain("5개 비슷");
  });

  it("지표가 모두 비슷해도 판정 ✕→●이고 기준이 같으면 개선, 끝에 판정 변화가 붙는다", () => {
    const h = head(BEFORE, BEFORE, { beforeBox: fail, afterBox: pass });
    expect(h.answer).toBe("improved");
    expect(h.verdictSignal).toBe("good");
    expect(h.countsLine.endsWith("판정 ✕ → ●")).toBe(true);
    expect(h.countsLine).toContain("0개 좋아짐");
  });

  it("기준이 다르면 판정 변화는 신호가 아니다", () => {
    const h = head(BEFORE, BEFORE, { beforeBox: fail, afterBox: pass, criteriaSame: false });
    expect(h.answer).toBe("similar");
    expect(h.verdictSignal).toBeNull();
    expect(h.countsLine).not.toContain("판정");
  });

  it("● → ✕(기준 같음)에 지표가 좋아지면 엇갈림", () => {
    const h = head(
      BEFORE,
      { ...BEFORE, p95_ms: 1000, mean_ms: 400 },
      { beforeBox: pass, afterBox: fail },
    );
    expect(h.answer).toBe("mixed");
    expect(h.verdictSignal).toBe("bad");
    expect(h.countsLine.endsWith("판정 ● → ✕")).toBe(true);
    expect(h.countsLine).toContain("2개 좋아짐");
  });

  it("한쪽이 기준 미설정이면 신호가 없다", () => {
    const h = head(BEFORE, BEFORE, { beforeBox: noCrit, afterBox: pass });
    expect(h.verdictSignal).toBeNull();
    expect(h.answer).toBe("similar");
  });

  it("오류율이 참고용이면 4개 중이고 그 행은 어느 개수에도 들어가지 않는다", () => {
    const h = head(BEFORE, AFTER_GOOD, { errorRateReference: true });
    expect(h.countsLine).toContain("4개 중");
    expect(h.countsLine).toContain("3개 좋아짐");
    expect(h.countsLine).toContain("1개 비슷");
    expect(h.countsLine).toContain("0개 나빠짐");
  });

  it("anyDiff면 방향(answer)은 그대로 두고 큰 글자만 ※ 참고용", () => {
    const h = head(BEFORE, AFTER_GOOD, { anyDiff: true });
    expect(h.reference).toBe(true);
    expect(h.answer).toBe("improved");
    expect(h.glyph).toBe("※");
    expect(h.word).toBe("참고용");
  });

  it("anyDiff + 나빠짐도 같은 큰 글자, answer는 worsened", () => {
    const h = head(
      BEFORE,
      { ...BEFORE, errors: 90, p95_ms: 4000, p99_ms: 5000, mean_ms: 1500, rps: 100 },
      { anyDiff: true },
    );
    expect(h.answer).toBe("worsened");
    expect(h.glyph).toBe("※");
    expect(h.word).toBe("참고용");
    expect(h.countsLine).toContain("5개 나빠짐");
  });

  it("anyDiff가 아니면 기존 기호와 낱말", () => {
    const h = head(BEFORE, AFTER_GOOD);
    expect([h.glyph, h.word]).toEqual(["▼", "개선"]);
  });

  it("비교 불가는 조건이 달라도 – 비교 불가", () => {
    const h = head(
      BEFORE,
      { ...BEFORE, count: 0, errors: 0 },
      { incomparable: true, anyDiff: true },
    );
    expect(h.glyph).toBe("–");
    expect(h.word).toBe("비교 불가");
  });

  it("지표가 모두 비슷해도 판정 ● → ✕(기준 같음)면 악화, 끝에 판정 변화가 붙는다", () => {
    const h = head(BEFORE, BEFORE, { beforeBox: pass, afterBox: fail });
    expect(h.answer).toBe("worsened");
    expect(h.glyph).toBe("▲");
    expect(h.verdictSignal).toBe("bad");
    expect(h.countsLine).toContain("0개 나빠짐");
    expect(h.countsLine.endsWith("판정 ● → ✕")).toBe(true);
  });

  it("이전이 기준 미설정이고 이후가 ✕여도 신호가 없고 지표만으로 답한다", () => {
    const h = head(BEFORE, AFTER_GOOD, { beforeBox: noCrit, afterBox: fail });
    expect(h.verdictSignal).toBeNull();
    expect(h.answer).toBe("improved");
    expect(h.countsLine).not.toContain("판정");
  });

  it("✕ → ✕, ● → ●는 신호가 없다", () => {
    for (const box of [fail, pass]) {
      const h = head(BEFORE, BEFORE, { beforeBox: box, afterBox: box });
      expect(h.verdictSignal).toBeNull();
      expect(h.answer).toBe("similar");
    }
  });

  it("판정 불가였던 이전이 이후 ●가 돼도 신호가 없다", () => {
    for (const before of [
      { kind: "notJudged", reason: "failed" } as BoxState,
      { kind: "notEvaluable" } as BoxState,
    ]) {
      const h = head(BEFORE, BEFORE, { beforeBox: before, afterBox: pass });
      expect(h.verdictSignal).toBeNull();
      expect(h.answer).toBe("similar");
    }
  });

  it("비교 불가", () => {
    const h = head(BEFORE, { ...BEFORE, count: 0, errors: 0 }, { incomparable: true });
    expect(h.answer).toBe("incomparable");
    expect(h.glyph).toBe("–");
    expect(h.word).toBe("비교 불가");
    expect(h.verdictSignal).toBeNull();
  });
});

const critProfile = (extra: Record<string, unknown> = {}) => ({
  ...baseProfile,
  criteria: { max_p95_ms: 3000 },
  ...extra,
});
const crit = (passed: boolean) => ({
  metric: "p95_ms",
  direction: "max" as const,
  threshold: 3000,
  actual: passed ? 1600 : 3500,
  passed,
});
const failV = { passed: false, criteria: [crit(false), crit(true), crit(true)] };
const passV = { passed: true, criteria: [crit(true), crit(true), crit(true)] };

const CODE_STEPS = [{ id: "s1", name: "접수", assert: [200] }];

function scene(b: Partial<SceneRun>, a: Partial<SceneRun>) {
  const before = sceneModel({ id: "bbbbbb", profile: critProfile(), ...b });
  const after = sceneModel({ id: "aaaaaa", profile: critProfile(), ...a });
  const pairs = stepPairs(before, after);
  const incomparable = before.report.summary.count === 0 || after.report.summary.count === 0;
  const rows = metricRows(before.report.summary, after.report.summary, {
    errorRateReference: hasStar(pairs),
    incomparable,
  });
  const fairness = buildFairness(before, after);
  const headline = buildHeadline({
    rows,
    beforeBox: before.box,
    afterBox: after.box,
    criteriaSame: fairness.criteriaSame,
    anyDiff: fairness.anyDiff,
    incomparable,
  });
  const lines = cmpSummaryLines({
    headline,
    rows,
    before,
    after,
    fairness,
    codeChange: biggestCodeChange(pairs),
  });
  expectTextFromParts(lines);
  const byId = (id: number) => lines.find((l) => l.id === id)?.text;
  const partsOf = (id: number) => lines.find((l) => l.id === id)?.parts;
  return { lines, byId, partsOf, headline, rows };
}

const setupWith = (failed: number): ReportSetup => ({ ok: 10, failed, interrupted: 0, steps: [] });

function setupScene(
  b: { setup?: ReportSetup; profile?: Record<string, unknown>; answer?: "same" | "incomparable" },
  a: { setup?: ReportSetup; profile?: Record<string, unknown> },
) {
  const incomparable = b.answer === "incomparable";
  const zero = { ...BEFORE, count: 0, errors: 0 };
  const before = sceneModel({
    id: "bbbbbb",
    profile: b.profile ?? critProfile(),
    summary: incomparable ? zero : BEFORE,
    ...(incomparable ? { rep: [] } : {}),
  });
  const after = sceneModel({ id: "aaaaaa", profile: a.profile ?? critProfile(), summary: BEFORE });
  const withSetup = (m: typeof before, s?: ReportSetup) =>
    s ? { ...m, report: { ...m.report, setup: s } } : m;
  const bm = withSetup(before, b.setup);
  const am = withSetup(after, a.setup);
  expect(bm.profile === null).toBe(b.profile?.vus === "x");
  expect(am.profile === null).toBe(a.profile?.vus === "x");
  const pairs = stepPairs(bm, am);
  const rows = metricRows(bm.report.summary, am.report.summary, {
    errorRateReference: hasStar(pairs),
    incomparable,
  });
  const fairness = buildFairness(bm, am);
  const headline = buildHeadline({
    rows,
    beforeBox: bm.box,
    afterBox: am.box,
    criteriaSame: fairness.criteriaSame,
    anyDiff: fairness.anyDiff,
    incomparable,
  });
  const lines = cmpSummaryLines({
    headline,
    rows,
    before: bm,
    after: am,
    fairness,
    codeChange: biggestCodeChange(pairs),
  });
  expectTextFromParts(lines);
  return lines;
}

const OPEN = () => critProfile({ target_rps: 50 });
const last = (l: CmpSummaryLine[]) => l[l.length - 1];

describe("cmpSummaryLines 5번 줄 (준비 실패 수 차이)", () => {
  it("둘 다 closed: 늘었습니다 / 줄었습니다", () => {
    const up = last(setupScene({ setup: setupWith(0) }, { setup: setupWith(3) }));
    expect(up.id).toBe(5);
    expect(up.text).toBe("준비에 실패한 사용자가 0명에서 3명으로 늘었습니다.");
    const down = last(setupScene({ setup: setupWith(5) }, { setup: setupWith(2) }));
    expect(down.id).toBe(5);
    expect(down.text).toBe("준비에 실패한 사용자가 5명에서 2명으로 줄었습니다.");
  });

  it("둘 다 open: 슬롯/개", () => {
    const l = last(
      setupScene(
        { setup: setupWith(1), profile: OPEN() },
        { setup: setupWith(4), profile: OPEN() },
      ),
    );
    expect(l.id).toBe(5);
    expect(l.text).toBe("준비에 실패한 슬롯이 1개에서 4개로 늘었습니다.");
  });

  it("부하 방식이 다르면 단위 없는 문장, 조사는 숫자 끝소리", () => {
    const t = (x: number, y: number) =>
      last(
        setupScene(
          { setup: setupWith(x), profile: critProfile() },
          { setup: setupWith(y), profile: OPEN() },
        ),
      ).text;
    expect(t(0, 3)).toBe("준비 실패가 0에서 3으로 늘었습니다.");
    expect(t(1, 6)).toBe("준비 실패가 1에서 6으로 늘었습니다.");
    expect(t(2, 0)).toBe("준비 실패가 2에서 0으로 줄었습니다.");
  });

  it("프로필을 읽지 못한 run이 한쪽이라도 있으면 단위 없는 문장", () => {
    const l = last(
      setupScene({ setup: setupWith(0), profile: { vus: "x" } }, { setup: setupWith(3) }),
    );
    expect(l.id).toBe(5);
    expect(l.text).toBe("준비 실패가 0에서 3으로 늘었습니다.");
    const r = last(
      setupScene({ setup: setupWith(0) }, { setup: setupWith(3), profile: { vus: "x" } }),
    );
    expect(r.text).toBe("준비 실패가 0에서 3으로 늘었습니다.");
  });

  it("실패 수가 같거나 한쪽만 준비가 있거나 비교 불가면 5번 줄이 없다", () => {
    const ids = (l: CmpSummaryLine[]) => l.map((x) => x.id);
    expect(ids(setupScene({ setup: setupWith(2) }, { setup: setupWith(2) }))).not.toContain(5);
    expect(ids(setupScene({ setup: setupWith(0) }, {}))).not.toContain(5);
    expect(ids(setupScene({}, { setup: setupWith(3) }))).not.toContain(5);
    expect(
      ids(setupScene({ setup: setupWith(0), answer: "incomparable" }, { setup: setupWith(3) })),
    ).not.toContain(5);
  });

  it("5번 줄의 parts를 이으면 text와 같다", () => {
    const l = last(setupScene({ setup: setupWith(0) }, { setup: setupWith(3) }));
    expect(partsText(l.parts)).toBe(l.text);
  });

  it("준비 없는 두 run의 기존 줄은 그대로", () => {
    const s = scene({ summary: BEFORE, verdict: failV }, { summary: AFTER_GOOD, verdict: passV });
    expect(s.lines.map((l) => [l.id, l.text])).toEqual([
      [1, "판정이 ✕ 부적합 → ● 적합으로 바뀌었습니다. 기준 3개를 모두 지켰습니다."],
      [2, "오류율 2.6% → 0.3% (88% 감소)."],
    ]);
  });
});

/** 모든 줄의 text는 parts를 이어 붙인 글과 같다(문장마다 한 번씩, 이 파일의 모든 장면에서). */
function expectTextFromParts(lines: CmpSummaryLine[]) {
  for (const l of lines) {
    expect(l.parts.length, `line ${l.id}`).toBeGreaterThan(0);
    expect(l.text, `line ${l.id}`).toBe(l.parts.map((p) => p.text).join(""));
  }
}

describe("cmpSummaryLines 1번 줄 (판정)", () => {
  it("✕ → ●: 바뀌었고 기준 3개를 모두 지켰다", () => {
    const s = scene({ summary: BEFORE, verdict: failV }, { summary: AFTER_GOOD, verdict: passV });
    const t = s.byId(1) ?? "";
    expect(t).toContain("✕ 부적합");
    expect(t).toContain("● 적합");
    expect(t).toContain("바뀌었습니다");
    expect(t).toContain("기준 3개를 모두 지켰습니다");
    expect(t).toBe("판정이 ✕ 부적합 → ● 적합으로 바뀌었습니다. 기준 3개를 모두 지켰습니다.");
  });

  it("같은 판정이면 두 측정 모두라고 적는다", () => {
    const s = scene({ summary: BEFORE, verdict: passV }, { summary: AFTER_GOOD, verdict: passV });
    expect(s.byId(1)).toContain("두 측정 모두 ● 적합");
  });

  it("한쪽이 기준 미설정이면 낱말 그대로", () => {
    const s = scene(
      { summary: BEFORE, profile: { ...baseProfile } },
      { summary: AFTER_GOOD, verdict: passV },
    );
    const t = s.byId(1) ?? "";
    expect(t.startsWith("판정은 이전 기준 미설정, 이후 ● 적합입니다.")).toBe(true);
    expect(t).toContain("기준 3개를 모두 지켰습니다.");
  });
});

describe("cmpSummaryLines 2·3번 줄", () => {
  it("오류율이 최고 순위면 수치와 건수 변화 문장이 이어진다", () => {
    const s = scene(
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9000, "503": 2880 }, errors: 2880 }],
        summary: BEFORE,
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }],
        summary: AFTER_GOOD,
      },
    );
    const t = s.byId(2) ?? "";
    expect(t).toContain("오류율");
    expect(t).toContain("2.6%");
    expect(t).toContain("0.3%");
    expect(t).toContain("88%");
    expect(t).toContain("2,880건이 0건이 되었습니다");
    expect(t).toContain("503");
  });

  it("줄었음: 312건이 24건으로 줄었습니다", () => {
    const s = scene(
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9000, "502": 312 }, errors: 312 }],
        summary: BEFORE,
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9900, "502": 24 }, errors: 24 }],
        summary: AFTER_GOOD,
      },
    );
    expect(s.byId(2)).toContain("312건이 24건으로 줄었습니다");
  });

  it("이전 0건이던 코드가 생겼으면 새로 생겼습니다", () => {
    const s = scene(
      { steps: CODE_STEPS, summary: BEFORE },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 990, "502": 10 }, errors: 10 }],
        summary: { ...AFTER_GOOD, errors: 3 },
      },
    );
    expect(s.byId(2)).toContain("10건이 새로 생겼습니다");
  });

  it("'새로 생김'(이전 0)이 변화율 큰 행보다 앞선다", () => {
    const s = scene({ summary: { ...BEFORE, rps: 0 } }, { summary: { ...AFTER_GOOD, rps: 100 } });
    const t = s.byId(2) ?? "";
    expect(t).toContain("처리량");
    expect(t).toContain("새로 생김");
    expect(t).not.toContain("오류율");
  });

  it("오류율이 참고용이면 후보에서 빠져 다음 순위 지표가 나온다", () => {
    const s = scene(
      {
        steps: [{ id: "s1", name: "접수" }],
        rep: [{ id: "s1", counts: { "200": 9400, "502": 600 }, errors: 0 }],
        summary: BEFORE,
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }],
        summary: AFTER_GOOD,
      },
    );
    expect(s.rows[0].cls).toBe("reference");
    const t = s.byId(2) ?? "";
    expect(t).not.toContain("오류율");
    expect(t).toContain("99% 응답시간");
  });

  it("답이 비슷이면 2번 줄이 없다", () => {
    const s = scene({ summary: BEFORE }, { summary: BEFORE });
    expect(s.byId(2)).toBeUndefined();
    expect(s.byId(3)).toBeUndefined();
  });

  it("개선이 판정 변화뿐이면 2번 줄이 없다", () => {
    const s = scene({ summary: BEFORE, verdict: failV }, { summary: BEFORE, verdict: passV });
    expect(s.headline.answer).toBe("improved");
    expect(s.byId(2)).toBeUndefined();
  });

  it("엇갈림이면 3번 줄에 나빠진 지표 하나", () => {
    const s = scene({ summary: BEFORE }, { summary: { ...BEFORE, errors: 3, p95_ms: 2800 } });
    expect(s.headline.answer).toBe("mixed");
    expect(s.byId(3)).toBe("반면 95% 응답시간은 2.4초 → 2.8초로 늘었습니다.");
  });

  it("오류율이 나빠진 엇갈림: 2번은 좋아진 지표, 3번은 오류율", () => {
    const s = scene({ summary: BEFORE }, { summary: { ...BEFORE, errors: 90, p95_ms: 1000 } });
    expect(s.byId(2)).toContain("95% 응답시간");
    expect(s.byId(3)).toContain("반면 오류율은");
    expect(s.byId(3)).toContain("늘었습니다");
  });

  it("나쁨이 판정 변화뿐이면 3번 줄이 없다", () => {
    const s = scene(
      { summary: BEFORE, verdict: passV },
      { summary: { ...BEFORE, errors: 3 }, verdict: failV },
    );
    expect(s.headline.answer).toBe("mixed");
    expect(s.byId(3)).toBeUndefined();
  });

  it("개선에서는 3번 줄이 없다", () => {
    expect(scene({ summary: BEFORE }, { summary: AFTER_GOOD }).byId(3)).toBeUndefined();
  });
});

describe("cmpSummaryLines 악화·조사·줄었음", () => {
  it("악화: 2번 줄에 가장 나빠진 지표의 값과 변화율", () => {
    const s = scene({ summary: BEFORE }, { summary: { ...BEFORE, p95_ms: 4000 } });
    expect(s.headline.answer).toBe("worsened");
    const t = s.byId(2) ?? "";
    expect(t).toContain("95% 응답시간");
    expect(t).toContain("2.4초 → 4.0초");
    expect(t).toContain("67%");
    expect(s.byId(3)).toBeUndefined();
  });

  it("악화: 변화율이 가장 큰 나쁜 지표가 고른다", () => {
    const s = scene(
      { summary: BEFORE },
      { summary: { ...BEFORE, p95_ms: 3000, p99_ms: 6000, mean_ms: 1000 } },
    );
    expect(s.headline.answer).toBe("worsened");
    expect(s.byId(2)).toContain("99% 응답시간");
  });

  it("악화에서 오류율이 맨 위고 코드가 늘었으면 건수 문장이 이어진다", () => {
    const s = scene(
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9900, "502": 100 }, errors: 100 }],
        summary: { ...BEFORE, count: 10000, errors: 100 },
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9700, "502": 300 }, errors: 300 }],
        summary: { ...BEFORE, count: 10000, errors: 300 },
      },
    );
    expect(s.headline.answer).toBe("worsened");
    const t = s.byId(2) ?? "";
    expect(t).toContain("오류율");
    expect(t).toContain("100건이 300건으로 늘었습니다");
    expect(t).toContain("502");
  });

  it("악화에서 이전 0건이던 코드가 생겼으면 새로 생겼습니다", () => {
    const s = scene(
      {
        steps: CODE_STEPS,
        summary: { ...BEFORE, count: 10000, errors: 0 },
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9800, "502": 200 }, errors: 200 }],
        summary: { ...BEFORE, count: 10000, errors: 200 },
      },
    );
    expect(s.headline.answer).toBe("worsened");
    const t = s.byId(2) ?? "";
    expect(t).toContain("오류율");
    expect(t).toContain("200건이 새로 생겼습니다");
  });

  it("악화가 판정 변화뿐이면 2번 줄이 없다", () => {
    const s = scene({ summary: BEFORE, verdict: passV }, { summary: BEFORE, verdict: failV });
    expect(s.headline.answer).toBe("worsened");
    expect(s.byId(2)).toBeUndefined();
    expect(s.byId(3)).toBeUndefined();
  });

  it("3번 줄: 값이 받침으로 끝나면 '으로'", () => {
    const s = scene(
      { summary: { ...BEFORE, count: 10000, errors: 0 } },
      { summary: { ...BEFORE, count: 10000, errors: 6, p95_ms: 1000 } },
    );
    expect(s.headline.answer).toBe("mixed");
    const t = s.byId(3) ?? "";
    expect(t).toBe("반면 오류율은 0.0% → 0.1% 미만으로 늘었습니다.");
  });

  it("3번 줄: 나빠진 지표가 줄어든 쪽이면 줄었습니다", () => {
    const s = scene({ summary: BEFORE }, { summary: { ...BEFORE, rps: 100, p95_ms: 1000 } });
    expect(s.headline.answer).toBe("mixed");
    expect(s.byId(3)).toBe("반면 처리량은 240건/초 → 100건/초로 줄었습니다.");
  });
});

describe("cmpSummaryLines 4번 줄·비교 불가", () => {
  it("조건이 다르면 항목 앞 2개 + 외 N개", () => {
    const s = scene(
      { summary: BEFORE, env: { A: "1" } },
      {
        summary: AFTER_GOOD,
        env: { A: "2" },
        profile: critProfile({ vus: 20, criteria: { max_p95_ms: 2000 } }),
      },
    );
    const t = s.byId(4) ?? "";
    expect(t).toContain("참고용");
    expect(t).toContain("부하 조건·환경 변수");
    expect(t).toContain("외 1개");
    expect(t).toBe("두 측정의 부하 조건·환경 변수 외 1개가 달라 이 비교는 참고용입니다.");
  });

  it("4번 줄 조사는 마지막 항목 이름의 받침을 따른다", () => {
    const crit = scene(
      { summary: BEFORE },
      { summary: AFTER_GOOD, profile: critProfile({ criteria: { max_p95_ms: 2000 } }) },
    );
    expect(crit.byId(4)).toBe("두 측정의 판정 기준이 달라 이 비교는 참고용입니다.");
    const env = scene(
      { summary: BEFORE, env: { A: "1" } },
      { summary: AFTER_GOOD, env: { A: "2" } },
    );
    expect(env.byId(4)).toBe("두 측정의 환경 변수가 달라 이 비교는 참고용입니다.");
  });

  it("요약 문장 어디에도 두 꼴을 함께 쓴 조사가 남지 않는다", () => {
    const s = scene(
      { summary: BEFORE, verdict: failV, env: { A: "1" } },
      { summary: { ...BEFORE, errors: 3, p95_ms: 2800 }, verdict: passV, env: { A: "2" } },
    );
    expect(s.lines.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    for (const l of s.lines) expect(l.text).not.toMatch(/\((으|이|은|을)\)/);
  });

  it("같으면 4번 줄이 없다", () => {
    expect(scene({ summary: BEFORE }, { summary: AFTER_GOOD }).byId(4)).toBeUndefined();
  });

  it("비교 불가: 1번 줄은 고정 문장이고 사유는 따로 실린다", () => {
    const s = scene(
      { summary: BEFORE },
      {
        summary: { ...BEFORE, count: 0, errors: 0 },
        rep: [],
        meta: { status: "failed", message: "  연결할 수 없습니다 \n 포트 닫힘\r\n\t확인  " },
      },
    );
    const l1 = s.lines.find((l) => l.id === 1);
    expect(l1?.text).toBe("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.");
    expect(l1?.reasons).toEqual([{ side: "이후", text: "연결할 수 없습니다 포트 닫힘 확인" }]);
    expect(s.headline.answer).toBe("incomparable");
    expect(s.byId(2)).toBeUndefined();
  });

  it("양쪽 모두 0건이면 이전·이후 사유가 차례로", () => {
    const zero = { ...BEFORE, count: 0, errors: 0 };
    const s = scene(
      { summary: zero, rep: [], meta: { status: "failed", message: "가" } },
      { summary: zero, rep: [], meta: { status: "failed", message: "나" } },
    );
    expect(s.lines[0].reasons).toEqual([
      { side: "이전", text: "가" },
      { side: "이후", text: "나" },
    ]);
  });

  it("공백뿐인 사유는 항목이 없고 사유가 없으면 reasons도 비어 있다", () => {
    const zero = { ...BEFORE, count: 0, errors: 0 };
    const blank = scene(
      { summary: BEFORE },
      { summary: zero, rep: [], meta: { status: "failed", message: " \n\t " } },
    );
    expect(blank.lines[0].reasons ?? []).toEqual([]);
    const none = scene({ summary: BEFORE }, { summary: zero, rep: [], meta: { status: "failed" } });
    expect(none.lines[0].reasons ?? []).toEqual([]);
  });

  it("0건이 아닌 쪽의 message는 사유로 싣지 않는다", () => {
    const zero = { ...BEFORE, count: 0, errors: 0 };
    const s = scene(
      { summary: BEFORE, meta: { message: "무관" } },
      { summary: zero, rep: [], meta: { status: "failed", message: "사유" } },
    );
    expect(s.lines[0].reasons).toEqual([{ side: "이후", text: "사유" }]);
  });
});

describe("요약 문장의 굵은 부분(시안)", () => {
  it("판정 변화·오류율과 코드 변화·엇갈림·조건 차이: 1–4번 줄의 parts", () => {
    const s = scene(
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9000, "503": 2880 }, errors: 2880 }],
        summary: BEFORE,
        verdict: failV,
        env: { A: "1" },
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }],
        summary: { ...BEFORE, errors: 3, p95_ms: 2800 },
        verdict: passV,
        env: { A: "2" },
      },
    );
    expect(s.headline.answer).toBe("mixed");
    expect(s.partsOf(1)).toEqual([
      { text: "판정이 " },
      { text: "✕ 부적합", strong: true, tone: "bad" },
      { text: " → " },
      { text: "● 적합", strong: true, tone: "ok" },
      { text: "으로 바뀌었습니다. 기준 3개를 모두 지켰습니다." },
    ]);
    expect(s.partsOf(2)).toEqual([
      { text: "오류율 2.6% → 0.3%", strong: true },
      { text: " (88% 감소). '① 접수'의 " },
      { text: "503 서버가 바쁨 2,880건이 0건", strong: true },
      { text: "이 되었습니다." },
    ]);
    expect(s.partsOf(3)).toEqual([
      { text: "반면 95% 응답시간은 " },
      { text: "2.4초 → 2.8초", strong: true },
      { text: "로 늘었습니다." },
    ]);
    expect(s.partsOf(4)).toEqual([
      { text: "두 측정의 " },
      { text: "환경 변수", strong: true },
      { text: "가 달라 이 비교는 참고용입니다." },
    ]);
  });

  it("판정 낱말: 판정한 쪽만 색, 판정 안 한 쪽은 굵게만", () => {
    const words = scene(
      { summary: BEFORE, profile: { ...baseProfile } },
      { summary: AFTER_GOOD, verdict: passV },
    );
    expect(words.partsOf(1)).toEqual([
      { text: "판정은 이전 " },
      { text: "기준 미설정", strong: true },
      { text: ", 이후 " },
      { text: "● 적합", strong: true, tone: "ok" },
      { text: "입니다. 기준 3개를 모두 지켰습니다." },
    ]);
    const same = scene(
      { summary: BEFORE, verdict: failV },
      { summary: AFTER_GOOD, verdict: failV },
    );
    expect(same.partsOf(1)).toEqual([
      { text: "판정은 두 측정 모두 " },
      { text: "✕ 부적합", strong: true, tone: "bad" },
      { text: "입니다." },
    ]);
  });

  it("건수 문장: 줄었음·늘었음·새로 생김은 코드와 건수만 굵게", () => {
    const reduced = scene(
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9000, "502": 312 }, errors: 312 }],
        summary: BEFORE,
      },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9900, "502": 24 }, errors: 24 }],
        summary: AFTER_GOOD,
      },
    );
    expect(reduced.partsOf(2)?.slice(2)).toEqual([
      { text: "502 중계 서버 오류 312건이 24건", strong: true },
      { text: "으로 줄었습니다." },
    ]);
    const appeared = scene(
      { steps: CODE_STEPS, summary: { ...BEFORE, count: 10000, errors: 0 } },
      {
        steps: CODE_STEPS,
        rep: [{ id: "s1", counts: { "200": 9800, "502": 200 }, errors: 200 }],
        summary: { ...BEFORE, count: 10000, errors: 200 },
      },
    );
    expect(appeared.partsOf(2)?.slice(2)).toEqual([
      { text: "502 중계 서버 오류 200건", strong: true },
      { text: "이 새로 생겼습니다." },
    ]);
  });

  it("비교 불가 문장과 외 N개 꼬리는 굵지 않다", () => {
    const zero = { ...BEFORE, count: 0, errors: 0 };
    const inc = scene({ summary: BEFORE }, { summary: zero, rep: [] });
    expect(inc.partsOf(1)).toEqual([
      { text: "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다." },
    ]);
    const many = scene(
      { summary: BEFORE, env: { A: "1" } },
      {
        summary: AFTER_GOOD,
        env: { A: "2" },
        profile: critProfile({ vus: 20, criteria: { max_p95_ms: 2000 } }),
      },
    );
    expect(many.partsOf(4)).toEqual([
      { text: "두 측정의 " },
      { text: "부하 조건·환경 변수", strong: true },
      { text: " 외 1개가 달라 이 비교는 참고용입니다." },
    ]);
  });
});
