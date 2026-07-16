import { describe, expect, it } from "vitest";
import { ScenarioTraceSchema, SequentialTraceSchema, type TestRunDatasetConfig } from "../schemas";

// Rust RowsTrace 직렬화 1:1 fixture (Task 2/3 와이어 — 전 필드 항상 emit)
const stepTrace = {
  step_id: "01HX0000000000000000000010",
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "http://x/u/bob", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 3,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "ok",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
};
const trace = {
  ok: true,
  total_ms: 5,
  steps: [stepTrace],
  final_vars: { u: "bob" },
  truncated: false,
  error: null,
};

describe("SequentialTraceSchema", () => {
  it("parses the Rust RowsTrace wire shape 1:1", () => {
    const seq = {
      ok: false,
      truncated: true,
      total_ms: 42,
      rows: [
        { row_index: 3, trace },
        { row_index: 4, trace: { ...trace, ok: false } },
      ],
    };
    const parsed = SequentialTraceSchema.parse(seq);
    expect(parsed.rows[0].row_index).toBe(3);
    expect(parsed.rows[1].trace.ok).toBe(false);
  });

  it("rejects a single-trace payload (rows 없음)", () => {
    expect(SequentialTraceSchema.safeParse(trace).success).toBe(false);
  });

  it("single_row 응답은 기존 ScenarioTraceSchema 그대로 통과 (R7)", () => {
    expect(ScenarioTraceSchema.safeParse(trace).success).toBe(true);
  });

  it("요청 타입이 와이어 필드명과 일치 (컴파일 계약)", () => {
    const cfg: TestRunDatasetConfig = {
      mode: "sequential",
      bindings: [{ dataset_id: "01J", mappings: [{ kind: "column", var: "u", column: "u" }] }],
      start_row: 1,
      row_limit: 5,
    };
    expect(cfg.bindings[0].dataset_id).toBe("01J");
  });
});
