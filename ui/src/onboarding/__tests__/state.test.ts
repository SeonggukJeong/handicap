import { beforeEach, describe, expect, it } from "vitest";
import { dismissOnboarding, markReportViewed, markRunCreated, readOnboarding } from "../state";

const KEY = "handicap.onboarding.v1";

describe("onboarding state (localStorage 순수 헬퍼)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("키가 없으면 전부 false", () => {
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
  });

  it("깨진 JSON·비객체 값은 전부 false로 관대 파싱", () => {
    window.localStorage.setItem(KEY, "not-json{");
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
    window.localStorage.setItem(KEY, '"a string"');
    expect(readOnboarding().runCreated).toBe(false);
  });

  it("markRunCreated는 다른 플래그를 보존하며 merge한다", () => {
    dismissOnboarding();
    markRunCreated();
    expect(readOnboarding()).toEqual({
      runCreated: true,
      reportViewed: false,
      dismissed: true,
    });
  });

  it("markReportViewed / dismissOnboarding 각각 해당 플래그만 켠다", () => {
    markReportViewed();
    expect(readOnboarding().reportViewed).toBe(true);
    expect(readOnboarding().dismissed).toBe(false);
    dismissOnboarding();
    expect(readOnboarding().dismissed).toBe(true);
  });

  it("truthy 비불리언 값은 false로 정규화한다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: "yes", dismissed: 1 }));
    expect(readOnboarding()).toEqual({
      runCreated: false,
      reportViewed: false,
      dismissed: false,
    });
  });
});
