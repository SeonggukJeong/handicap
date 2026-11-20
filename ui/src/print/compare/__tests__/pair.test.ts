import { describe, expect, it } from "vitest";
import type { Run } from "../../../api/schemas";
import { orderByMeasured, resolvePair, toRunMeta, type RunMeta } from "../pair";

const m = (
  id: string,
  started: number | null,
  created: number,
  status: RunMeta["status"] = "completed",
): RunMeta => ({
  id,
  status,
  started_at: started,
  ended_at: null,
  created_at: created,
  label: null,
  message: null,
});

const A = m("a", 100, 90);
const B = m("b", 200, 190);
const C = m("c", 300, 290);
const ALL = [A, B, C];

const run = (over: Partial<Parameters<typeof resolvePair>[0]>) =>
  resolvePair({ runIds: [], pairParam: null, baseline: null, scenarioRuns: ALL, ...over });

function ok(r: ReturnType<typeof resolvePair>) {
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
  return r;
}

describe("resolvePair", () => {
  it("2개: 나중 run을 먼저 적어도 이전/이후가 측정 시각 순", () => {
    const r = ok(run({ runIds: ["c", "a"] }));
    expect(r.before.id).toBe("a");
    expect(r.after.id).toBe("c");
  });

  it("3개 + baseline b: b와 나머지 중 가장 늦은 c", () => {
    const r = ok(run({ runIds: ["a", "b", "c"], baseline: "b" }));
    expect([r.before.id, r.after.id]).toEqual(["b", "c"]);
  });

  it("3개 + baseline 없음: 가장 이른 a와 가장 늦은 c", () => {
    const r = ok(run({ runIds: ["a", "b", "c"] }));
    expect([r.before.id, r.after.id]).toEqual(["a", "c"]);
  });

  it("3개 + baseline이 가장 늦은 c: c와 b, 순서는 b → c", () => {
    const r = ok(run({ runIds: ["a", "b", "c"], baseline: "c" }));
    expect([r.before.id, r.after.id]).toEqual(["b", "c"]);
  });

  it("baseline이 runs에 없으면 가장 이른 run으로", () => {
    const r = ok(run({ runIds: ["b", "c"], baseline: "a" }));
    expect([r.before.id, r.after.id]).toEqual(["b", "c"]);
    const r3 = ok(run({ runIds: ["a", "b", "c"], baseline: "zzz" }));
    expect([r3.before.id, r3.after.id]).toEqual(["a", "c"]);
  });

  it("pair=a,c는 그 둘", () => {
    const r = ok(run({ runIds: ["a", "b", "c"], pairParam: "a,c", baseline: "b" }));
    expect([r.before.id, r.after.id]).toEqual(["a", "c"]);
    expect(r.candidates.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("pair=b,a는 순서를 뒤집어도 a → b", () => {
    const r = ok(run({ runIds: ["a", "b", "c"], pairParam: "b,a" }));
    expect([r.before.id, r.after.id]).toEqual(["a", "b"]);
  });

  it.each(["a,a", "a,zzz", "a", ""])("이상한 pair=%j는 기본 짝으로", (p) => {
    const r = ok(run({ runIds: ["a", "b", "c"], pairParam: p }));
    expect([r.before.id, r.after.id]).toEqual(["a", "c"]);
  });

  it("pair의 id가 runs에 없으면(목록엔 있어도) 기본 짝", () => {
    const r = ok(run({ runIds: ["a", "b"], pairParam: "a,c" }));
    expect([r.before.id, r.after.id]).toEqual(["a", "b"]);
  });

  it("runs 중복은 제거", () => {
    const r = ok(run({ runIds: ["a", "a", "b"] }));
    expect(r.candidates).toHaveLength(2);
    expect(run({ runIds: ["a", "a"] }).kind).toBe("tooFew");
    expect(run({ runIds: [] }).kind).toBe("tooFew");
  });

  it("목록에 없는 id가 있으면 foreign", () => {
    expect(run({ runIds: ["a", "x"] }).kind).toBe("foreign");
  });

  it("짝 중 하나가 running이면 notTerminal, 짝 밖이면 ok", () => {
    const running = [A, m("b", 200, 190, "running"), C];
    expect(run({ runIds: ["a", "b"], scenarioRuns: running }).kind).toBe("notTerminal");
    const r = ok(run({ runIds: ["a", "b", "c"], scenarioRuns: running }));
    expect([r.before.id, r.after.id]).toEqual(["a", "c"]);
  });

  it("failed·aborted는 terminal", () => {
    const runs = [m("a", 1, 1, "failed"), m("b", 2, 2, "aborted")];
    expect(run({ runIds: ["a", "b"], scenarioRuns: runs }).kind).toBe("ok");
  });

  it("둘 다 started_at null이면 created_at 순", () => {
    const runs = [m("a", null, 50), m("b", null, 40)];
    const r = ok(run({ runIds: ["a", "b"], scenarioRuns: runs }));
    expect([r.before.id, r.after.id]).toEqual(["b", "a"]);
  });

  it("한쪽만 started_at null이면 created_at을 값으로 비교", () => {
    const runs = [m("a", 100, 10), m("b", null, 150)];
    const r = ok(run({ runIds: ["b", "a"], scenarioRuns: runs }));
    expect([r.before.id, r.after.id]).toEqual(["a", "b"]);
    const runs2 = [m("a", 100, 10), m("b", null, 50)];
    const r2 = ok(run({ runIds: ["a", "b"], scenarioRuns: runs2 }));
    expect([r2.before.id, r2.after.id]).toEqual(["b", "a"]);
  });

  it("값이 같으면 id 오름차순, 숫자는 자릿수가 아니라 값으로", () => {
    const runs = [m("b", 5, 5), m("a", 5, 5)];
    const r = ok(run({ runIds: ["b", "a"], scenarioRuns: runs }));
    expect([r.before.id, r.after.id]).toEqual(["a", "b"]);
    const nums = [m("x", 9, 9), m("y", 10, 10)];
    const r2 = ok(run({ runIds: ["y", "x"], scenarioRuns: nums }));
    expect([r2.before.id, r2.after.id]).toEqual(["x", "y"]);
  });
});

describe("orderByMeasured", () => {
  it("[이전, 이후]", () => {
    expect(orderByMeasured(C, A).map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("toRunMeta", () => {
  it("label/message의 undefined를 null로", () => {
    const meta = toRunMeta({
      id: "r",
      status: "completed",
      started_at: 1,
      ended_at: 2,
      created_at: 0,
    } as Run);
    expect(meta.label).toBeNull();
    expect(meta.message).toBeNull();
    expect(meta.started_at).toBe(1);
  });
});
