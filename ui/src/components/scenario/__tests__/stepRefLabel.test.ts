import { describe, expect, it } from "vitest";
import { describeStepRef, STEP_REF_BADGE_CLASS } from "../stepRefLabel";
import type { Step } from "../../../scenario/model";

const http: Step = {
  id: "h1",
  type: "http",
  name: "로그인",
  request: { method: "POST", url: "/login", headers: {} },
  assert: [],
  extract: [],
};
const child: Step = {
  id: "h2",
  type: "http",
  name: "확인",
  request: { method: "GET", url: "/ok", headers: {} },
  assert: [],
  extract: [],
};
const ifStep: Step = {
  id: "i1",
  type: "if",
  name: "분기",
  cond: { left: "{{token}}", op: "eq", right: "ok" },
  then: [child],
  elif: [],
  else: [],
};
const loop: Step = { id: "l1", type: "loop", name: "반복", repeat: 2, do: [child] };

describe("describeStepRef", () => {
  it("http 스텝은 메서드 배지 + 스텝 이름", () => {
    expect(describeStepRef([http], "h1")).toEqual({
      badge: { text: "POST", colorClass: "bg-blue-100 text-blue-700" },
      label: "로그인",
    });
  });

  it("if 스텝은 IF 배지 + 조건 요약", () => {
    // summarizeCondition(model.ts:323-328)은 `${left || "?"} ${op}` 뒤에
    // exists/empty가 아니면 ` ${right ?? ""}`를 붙인다 → 여기선 "{{token}} eq ok".
    expect(describeStepRef([ifStep], "i1")).toEqual({
      badge: { text: "IF", colorClass: "bg-slate-100 text-slate-500" },
      label: "{{token}} eq ok",
    });
  });

  it("찾았지만 http/if가 아니면 배지 없이 스텝 이름을 쓴다(현재 refIds 구성상 도달 불가한 방어 가지)", () => {
    expect(describeStepRef([loop], "l1")).toEqual({ badge: null, label: "반복" });
  });

  it("못 찾으면 배지 없이 raw id", () => {
    expect(describeStepRef([http], "ghost")).toEqual({ badge: null, label: "ghost" });
  });

  it("중첩 컨테이너 안의 http도 찾는다(findStepById 재귀 위임)", () => {
    expect(describeStepRef([ifStep], "h2").label).toBe("확인");
  });

  it("공유 배지 레이아웃 클래스는 색 토큰을 포함하지 않는다", () => {
    const tokens = STEP_REF_BADGE_CLASS.split(/\s+/);
    expect(tokens).toContain("shrink-0");
    expect(tokens).toContain("font-mono");
    expect(tokens.some((t) => t.startsWith("bg-") || t.startsWith("text-slate"))).toBe(false);
  });
});
