import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  MetricSummarySchema,
  RunListSchema,
  RunSchema,
  ScenarioListSchema,
  ScenarioSchema,
} from "../api/schemas";

describe("ScenarioSchema", () => {
  it("parses a valid scenario", () => {
    const v = {
      id: "01HX",
      name: "n",
      yaml: "version: 1\n",
      version: 1,
      created_at: 0,
      updated_at: 0,
    };
    expect(() => ScenarioSchema.parse(v)).not.toThrow();
  });

  it("rejects missing required field", () => {
    const bad: unknown = { id: "x", name: "n", yaml: "" };
    expect(() => ScenarioSchema.parse(bad)).toThrow();
  });
});

describe("RunSchema", () => {
  it("accepts a pending run with null timestamps", () => {
    const v = {
      id: "r",
      scenario_id: "s",
      status: "pending",
      profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0 },
      env: {},
      started_at: null,
      ended_at: null,
      created_at: 1,
    };
    expect(() => RunSchema.parse(v)).not.toThrow();
  });

  it("rejects unknown status", () => {
    const v = {
      id: "r",
      scenario_id: "s",
      status: "weird",
      profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0 },
      env: {},
      started_at: null,
      ended_at: null,
      created_at: 1,
    };
    expect(() => RunSchema.parse(v)).toThrow();
  });
});

describe("RunListSchema", () => {
  it("parses empty runs array", () => {
    expect(() => RunListSchema.parse({ runs: [] })).not.toThrow();
  });
});

describe("ScenarioListSchema", () => {
  it("parses empty scenarios array", () => {
    expect(() => ScenarioListSchema.parse({ scenarios: [] })).not.toThrow();
  });
});

describe("MetricSummarySchema", () => {
  it("parses an empty windows list", () => {
    expect(() => MetricSummarySchema.parse({ run_id: "r", windows: [] })).not.toThrow();
  });

  it("parses one window with status counts", () => {
    expect(() =>
      MetricSummarySchema.parse({
        run_id: "r",
        windows: [
          {
            ts_second: 100,
            step_id: "a",
            count: 10,
            error_count: 0,
            status_counts: { "200": 10 },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("ApiErrorSchema", () => {
  it("parses a typical error body", () => {
    expect(ApiErrorSchema.parse({ error: "nope" }).error).toBe("nope");
  });
});
