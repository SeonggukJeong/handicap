import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "../sanitizeFilename";

describe("sanitizeFilename", () => {
  it("keeps a clean name unchanged", () => {
    expect(sanitizeFilename("Login Flow")).toBe("Login Flow");
  });
  it("strips path and reserved characters", () => {
    expect(sanitizeFilename('a/b:c*d?"e<f>g|h\\i')).toBe("abcdefghi");
  });
  it("strips control characters", () => {
    expect(sanitizeFilename("a\x00b\x1fc")).toBe("abc");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeFilename("  spaced  ")).toBe("spaced");
  });
  it("returns empty string when everything is stripped", () => {
    expect(sanitizeFilename("///")).toBe("");
  });
  it("returns empty string for nullish input without throwing", () => {
    expect(sanitizeFilename(undefined)).toBe("");
    expect(sanitizeFilename(null)).toBe("");
  });
  it("composes with the caller fallback to scenario", () => {
    expect(sanitizeFilename("///") || "scenario").toBe("scenario");
  });
});
