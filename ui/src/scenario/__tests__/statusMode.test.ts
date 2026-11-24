import { describe, expect, it } from "vitest";
import type { Assertion } from "../model";
import {
  EDITOR_STATUS_RULE,
  mergeStatusLines,
  passingCodes,
  statusMode,
  statusUnchecked,
} from "../statusMode";

const one = (...codes: number[]): Assertion => ({ kind: "status", codes });
const any: Assertion = { kind: "status_any" };

describe("statusMode", () => {
  it("에디터 판정 규칙 번호는 2", () => {
    expect(EDITOR_STATUS_RULE).toBe(2);
  });
  it("줄 수·종류로 방식을 가른다", () => {
    expect(statusMode([])).toEqual({ kind: "default" });
    expect(statusMode([one(200)])).toEqual({ kind: "codes", codes: [200] });
    expect(statusMode([one(200, 409)])).toEqual({ kind: "codes", codes: [200, 409] });
    expect(statusMode([one(200, 200)])).toEqual({ kind: "codes", codes: [200] });
    expect(statusMode([any])).toEqual({ kind: "any" });
    expect(statusMode([any, any])).toEqual({ kind: "multi", lines: [any, any] });
    expect(statusMode([one(200), one(201)])).toEqual({
      kind: "multi",
      lines: [one(200), one(201)],
    });
  });
});

describe("statusUnchecked (엔진 status_unchecked와 같은 표)", () => {
  it("검사 줄이 있고 모두 any일 때만 참", () => {
    expect(statusUnchecked([])).toBe(false);
    expect(statusUnchecked([one(200)])).toBe(false);
    expect(statusUnchecked([any])).toBe(true);
    expect(statusUnchecked([any, any])).toBe(true);
    expect(statusUnchecked([any, one(200)])).toBe(false);
  });
});

describe("mergeStatusLines", () => {
  it("코드 줄을 처음 나온 순서로 합치고 any 줄은 뺀다", () => {
    expect(mergeStatusLines([one(200), one(201)])).toEqual([one(200, 201)]);
    expect(mergeStatusLines([one(200, 409), one(409, 500)])).toEqual([one(200, 409, 500)]);
    expect(mergeStatusLines([any, one(200)])).toEqual([one(200)]);
    expect(mergeStatusLines([any, any])).toEqual([any]);
    expect(mergeStatusLines([])).toEqual([]);
  });
});

describe("passingCodes", () => {
  it("모든 코드 줄에 함께 든 코드, 없으면 any", () => {
    expect(passingCodes([one(200), one(201)])).toEqual([]);
    expect(passingCodes([one(200), one(200)])).toEqual([200]);
    expect(passingCodes([one(200, 409), one(200)])).toEqual([200]);
    expect(passingCodes([one(409, 200), one(200, 409, 500)])).toEqual([409, 200]);
    expect(passingCodes([any, any])).toBe("any");
    expect(passingCodes([any, one(200)])).toEqual([200]);
  });
});
