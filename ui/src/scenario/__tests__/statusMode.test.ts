import { describe, expect, it } from "vitest";
import type { Assertion } from "../model";
import {
  assertHeadHint,
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

describe("assertHeadHint — 응답 검증 구획 머리 덧글", () => {
  it("기본은 덧글 없음", () => {
    expect(assertHeadHint([])).toBeNull();
  });
  it("코드는 muted, 둘 이하는 모두 적는다", () => {
    expect(assertHeadHint([one(200)])).toEqual({ text: "200만 통과", tone: "muted" });
    expect(assertHeadHint([one(200, 409)])).toEqual({ text: "200, 409만 통과", tone: "muted" });
  });
  it("셋 이상은 앞 둘 외 N개", () => {
    const codes = Array.from({ length: 12 }, (_, i) => 200 + i);
    expect(assertHeadHint([one(...codes)])).toEqual({
      text: "200, 201 외 10개만 통과",
      tone: "muted",
    });
  });
  it("보지 않음·여러 줄은 warn", () => {
    expect(assertHeadHint([any])).toEqual({ text: "상태 코드를 보지 않음", tone: "warn" });
    expect(assertHeadHint([one(200), one(201)])).toEqual({ text: "확인 필요", tone: "warn" });
  });
});
