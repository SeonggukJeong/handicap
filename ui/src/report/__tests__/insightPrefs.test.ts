import { beforeEach, describe, expect, it } from "vitest";
import { readShowInsightActions, writeShowInsightActions } from "../insightPrefs";

describe("insightPrefs", () => {
  beforeEach(() => window.localStorage.clear());

  it("기본값은 숨김(false)", () => {
    expect(readShowInsightActions()).toBe(false);
  });

  it("쓰고 읽으면 유지된다", () => {
    writeShowInsightActions(true);
    expect(readShowInsightActions()).toBe(true);
  });

  it("malformed 값은 기본값으로 폴백하고 throw하지 않는다", () => {
    window.localStorage.setItem("handicap:report:insight-actions:v1", "{nope");
    expect(() => readShowInsightActions()).not.toThrow();
    expect(readShowInsightActions()).toBe(false);
  });
});
