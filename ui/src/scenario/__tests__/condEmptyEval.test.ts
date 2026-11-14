import { describe, expect, it } from "vitest";
import type { Condition, LoopStep } from "../model";
import { condWhenBodyVarsEmpty, directBodyExtractVars } from "../condEmptyEval";

const X = new Set(["x"]);
const leaf = (op: string, right?: string, left = "{{x}}"): Condition =>
  ({ left, op, ...(right === undefined ? {} : { right }) }) as Condition;

describe("condWhenBodyVarsEmpty — 왼쪽이 빈 값일 때 연산자 표 (엔진 empty_left_operator_table과 같은 값)", () => {
  const table: Array<[string, string | undefined, boolean]> = [
    ["eq", "WAIT", false],
    ["ne", "WAIT", true],
    ["contains", "WAIT", false],
    ["matches", "^$", true],
    ["matches", "WAIT", false],
    ["lt", "WAIT", false],
    ["gt", "WAIT", false],
    ["lte", "WAIT", false],
    ["gte", "WAIT", false],
    // 회귀 가드: Number("") === 0 이므로 빈 문자열을 숫자로 보면 아래 세 줄이 틀린다.
    ["lt", "5", false],
    ["gte", "0", false],
    ["lte", "0", false],
    ["exists", undefined, false],
    ["empty", undefined, true],
  ];
  it.each(table)("%s %s → %s", (op, right, want) => {
    expect(condWhenBodyVarsEmpty(leaf(op, right), X)).toBe(want);
  });
});

describe("condWhenBodyVarsEmpty — unknown·3값 논리", () => {
  it("bodyVars에 없는 {{변수}}·${ENV}는 unknown", () => {
    expect(condWhenBodyVarsEmpty(leaf("eq", "WAIT", "{{other}}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("eq", "x", "${ENV}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("eq", "{{other}}"), X)).toBe("unknown");
  });
  const T = leaf("empty");
  const F = leaf("exists");
  const U = leaf("eq", "a", "{{o}}");
  it("all", () => {
    expect(condWhenBodyVarsEmpty({ all: [T, U] }, X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty({ all: [F, U] }, X)).toBe(false);
    expect(condWhenBodyVarsEmpty({ all: [T, T] }, X)).toBe(true);
    expect(condWhenBodyVarsEmpty({ all: [] }, X)).toBe(true);
  });
  it("any", () => {
    expect(condWhenBodyVarsEmpty({ any: [T, U] }, X)).toBe(true);
    expect(condWhenBodyVarsEmpty({ any: [F, U] }, X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty({ any: [F, F] }, X)).toBe(false);
    expect(condWhenBodyVarsEmpty({ any: [] }, X)).toBe(false);
  });
  it("JS에서 못 여는 정규식은 unknown", () => {
    expect(condWhenBodyVarsEmpty(leaf("matches", "(?<=a"), X)).toBe("unknown");
  });
});

const http = (id: string, extract: string[]) => ({
  id,
  name: id,
  type: "http",
  request: { method: "GET", url: "/a", headers: {} },
  assert: [],
  extract: extract.map((v) => ({ var: v, from: "body", path: "$.a" })),
});

describe("directBodyExtractVars", () => {
  it("본문 직계 http의 extract만 — if 분기 안은 제외", () => {
    const loop = {
      id: "L",
      name: "L",
      type: "loop",
      while: leaf("ne", "OK", "{{code}}"),
      do: [
        http("a", ["code"]),
        {
          id: "i",
          name: "i",
          type: "if",
          cond: leaf("eq", "1", "{{code}}"),
          then: [http("b", ["inner"])],
          elif: [],
          else: [],
        },
      ],
    } as unknown as LoopStep;
    expect([...directBodyExtractVars(loop)]).toEqual(["code"]);
  });
});
