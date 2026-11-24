import { describe, expect, it } from "vitest";
import { statusRuleNotice } from "../statusRuleNotice";

const rep = (rule?: 1 | 2) =>
  ({ run: { id: "x", ...(rule ? { status_rule: rule } : {}) } }) as never;

describe("statusRuleNotice", () => {
  const text =
    "선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요.";
  it("모두 규칙 1 → null", () => {
    expect(statusRuleNotice([rep(1), rep(1)])).toBeNull();
  });
  it("모두 규칙 2 → null", () => {
    expect(statusRuleNotice([rep(2), rep(2)])).toBeNull();
  });
  it("키 없는 옛 run은 규칙 1이다", () => {
    expect(statusRuleNotice([rep(), rep(1)])).toBeNull();
    expect(statusRuleNotice([rep(), rep(2)])).toBe(text);
  });
  it("규칙이 섞이면 안내 문구", () => {
    expect(statusRuleNotice([rep(1), rep(2)])).toBe(text);
    expect(statusRuleNotice([rep(2), rep(2), rep(1)])).toBe(text);
  });
});
