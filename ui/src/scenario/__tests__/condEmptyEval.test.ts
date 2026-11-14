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

describe("condWhenBodyVarsEmpty — 엔진과 어긋날 수 있는 입력은 판단 보류", () => {
  it.each(["^(?!OK)", "(?<=a)b", "(?=a)", "(?<!a)b", "(a)\\1"])(
    "matches %s → unknown (Rust regex가 못 여는 문법)",
    (pat) => {
      expect(condWhenBodyVarsEmpty(leaf("matches", pat), X)).toBe("unknown");
    },
  );
  it("평범한 패턴은 그대로", () => {
    expect(condWhenBodyVarsEmpty(leaf("matches", "^$"), X)).toBe(true);
    expect(condWhenBodyVarsEmpty(leaf("matches", "WAIT"), X)).toBe(false);
  });
  it("깨진 토큰은 unknown", () => {
    expect(condWhenBodyVarsEmpty(leaf("eq", "x", "{{{x}}}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("eq", "x", "{{a}b}}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("eq", "{{{x}}}"), X)).toBe("unknown");
  });
});

describe("condWhenBodyVarsEmpty — 사용자 정규식 안전 (렌더 경로에서 실행되므로 멈추면 안 된다)", () => {
  // 파국적 역추적 입력은 실행하면 멈추므로 "unknown이 즉시 돌아온다"만 단언한다
  // (정규식을 아예 만들지 않는 가드의 이빨은 이 호출이 끝난다는 사실 자체다).
  it("왼쪽이 리터럴(비어 있지 않음)인 matches는 정규식을 돌리지 않고 unknown", () => {
    const t0 = Date.now();
    expect(
      condWhenBodyVarsEmpty(
        leaf("matches", "^(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"),
        X,
      ),
    ).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("묶음에 반복이 붙은 패턴은 unknown", () => {
    expect(condWhenBodyVarsEmpty(leaf("matches", "(?:a*|b*){30}x", "{{x}}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("matches", "(a+)+$", "{{x}}"), X)).toBe("unknown");
  });
  it("대안(|)이 든 패턴은 unknown — 빈 값에서도 경로가 폭발한다", () => {
    expect(condWhenBodyVarsEmpty(leaf("matches", "(|)".repeat(3) + "x", "{{x}}"), X)).toBe(
      "unknown",
    );
    // 90자 안팎이라도 2^30 경로 — 가드가 있어야 즉시 돌아온다(결과만 단언).
    expect(condWhenBodyVarsEmpty(leaf("matches", "(|)".repeat(30) + "x", "{{x}}"), X)).toBe(
      "unknown",
    );
  });
  it("200자를 넘는 패턴은 unknown, 200자는 평가", () => {
    expect(condWhenBodyVarsEmpty(leaf("matches", "a".repeat(201), "{{x}}"), X)).toBe("unknown");
    expect(condWhenBodyVarsEmpty(leaf("matches", "a".repeat(200), "{{x}}"), X)).toBe(false);
  });
});
