import { describe, expect, it } from "vitest";
import {
  buildDumbbell as buildDumbbellFromPairs,
  DB,
  type DbClass,
  type DbShape,
} from "../dumbbell";
import { stepPairs } from "../errorCells";
import type { RunModel } from "../runModel";
import { expectClean } from "./expectClean";
import { sceneModel } from "./scene";

const buildDumbbell = (before: RunModel, after: RunModel) =>
  buildDumbbellFromPairs(before, after, stepPairs(before, after));

type Crit = Record<string, unknown>;

const prof = (criteria?: Crit) => ({
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  ...(criteria ? { criteria } : {}),
});

function runOf(id: string, p95s: number[], criteria?: Crit, prefix = "s"): RunModel {
  const steps = p95s.map((_, i) => ({ id: `${prefix}${i + 1}`, name: `단계${i + 1}` }));
  const rep = p95s.map((p, i) => ({
    id: `${prefix}${i + 1}`,
    counts: { "200": 10 },
    errors: 0,
    p95: p,
  }));
  return sceneModel({ id, steps, rep, profile: prof(criteria) });
}

function build(pairs: Array<[number, number]>, bc?: Crit, ac?: Crit) {
  return buildDumbbell(
    runOf(
      "b",
      pairs.map((p) => p[0]),
      bc,
    ),
    runOf(
      "a",
      pairs.map((p) => p[1]),
      ac,
    ),
  );
}

// 시안 「화살표 방향 점검」 6사례 — 축 0–5초(최댓값 4,800ms)
const CASES: Array<[number, number, DbClass, DbShape, -1 | 0 | 1, string, string]> = [
  [1000, 1000, "similar", "merged", 0, "1.0초 → 1.0초", "= 비슷"],
  [1000, 1040, "similar", "merged", 1, "1.0초 → 1.0초", "= 비슷"],
  [1100, 950, "better", "tri", -1, "1.1초 → 0.95초 (−14%)", "빨라짐"],
  [1000, 1150, "worse", "tri", 1, "1.0초 → 1.2초 (+15%)", "느려짐"],
  [1200, 3400, "worse", "arrow", 1, "1.2초 → 3.4초 (+183%)", "느려짐"],
  [4800, 400, "better", "arrow", -1, "4.8초 → 0.40초 (−92%)", "빨라짐"],
];

