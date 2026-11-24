import { describe, expect, it } from "vitest";
import { defaultRuleCode } from "../statusExplain";
import { ko } from "../../i18n/ko";

describe("defaultRuleCode", () => {
  // 출처: crates/engine/src/status_rule.rs 의 status_error_text 테스트가 같은 글 "status 404 (>= 400)"를 고정한다(②a 계약).
  it("엔진 기본 규칙 글에서 코드를 꺼낸다", () => {
    expect(defaultRuleCode("status 404 (>= 400)")).toBe(404);
    expect(defaultRuleCode("status 503 (>= 400)")).toBe(503);
  });

  it("다른 글은 null — 정규식 끝 앵커 포함", () => {
    for (const e of [
      "status 503 != 200",
      "status 503 not in [200, 409]",
      "request timed out",
      null,
      "",
      "xstatus 404 (>= 400)",
      "status 404 (>= 400) extra",
    ]) {
      expect(defaultRuleCode(e)).toBeNull();
    }
  });
});

describe("ko.common.defaultRuleExplain", () => {
  it("404 — 을/이 조사", () => {
    expect(ko.common.defaultRuleExplain(404)).toBe(
      "상태 코드 404를 받아 오류로 셌습니다. 검사를 따로 적지 않은 스텝은 400 이상을 오류로 봅니다. 404가 정상이면 「응답 검증」에서 기대하는 코드에 404를 넣으세요.",
    );
  });
  it("503", () => {
    expect(ko.common.defaultRuleExplain(503)).toBe(
      "상태 코드 503을 받아 오류로 셌습니다. 검사를 따로 적지 않은 스텝은 400 이상을 오류로 봅니다. 503이 정상이면 「응답 검증」에서 기대하는 코드에 503을 넣으세요.",
    );
  });
});
