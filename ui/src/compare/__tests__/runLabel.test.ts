import { describe, it, expect } from "vitest";
import { runColor } from "../runLabel";

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
