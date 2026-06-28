import { describe, it, expect } from "vitest";
import { computeReorder } from "../reorder";

describe("computeReorder", () => {
  const group = ["a", "b", "c"];
  it("returns the over index within the same group", () => {
    expect(computeReorder(group, "a", "c")).toBe(2);
    expect(computeReorder(group, "c", "a")).toBe(0);
  });
  it("returns null when active === over (no move)", () => {
    expect(computeReorder(group, "b", "b")).toBeNull();
  });
  it("returns null when over is null", () => {
    expect(computeReorder(group, "a", null)).toBeNull();
  });
  it("returns null when over is in a different group (cross-container drop ignored — slice 3)", () => {
    expect(computeReorder(group, "a", "z")).toBeNull();
  });
});
