import { describe, expect, it } from "vitest";
import { branchText, deriveChipResults } from "../chipResults";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";

const httpRow = (over: Partial<StepTrace>): StepTrace => ({
  step_id: "s1",
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "/x", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 1,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
  ...over,
});

const ifRow = (branch: string): StepTrace =>
  httpRow({ step_id: "g1", kind: "if", branch, request: null, response: null });

const trace = (steps: StepTrace[]): ScenarioTrace => ({
  ok: true,
  total_ms: 1,
  steps,
  final_vars: {},
  truncated: false,
  error: null,
});

describe("deriveChipResults (spec R4 ①–⑧)", () => {
  it("① 클린 1행 = pass", () => {
    const m = deriveChipResults(trace([httpRow({})]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "pass" });
  });

  it("② error 행 포함 = fail", () => {
    const m = deriveChipResults(trace([httpRow({ error: "status 200 != 201" })]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("③ status 500 = fail", () => {
    const bad = httpRow({});
    bad.response = { ...bad.response!, status: 500 };
    const m = deriveChipResults(trace([bad]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("④ loop 3행 중 1 fail = fail (순서 무관 집계)", () => {
    const bad = httpRow({ loop_index: 1 });
    bad.response = { ...bad.response!, status: 500 };
    const m = deriveChipResults(
      trace([httpRow({ loop_index: 0 }), bad, httpRow({ loop_index: 2 })]),
    );
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("⑤ 행 없음 = 맵 미포함 (not-run)", () => {
    const m = deriveChipResults(trace([httpRow({})]));
    expect(m.has("other")).toBe(false);
  });

  it("⑥ if 단일 then = branches ['then']", () => {
    const m = deriveChipResults(trace([ifRow("then")]));
    expect(m.get("g1")).toEqual({ kind: "if", branches: ["then"] });
  });

  it("⑦ if then+else 두 행 = 고유 집합 순서 보존", () => {
    const m = deriveChipResults(trace([ifRow("then"), ifRow("else"), ifRow("then")]));
    expect(m.get("g1")).toEqual({ kind: "if", branches: ["then", "else"] });
  });

  it("⑧ 3xx 클린 행 = pass (fail 아님 = 성공, statusClass 3-상태와 의도적 차이)", () => {
    const redirect = httpRow({});
    redirect.response = { ...redirect.response!, status: 304 };
    const m = deriveChipResults(trace([redirect]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "pass" });
  });
});

describe("branchText (TestRunPanel에서 byte-identical 추출)", () => {
  it("elif는 0-based 키를 그대로 표시", () => {
    expect(branchText("elif_0")).toBe("elif 0");
    expect(branchText("elif_2")).toBe("elif 2");
  });
  it("none = (미매치), then/else = 원문", () => {
    expect(branchText("none")).toBe("(미매치)");
    expect(branchText("then")).toBe("then");
    expect(branchText("else")).toBe("else");
  });
});
