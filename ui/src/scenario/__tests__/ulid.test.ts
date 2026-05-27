import { describe, expect, it } from "vitest";
import { newStepId, isStepId } from "../ulid";

describe("newStepId", () => {
  it("produces a 26-char Crockford ULID", () => {
    const id = newStepId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).toHaveLength(26);
  });

  it("two consecutive calls return different ids", () => {
    expect(newStepId()).not.toEqual(newStepId());
  });
});

describe("isStepId", () => {
  it("accepts a fresh ULID", () => {
    expect(isStepId(newStepId())).toBe(true);
  });

  it("rejects lowercase", () => {
    expect(isStepId("01hx0000000000000000000000")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isStepId("01HX0")).toBe(false);
  });
});
