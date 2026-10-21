import { describe, expect, it } from "vitest";
import { newPanel, PreviewSchema, StatusSchema, BoardSchema } from "../monitors";

describe("monitors schemas", () => {
  it("status payload with nulls parses", () => {
    const s = StatusSchema.parse({
      now_ms: 1,
      board_updated_at: 2,
      enabled: false,
      started_at_ms: null,
      panels: [
        {
          panel_id: "p",
          results: [{ at_ms: 1, verdict: "ok", latency_ms: null, reason: null }],
          consecutive_fail: 0,
          fail_since_ms: null,
          running: false,
        },
      ],
    });
    expect(s.started_at_ms).toBeNull();
  });
  it("preview payload with null trace parses", () => {
    const p = PreviewSchema.parse({
      trace: null,
      result: { at_ms: 1, verdict: "fail", latency_ms: null, reason: "x" },
    });
    expect(p.trace).toBeNull();
  });
  it("board parses with step latency_source and null environment", () => {
    const b = BoardSchema.parse({
      id: "b",
      name: "n",
      enabled: true,
      created_at: 1,
      updated_at: 2,
      config: {
        font_scale: "xlarge",
        blink: "slow_and_fail",
        panels: [{ ...newPanel(), latency_source: { kind: "step", step_id: "S" } }],
      },
    });
    expect(b.config.panels[0]?.environment_id).toBeNull();
  });
  it("new_panel_ids_unique", () => {
    const a = newPanel();
    const b = newPanel();
    expect(a.id).toHaveLength(26);
    expect(a.id).not.toBe(b.id);
    expect(a.interval_seconds).toBe(10);
    expect(a.thresholds).toEqual([]);
  });
});
