import { describe, expect, it } from "vitest";
import { ConnectionStatsSchema, ReportStepSchema } from "../schemas";

describe("connection stats + wait wire", () => {
  it("parses ConnectionStats (inner numerics are plain, never null/undefined)", () => {
    const parsed = ConnectionStatsSchema.parse({
      dns: { count: 2, p50_ms: 2, p95_ms: 8, p99_ms: 8, max_ms: 9 },
      connect: { count: 2, p50_ms: 15, p95_ms: 40, p99_ms: 40, max_ms: 41 },
      connections_opened: 2,
      requests_total: 100,
      reuse_ratio: 0.98,
    });
    expect(parsed.connections_opened).toBe(2);
    expect(parsed.reuse_ratio).toBeCloseTo(0.98);
  });

  it("ReportStep accepts the wait phase, and accepts it absent (measure off)", () => {
    const base = {
      step_id: "s1",
      count: 10,
      error_count: 0,
      status_counts: { "200": 10 },
      p50_ms: 48,
      p95_ms: 60,
      p99_ms: 70,
    };
    const withWait = ReportStepSchema.parse({
      ...base,
      wait: { count: 10, p50_ms: 45, p95_ms: 55, p99_ms: 60, max_ms: 61 },
    });
    expect(withWait.wait?.p50_ms).toBe(45);
    expect(() => ReportStepSchema.parse(base)).not.toThrow(); // wait is optional
  });
});
