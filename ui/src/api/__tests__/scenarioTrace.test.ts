import { describe, expect, it } from "vitest";
import { ScenarioTraceSchema, SequentialTraceSchema } from "../schemas";

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
    const bad = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1], kind: "bogus" }] };
    expect(() => ScenarioTraceSchema.parse(bad)).toThrow();
  });

  it("accepts a loop judge row and ended_by_loop (loop-do-while)", () => {
    const withLoop = {
      ...SAMPLE,
      ended_by_loop: "poll",
      steps: [
        { ...SAMPLE.steps[1], kind: "loop", branch: "exhausted", request: null, response: null },
      ],
    };
    const r = ScenarioTraceSchema.safeParse(withLoop);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.steps[0].kind).toBe("loop");
      expect(r.data.ended_by_loop).toBe("poll");
    }
  });

  it("legacy trace JSON without ended_by_loop still parses", () => {
    const r = ScenarioTraceSchema.safeParse(SAMPLE);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ended_by_loop).toBeUndefined();
  });

  it("requires always-emitted collection fields", () => {
    const missing = { ...SAMPLE, steps: [{ ...SAMPLE.steps[1] }] };
    // backend always emits these; a missing one is a contract violation -> throw.
    delete (missing.steps[0] as Record<string, unknown>).unbound_vars;
    expect(() => ScenarioTraceSchema.parse(missing)).toThrow();
  });
});

describe("준비 표지 (setup)", () => {
  const withSection = (section?: string) => ({
    ...SAMPLE,
    steps: [{ ...SAMPLE.steps[1], ...(section === undefined ? {} : { section }) }],
  });

  it("준비 표지가 든 단일 trace를 읽고 키를 버리지 않는다", () => {
    const t = ScenarioTraceSchema.parse({ ...withSection("setup"), setup_ms: 41 });
    expect(t.steps[0].section).toBe("setup");
    expect(t.setup_ms).toBe(41);
    expect(t.setup_failed).toBeUndefined();
  });

  it("준비 키가 없는 trace도 읽는다", () => {
    const t = ScenarioTraceSchema.parse(withSection());
    expect(t.steps[0].section).toBeUndefined();
  });

  it("모르는 구간 이름이 와도 읽는다", () => {
    const t = ScenarioTraceSchema.parse(withSection("teardown"));
    expect(t.steps[0].section).toBe("teardown");
  });

  it("행 모드의 setup_steps를 읽는다", () => {
    const s = SequentialTraceSchema.parse({
      ok: false,
      truncated: false,
      total_ms: 5,
      rows: [],
      setup_steps: [{ ...SAMPLE.steps[1], section: "setup" }],
      setup_failed: true,
    });
    expect(s.setup_steps).toHaveLength(1);
    expect(s.setup_failed).toBe(true);
  });
});
