import { describe, expect, it } from "vitest";
import { ScenarioTraceSchema } from "../schemas";

const SAMPLE = {
  ok: false,
  total_ms: 12,
  truncated: true,
  error: null,
  final_vars: { token: "abc" },
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "if",
      loop_index: null,
      branch: "then",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: ["missing_cond"],
      error: null,
    },
    {
      step_id: "01HX0000000000000000000011",
      kind: "http",
      loop_index: 0,
      branch: null,
      request: {
        method: "GET",
        url: "http://x/ping",
        headers: { "x-token": "" },
        body: null,
      },
      response: {
        status: 201,
        latency_ms: 3,
        download_ms: 2,
        headers: { "x-trace": "yes" },
        set_cookies: ["sid=1"],
        body: "pong",
        body_truncated: false,
      },
      extracted: { id: "42" },
      unbound_vars: [],
      error: null,
    },
  ],
};

describe("ScenarioTraceSchema", () => {
  it("parses a full trace and infers fields", () => {
    const t = ScenarioTraceSchema.parse(SAMPLE);
    expect(t.ok).toBe(false);
    expect(t.truncated).toBe(true);
    expect(t.steps).toHaveLength(2);
    expect(t.steps[0].kind).toBe("if");
    expect(t.steps[0].branch).toBe("then");
    expect(t.steps[0].request).toBeNull();
    expect(t.steps[1].kind).toBe("http");
    expect(t.steps[1].loop_index).toBe(0);
    expect(t.steps[1].response?.status).toBe(201);
    expect(t.steps[1].extracted).toEqual({ id: "42" });
  });

  it("rejects an unknown kind", () => {
    const bad = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1], kind: "loop" }] };
    expect(() => ScenarioTraceSchema.parse(bad)).toThrow();
  });

  it("requires always-emitted collection fields", () => {
    const missing = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1] }] };
    // backend always emits these; a missing one is a contract violation -> throw.
    delete (missing.steps[0] as Record<string, unknown>).unbound_vars;
    expect(() => ScenarioTraceSchema.parse(missing)).toThrow();
  });
});
