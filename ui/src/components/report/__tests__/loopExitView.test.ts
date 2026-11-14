import { describe, it, expect } from "vitest";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import type { Step } from "../../../scenario/model";
import { LoopExitSchema, ReportSchema, type LoopExit, type ReportStep } from "../../../api/schemas";
import { floorPct } from "../format";
import { buildLoopExitViews, noticeLoops, retriedStepIdSet } from "../loopExitView";

const L = "01JA00000000000000000000K1";
const A = "01JA00000000000000000000A1";
const B = "01JA00000000000000000000B1";
const IF = "01JA00000000000000000000F1";

const http = (id: string, name: string) =>
  `{ id: ${id}, name: ${name}, type: http, request: { method: GET, url: "http://x/${name}" } }`;

function steps(yaml: string): ReadonlyArray<Step> {
  const r = parseScenarioDoc(yaml);
  if (!("model" in r)) throw new Error(r.error);
  return r.model.steps;
}

const loopYamlWith = (repeatLine: string) => `version: 1
name: s
steps:
  - id: ${L}
    name: 대기 반복
    type: loop
${repeatLine}
    while: { left: "{{s}}", op: eq, right: wait }
    do:
      - ${http(A, "poll")}
      - id: ${IF}
        name: 성공이면
        type: if
        cond: { left: "{{s}}", op: eq, right: ok }
        then:
          - ${http(B, "done")}
`;
const loopYaml = loopYamlWith("    repeat: 5");

const rs = (step_id: string, loop_breakdown?: ReportStep["loop_breakdown"]): ReportStep => ({
  step_id,
  count: 0,
  error_count: 0,
  status_counts: {},
  p50_ms: 0,
  p95_ms: 0,
  p99_ms: 0,
  loop_breakdown,
});
const bd = (loop_index: number | null, count: number) => ({ loop_index, count, error_count: 0 });

const bk = (pass: number | null, completed: number, exhausted = 0, truncated = 0) => ({
  pass,
  completed,
  exhausted,
  truncated,
});
const le = (over: Partial<LoopExit> & { entered: number; passes: number }): LoopExit => ({
  step_id: L,
  exhausted: 0,
  truncated: 0,
  buckets: [],
  ...over,
});

const basic = le({
  entered: 1200,
  passes: 1812,
  exhausted: 12,
  truncated: 3,
  buckets: [bk(1, 816, 0, 1), bk(2, 240), bk(3, 114), bk(5, 12, 12), bk(null, 3, 0, 2)],
});

