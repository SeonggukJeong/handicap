import { describe, it, expect } from "vitest";
import { COMMON_HEADERS, findCommonHeader } from "../commonHeaders";

describe("commonHeaders", () => {
  it("includes core headers with seed values and excludes Cookie", () => {
    const byName = Object.fromEntries(COMMON_HEADERS.map((h) => [h.name, h.value]));
    expect(byName["Content-Type"]).toBe("application/json");
    expect(byName["Authorization"]).toBe("Bearer {{token}}");
    expect(byName["Cookie"]).toBeUndefined();
  });

  it("findCommonHeader matches case-insensitively, trims, returns the canonical entry", () => {
    expect(findCommonHeader("content-type")).toEqual({
      name: "Content-Type",
      value: "application/json",
    });
    expect(findCommonHeader("  AUTHORIZATION ")).toEqual({
      name: "Authorization",
      value: "Bearer {{token}}",
    });
    expect(findCommonHeader("X-Not-A-Common-Header")).toBeUndefined();
    expect(findCommonHeader("")).toBeUndefined();
  });
});
