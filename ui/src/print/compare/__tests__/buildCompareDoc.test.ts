import { describe, expect, it } from "vitest";
import type { Report } from "../../../api/schemas";
import type { Heights } from "../../buildPrintDoc";
import {
  CMP_IDS,
  CMP_LAST_LEVEL,
  buildCompareDoc,
  compareSheetBlocks,
  compareStandardBlocks,
  compareSummaryBlocks,
  issuesShown,
  sectionNo,
  tableIds,
  type CompareDoc,
} from "../buildCompareDoc";
import { baseProfile, scenarioYaml } from "./fixtures";
import type { RunModel } from "../runModel";
import { sceneModel, type SceneRun } from "./scene";

const NOON = Date.UTC(2026, 10, 6, 12, 0, 0);
const BEFORE: Partial<Report["summary"]> = {
  count: 1000,
  errors: 26,
  rps: 240,
  mean_ms: 840,
  p95_ms: 2400,
  p99_ms: 3000,
};
const AFTER: Partial<Report["summary"]> = {
  count: 1000,
  errors: 3,
  rps: 252,
  mean_ms: 620,
  p95_ms: 1600,
  p99_ms: 1800,
};

const STEPS = [{ id: "s1", name: "접수", assert: [200] }];

function doc(b: Partial<SceneRun> = {}, a: Partial<SceneRun> = {}, fallback: string | null = null) {
  const before = sceneModel({ id: "01HBEFORE000abc111", summary: BEFORE, ...b });
  const after = sceneModel({ id: "01HAFTER0000def222", summary: AFTER, ...a });
  return buildCompareDoc({ before, after, fallbackScenarioName: fallback, now: NOON });
}

const ids = (d: CompareDoc, h: Heights = new Map()) => compareStandardBlocks(d, h).map((x) => x.id);

describe("buildCompareDoc", () => {
  it("머리: 제목·짝 상자·꼬리말", () => {
    const d = doc();
    expect(d.title).toContain("민원 신청 흐름");
    expect(d.title).toContain("이전·이후 비교");
    expect(d.before.role).toBe("이전");
    expect(d.after.role).toBe("이후");
    expect(d.before.shortId).toBe("#abc111");
    expect(d.footerTitle).toBe("민원 신청 흐름 이전·이후 비교");
    expect(d.footerIds).toBe(" · #abc111 → #def222");
    expect(d.createdDate).toMatch(/^2026-11-0[67]$/);
    expect(d.headline.answer).toBe("improved");
  });

  it("각 쪽 머리는 판정 종류(verdictKind)를 낱말과 함께 싣는다", () => {
    const d = doc({ summary: { count: 0, errors: 0, rps: 0 } });
    expect(d.before.verdictKind).toBe("notJudged");
    expect(d.before.verdictText).not.toBe("");
    expect(d.after.verdictKind).toBe(
      sceneModel({ id: "01HAFTER0000def222", summary: AFTER }).box.kind,
    );
  });

  it("run 라벨은 공백이면 null, 있으면 앞뒤 공백을 뗀 값", () => {
    const d = doc({ meta: { label: "  " } }, { meta: { label: "  고친 뒤  " } });
    expect(d.before.label).toBeNull();
    expect(d.after.label).toBe("고친 뒤");
  });

  it("제목 이름 폴백: 이후 → 이전 → fallback → 문구", () => {
    const bad = "{{{: not yaml";
    const named = (n: string) => scenarioYaml(STEPS, n);
    expect(doc({ yaml: named("이전 이름") }, { yaml: named("이후 이름") }).title).toContain(
      "이후 이름",
    );
    expect(doc({ yaml: named("이전 이름") }, { yaml: bad }).title).toContain("이전 이름");
    expect(doc({ yaml: bad }, { yaml: bad }, "현재 이름").title).toContain("현재 이름");
    expect(doc({ yaml: bad }, { yaml: bad }, null).title).toContain("시나리오");
  });

  it("별(*)이 있으면 오류율 행은 참고용이고 각주가 있다", () => {
    const d = doc(
      {
        steps: [{ id: "s1", name: "접수" }],
        rep: [{ id: "s1", counts: { "200": 9400, "502": 600 }, errors: 0 }],
      },
      { steps: STEPS, rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }] },
    );
    expect(d.rows[0].cls).toBe("reference");
    expect(d.starNote).not.toBeNull();
    expect(d.starNote).not.toBe("");
    expect(d.headline.countsLine).toContain("4개 중");
  });

  it("별이 있어도 비교 불가면 starNote는 null(오류율 행이 '–'이므로)", () => {
    const d = doc(
      {
        steps: [{ id: "s1", name: "접수" }],
        rep: [{ id: "s1", counts: { "200": 9400, "502": 600 }, errors: 0 }],
      },
      {
        steps: STEPS,
        rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }],
        summary: { count: 0, errors: 0, rps: 0 },
      },
    );
    expect(d.incomparable).toBe(true);
    expect(d.rows[0].cls).toBe("none");
    expect(d.rows[0].wordText).toBe("–");
    expect(d.starNote).toBeNull();
  });

  it("별이 없으면 starNote는 null", () => {
    expect(doc().starNote).toBeNull();
  });

  it("환경 변수 값은 어떤 출력에도 없다", () => {
    const d = doc({ env: { HOST: "SECRET-AAA" } }, { env: { HOST: "SECRET-BBB" } });
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(d.fairness.cards[1].line).toContain("HOST");
  });

  it("같은 리포트 둘: 비슷, NaN·Infinity·∞ 없음", () => {
    const d = doc({ summary: BEFORE }, { summary: BEFORE });
    expect(d.headline.answer).toBe("similar");
    const s = JSON.stringify(d);
    expect(s).not.toContain("NaN");
    expect(s).not.toContain("Infinity");
    expect(s).not.toContain("∞");
  });

  it("둘 다 요청 0건: 비교 불가, 남은 문제 없음, 깨끗한 출력", () => {
    const zero = { count: 0, errors: 0, rps: 0, mean_ms: 0, p95_ms: 0, p99_ms: 0, p50_ms: 0 };
    const d = doc({ summary: zero, rep: [] }, { summary: zero, rep: [] });
    expect(d.incomparable).toBe(true);
    expect(d.headline.answer).toBe("incomparable");
    expect(d.issues).toEqual([]);
    expect(d.rows.every((r) => r.cls === "none")).toBe(true);
    const s = JSON.stringify(d);
    expect(s).not.toContain("NaN");
    expect(s).not.toContain("Infinity");
    expect(s).not.toContain("∞");
  });

  it("이전 profile이 읽히지 않아도 throw 없이 만들어진다", () => {
    const d = doc({ profile: { vus: "x" } }, { profile: baseProfile });
    expect(d.fairness.cards[0].same).toBe(false);
  });
});

