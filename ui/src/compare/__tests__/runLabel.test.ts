import { describe, it, expect } from "vitest";
import { runColor, runDisplayLabel, runShortLabel } from "../runLabel";

describe("runColor", () => {
  const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];

  it("maps each index to the stable per-index palette", () => {
    PALETTE.forEach((hex, i) => expect(runColor(i)).toBe(hex));
  });

  it("wraps modulo the palette length (defensive — compare caps at 5 runs)", () => {
    expect(runColor(5)).toBe(runColor(0));
    expect(runColor(6)).toBe(runColor(1));
  });
});

describe("runDisplayLabel", () => {
  it("uses the label when present", () => {
    expect(runDisplayLabel("01ABCDEF", "내 라벨")).toBe("내 라벨");
  });

  it("falls back to #끝6자 when label is null", () => {
    expect(runDisplayLabel("01ABCDEF", null)).toBe("#ABCDEF");
  });

  it("falls back to #끝6자 when label is absent", () => {
    expect(runDisplayLabel("01ABCDEF")).toBe("#ABCDEF");
  });

  it("falls back to #끝6자 when label is whitespace-only", () => {
    expect(runDisplayLabel("01ABCDEF", "   ")).toBe("#ABCDEF");
  });

  it("does not change runShortLabel's existing behavior", () => {
    expect(runShortLabel("01HXXXXXXXXXXABCDEF")).toBe("#ABCDEF");
  });
});
