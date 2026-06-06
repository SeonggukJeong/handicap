import { describe, expect, it } from "vitest";
import { cloneName } from "../cloneName";

describe("cloneName", () => {
  it("appends (copy) when base has no copy suffix", () => {
    expect(cloneName("Foo", ["Foo"])).toBe("Foo (copy)");
  });

  it("increments to (copy 2) when (copy) is taken", () => {
    expect(cloneName("Foo", ["Foo", "Foo (copy)"])).toBe("Foo (copy 2)");
  });

  it("strips an existing (copy) suffix before numbering (no (copy) (copy) pileup)", () => {
    expect(cloneName("Foo (copy)", ["Foo", "Foo (copy)"])).toBe("Foo (copy 2)");
  });

  it("strips an existing (copy N) suffix to find the base", () => {
    expect(cloneName("Foo (copy 2)", ["Foo", "Foo (copy)", "Foo (copy 2)"])).toBe("Foo (copy 3)");
  });

  it("fills the first empty slot — may produce a lower number than the source", () => {
    // base = "Foo"; "(copy)" is free → fills it, not "(copy 3)"
    expect(cloneName("Foo (copy 2)", ["Foo (copy 2)"])).toBe("Foo (copy)");
  });

  it("does not treat an unrelated name as a copy", () => {
    expect(cloneName("Bar", ["Foo"])).toBe("Bar (copy)");
  });

  it("works with empty existing list", () => {
    expect(cloneName("Foo", [])).toBe("Foo (copy)");
  });
});
