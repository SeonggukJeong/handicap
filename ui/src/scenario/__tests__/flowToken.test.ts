import { describe, it, expect } from "vitest";
import { splitFlowToken } from "../flowToken";
import { CAST_KEYWORDS, trailingCast } from "../cast";

describe("splitFlowToken", () => {
  it("splits a trailing cast keyword and trims the base", () => {
    expect(splitFlowToken("token:num")).toEqual({ base: "token", cast: "num" });
    expect(splitFlowToken("token:json")).toEqual({ base: "token", cast: "json" });
    expect(splitFlowToken(" token : num ".trim())).toEqual({ base: "token", cast: "num" });
    // FLOW_VAR_RE trims outer ws, but inner spaces survive → base trimmed, cast kept (engine lockstep)
    expect(splitFlowToken("token : num")).toEqual({ base: "token", cast: "num" });
  });

  it("keeps a non-keyword :suffix as part of the base (engine reads {{count:foo}} as name count:foo)", () => {
    expect(splitFlowToken("count:foo")).toEqual({ base: "count:foo", cast: null });
    expect(splitFlowToken("a:b:num")).toEqual({ base: "a:b", cast: "num" }); // only the trailing keyword strips
  });

  it("has no cast for a bare name or a namespaced ref", () => {
    expect(splitFlowToken("plain")).toEqual({ base: "plain", cast: null });
    expect(splitFlowToken("branch.var")).toEqual({ base: "branch.var", cast: null });
  });

  // Drift guard (spec §3-1): splitFlowToken's cast detection ≡ trailingCast filtered by CAST_KEYWORDS.
  it("is equivalent to trailingCast ∩ CAST_KEYWORDS on a battery of inputs", () => {
    const inputs = [
      "token:num",
      "count:foo",
      "a",
      "branch.var",
      "x:bool",
      "y:",
      "z:json",
      "n:str",
      "q:date",
      "a:b:num",
    ];
    for (const inp of inputs) {
      const tc = trailingCast(inp);
      const expectedCast = tc !== null && CAST_KEYWORDS.includes(tc) ? tc : null;
      expect(splitFlowToken(inp).cast).toBe(expectedCast);
    }
  });
});