describe("buildLoopExitViews", () => {
  it("1 기본 계산", () => {
    const [v] = buildLoopExitViews([basic], [], steps(loopYaml));
    expect(v.retries).toBe(612);
    expect(floorPct(v.retryPct)).toBe("33.8%");
    expect(v.name).toBe("대기 반복");
    expect(v.maxPasses).toBe(5);
  });

  it("2 줄 순서와 분류", () => {
    const [v] = buildLoopExitViews([basic], [], steps(loopYaml));
    expect(v.rows.map((r) => [r.kind, r.pass, r.count])).toEqual([
      ["first", 1, 816],
      ["retried", 2, 240],
      ["retried", 3, 114],
      ["retried", 5, 12],
      ["retried", null, 3],
      ["exhausted", null, 12],
      ["truncated", null, 3],
    ]);
    expect(v.rows.reduce((a, r) => a + r.count, 0)).toBe(1200);
    expect(v.rows[0].pct).toBeCloseTo(68, 5);
    // 건수 0인 줄은 없다
    const [w] = buildLoopExitViews(
      [le({ entered: 2, passes: 2, buckets: [bk(1, 2), bk(2, 0)] })],
      [],
      steps(loopYaml),
    );
    expect(w.rows).toHaveLength(1);
  });

  it("3a 1번째 회차에서만 요청된 스텝은 표지 없음", () => {
    // 진입 10 = 1번째에 끝남 6 + 5번째까지 가서 중단 4. passes = 6 + 4*5 = 26.
    // A는 매 회차(진입 10 → 이후 회차마다 4), B(성공 회차에만)는 끝난 6건 = loop_index 0 한 줄.
    const [v] = buildLoopExitViews(
      [le({ entered: 10, passes: 26, exhausted: 4, buckets: [bk(1, 6), bk(5, 0, 4)] })],
      [rs(A, [bd(0, 10), bd(1, 4), bd(2, 4), bd(3, 4), bd(4, 4)]), rs(B, [bd(0, 6)])],
      steps(loopYaml),
    );
    expect(v.retriedStepIds).toEqual([A]);
  });

  it("3b 성공 회차에만 도는 if 안 스텝도 그 회차가 2번째 이후면 표지가 붙는다", () => {
    // 진입 10 = 1번째에 끝남 6 + 2번째에 끝남 4. passes = 6 + 4*2 = 14.
    const [v] = buildLoopExitViews(
      [le({ entered: 10, passes: 14, buckets: [bk(1, 6), bk(2, 4)] })],
      [rs(A, [bd(0, 10), bd(1, 4)]), rs(B, [bd(0, 6), bd(1, 4)])],
      steps(loopYaml),
    );
    expect(v.retriedStepIds).toEqual([A, B]);
  });

  it("3c 상한 초과 줄(loop_index null)만 있는 스텝도 표지", () => {
    const [w] = buildLoopExitViews(
      [basic],
      [rs(A, [bd(0, 10)]), rs(B, [bd(null, 2)])],
      steps(loopYaml),
    );
    expect(w.retriedStepIds).toEqual([B]);
  });

  it("4 표지 — 회차별 요청 수가 없을 때", () => {
    const [v] = buildLoopExitViews([basic], [rs(A, []), rs(B, [])], steps(loopYaml));
    expect(v.retriedStepIds).toEqual([A, B]);
    const [w] = buildLoopExitViews(
      [le({ entered: 3, passes: 3, buckets: [bk(1, 3)] })],
      [rs(A, []), rs(B, [])],
      steps(loopYaml),
    );
    expect(w.retries).toBe(0);
    expect(w.retriedStepIds).toEqual([]);
  });

  it("5 repeat 1 중단만", () => {
    const views = buildLoopExitViews(
      [le({ entered: 5, passes: 5, exhausted: 5, buckets: [bk(1, 5, 5)] })],
      [rs(A, [bd(0, 5)])],
      steps(loopYamlWith("    repeat: 1")),
    );
    expect(views[0].maxPasses).toBe(1);
    expect(views[0].retries).toBe(0);
    expect(views[0].retriedStepIds).toEqual([]);
    expect(noticeLoops(views)).toHaveLength(1);
  });

  it("6 마치지 못함만 있고 재시도 0", () => {
    const views = buildLoopExitViews(
      [le({ entered: 3, passes: 3, truncated: 3, buckets: [bk(1, 0, 0, 3)] })],
      [],
      steps(loopYaml),
    );
    expect(noticeLoops(views)).toEqual([]);
  });

  it("7 끝내 안 풀린 무제한", () => {
    const views = buildLoopExitViews(
      [le({ entered: 4, passes: 400, truncated: 4, buckets: [bk(null, 0, 0, 4)] })],
      [],
      steps(loopYamlWith("")),
    );
    expect(views[0].maxPasses).toBeNull();
    expect(views[0].retries).toBe(396);
    expect(noticeLoops(views)).toHaveLength(1);
    expect(views[0].rows.map((r) => [r.kind, r.count])).toEqual([["truncated", 4]]);
  });

  it("8 시나리오 파싱 실패", () => {
    const [v] = buildLoopExitViews([basic], [rs(A, [bd(1, 4)])], null);
    expect(v.name).toBe(L);
    expect(v.maxPasses).toBeNull();
    expect(v.retriedStepIds).toEqual([]);
    expect(v.rows).toHaveLength(7);
  });

  it("9 if 분기 안의 조건 반복", () => {
    const yaml = `version: 1
name: s
steps:
  - id: ${IF}
    name: 분기
    type: if
    cond: { left: "{{s}}", op: eq, right: a }
    then:
      - id: ${L}
        name: 안쪽 반복
        type: loop
        repeat: 3
        while: { left: "{{s}}", op: eq, right: wait }
        do:
          - ${http(A, "poll")}
`;
    const [v] = buildLoopExitViews([basic], [rs(A, [bd(0, 1), bd(1, 1)])], steps(yaml));
    expect(v.name).toBe("안쪽 반복");
    expect(v.maxPasses).toBe(3);
    expect(v.retriedStepIds).toEqual([A]);
  });

  it("10 loopExits 없음", () => {
    expect(buildLoopExitViews(undefined, [], steps(loopYaml))).toEqual([]);
    expect(buildLoopExitViews([], [], steps(loopYaml))).toEqual([]);
  });

  it("11 noticeLoops 정렬", () => {
    const mk = (id: string, entered: number, passes: number, exhausted: number) =>
      le({ step_id: id, entered, passes, exhausted });
    const views = buildLoopExitViews(
      [mk("p10", 90, 100, 0), mk("p50a", 50, 100, 0), mk("p50b", 50, 100, 3)],
      [],
      null,
    );
    expect(noticeLoops(views).map((v) => v.stepId)).toEqual(["p50b", "p50a", "p10"]);
  });

  it("retriedStepIdSet은 합집합", () => {
    const views = buildLoopExitViews([basic], [rs(A, []), rs(B, [])], steps(loopYaml));
    expect([...retriedStepIdSet(views)].sort()).toEqual([A, B]);
  });
});

describe("Zod", () => {
  const ok = {
    step_id: L,
    entered: 1,
    passes: 1,
    exhausted: 0,
    truncated: 0,
    buckets: [bk(null, 1)],
  };
  it("12 pass null 허용, 모르는 키·소수 pass 거부", () => {
    expect(LoopExitSchema.safeParse(ok).success).toBe(true);
    expect(LoopExitSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(LoopExitSchema.safeParse({ ...ok, buckets: [bk(1.5, 1)] }).success).toBe(false);
  });
  it("12 ReportSchema는 loop_exits 부재·존재 모두 통과", () => {
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
    expect(ReportSchema.safeParse(base).success).toBe(true);
    expect(ReportSchema.safeParse({ ...base, loop_exits: [ok] }).success).toBe(true);
  });
});