describe("buildDumbbell", () => {
  it("시안 6사례", () => {
    const m = build(CASES.map((c) => [c[0], c[1]]));
    expect(m.axisMaxMs).toBe(5000);
    expect(m.ticks.map((t) => t.label)).toEqual(["0초", "1초", "2초", "3초", "4초", "5초"]);
    expect(m.ticks.map((t) => t.x)).toEqual([16, 80, 144, 208, 272, 336]);
    expect(m.rows).toHaveLength(6);
    m.rows.forEach((r, i) => {
      const [, , cls, shape, dir, value, word] = CASES[i]!;
      expect([r.cls, r.shape, r.dir, r.valueText, r.wordText]).toEqual([
        cls,
        shape,
        dir,
        value,
        word,
      ]);
    });
    expect(m.rows[4]!.xBefore).toBeCloseTo(92.8, 6);
    expect(m.rows[4]!.xAfter).toBeCloseTo(233.6, 6);
    expect(m.rows[0]!.label).toBe("① 단계1");
  });

  it("valueText는 beforeText → afterText이고 이후 글에 퍼센트 괄호가 든다", () => {
    const m = build(CASES.map((c) => [c[0], c[1]]));
    m.rows.forEach((r) => expect(r.valueText).toBe(`${r.beforeText} → ${r.afterText}`));
    expect([m.rows[2]!.beforeText, m.rows[2]!.afterText]).toEqual(["1.1초", "0.95초 (−14%)"]);
    expect([m.rows[4]!.beforeText, m.rows[4]!.afterText]).toEqual(["1.2초", "3.4초 (+183%)"]);
    expect([m.rows[0]!.beforeText, m.rows[0]!.afterText]).toEqual(["1.0초", "1.0초"]);
  });

  it("비슷인데 간격이 넓으면 점 둘(dots)", () => {
    const m = build([[1000, 1040]]);
    expect(m.axisMaxMs).toBe(1200);
    expect(m.rows[0]!.cls).toBe("similar");
    expect(m.rows[0]!.shape).toBe("dots");
  });

  it("같은 글자·다른 분류면 정확한 ms로 쓴다", () => {
    const m = build([[1060, 1140]]);
    expect(m.rows[0]!.valueText).toBe("1,060ms → 1,140ms (+8%)");
  });

  it("서브 ms: 이전 0이면 퍼센트 괄호가 없다", () => {
    const m = build([[0, 12]]);
    const r = m.rows[0]!;
    expect(r.valueText).not.toContain("(");
    expect(r.wordText).toBe("느려짐");
    expect(r.cls).toBe("worse");
  });

  it("한쪽에만 있는 단계", () => {
    const before = sceneModel({
      id: "b",
      steps: [
        { id: "s1", name: "가" },
        { id: "gone", name: "사라진" },
      ],
      rep: [
        { id: "s1", counts: { "200": 10 }, errors: 0, p95: 1000 },
        { id: "gone", counts: { "200": 10 }, errors: 0, p95: 2100 },
      ],
    });
    const after = sceneModel({
      id: "a",
      steps: [
        { id: "s1", name: "가" },
        { id: "fresh", name: "새로운" },
      ],
      rep: [
        { id: "s1", counts: { "200": 10 }, errors: 0, p95: 900 },
        { id: "fresh", counts: { "200": 10 }, errors: 0, p95: 1500 },
      ],
    });
    const m = buildDumbbell(before, after);
    expect(m.rows.map((r) => r.stepId)).toEqual(["s1", "fresh", "gone"]);
    const gone = m.rows[2]!;
    expect(gone.note).toBe("(이후 측정에 없음)");
    expect(gone.shape).toBe("single");
    expect(gone.cls).toBeNull();
    expect(gone.xAfter).toBeNull();
    expect(gone.valueText).toBe("2.1초 → –");
    expect(gone.label).toBe("사라진");
    const fresh = m.rows[1]!;
    expect(fresh.note).toBe("(이전 측정에 없음)");
    expect(fresh.valueText).toBe("– → 1.5초");
    expect(m.rows[0]!.note).toBeNull();
  });

  it("한쪽 실행 0회(시나리오엔 있고 리포트 단계엔 없음)면 점 하나", () => {
    const steps = [
      { id: "s1", name: "가" },
      { id: "s2", name: "나" },
    ];
    const before = sceneModel({
      id: "b",
      steps,
      rep: [
        { id: "s1", counts: { "200": 10 }, errors: 0, p95: 1000 },
        { id: "s2", counts: { "200": 10 }, errors: 0, p95: 800 },
      ],
    });
    const after = sceneModel({
      id: "a",
      steps,
      rep: [{ id: "s1", counts: { "200": 10 }, errors: 0, p95: 900 }],
    });
    const r = buildDumbbell(before, after).rows[1]!;
    expect(r.shape).toBe("single");
    expect(r.note).toBeNull();
    expect(r.beforeMs).toBe(800);
    expect(r.afterMs).toBeNull();
    expect(r.cls).toBeNull();
  });

  it("전부 시간 초과인 쪽은 기다린 시간이 응답 시간으로 그려진다", () => {
    const steps = [{ id: "s1", name: "가" }];
    const before = sceneModel({
      id: "b",
      steps,
      rep: [{ id: "s1", counts: { "200": 10 }, errors: 0, p95: 2100 }],
    });
    const after = sceneModel({
      id: "a",
      steps,
      rep: [{ id: "s1", counts: { "0": 10 }, count: 10, errors: 10, p95: 30000 }],
    });
    const r = buildDumbbell(before, after).rows[0]!;
    expect(r.afterMs).toBe(30000);
    expect(r.valueText).toBe("2.1초 → 30.0초 (+1329%)");
  });

  it("요청이 전부 보내지 않음인 쪽은 응답 시간이 없어 점·분류·화살표가 없다", () => {
    const steps = [{ id: "s1", name: "가" }];
    const before = sceneModel({
      id: "b",
      steps,
      rep: [{ id: "s1", counts: { "200": 10 }, errors: 0, p95: 2100 }],
    });
    const after = sceneModel({
      id: "a",
      steps,
      rep: [{ id: "s1", counts: {}, count: 10, errors: 10, p95: 0, notSent: 10 }],
    });
    expect(after.table.rows[0]!.count).toBe(10);
    const r = buildDumbbell(before, after).rows[0]!;
    expect(r.shape).toBe("single");
    expect(r.cls).toBeNull();
    expect(r.wordText).toBe("");
    expect(r.afterMs).toBeNull();
    expect(r.afterText).toBe("–");
    expect(r.beforeText).toBe("2.1초");
    expect(r.valueText).toBe("2.1초 → –");
  });

  it("양쪽 모두 실행되지 않은 단계는 점 없는 행(none)", () => {
    const steps = [
      { id: "s1", name: "가" },
      { id: "s2", name: "나" },
    ];
    const rep = [{ id: "s1", counts: { "200": 10 }, errors: 0, p95: 1000 }];
    const m = buildDumbbell(
      sceneModel({ id: "b", steps, rep }),
      sceneModel({ id: "a", steps, rep }),
    );
    const r = m.rows[1]!;
    expect(r.shape).toBe("none");
    expect(r.xBefore).toBeNull();
    expect(r.xAfter).toBeNull();
    expect(r.cls).toBeNull();
    expectClean(r);
  });

  describe("기준선", () => {
    const pairs: Array<[number, number]> = [
      [4800, 2700],
      [2000, 3400],
    ];
    it("양쪽 같은 max_p95_ms·단계 기준 없음이면 선과 교차 글자", () => {
      const m = build(pairs, { max_p95_ms: 3000 }, { max_p95_ms: 3000 });
      expect(m.baseline).toMatchObject({ ms: 3000, label: "기준 3초" });
      expect(m.rows[0]!.crossText).toBe("기준 안으로");
      expect(m.rows[1]!.crossText).toBe("기준 초과");
      expect(m.legend).toContain("빨간 점선 = 기준 3초");
      expect(m.legend).toBe(
        "회색 점 = 이전 · 파란 점 = 이후 · 빨간 점선 = 기준 3초 · 화살표 왼쪽 = 빨라짐, 오른쪽 = 느려짐",
      );
    });
    it("기준과 같은 값은 기준 안쪽으로 센다 · 기준선 x", () => {
      const lim = { max_p95_ms: 3000 };
      const into = build([[3400, 3000]], lim, lim);
      expect(into.rows[0]!.crossText).toBe("기준 안으로");
      const over = build([[3000, 3400]], lim, lim);
      expect(over.rows[0]!.crossText).toBe("기준 초과");
      expect(over.baseline!.x).toBe(DB.PAD + (DB.PLOT_W * 3000) / over.axisMaxMs);
    });
    const none: Array<[string, Crit | undefined, Crit | undefined]> = [
      ["한쪽만 기준", { max_p95_ms: 3000 }, undefined],
      ["값이 다름", { max_p95_ms: 3000 }, { max_p95_ms: 2000 }],
      [
        "한쪽에 단계 p95 기준",
        {
          max_p95_ms: 3000,
          step_criteria: [{ metric: "p95_ms", op: "max", threshold: 500, target: "s1" }],
        },
        { max_p95_ms: 3000 },
      ],
      ["기준이 축 밖", { max_p95_ms: 30000 }, { max_p95_ms: 30000 }],
    ];
    it.each(none)("%s이면 선 없음", (_n, bc, ac) => {
      const m = build(pairs, bc, ac);
      expect(m.baseline).toBeNull();
      expect(m.rows.every((r) => r.crossText === null)).toBe(true);
      expect(m.legend).not.toContain("┊");
      expect(m.legend).toBe(
        "회색 점 = 이전 · 파란 점 = 이후 · 화살표 왼쪽 = 빨라짐, 오른쪽 = 느려짐",
      );
    });
  });

  it("Review Focus 1: 단계 id가 하나도 안 겹쳐도 점 하나씩, NaN 없음", () => {
    const m = buildDumbbell(
      runOf("b", [1000, 2000], undefined, "s"),
      runOf("a", [900, 1500, 700], undefined, "t"),
    );
    expect(m.rows).toHaveLength(5);
    expect(m.rows.every((r) => r.shape === "single" && r.cls === null)).toBe(true);
    expectClean(m);
    for (const r of m.rows) {
      for (const x of [r.xBefore, r.xAfter]) expect(x === null || Number.isFinite(x)).toBe(true);
    }
  });

  it("Review Focus 2: 모든 p95가 0이면 축 0ms–1ms, x는 PAD", () => {
    const m = build([
      [0, 0],
      [0, 0],
    ]);
    expect(m.axisMaxMs).toBe(1);
    expect(m.ticks.map((t) => t.label)).toEqual(["0ms", "1ms"]);
    for (const r of m.rows) {
      expect(r.xBefore).toBe(DB.PAD);
      expect(r.xAfter).toBe(DB.PAD);
    }
  });

  it("Review Focus 2: 단계가 0개면 행 없음·눈금 2개", () => {
    const m = buildDumbbell(runOf("b", []), runOf("a", []));
    expect(m.rows).toEqual([]);
    expect(m.ticks).toHaveLength(2);
    expect(m.axisMaxMs).toBe(1);
  });

  it("통과한 요청이 없는 단계는 점·변화를 내지 않는다(표본 passed)", () => {
    const passed = { selected: "passed", default: "passed", split: true } as const;
    const mk = (id: string, errors: number, p95: number, sample?: typeof passed) =>
      sceneModel({
        id,
        steps: [{ id: "s1", name: "단계1" }],
        rep: [{ id: "s1", counts: { "200": 10 - errors, "500": errors }, errors, p95 }],
        profile: prof(),
        sample,
      });
    const m = buildDumbbell(mk("b", 10, 0, passed), mk("a", 1, 400, passed));
    const r = m.rows[0]!;
    expect([r.beforeMs, r.afterMs, r.cls, r.shape]).toEqual([null, 400, null, "single"]);
    expect(r.beforeText).toBe("–");
    // 옛 run(표본 없음)은 모두 실패여도 값 그대로
    const old = buildDumbbell(mk("b", 10, 0), mk("a", 1, 400));
    expect(old.rows[0]!.beforeMs).toBe(0);
  });

  it("최댓값이 1초 미만이면 ms 눈금", () => {
    const m = build([[150, 800]]);
    expect(m.axisMaxMs).toBe(800);
    expect(m.ticks.map((t) => t.label)).toEqual(["0ms", "200ms", "400ms", "600ms", "800ms"]);
  });
});
