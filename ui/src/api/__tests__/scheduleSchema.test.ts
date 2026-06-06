import { describe, it, expect } from "vitest";
import {
  ScheduleSchema,
  ScheduleSummarySchema,
  TriggerSchema,
  ScheduleEventSchema,
} from "../schemas";

describe("TriggerSchema", () => {
  it("parses once + cron variants by kind", () => {
    expect(TriggerSchema.parse({ kind: "once", run_at: 1_700_000_000_000 })).toEqual({
      kind: "once",
      run_at: 1_700_000_000_000,
    });
    expect(TriggerSchema.parse({ kind: "cron", cron_expr: "0 2 * * *" })).toEqual({
      kind: "cron",
      cron_expr: "0 2 * * *",
    });
  });
});

describe("ScheduleSchema", () => {
  it("accepts server null for optional fields (.nullish, S-D trap)", () => {
    const wire = {
      id: "01J",
      name: "nightly",
      scenario_id: "01S",
      profile: { vus: 4, duration_seconds: 30 },
      env: { BASE_URL: "https://x" },
      trigger: { kind: "cron", cron_expr: "0 2 * * *" },
      enabled: true,
      next_run_at: 1_700_000_000_000,
      last_run_id: null,
      last_fired_at: null,
      last_status: null,
      last_error: null,
      created_at: 1,
      updated_at: 2,
    };
    const s = ScheduleSchema.parse(wire);
    expect(s.trigger.kind).toBe("cron");
    expect(s.last_run_id).toBeNull();
  });
});

describe("ScheduleSummarySchema", () => {
  it("has no profile/env/last_run_id/last_error (목록 요약)", () => {
    const wire = {
      id: "01J",
      name: "n",
      scenario_id: "01S",
      trigger: { kind: "once", run_at: 1 },
      enabled: false,
      next_run_at: null,
      last_status: "fired",
      last_fired_at: 1,
    };
    expect(ScheduleSummarySchema.parse(wire).enabled).toBe(false);
  });
});

describe("ScheduleEventSchema", () => {
  it("parses event with null run_id/detail", () => {
    expect(
      ScheduleEventSchema.parse({
        id: "e1",
        at: 5,
        kind: "skipped_overlap",
        run_id: null,
        detail: "overlap",
      }).kind,
    ).toBe("skipped_overlap");
  });
});
