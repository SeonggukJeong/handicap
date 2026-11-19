import { describe, it, expect } from "vitest";
import { parseBodyJson } from "../bodyJson";

describe("parseBodyJson", () => {
  it("parse_body_json_table", () => {
    expect(parseBodyJson('{"a":1}')).toEqual({ value: { a: 1 }, unwrapped: 0 });
    expect(parseBodyJson(JSON.stringify('{"code":1}'))).toEqual({
      value: { code: 1 },
      unwrapped: 1,
    });
    const two = JSON.stringify(JSON.stringify('{"code":1}'));
    expect(parseBodyJson(two)).toEqual({ value: { code: 1 }, unwrapped: 2 });
    const three = JSON.stringify(JSON.stringify(JSON.stringify('{"code":1}')));
    expect(parseBodyJson(three)).toEqual({ value: { code: 1 }, unwrapped: 3 });
    const four = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify('{"code":1}'))));
    expect(parseBodyJson(four)).toEqual({ value: JSON.parse(four), unwrapped: 0 });
    expect(parseBodyJson('"hello"')).toEqual({ value: "hello", unwrapped: 0 });
    expect(parseBodyJson('"12"')).toEqual({ value: "12", unwrapped: 0 });
    expect(parseBodyJson('"[1,2]"')).toEqual({ value: [1, 2], unwrapped: 1 });
    expect(parseBodyJson("not json")).toBeNull();
  });

  it("parse_body_json_nested_fields", () => {
    const deep = JSON.stringify({ k: "x" });
    const inner = JSON.stringify({ id: 7, items: [], deep });
    const outer = JSON.stringify({ code: 1, data: inner, empty: "[]", n: "007", q: '"12"' });
    const want = {
      code: 1,
      data: { id: 7, items: [], deep: { k: "x" } },
      empty: [],
      n: "007",
      q: '"12"',
    };
    // 바깥이 객체여도, 바깥까지 감싸져 있어도 안쪽 필드를 푼다
    expect(parseBodyJson(outer)?.value).toEqual(want);
    expect(parseBodyJson(outer)?.unwrapped).toBeGreaterThan(0);
    expect(parseBodyJson(JSON.stringify(outer))?.value).toEqual(want);
    // 필드 하나당 최대 3겹, 앞뒤 공백 허용
    const l3 = JSON.stringify(JSON.stringify('{"k":1}'));
    const l4 = JSON.stringify(l3);
    expect(parseBodyJson(JSON.stringify({ a: l3 }))?.value).toEqual({ a: { k: 1 } });
    expect(parseBodyJson(JSON.stringify({ a: l4 }))).toEqual({ value: { a: l4 }, unwrapped: 0 });
    expect(parseBodyJson(JSON.stringify([" \n[1,2] "]))?.value).toEqual([[1, 2]]);
    expect(parseBodyJson(JSON.stringify({ a: "{oops" }))).toEqual({
      value: { a: "{oops" },
      unwrapped: 0,
    });
  });

  // Documents behaviour (JSON.parse makes `__proto__` an own key, so plain assignment is safe).
  it("parse_body_json_nested_proto_key_stays_own_property", () => {
    const r = parseBodyJson(String.raw`{"__proto__":"{\"polluted\":1}"}`)!;
    const v = r.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(v, "__proto__")?.value).toEqual({ polluted: 1 });
    expect(v.polluted).toBeUndefined();
  });

  it("parse_body_json_nested_deep_body_no_stack_overflow", () => {
    const n = 20000;
    const body = "[".repeat(n) + JSON.stringify('{"k":1}') + "]".repeat(n);
    let v = parseBodyJson(body)!.value;
    for (let i = 0; i < n; i++) v = (v as unknown[])[0];
    expect(v).toEqual({ k: 1 });
  });
});
