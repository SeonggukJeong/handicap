import { describe, expect, it } from "vitest";
import {
  buildThinkRows,
  classifyThink,
  formatThink,
  resolveThinkDraft,
  type ThinkState,
} from "../thinkTime";
import type { HttpStep, Scenario, Step, ThinkTime } from "../model";
import { ko } from "../../i18n/ko";

const ID = (n: number) => `01HX00000000000000000000${String(n).padStart(2, "0")}`;

function http(n: number, name: string, think?: ThinkTime): HttpStep {
  return {
    id: ID(n),
    name,
    type: "http",
    request: { method: "GET", url: `/p${n}`, headers: {} },
    assert: [],
    extract: [],
    ...(think ? { think_time: think } : {}),
  } as unknown as HttpStep;
}

function scenario(steps: Step[], def?: ThinkTime): Scenario {
  return {
    version: 1,
    name: "demo",
    cookie_jar: "auto",
    variables: {},
    steps,
    ...(def ? { default_think_time: def } : {}),
  } as unknown as Scenario;
}

const T = { min_ms: 200, max_ms: 500 };
const ZERO = { min_ms: 0, max_ms: 0 };

describe("classifyThink — 3×3×2 전조합", () => {
  // [think_time, default, insideParallel] → [state, effective]
  const cases: Array<
    [ThinkTime | undefined, ThinkTime | undefined, boolean, ThinkState, ThinkTime | undefined]
  > = [
    // think_time 없음
    [undefined, undefined, false, "inherited_none", undefined],
    [undefined, ZERO, false, "inherited", undefined], // R1-a2: 기본값 {0,0} → 대기없음
    [undefined, T, false, "inherited", T],
    [undefined, undefined, true, "parallel_unset", undefined],
    [undefined, ZERO, true, "parallel_unset", undefined],
    [undefined, T, true, "parallel_unset", undefined],
    // think_time = {0,0}
    [ZERO, undefined, false, "no_wait", undefined],
    [ZERO, ZERO, false, "no_wait", undefined],
    [ZERO, T, false, "no_wait", undefined],
    [ZERO, undefined, true, "no_wait", undefined],
    [ZERO, ZERO, true, "no_wait", undefined],
    [ZERO, T, true, "no_wait", undefined],
    // think_time = {200,500}
    [T, undefined, false, "override", T],
    [T, ZERO, false, "override", T],
    [T, T, false, "override", T],
    [T, undefined, true, "override", T],
    [T, ZERO, true, "override", T],
    [T, T, true, "override", T],
  ];

  it.each(cases)(
    "think=%o default=%o parallel=%s → %s",
    (think, def, inPar, expectedState, expectedEff) => {
      const r = classifyThink(http(1, "s", think), def, inPar);
      expect(r.state).toBe(expectedState);
      expect(r.effective).toEqual(expectedEff);
      expect(r.insideParallel).toBe(inPar);
    },
  );

  it("R1-a2: 기본값 {0,0} 상속과 스텝 {0,0}은 같은 실효값(undefined)이다", () => {
    const inherited = classifyThink(http(1, "a"), ZERO, false);
    const own = classifyThink(http(2, "b", ZERO), undefined, false);
    expect(inherited.state).toBe("inherited");
    expect(own.state).toBe("no_wait");
    expect(inherited.effective).toBeUndefined();
    expect(own.effective).toBeUndefined();
  });

  it("분기 안의 {0,0}은 parallel_unset이 아니라 no_wait다", () => {
    expect(classifyThink(http(1, "a", ZERO), T, true).state).toBe("no_wait");
  });
});