const OVERALL = {
  slow_ms: 3000,
  basis: "p95" as const,
  own: false,
  fast: 580,
  within: 330,
  over: 90,
};
const withSpeed = (m: RunModel): RunModel => ({
  ...m,
  report: { ...m.report, speed_bands: { overall: OVERALL, steps: [] } },
});
function docSpeed(both: boolean, onlyBefore = false): CompareDoc {
  const before = sceneModel({ id: "01HBEFORE000abc111", summary: BEFORE });
  const after = sceneModel({ id: "01HAFTER0000def222", summary: AFTER });
  return buildCompareDoc({
    before: both || onlyBefore ? withSpeed(before) : before,
    after: both ? withSpeed(after) : after,
    fallbackScenarioName: null,
    now: NOON,
  });
}

describe("블록 — 응답 속도 구간 비교", () => {
  it("양쪽에 speed_bands가 있으면 cmp:speed가 cmp:overlay 다음·cmp:cond 앞", () => {
    const d = docSpeed(true);
    expect(d.speed).not.toBeNull();
    const list = ids(d);
    expect(list.indexOf("cmp:speed")).toBe(list.indexOf("cmp:overlay") + 1);
    expect(list.indexOf("cmp:cond")).toBe(list.indexOf("cmp:speed") + 1);
    expect(compareSheetBlocks(d, "standard").map((b) => b.id)).toEqual(list);
  });

  it("한쪽만 있으면 블록이 없다", () => {
    const d = docSpeed(false, true);
    expect(d.speed).toBeNull();
    expect(ids(d)).not.toContain("cmp:speed");
  });

  it("요약판 어느 칸에도 없다", () => {
    const d = docSpeed(true);
    const lv = [0, 1, 2, 3, 4, 5].flatMap((l) =>
      compareSummaryBlocks(d, new Map(), l).map((b) => b.id),
    );
    expect(lv).not.toContain("cmp:speed");
  });
});

