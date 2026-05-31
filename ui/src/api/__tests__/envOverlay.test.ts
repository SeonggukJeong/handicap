import { describe, it, expect } from "vitest";
import { resolveEnv, type EnvEntry } from "../envOverlay";

const ov = (pairs: [string, string][]): EnvEntry[] => pairs.map(([key, value]) => ({ key, value }));

describe("resolveEnv", () => {
  it("override-only (no base) is byte-identical to the old submit loop", () => {
    expect(
      resolveEnv(
        {},
        ov([
          ["A", "1"],
          ["B", "2"],
        ]),
      ),
    ).toEqual({ A: "1", B: "2" });
  });

  it("base-only when there are no overrides", () => {
    expect(resolveEnv({ BASE_URL: "http://s" }, [])).toEqual({ BASE_URL: "http://s" });
  });

  it("override wins over a base key", () => {
    expect(
      resolveEnv({ BASE_URL: "http://s", API_KEY: "k" }, ov([["BASE_URL", "http://o"]])),
    ).toEqual({
      BASE_URL: "http://o",
      API_KEY: "k",
    });
  });

  it("a new override key is added alongside base", () => {
    expect(resolveEnv({ BASE_URL: "http://s" }, ov([["EXTRA", "x"]]))).toEqual({
      BASE_URL: "http://s",
      EXTRA: "x",
    });
  });

  it("trims keys and drops empty-key overrides (matches RunDialog.tsx:122-125)", () => {
    expect(
      resolveEnv(
        {},
        ov([
          ["  ", "ignored"],
          [" A ", "1"],
        ]),
      ),
    ).toEqual({ A: "1" });
  });

  it("last duplicate override key wins (matches env[k]=value loop)", () => {
    expect(
      resolveEnv(
        {},
        ov([
          ["A", "1"],
          ["A", "2"],
        ]),
      ),
    ).toEqual({ A: "2" });
  });
});
