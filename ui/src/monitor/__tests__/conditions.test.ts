import { describe, it, expect } from "vitest";
import {
  OPS_BY_SOURCE,
  conditionError,
  conditionSummary,
  defaultCondition,
  isSecretName,
  lastKeyOf,
  isFiniteNumberText,
  normalizeCondition,
  oneOfCandidates,
  parseBodyJson,
  targetLabel,
} from "../conditions";
import type { Condition } from "../../api/monitors";
import type { ConditionClick } from "../conditions";
import { ko } from "../../i18n/ko";

const SID = "01HZZZZZZZZZZZZZZZZZZZZZA1";
const base: Condition = {
  step_id: SID,
  source: "body",
  path: "$.a",
  op: "eq",
  value: "v",
  ignore_case: false,
  trim: false,
};
const c = (over: Partial<Condition>): Condition => ({ ...base, ...over });

describe("conditions", () => {
  it("ops_by_source_matches_server", () => {
    const ten = ["eq", "ne", "exists", "not_empty", "contains", "gt", "lt", "gte", "lte", "one_of"];
    expect(OPS_BY_SOURCE.body).toEqual(ten);
    expect(OPS_BY_SOURCE.header).toEqual(ten);
    expect(OPS_BY_SOURCE.status).toEqual(["eq", "ne", "gt", "lt", "gte", "lte", "one_of"]);
    expect(OPS_BY_SOURCE.body_text).toEqual(["contains", "not_empty"]);
  });

  it("default_condition_table", () => {
    const s40 = "가".repeat(40);
    const s41 = "가".repeat(41);
    let r = defaultCondition(SID, { kind: "body", path: "$.a", value: s40, key: "a" });
    expect(r.condition).toMatchObject({ source: "body", path: "$.a", op: "eq", value: s40 });
    expect(r.hint).toBeNull();
    r = defaultCondition(SID, { kind: "body", path: "$.a", value: s41, key: "a" });
    expect(r.condition.op).toBe("not_empty");
    expect(r.condition.value).toBe("");
    expect(r.hint).toBe("volatile");
    r = defaultCondition(SID, { kind: "body", path: "$.n", value: 12, key: "n" });
    expect(r.condition).toMatchObject({ op: "eq", value: "12" });
    r = defaultCondition(SID, { kind: "body", path: "$.b", value: false, key: "b" });
    expect(r.condition).toMatchObject({ op: "eq", value: "false" });
    r = defaultCondition(SID, { kind: "body", path: "$.z", value: null, key: "z" });
    expect(r.condition).toMatchObject({ op: "exists", value: "" });
    r = defaultCondition(SID, { kind: "header", name: "X-A", value: "x".repeat(50) });
    expect(r.condition).toMatchObject({ source: "header", path: "X-A", op: "not_empty" });
    expect(r.hint).toBe("volatile");
    r = defaultCondition(SID, { kind: "header", name: "X-A", value: "ok" });
    expect(r.condition).toMatchObject({ op: "eq", value: "ok" });
    r = defaultCondition(SID, { kind: "status", status: 200 });
    expect(r.condition).toMatchObject({ source: "status", path: "", op: "eq", value: "200" });
    r = defaultCondition(SID, { kind: "body_text" });
    expect(r.condition).toMatchObject({ source: "body_text", op: "contains", value: "" });
    expect(r.condition.ignore_case).toBe(false);
    expect(r.condition.trim).toBe(false);
    expect(r.condition.step_id).toBe(SID);
  });

  // Keep in sync: crates/tui/tests/pick_test.rs `secret_name_table` (same rows, same order).
  it("secret_name_table", () => {
    for (const n of [
      "session_id",
      "X-Api-Key",
      "csrfToken",
      "password",
      "author",
      "Set-Cookie",
      "user_pwd",
      "Authorization",
      "refresh_token",
    ]) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ["name", "id", "count", "status", "url", "message"]) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it("last_key_of_skips_indexes", () => {
    expect(lastKeyOf([])).toBeNull();
    expect(lastKeyOf([{ kind: "index", index: 0 }])).toBeNull();
    expect(
      lastKeyOf([
        { kind: "key", key: "tokens" },
        { kind: "index", index: 0 },
      ]),
    ).toBe("tokens");
    expect(
      lastKeyOf([
        { kind: "key", key: "a" },
        { kind: "key", key: "b" },
      ]),
    ).toBe("b");
  });

  // Keep in sync: crates/tui/tests/pick_test.rs `default_condition_prefill_parity`
  // (same rows, same order; the TUI-only Authorization/Masked row is the GUI
  // Set-Cookie header row here).
  it("default_condition_prefill_parity", () => {
    const body = (name: string, value: string | number) => ({
      kind: "body" as const,
      path: `$.${name}`,
      value,
      key: name,
    });
    const rows: Array<[ConditionClick, string, string, "volatile" | "secret" | null]> = [
      [body("session_id", "a".repeat(32)), "not_empty", "", "secret"],
      [body("session_id", ""), "exists", "", "secret"],
      [body("token", "x".repeat(41)), "not_empty", "", "secret"],
      [body("name", "web-1"), "eq", "web-1", null],
      [body("name", "x".repeat(41)), "not_empty", "", "volatile"],
      [body("name", "a\tb"), "not_empty", "", "volatile"],
      [body("name", "a\u{200f}b"), "not_empty", "", "volatile"],
      [body("session_count", 5), "eq", "5", null],
      [{ kind: "header", name: "Set-Cookie", value: "sid=abc" }, "not_empty", "", "secret"],
    ];
    for (const [click, op, value, hint] of rows) {
      const r = defaultCondition(SID, click);
      const label = JSON.stringify(click);
      expect(r.condition.op, label).toBe(op);
      expect(r.condition.value, label).toBe(value);
      expect(r.hint, label).toBe(hint);
    }
  });

  it("body_without_key_is_never_secret", () => {
    const r = defaultCondition(SID, { kind: "body", path: "$[0]", value: "abc", key: null });
    expect(r.condition.op).toBe("eq");
    expect(r.hint).toBeNull();
  });

  it("condition_error_cases", () => {
    expect(conditionError(c({ op: "contains", value: "" }))).toBe(ko.monitor.condErrValue);
    expect(conditionError(c({ op: "gt", value: "abc" }))).toBe(ko.monitor.condErrNumber);
    expect(conditionError(c({ op: "gt", value: "" }))).toBe(ko.monitor.condErrNumber);
    expect(conditionError(c({ op: "gt", value: "0x10" }))).toBe(ko.monitor.condErrNumber);
    expect(conditionError(c({ value: "v".repeat(201) }))).toBe(ko.monitor.condErrTooLong);
    expect(conditionError(c({ path: "" }))).toBe(ko.monitor.condErrPath);
    expect(conditionError(c({ path: "a.b" }))).toBe(ko.monitor.condErrPath);
    expect(conditionError(c({ path: "$" + "a".repeat(500) }))).toBe(ko.monitor.condErrPath);
    expect(conditionError(c({ source: "header", path: "  " }))).toBe(ko.monitor.condErrPath);
    expect(conditionError(c({ op: "gt", value: " 1e3 " }))).toBeNull();
    expect(conditionError(c({ value: "" }))).toBeNull();
    expect(isFiniteNumberText("")).toBe(false);
    expect(isFiniteNumberText("1e999")).toBe(false);
    expect(isFiniteNumberText(".5")).toBe(true);
  });

  it("normalize_condition_mirrors_server", () => {
    let n = normalizeCondition(c({ source: "status", path: "$.x", value: "200" }));
    expect(n.path).toBe("");
    expect(n.value).toBe("200");
    n = normalizeCondition(c({ source: "body_text", op: "contains", path: "$.x", value: "ok" }));
    expect(n.path).toBe("");
    n = normalizeCondition(c({ op: "exists", value: "z" }));
    expect(n.value).toBe("");
    n = normalizeCondition(c({ op: "exists", value: "v".repeat(201) }));
    expect(n.value).toBe("");
    n = normalizeCondition(c({ op: "gt", value: "1", ignore_case: true, trim: true }));
    expect(n.ignore_case).toBe(false);
    expect(n.trim).toBe(false);
    n = normalizeCondition(c({ source: "header", op: "exists", path: "  X-A ", value: "" }));
    expect(n.path).toBe("X-A");
    n = normalizeCondition(c({ op: "eq", ignore_case: true }));
    expect(n.ignore_case).toBe(true);
  });

  it("target_and_summary_labels", () => {
    expect(targetLabel({ source: "body", path: "$.data.items[0].code" })).toBe(
      "data.items[0].code",
    );
    expect(targetLabel({ source: "body", path: "$.resultCode" })).toBe("resultCode");
    expect(targetLabel({ source: "body", path: "$" })).toBe("본문");
    expect(targetLabel({ source: "body", path: "$['a b']" })).toBe("['a b']");
    expect(targetLabel({ source: "header", path: "X-A" })).toBe("헤더 X-A");
    expect(targetLabel({ source: "status", path: "" })).toBe("상태코드");
    expect(targetLabel({ source: "body_text", path: "" })).toBe("본문 전체");
    expect(
      conditionSummary(c({ path: "$.resultCode", value: "0000", ignore_case: true }), "로그인"),
    ).toBe("resultCode = 0000 · 로그인 · 대소문자 무시");
    expect(conditionSummary(c({ op: "exists", value: "" }), "로그인")).toBe("a 키 있음 · 로그인");
    expect(conditionSummary(c({ value: "" }), undefined)).toBe(`a = "" · ${SID}`);
    expect(conditionSummary(c({ trim: true }), "s")).toBe("a = v · s · 앞뒤 공백 무시");
  });

  it("condition_summary_symbols_table", () => {
    const sum = (over: Partial<Condition>) =>
      conditionSummary(c({ path: "$.n", ...over }), "로그인");
    expect(sum({ op: "ne", value: "1" })).toBe("n ≠ 1 · 로그인");
    expect(sum({ op: "gt", value: "1" })).toBe("n > 1 · 로그인");
    expect(sum({ op: "lt", value: "1" })).toBe("n < 1 · 로그인");
    expect(sum({ op: "gte", value: "1" })).toBe("n ≥ 1 · 로그인");
    expect(sum({ op: "lte", value: "1" })).toBe("n ≤ 1 · 로그인");
    expect(sum({ op: "contains", value: "x" })).toBe("n 글자 포함 x · 로그인");
    expect(sum({ op: "not_empty", value: "" })).toBe("n 값 있음 · 로그인");
    expect(sum({ op: "one_of", value: "0000, 0020" })).toBe("n ∈ {0000, 0020} · 로그인");
    expect(sum({ op: "one_of", value: " 0000 ,, ok ", ignore_case: true })).toBe(
      "n ∈ {0000, ok} · 로그인 · 대소문자 무시",
    );
    expect(
      conditionSummary(c({ source: "status", path: "", op: "gte", value: "200" }), "로그인"),
    ).toBe("상태코드 ≥ 200 · 로그인");
  });

  it("one_of_candidates_table", () => {
    expect(oneOfCandidates("0000, 0020")).toEqual(["0000", "0020"]);
    expect(oneOfCandidates(" 0000 ,, ok ")).toEqual(["0000", "ok"]);
    expect(oneOfCandidates(" , ")).toEqual([]);
    expect(oneOfCandidates("")).toEqual([]);
    expect(oneOfCandidates("a")).toEqual(["a"]);
  });

  it("condition_error_one_of_and_gte_lte", () => {
    expect(conditionError(c({ op: "one_of", value: " , " }))).toBe(ko.monitor.condErrOneOf);
    expect(conditionError(c({ op: "one_of", value: "a, b" }))).toBeNull();
    expect(conditionError(c({ op: "gte", value: "x" }))).toBe(ko.monitor.condErrNumber);
    expect(conditionError(c({ op: "lte", value: "" }))).toBe(ko.monitor.condErrNumber);
    expect(conditionError(c({ op: "gte", value: "1" }))).toBeNull();
  });

  it("normalize_gte_drops_flags_one_of_keeps", () => {
    let n = normalizeCondition(c({ op: "gte", value: "1", ignore_case: true, trim: true }));
    expect(n.ignore_case).toBe(false);
    expect(n.trim).toBe(false);
    n = normalizeCondition(c({ op: "one_of", value: "a,b", ignore_case: true, trim: true }));
    expect(n.ignore_case).toBe(true);
    expect(n.trim).toBe(true);
  });

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
