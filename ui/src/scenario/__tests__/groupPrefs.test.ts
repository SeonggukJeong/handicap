import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCollapsedGroups, saveCollapsedGroups } from "../groupPrefs";

const KEY = "handicap:scenarios:collapsed-groups:v1";

describe("groupPrefs", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("저장 → 읽기 왕복", () => {
    saveCollapsedGroups(["결제", "회원"]);
    expect(loadCollapsedGroups()).toEqual(["결제", "회원"]);
  });

  it("저장값이 없으면 빈 배열", () => {
    expect(loadCollapsedGroups()).toEqual([]);
  });

  it.each([
    ["JSON이 아님", "{not json"],
    ["배열이 아님", JSON.stringify({ a: 1 })],
    ["문자열 아닌 원소", JSON.stringify(["a", 1])],
  ])("%s → []", (_label, raw) => {
    window.localStorage.setItem(KEY, raw);
    expect(loadCollapsedGroups()).toEqual([]);
  });

  it("getItem이 throw해도 []", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadCollapsedGroups()).toEqual([]);
  });

  it("setItem이 throw해도 예외 없음", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveCollapsedGroups(["a"])).not.toThrow();
  });
});