describe("buildThinkRows", () => {
  it("아웃라인과 같은 깊이우선 순서로 전 http leaf를 낸다", () => {
    const sc = scenario([
      http(1, "first"),
      {
        id: ID(2),
        name: "반복",
        type: "loop",
        repeat: 2,
        do: [http(3, "in-loop")],
      },
      {
        id: ID(4),
        name: "조건",
        type: "if",
        cond: { left: "{{x}}", op: "eq", right: "1" },
        then: [http(5, "then-step")],
        elif: [{ cond: { left: "{{y}}", op: "eq", right: "2" }, then: [http(6, "elif-step")] }],
        else: [http(7, "else-step")],
      },
      {
        id: ID(8),
        name: "동시",
        type: "parallel",
        branches: [
          { name: "b1", steps: [http(9, "par-a")] },
          { name: "b2", steps: [http(10, "par-b")] },
        ],
      },
    ] as unknown as Step[]);

    expect(buildThinkRows(sc).map((r) => r.name)).toEqual([
      "first",
      "in-loop",
      "then-step",
      "elif-step",
      "else-step",
      "par-a",
      "par-b",
    ]);
  });

  it("경로 라벨 — loop / if 3밴드(1-based elif) / parallel 분기", () => {
    const sc = scenario([
      http(1, "top"),
      { id: ID(2), name: "반복", type: "loop", repeat: 2, do: [http(3, "L")] },
      {
        id: ID(4),
        name: "조건",
        type: "if",
        cond: { left: "{{x}}", op: "eq", right: "1" },
        then: [http(5, "TH")],
        elif: [{ cond: { left: "{{y}}", op: "eq", right: "2" }, then: [http(6, "EL")] }],
        else: [http(7, "ES")],
      },
      {
        id: ID(8),
        name: "동시",
        type: "parallel",
        branches: [{ name: "b1", steps: [http(9, "P")] }],
      },
    ] as unknown as Step[]);

    const byName = Object.fromEntries(buildThinkRows(sc).map((r) => [r.name, r.path]));
    expect(byName["top"]).toBe("");
    expect(byName["L"]).toBe("반복");
    expect(byName["TH"]).toBe("조건·Then");
    expect(byName["EL"]).toBe("조건·Elif 1"); // 1-based
    expect(byName["ES"]).toBe("조건·Else");
    expect(byName["P"]).toBe("동시·b1");
  });

  it("parallel 분기 안 스텝만 parallel_unset이 된다", () => {
    const sc = scenario(
      [
        http(1, "seq"),
        {
          id: ID(2),
          name: "동시",
          type: "parallel",
          branches: [{ name: "b1", steps: [http(3, "par")] }],
        },
      ] as unknown as Step[],
      T,
    );
    const rows = buildThinkRows(sc);
    expect(rows.find((r) => r.name === "seq")?.state).toBe("inherited");
    expect(rows.find((r) => r.name === "par")?.state).toBe("parallel_unset");
    expect(rows.find((r) => r.name === "par")?.effective).toBeUndefined();
  });

  it("insideParallel 플래그 — 분기 안만 true (loop 안 if는 false)", () => {
    const sc = scenario([
      http(1, "seq"),
      {
        id: ID(2),
        name: "반복",
        type: "loop",
        repeat: 2,
        do: [
          {
            id: ID(3),
            name: "조건",
            type: "if",
            cond: { left: "{{x}}", op: "eq", right: "1" },
            then: [http(4, "nested")],
            elif: [],
            else: [],
          },
        ],
      },
      {
        id: ID(5),
        name: "동시",
        type: "parallel",
        branches: [{ name: "b1", steps: [http(6, "par")] }],
      },
    ] as unknown as Step[]);
    const by = Object.fromEntries(buildThinkRows(sc).map((r) => [r.name, r.insideParallel]));
    expect(by["seq"]).toBe(false);
    expect(by["nested"]).toBe(false); // loop 안 if — 경로에 구분자가 있지만 분기가 아니다
    expect(by["par"]).toBe(true);
  });

  it("configured는 정규화하지 않는다 (입력 시드는 원본 그대로)", () => {
    const sc = scenario([http(1, "z", ZERO)] as unknown as Step[]);
    expect(buildThinkRows(sc)[0].configured).toEqual(ZERO);
    expect(buildThinkRows(sc)[0].effective).toBeUndefined();
  });

  it("http leaf가 없으면 빈 배열", () => {
    expect(buildThinkRows(scenario([]))).toEqual([]);
  });
});

