import { describe, it, expect } from "vitest";
import { isForbiddenTextChar, segmentsToPath, suggestVarName, type Segment } from "../jsonPath";

const k = (key: string): Segment => ({ kind: "key", key });
const i = (index: number): Segment => ({ kind: "index", index });

describe("segmentsToPath (RFC 9535, lockstep with engine serde_json_path)", () => {
  it("root is $", () => expect(segmentsToPath([])).toBe("$"));
  it("identifier members use dot", () =>
    expect(segmentsToPath([k("data"), k("token")])).toBe("$.data.token"));
  it("array index uses brackets", () =>
    expect(segmentsToPath([k("items"), i(0), k("sku")])).toBe("$.items[0].sku"));
  it("special-char key uses bracket-quote", () =>
    expect(segmentsToPath([k("weird.key")])).toBe("$['weird.key']"));
  it("space key uses bracket-quote", () =>
    expect(segmentsToPath([k("has space")])).toBe("$['has space']"));
  it("escapes single quote", () => expect(segmentsToPath([k("it's")])).toBe("$['it\\'s']"));
  it("escapes backslash", () => expect(segmentsToPath([k("a\\b")])).toBe("$['a\\\\b']"));
  it("escapes control chars as \\uXXXX (tab → \\u0009)", () =>
    expect(segmentsToPath([k("a\tb")])).toBe("$['a\\u0009b']"));
  it("escapes newline as \\u000a", () =>
    expect(segmentsToPath([k("a\nb")])).toBe("$['a\\u000ab']"));
  it.each([
    ["a\u{202e}b", "$['a\\u202eb']"],
    ["a\u{2028}b", "$['a\\u2028b']"],
    ["a\u{85}b", "$['a\\u0085b']"],
    ["a\u{7f}b", "$['a\\u007fb']"],
    ["a\u{2066}b", "$['a\\u2066b']"],
    ["a\u{200d}b", "$['a\u{200d}b']"],
  ])("escapes forbidden chars only: %j", (key, want) =>
    expect(segmentsToPath([k(key)])).toBe(want));
});

describe("suggestVarName", () => {
  it("passes identifiers through", () => expect(suggestVarName("token")).toBe("token"));
  it("replaces non-identifier chars with _", () =>
    expect(suggestVarName("x-request-id")).toBe("x_request_id"));
  it("prefixes a leading digit", () => expect(suggestVarName("1abc")).toBe("_1abc"));
  it("falls back to value when empty after cleaning", () =>
    expect(suggestVarName("")).toBe("value"));
});

describe("isForbiddenTextChar", () => {
  it("matches the server set (Rust forbidden_char_set_boundary)", () => {
    for (const c of [
      "\t", "\n", "\u{7f}", "\u{85}", "\u{9f}", "\u{200e}", "\u{200f}", "\u{2028}",
      "\u{2029}", "\u{202a}", "\u{202e}", "\u{2066}", "\u{2069}", "\u{061c}",
    ]) {
      expect(isForbiddenTextChar(c), JSON.stringify(c)).toBe(true);
    }
    for (const c of ["\u{200d}", "\u{200c}", "a", "가", "❤"]) {
      expect(isForbiddenTextChar(c), JSON.stringify(c)).toBe(false);
    }
  });
});
