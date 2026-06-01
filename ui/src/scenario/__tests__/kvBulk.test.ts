import { describe, it, expect } from "vitest";
import { parseBulk, formatEntries } from "../kvBulk";

describe("parseBulk — header", () => {
  it("splits on first colon, trims, keeps colons in value", () => {
    const { entries } = parseBulk("Content-Type: application/json\nX-Url: http://x", "header");
    expect(entries).toEqual({ "Content-Type": "application/json", "X-Url": "http://x" });
  });

  it("skips blank lines (uncounted) and counts separator-less / empty-key lines", () => {
    const { entries, skipped } = parseBulk("A: 1\n\nnoseparator\n: emptykey\nB: 2", "header");
    expect(entries).toEqual({ A: "1", B: "2" });
    expect(skipped).toBe(2);
  });

  it("dedupes last-wins", () => {
    const { entries } = parseBulk("A: 1\nA: 2", "header");
    expect(entries).toEqual({ A: "2" });
  });

  it("does NOT url-decode header values", () => {
    const { entries } = parseBulk("X: a%20b+c", "header");
    expect(entries).toEqual({ X: "a%20b+c" });
  });
});

describe("parseBulk — form", () => {
  it("splits pairs on \\n AND &, each on first '='", () => {
    const { entries } = parseBulk("a=1\nb=2&c=3", "form");
    expect(entries).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("keeps base64 '==' padding (first '=' split, then decode is no-op)", () => {
    const { entries } = parseBulk("token=YWJj==", "form");
    expect(entries).toEqual({ token: "YWJj==" });
  });

  it("url-decodes %XX and + -> space", () => {
    const { entries } = parseBulk("name=John+Doe&city=New%20York", "form");
    expect(entries).toEqual({ name: "John Doe", city: "New York" });
  });

  it("preserves an invalid % sequence verbatim (no throw)", () => {
    const { entries } = parseBulk("x=100%done", "form");
    expect(entries).toEqual({ x: "100%done" });
  });
});

describe("formatEntries <-> parseBulk round-trip", () => {
  it("header round-trips (incl. ':' in value)", () => {
    const m = {
      "Content-Type": "application/json",
      Authorization: "Bearer {{token}}",
      "X-Url": "http://x",
    };
    expect(parseBulk(formatEntries(m, "header"), "header").entries).toEqual(m);
  });

  it("form round-trips literal values: interior space, %, +, &, =", () => {
    const m = { auth: "Bearer {{token}}", pct: "a%20b", plus: "c+d", amp: "x&y", eq: "k=v" };
    expect(parseBulk(formatEntries(m, "form"), "form").entries).toEqual(m);
  });
});
