import { describe, expect, it } from "vitest";
import { ScenarioTraceSchema, StepTraceSchema } from "../../api/schemas";
import { defaultedText, traceErrorText } from "../blockedText";

const RAW = "not sent: blank value in url";
const names = (id: string) => (id === "S1" ? "상태 조회" : undefined);

describe("traceErrorText", () => {
  it("blocked 한국어 문구 (스텝 이름)", () => {
    expect(
      traceErrorText({ error: RAW, blocked: { vars: ["orderId"], by_step: "S1" } }, names),
    ).toBe("앞 스텝 상태 조회이(가) orderId 값을 주지 않아 요청을 보내지 않음");
  });
  it("vars 2개는 쉼표로 잇는다", () => {
    expect(
      traceErrorText({ error: RAW, blocked: { vars: ["orderId", "code"], by_step: "S1" } }, names),
    ).toContain("orderId, code");
  });
  it("이름이 없으면 id", () => {
    const t = traceErrorText({ error: RAW, blocked: { vars: ["a"], by_step: "S9" } }, names);
    expect(t).toContain("S9");
  });
  it("이름이 빈 문자열/공백이면 id로 대체", () => {
    const b = { error: RAW, blocked: { vars: ["a"], by_step: "S1" } };
    expect(traceErrorText(b, () => "")).toBe(
      "앞 스텝 S1이(가) a 값을 주지 않아 요청을 보내지 않음",
    );
    expect(traceErrorText(b, () => "  ")).toBe(
      "앞 스텝 S1이(가) a 값을 주지 않아 요청을 보내지 않음",
    );
  });
  it("by_step이 객체 원형 키여도 던지지 않고 id를 쓴다", () => {
    const lookup = (id: string) => (({}) as Record<string, string>)[id];
    for (const id of ["constructor", "__proto__"]) {
      const b = { error: RAW, blocked: { vars: ["a"], by_step: id } };
      expect(traceErrorText(b, lookup)).toBe(
        `앞 스텝 ${id}이(가) a 값을 주지 않아 요청을 보내지 않음`,
      );
    }
  });
  it("blocked 없으면 error 그대로", () => {
    expect(traceErrorText({ error: "status 500 != 200" }, names)).toBe("status 500 != 200");
  });
  it("error null이면 null", () => {
    expect(traceErrorText({ error: null }, names)).toBeNull();
  });
});

describe("ScenarioTraceSchema blocked", () => {
  const base = {
    ok: false,
    total_ms: 1,
    final_vars: {},
    truncated: false,
    error: null,
  };
  const step = {
    step_id: "S2",
    kind: "http",
    loop_index: null,
    branch: null,
    request: null,
    response: null,
    extracted: {},
    unbound_vars: [],
    error: RAW,
  };
  it("blocked 있는/없는 trace 모두 파싱", () => {
    const withB = ScenarioTraceSchema.parse({
      ...base,
      steps: [{ ...step, blocked: { vars: ["orderId"], by_step: "S1" } }],
    });
    expect(withB.steps[0].blocked).toEqual({ vars: ["orderId"], by_step: "S1" });
    const without = ScenarioTraceSchema.parse({ ...base, steps: [step] });
    expect(without.steps[0].blocked).toBeUndefined();
  });
});

describe("defaultedText", () => {
  it("없거나 비면 null", () => {
    expect(defaultedText({})).toBeNull();
    expect(defaultedText({ defaulted: [] })).toBeNull();
  });
  it("이름을 쉼표로 잇는다", () => {
    expect(defaultedText({ defaulted: ["orderId", "cursor"] })).toBe(
      "기본값 사용: orderId, cursor",
    );
  });
});

describe("StepTraceSchema defaulted", () => {
  const base = {
    step_id: "S1",
    kind: "http",
    loop_index: null,
    branch: null,
    request: null,
    response: null,
    extracted: {},
    unbound_vars: [],
    error: null,
  };
  it("키가 없어도 있어도 통과한다", () => {
    expect(StepTraceSchema.parse(base).defaulted).toBeUndefined();
    expect(StepTraceSchema.parse({ ...base, defaulted: ["orderId"] }).defaulted).toEqual([
      "orderId",
    ]);
  });
});
