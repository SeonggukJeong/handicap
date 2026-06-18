import { describe, it, expect } from "vitest";
import { segmentsToPath, suggestVarName, type Segment } from "../jsonPath";

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
});

describe("suggestVarName", () => {
  it("passes identifiers through", () => expect(suggestVarName("token")).toBe("token"));
  it("replaces non-identifier chars with _", () =>
    expect(suggestVarName("x-request-id")).toBe("x_request_id"));
  it("prefixes a leading digit", () => expect(suggestVarName("1abc")).toBe("_1abc"));
  it("falls back to value when empty after cleaning", () =>
    expect(suggestVarName("")).toBe("value"));
});