describe("resolveThinkDraft — 4분기 커밋 규칙 (R3, Inspector·ThinkTimeBoard 공용)", () => {
  it("둘 다 빔 → clear (think_time 키 삭제)", () => {
    expect(resolveThinkDraft("", "")).toEqual({ kind: "clear" });
  });

  it("공백-only도 빔으로 취급 → clear", () => {
    expect(resolveThinkDraft("   ", "  ")).toEqual({ kind: "clear" });
  });

  it("min만 빔 → noop (draft 보존, 미완성 쌍)", () => {
    expect(resolveThinkDraft("", "20")).toEqual({ kind: "noop" });
  });

  it("max만 빔 → noop (draft 보존, 미완성 쌍)", () => {
    expect(resolveThinkDraft("10", "")).toEqual({ kind: "noop" });
  });

  it("공백-only 한쪽만 빔인 경우도 noop", () => {
    expect(resolveThinkDraft("   ", "20")).toEqual({ kind: "noop" });
  });

  it("둘 다 유효 → commit (trim 후 정수 변환)", () => {
    expect(resolveThinkDraft("10", "20")).toEqual({
      kind: "commit",
      value: { min_ms: 10, max_ms: 20 },
    });
  });

  it("앞뒤 공백은 trim 후 커밋된다", () => {
    expect(resolveThinkDraft(" 10 ", " 20 ")).toEqual({
      kind: "commit",
      value: { min_ms: 10, max_ms: 20 },
    });
  });

  it("경계값 0: min=0,max=0 → commit", () => {
    expect(resolveThinkDraft("0", "0")).toEqual({
      kind: "commit",
      value: { min_ms: 0, max_ms: 0 },
    });
  });

  it("경계값 600000(상한): max=600000 → commit", () => {
    expect(resolveThinkDraft("0", "600000")).toEqual({
      kind: "commit",
      value: { min_ms: 0, max_ms: 600000 },
    });
  });

  it("경계값 600001(상한 초과): max=600001 → revert", () => {
    expect(resolveThinkDraft("0", "600001")).toEqual({ kind: "revert" });
  });

  it("min > max → revert", () => {
    expect(resolveThinkDraft("100", "50")).toEqual({ kind: "revert" });
  });

  it("비정수(소수) → revert", () => {
    expect(resolveThinkDraft("1.5", "10")).toEqual({ kind: "revert" });
  });

  it("숫자가 아닌 문자열(NaN) → revert", () => {
    expect(resolveThinkDraft("abc", "10")).toEqual({ kind: "revert" });
  });

  it("음수 → revert", () => {
    expect(resolveThinkDraft("-5", "10")).toEqual({ kind: "revert" });
  });
});

describe("formatThink — 표시 단일 소스 (R1)", () => {
  it("undefined는 '대기없음'", () => {
    expect(formatThink(undefined)).toBe(ko.editor.thinkNoWait);
  });

  it("{0,0}은 '대기없음' (엔진 pace(0)이 즉시 반환 — undefined와 구별 불가능)", () => {
    expect(formatThink({ min_ms: 0, max_ms: 0 })).toBe(ko.editor.thinkNoWait);
  });

  // 이빨: 두 반환값을 서로 직접 비교한다. 각각을 리터럴 "대기없음"과 비교하면
  // 한쪽 분기만 틀려도 통과할 수 있다.
  it("undefined와 {0,0}이 같은 문자열이다 (동치 락인)", () => {
    expect(formatThink(undefined)).toBe(formatThink({ min_ms: 0, max_ms: 0 }));
  });

  it("값이 있으면 범위 표기", () => {
    expect(formatThink({ min_ms: 200, max_ms: 500 })).toBe(ko.editor.thinkRange(200, 500));
  });

  it("0이 한쪽만이면 범위 경로 (둘 다 0일 때만 대기없음)", () => {
    expect(formatThink({ min_ms: 0, max_ms: 1 })).toBe(ko.editor.thinkRange(0, 1));
    expect(formatThink({ min_ms: 1, max_ms: 0 })).toBe(ko.editor.thinkRange(1, 0));
  });
});
