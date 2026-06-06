import { describe, it, expect } from "vitest";
import { compileTrigger, describeTrigger, type BuilderState } from "../triggerCron";

describe("compileTrigger", () => {
  it("daily → 'M H * * *'", () => {
    const s: BuilderState = {
      mode: "daily",
      time: "02:05",
      days: [],
      everyN: 15,
      unit: "minutes",
      raw: "",
      runAtLocal: "",
    };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "5 2 * * *" });
  });
  it("weekly → 'M H * * d,d' (sorted)", () => {
    const s: BuilderState = {
      mode: "weekly",
      time: "02:00",
      days: [3, 1],
      everyN: 1,
      unit: "minutes",
      raw: "",
      runAtLocal: "",
    };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "0 2 * * 1,3" });
  });
  it("interval minutes → '*/N * * * *'", () => {
    const s: BuilderState = {
      mode: "interval",
      time: "",
      days: [],
      everyN: 15,
      unit: "minutes",
      raw: "",
      runAtLocal: "",
    };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "*/15 * * * *" });
  });
  it("interval hours → '0 */N * * *'", () => {
    const s: BuilderState = {
      mode: "interval",
      time: "",
      days: [],
      everyN: 6,
      unit: "hours",
      raw: "",
      runAtLocal: "",
    };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "0 */6 * * *" });
  });
  it("advanced → raw passthrough", () => {
    const s: BuilderState = {
      mode: "advanced",
      time: "",
      days: [],
      everyN: 1,
      unit: "minutes",
      raw: "30 3 1 * *",
      runAtLocal: "",
    };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "30 3 1 * *" });
  });
  it("once → epoch ms from local datetime", () => {
    const s: BuilderState = {
      mode: "once",
      time: "",
      days: [],
      everyN: 1,
      unit: "minutes",
      raw: "",
      runAtLocal: "2030-01-02T03:04",
    };
    const t = compileTrigger(s);
    expect(t).not.toBeNull();
    if (t !== null && t.kind === "once")
      expect(t.run_at).toBe(new Date("2030-01-02T03:04").getTime());
    else throw new Error("expected once trigger");
  });
  it("returns null for incomplete input (empty daily time / no weekly days / empty raw)", () => {
    expect(
      compileTrigger({
        mode: "daily",
        time: "",
        days: [],
        everyN: 1,
        unit: "minutes",
        raw: "",
        runAtLocal: "",
      }),
    ).toBeNull();
    expect(
      compileTrigger({
        mode: "weekly",
        time: "02:00",
        days: [],
        everyN: 1,
        unit: "minutes",
        raw: "",
        runAtLocal: "",
      }),
    ).toBeNull();
    expect(
      compileTrigger({
        mode: "advanced",
        time: "",
        days: [],
        everyN: 1,
        unit: "minutes",
        raw: "  ",
        runAtLocal: "",
      }),
    ).toBeNull();
  });
});

describe("describeTrigger", () => {
  it("friendly summaries for preset shapes, raw fallback", () => {
    expect(describeTrigger({ kind: "cron", cron_expr: "0 2 * * *" })).toBe("매일 02:00");
    expect(describeTrigger({ kind: "cron", cron_expr: "*/15 * * * *" })).toBe("15분마다");
    expect(describeTrigger({ kind: "cron", cron_expr: "0 */6 * * *" })).toBe("6시간마다");
    expect(describeTrigger({ kind: "cron", cron_expr: "5 2 * * 1,3" })).toBe("매주 월,수 02:05");
    expect(describeTrigger({ kind: "cron", cron_expr: "30 3 1 * *" })).toBe("cron: 30 3 1 * *");
  });
});
