import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { ruleNotice } from "../statusRuleNotice";

const rep = (status?: 1 | 2, latency?: 1 | 2) =>
  ({
    run: {
      id: "x",
      ...(status ? { status_rule: status } : {}),
      ...(latency ? { latency_rule: latency } : {}),
    },
  }) as never;

describe("ruleNotice", () => {
  const text =
    "선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다. 이 변경 전에 실행한 run은 상태 코드 검사가 없는 스텝의 4xx·5xx를 오류로 세지 않았습니다 — 오류율을 그대로 견주지 마세요.";
  it("모두 규칙 1 → null", () => {
    expect(ruleNotice([rep(1), rep(1)])).toBeNull();
  });
  it("모두 규칙 2 → null", () => {
    expect(ruleNotice([rep(2, 2), rep(2, 2)])).toBeNull();
  });
  it("키 없는 옛 run은 규칙 1이다", () => {
    expect(ruleNotice([rep(), rep(1)])).toBeNull();
    expect(ruleNotice([rep(), rep(2)])).toBe(text);
  });
  it("상태 코드 규칙이 섞이면 안내 문구", () => {
    expect(ruleNotice([rep(1), rep(2)])).toBe(text);
    expect(ruleNotice([rep(2), rep(2), rep(1)])).toBe(text);
  });
  it("응답 시간 규칙만 다르면 응답 시간 안내", () => {
    expect(ruleNotice([rep(2, 2), rep(2)])).toBe(ko.compare.latencyRuleNotice);
  });
  it("둘 다 다르면 한 문장만", () => {
    const t = ruleNotice([rep(1, 1), rep(2, 2)]);
    expect(t).toBe(ko.compare.bothRulesNotice);
    expect(t).not.toBe(text);
    expect(ruleNotice([rep(1, 1), rep(1, 1), rep(2, 2)])).toBe(ko.compare.bothRulesNotice);
  });
});
