import { describe, expect, it } from "vitest";

// suite-wide 비결정 테스트 격리 flake 회귀 가드 (ui/CLAUDE.md): setup.ts의
// localStorage 폴리필이 매 파일 fresh하게 재설치되고 전역 afterEach가 매 테스트
// 후 clear()하는지 — 이 두 테스트 순서 자체가 "이전 테스트의 값이 안 샌다"의 최소
// 재현이다(고치기 전엔 두 번째 it가 실패).
describe("test setup: localStorage isolation between tests", () => {
  it("writes a value in this test", () => {
    localStorage.setItem("leak-check", "should-not-survive");
    expect(localStorage.getItem("leak-check")).toBe("should-not-survive");
  });

  it("does not see the previous test's value", () => {
    expect(localStorage.getItem("leak-check")).toBeNull();
  });
});
