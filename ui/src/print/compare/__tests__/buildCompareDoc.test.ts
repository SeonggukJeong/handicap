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
  type CompareDoc,
} from "../buildCompareDoc";
import { baseProfile, scenarioYaml } from "./fixtures";
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
    expect(d.footerLeft).toContain("#abc111");
    expect(d.footerLeft).toContain("→");
    expect(d.footerLeft).toContain("#def222");
    expect(d.createdDate).toMatch(/^2026-11-0[67]$/);
    expect(d.headline.answer).toBe("improved");
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

describe("블록", () => {
  it("표준판 id 순서", () => {
    expect(ids(doc())).toEqual([
      "cmp:header",
      "cmp:headline",
      "cmp:lines:full",
      "cmp:cards",
      "cmp:kpi:bars",
      "cmp:kpi:note",
      "cmp:cond",
      "cmp:issues:8",
      "signature",
    ]);
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
    expect(sectionNo("standard")).toEqual({ overview: "1", kpi: "2", cond: "3", issues: "4" });
    expect(sectionNo("summary")).toEqual({ overview: "1", kpi: "2", cond: null, issues: "3" });
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
