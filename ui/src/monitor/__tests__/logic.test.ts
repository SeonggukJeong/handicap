import { describe, expect, it } from "vitest";
import type { CheckResult, Threshold } from "../../api/monitors";
import {
  axisAgoLabel,
  barColor,
  barSlots,
  bigValueText,
  formatMs,
  FONT_SCALE,
  gridFor,
  panelState,
  showConsecutive,
  staleAfterMs,
} from "../logic";

const ok = (at: number, ms: number | null): CheckResult => ({
  at_ms: at,
  verdict: "ok",
  latency_ms: ms,
  reason: null,
});
const th: Threshold[] = [
  { ms: 1000, color: "#f59e0b" },
  { ms: 3000, color: "#ef4444" },
];
const base = {
  nowMs: 100_000,
  startedAtMs: 50_000,
  enabled: true,
  serverDown: false,
  intervalSec: 10,
  timeoutSec: 5,
  thresholds: th,
};

describe("logic", () => {
  it("formatMs_integer_commas", () => {
    expect(formatMs(1350)).toBe("1,350 ms");
    expect(formatMs(7)).toBe("7 ms");
  });
  it("barColor_highest_crossed", () => {
    expect(barColor(999, th)).toBe("#22c55e");
    expect(barColor(1000, th)).toBe("#f59e0b");
    expect(barColor(5000, th)).toBe("#ef4444");
    expect(barColor(5000, [])).toBe("#22c55e");
  });
  it("slots_left_fill", () => {
    const s = barSlots([ok(1, 1), ok(2, 2)], 10);
    expect(s).toHaveLength(10);
    expect(s[0]?.at_ms).toBe(1);
    expect(s[1]?.at_ms).toBe(2);
    expect(s[2]).toBeNull();
  });
  it("slots_evict_oldest", () => {
    const rs = Array.from({ length: 12 }, (_, i) => ok(i, i));
    const s = barSlots(rs, 10);
    expect(s).toHaveLength(10);
    expect(s[0]?.at_ms).toBe(2);
    expect(s[9]?.at_ms).toBe(11);
  });
  it("state_slow_uses_current_thresholds", () => {
    const latest = ok(99_000, 1500);
    expect(panelState({ ...base, latest })).toBe("slow");
    expect(panelState({ ...base, latest, thresholds: [] })).toBe("ok");
    expect(panelState({ ...base, latest: ok(99_000, null) })).toBe("ok");
  });
  it("state_fail_and_config_error", () => {
    const f: CheckResult = { at_ms: 99_000, verdict: "fail", latency_ms: null, reason: "x" };
    const c: CheckResult = { ...f, verdict: "config_error" };
    expect(panelState({ ...base, latest: f })).toBe("fail");
    expect(panelState({ ...base, latest: c })).toBe("config_error");
  });
  it("stale_after_grace", () => {
    expect(staleAfterMs(10, 5)).toBe(40_000);
    const latest = ok(60_000, 5);
    expect(panelState({ ...base, latest, nowMs: 100_000 })).toBe("stale");
    expect(panelState({ ...base, latest, nowMs: 99_000 })).toBe("ok");
  });
  it("pending_until_grace_after_start", () => {
    expect(panelState({ ...base, nowMs: 60_000 })).toBe("pending");
    expect(panelState({ ...base, nowMs: 100_000 })).toBe("stale");
    expect(panelState({ ...base, startedAtMs: null })).toBe("pending");
  });
  it("stale_off_when_disabled", () => {
    expect(panelState({ ...base, enabled: false, latest: ok(99_000, 1) })).toBe("stale_off");
  });
  it("server_down_forces_stale", () => {
    expect(panelState({ ...base, serverDown: true, enabled: false, latest: ok(99_000, 1) })).toBe(
      "stale",
    );
  });
  it("grid_table", () => {
    const t: [number, number, number][] = [
      [1, 1, 1],
      [2, 2, 1],
      [3, 3, 1],
      [4, 2, 2],
      [5, 3, 2],
      [6, 3, 2],
      [7, 3, 3],
      [9, 3, 3],
    ];
    for (const [n, cols, rows] of t) expect(gridFor(n)).toEqual({ cols, rows });
  });
  it("axis_labels", () => {
    expect(axisAgoLabel(60, 10)).toBe("10분");
    expect(axisAgoLabel(10, 5)).toBe("50초");
    expect(axisAgoLabel(100, 60)).toBe("1시간 40분");
    expect(axisAgoLabel(60, 60)).toBe("1시간");
  });
  it("big_value_text_cases", () => {
    expect(bigValueText("ok", ok(1, 1350))).toBe("1,350 ms");
    expect(bigValueText("slow", ok(1, 1350))).toBe("1,350 ms");
    expect(bigValueText("ok", ok(1, null))).toBe("—");
    const f: CheckResult = {
      at_ms: 1,
      verdict: "fail",
      latency_ms: null,
      reason: "시간 초과(5초)",
    };
    expect(bigValueText("fail", f)).toBe("시간 초과(5초)");
    expect(bigValueText("config_error", { ...f, reason: "r" })).toBe("r");
    expect(bigValueText("stale", f)).toBe("—");
    expect(bigValueText("stale_off", undefined)).toBe("—");
    expect(bigValueText("pending", undefined)).toBe("—");
  });
  it("consecutive_threshold", () => {
    expect(showConsecutive(1)).toBe(false);
    expect(showConsecutive(2)).toBe(true);
  });
  it("font_scale", () => {
    expect(FONT_SCALE).toEqual({ small: 0.7, medium: 0.85, large: 1, xlarge: 1.2 });
  });
});