describe("블록", () => {
  it("표준판 id 순서", () => {
    expect(ids(doc())).toEqual([
      "cmp:header",
      "cmp:headline",
      "cmp:lines:full",
      "cmp:cards",
      "cmp:kpi:bars",
      "cmp:kpi:note",
      "cmp:db",
      "cmp:db:legend",
      "cmp:err",
      "cmp:overlay",
      "cmp:cond",
      "cmp:issues:8",
      "signature",
    ]);
  });

  it("겹쳐 보기 블록은 오류 표(·각주) 다음, 조건 대조 앞 — 단계가 없는 문서에도 있다", () => {
    const d = doc();
    const list = ids(d);
    expect(list.indexOf("cmp:overlay")).toBe(list.indexOf("cmp:err") + 1);
    expect(list.indexOf("cmp:cond")).toBe(list.indexOf("cmp:overlay") + 1);
    const withNote = { ...d, errors: { ...d.errors, notes: ["각주"] } };
    const l2 = ids(withNote);
    expect(l2.indexOf("cmp:overlay")).toBe(l2.indexOf("cmp:err:notes") + 1);
    const none = doc({ steps: [], rep: [] }, { steps: [], rep: [] });
    expect(ids(none)).toContain("cmp:overlay");
    expect(ids(none).indexOf("cmp:overlay")).toBe(ids(none).indexOf("cmp:kpi:note") + 1);
    const lv = [0, 1, 2, 3, 4, 5].flatMap((l) =>
      compareSummaryBlocks(d, new Map(), l).map((b) => b.id),
    );
    expect(lv).not.toContain("cmp:overlay");
  });

  it("단계가 없으면 덤벨 표·범례 블록이 없다", () => {
    const d = doc({ steps: [], rep: [] }, { steps: [], rep: [] });
    expect(d.hasSteps).toBe(false);
    expect(ids(d)).not.toContain("cmp:db");
    expect(ids(d)).not.toContain("cmp:db:legend");
    expect(ids(d)).not.toContain("cmp:err");
    expect(ids(d)).not.toContain("cmp:err:notes");
  });

  it("오류 표 블록: 행 수는 모델과 같고 각주가 있을 때만 cmp:err:notes(p-cmp-b--note), 요약판엔 없다", () => {
    const d = doc();
    const t = compareStandardBlocks(d, new Map()).find((b) => b.id === "cmp:err");
    if (!t || t.kind !== "table") throw new Error("no err table");
    expect(t.rowsMm.length).toBe(d.errors.rows.length);
    expect(t.rowsMm.length).toBeGreaterThan(0);
    const list = ids(d);
    expect(list.indexOf("cmp:err")).toBe(list.indexOf("cmp:db:legend") + 1);
    expect(list.includes("cmp:err:notes")).toBe(d.errors.notes.length > 0);
    const withNote = { ...d, errors: { ...d.errors, notes: ["각주"] } };
    const l2 = ids(withNote);
    expect(l2.indexOf("cmp:err:notes")).toBe(l2.indexOf("cmp:err") + 1);
    const none = { ...d, errors: { ...d.errors, notes: [] } };
    expect(ids(none)).not.toContain("cmp:err:notes");
    const lv = [0, 1, 2, 3, 4, 5].flatMap((l) =>
      compareSummaryBlocks(d, new Map(), l).map((b) => b.id),
    );
    expect(lv.some((x) => x.startsWith("cmp:err"))).toBe(false);
  });

  it("덤벨 표 블록의 행 수는 모델 행 수와 같고, 요약판에는 없다", () => {
    const d = doc();
    const t = compareStandardBlocks(d, new Map()).find((b) => b.id === "cmp:db");
    if (!t || t.kind !== "table") throw new Error("no db table");
    expect(t.rowsMm.length).toBe(d.dumbbell.rows.length);
    expect(t.rowsMm.length).toBeGreaterThan(0);
    const lv = [0, 1, 2, 3, 4, 5].flatMap((l) =>
      compareSummaryBlocks(d, new Map(), l).map((b) => b.id),
    );
    expect(lv.some((x) => x.startsWith("cmp:db"))).toBe(false);
  });

  it("tableIds는 표 id에서 제목·머리·행 측정 id를 만든다", () => {
    expect(tableIds("cmp:db")).toMatchObject({ title: "cmp:db:title", header: "cmp:db:header" });
    expect(tableIds("cmp:db").row(3)).toBe("cmp:db:row:3");
    expect(CMP_IDS.condRowId(2)).toBe("cmp:cond:row:2");
  });

  it("조건 대조 표는 행마다 높이를 가진 표 블록", () => {
    const d = doc();
    d.fairness.condRows = Array.from({ length: 30 }, (_, i) => ({
      label: `x${i}`,
      before: "a",
      after: "b",
      differs: false,
    }));
    const h: Heights = new Map([
      [CMP_IDS.condTitle, 7],
      [CMP_IDS.condHeader, 5],
      [CMP_IDS.condRowId(2), 4],
    ]);
    const t = compareStandardBlocks(d, h).find((b) => b.id === "cmp:cond");
    if (!t || t.kind !== "table") throw new Error("no cond table");
    expect(t.rowsMm.length).toBe(30);
    expect(t.titleMm).toBe(7);
    expect(t.headerMm).toBe(5);
    expect(t.rowsMm[2]).toBe(4);
    expect(t.rowsMm[3]).toBe(0);
  });

  it("요약판 칸 0..5의 블록 id가 정확히 이 순서·구성이다", () => {
    const d = doc();
    const lv = [0, 1, 2, 3, 4, 5].map((l) =>
      compareSummaryBlocks(d, new Map(), l).map((b) => b.id),
    );
    expect(lv).toEqual([
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:full",
        "cmp:cards",
        "cmp:kpi:bars",
        "cmp:kpi:note",
        "cmp:issues:5",
      ],
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:full",
        "cmp:cards",
        "cmp:kpi:plain",
        "cmp:kpi:note",
        "cmp:issues:5",
      ],
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:full",
        "cmp:cards",
        "cmp:kpi:plain",
        "cmp:kpi:note",
        "cmp:issues:3",
      ],
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:short",
        "cmp:cards",
        "cmp:kpi:plain",
        "cmp:kpi:note",
        "cmp:issues:3",
      ],
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:short",
        "cmp:cards:line",
        "cmp:kpi:plain",
        "cmp:kpi:note",
        "cmp:issues:3",
      ],
      [
        "cmp:header",
        "cmp:headline",
        "cmp:lines:short",
        "cmp:cards:line",
        "cmp:kpi:plain",
        "cmp:kpi:note",
        "cmp:issues:1",
      ],
    ]);
    expect(CMP_LAST_LEVEL).toBe(5);
  });

  it("측정 시트: summary = 칸 0..5 블록 id 합집합, standard = 표준 블록", () => {
    const d = doc();
    const union = new Set<string>();
    for (let l = 0; l <= CMP_LAST_LEVEL; l++) {
      for (const b of compareSummaryBlocks(d, new Map(), l)) union.add(b.id);
    }
    const sheet = compareSheetBlocks(d, "summary").map((b) => b.id);
    expect(new Set(sheet)).toEqual(union);
    expect(sheet.length).toBe(union.size);
    for (const must of [
      "cmp:kpi:plain",
      "cmp:issues:3",
      "cmp:issues:1",
      "cmp:lines:short",
      "cmp:cards:line",
    ]) {
      expect(sheet).toContain(must);
    }
    expect(compareSheetBlocks(d, "standard").map((b) => b.id)).toEqual(ids(d));
  });

  it("절 번호는 그 판에 있는 절만", () => {
    const withSteps = { steps: true, speed: false };
    expect(sectionNo("standard", withSteps)).toEqual({
      overview: "1",
      kpi: "2",
      dumbbell: "3",
      errors: "4",
      overlay: "5",
      speed: null,
      cond: "6",
      issues: "7",
    });
    expect(sectionNo("standard", { steps: false, speed: false })).toEqual({
      overview: "1",
      kpi: "2",
      dumbbell: null,
      errors: null,
      overlay: "3",
      speed: null,
      cond: "4",
      issues: "5",
    });
    expect(sectionNo("summary", withSteps)).toEqual({
      overview: "1",
      kpi: "2",
      dumbbell: null,
      errors: null,
      overlay: null,
      speed: null,
      cond: null,
      issues: "3",
    });
  });

  it("속도 구간이 있으면 절 번호가 하나씩 밀린다", () => {
    expect(sectionNo("standard", { steps: true, speed: true })).toEqual({
      overview: "1",
      kpi: "2",
      dumbbell: "3",
      errors: "4",
      overlay: "5",
      speed: "6",
      cond: "7",
      issues: "8",
    });
    expect(sectionNo("standard", { steps: true, speed: false })).toMatchObject({
      speed: null,
      cond: "6",
      issues: "7",
    });
  });

  it("issuesShown", () => {
    const d = doc();
    d.issues = Array.from({ length: 20 }, (_, i) => `문제 ${i}`);
    const r = issuesShown(d, 5);
    expect(r.shown).toEqual(["문제 0", "문제 1", "문제 2", "문제 3", "문제 4"]);
    expect(r.more).toBe(15);
    d.issues = [];
    expect(issuesShown(d, 5)).toEqual({ shown: [], more: 0 });
    d.issues = ["a", "b"];
    expect(issuesShown(d, 5)).toEqual({ shown: ["a", "b"], more: 0 });
  });
});
