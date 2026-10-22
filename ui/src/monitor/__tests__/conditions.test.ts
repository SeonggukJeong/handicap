import { describe, it, expect } from "vitest";
import {
  OPS_BY_SOURCE,
  conditionError,
  conditionSummary,
  defaultCondition,
  isFiniteNumberText,
  normalizeCondition,
  targetLabel,
} from "../conditions";
import type { Condition } from "../../api/monitors";
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
    const seven = ["eq", "ne", "exists", "not_empty", "contains", "gt", "lt"];
    expect(OPS_BY_SOURCE.body).toEqual(seven);
    expect(OPS_BY_SOURCE.header).toEqual(seven);
    expect(OPS_BY_SOURCE.status).toEqual(["eq", "ne", "gt", "lt"]);
    expect(OPS_BY_SOURCE.body_text).toEqual(["contains", "not_empty"]);
  });

  it("default_condition_table", () => {
    const s40 = "가".repeat(40);
    const s41 = "가".repeat(41);
    let r = defaultCondition(SID, { kind: "body", path: "$.a", value: s40 });
    expect(r.condition).toMatchObject({ source: "body", path: "$.a", op: "eq", value: s40 });
    expect(r.volatileHint).toBe(false);
    r = defaultCondition(SID, { kind: "body", path: "$.a", value: s41 });
    expect(r.condition.op).toBe("not_empty");
    expect(r.condition.value).toBe("");
    expect(r.volatileHint).toBe(true);
    r = defaultCondition(SID, { kind: "body", path: "$.n", value: 12 });
    expect(r.condition).toMatchObject({ op: "eq", value: "12" });
    r = defaultCondition(SID, { kind: "body", path: "$.b", value: false });
    expect(r.condition).toMatchObject({ op: "eq", value: "false" });
    r = defaultCondition(SID, { kind: "body", path: "$.z", value: null });
    expect(r.condition).toMatchObject({ op: "exists", value: "" });
    r = defaultCondition(SID, { kind: "header", name: "X-A", value: "x".repeat(50) });
    expect(r.condition).toMatchObject({ source: "header", path: "X-A", op: "not_empty" });
    expect(r.volatileHint).toBe(true);
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
      "본문 data.items[0].code",
    );
    expect(targetLabel({ source: "body", path: "$" })).toBe("본문");
    expect(targetLabel({ source: "body", path: "$['a b']" })).toBe("본문 ['a b']");
    expect(targetLabel({ source: "header", path: "X-A" })).toBe("헤더 X-A");
    expect(targetLabel({ source: "status", path: "" })).toBe("상태코드");
    expect(targetLabel({ source: "body_text", path: "" })).toBe("본문 전체");
    expect(
      conditionSummary(c({ path: "$.resultCode", value: "0000", ignore_case: true }), "로그인"),
    ).toBe("로그인 · 본문 resultCode 같음 0000 · 대소문자 무시");
    expect(conditionSummary(c({ op: "exists", value: "" }), "로그인")).toBe(
      "로그인 · 본문 a 값이 있음",
    );
    expect(conditionSummary(c({ value: "" }), undefined)).toBe(`${SID} · 본문 a 같음 ""`);
    expect(conditionSummary(c({ trim: true }), "s")).toBe("s · 본문 a 같음 v · 앞뒤 공백 무시");
  });
});
