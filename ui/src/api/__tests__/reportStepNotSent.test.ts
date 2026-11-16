import { describe, expect, it } from "vitest";
import { ReportStepSchema } from "../schemas";

describe("ReportStep not_sent wire", () => {
  const base = {
    step_id: "s1",
    count: 10,
    error_count: 4,
    status_counts: { "200": 6 },
    p50_ms: 48,
    p95_ms: 60,
    p99_ms: 70,
  };

  it("reportStep_parses_with_and_without_not_sent", () => {
    expect(ReportStepSchema.parse({ ...base, not_sent: 3 }).not_sent).toBe(3);
    expect(ReportStepSchema.parse(base).not_sent).toBeUndefined();
    expect(() => ReportStepSchema.parse({ ...base, not_sent: "x" })).toThrow();
  });
});
