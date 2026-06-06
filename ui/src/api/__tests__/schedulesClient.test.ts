import { describe, it, expect, vi, afterEach } from "vitest";
import { listSchedules, previewNext, type ScheduleInput } from "../schedules";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("listSchedules", () => {
  it("unwraps {schedules:[...]} and parses summaries", async () => {
    mockFetchOnce({
      schedules: [
        {
          id: "01",
          name: "n",
          scenario_id: "s",
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
          next_run_at: 1,
          last_status: null,
          last_fired_at: null,
        },
      ],
    });
    const rows = await listSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger.kind).toBe("cron");
  });
});

describe("previewNext", () => {
  it("posts trigger+count and returns next[]", async () => {
    mockFetchOnce({ next: [100, 200, 300] });
    const r = await previewNext({ kind: "cron", cron_expr: "*/15 * * * *" }, 3);
    expect(r).toEqual([100, 200, 300]);
  });
});

describe("ScheduleInput type", () => {
  it("compiles with once + cron triggers", () => {
    const a: ScheduleInput = {
      name: "x",
      scenario_id: "s",
      profile: {
        vus: 1,
        duration_seconds: 1,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
      },
      env: {},
      trigger: { kind: "once", run_at: 1 },
      enabled: true,
    };
    const b: ScheduleInput = { ...a, trigger: { kind: "cron", cron_expr: "0 2 * * *" } };
    expect(a.trigger.kind).toBe("once");
    expect(b.trigger.kind).toBe("cron");
  });
});
