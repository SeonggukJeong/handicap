import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newPanel,
  PreviewSchema,
  StatusSchema,
  BoardSchema,
  CheckResultSchema,
  setLatencyStats,
} from "../monitors";

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
          results: [{ at_ms: 1, verdict: "ok", latency_ms: null, reason: null, detail: null, display: [] }],
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
      result: { at_ms: 1, verdict: "fail", latency_ms: null, reason: "x", detail: null, display: [] },
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
        display_style: "border",
        blink: "slow_and_fail",
        show_latency_stats: true,
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

describe("polish wire fields", () => {
  const res = { at_ms: 1, verdict: "ok", latency_ms: 1, reason: null, detail: null };
  it("check result parses display with nulls and requires it", () => {
    const r = CheckResultSchema.parse({ ...res, display: ["0000", null] });
    expect(r.display).toEqual(["0000", null]);
    expect(() => CheckResultSchema.parse(res)).toThrow();
  });
  it("board requires display_items and show_latency_stats", () => {
    const panel = {
      ...newPanel(),
      display_items: [{ step_id: "S", source: "body", path: "$.a" }],
    };
    const cfg = { font_scale: "large", display_style: "fill", blink: "off", panels: [panel] };
    const mk = (config: unknown) => ({
      id: "b",
      name: "n",
      enabled: false,
      created_at: 1,
      updated_at: 1,
      config,
    });
    const b = BoardSchema.parse(mk({ ...cfg, show_latency_stats: false }));
    expect(b.config.show_latency_stats).toBe(false);
    expect(b.config.panels[0]?.display_items[0]?.source).toBe("body");
    expect(() => BoardSchema.parse(mk(cfg))).toThrow();
    const noItems = { ...panel } as Record<string, unknown>;
    delete noItems.display_items;
    expect(() =>
      BoardSchema.parse(mk({ ...cfg, show_latency_stats: true, panels: [noItems] })),
    ).toThrow();
    expect(newPanel().display_items).toEqual([]);
  });
  describe("setLatencyStats", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("PUTs {show} to latency-stats", async () => {
      const board = {
        id: "b1",
        name: "n",
        enabled: false,
        created_at: 1,
        updated_at: 1,
        config: {
          font_scale: "large",
          display_style: "fill",
          blink: "off",
          show_latency_stats: false,
          panels: [],
        },
      };
      const f = vi.fn().mockResolvedValue(new Response(JSON.stringify(board), { status: 200 }));
      vi.stubGlobal("fetch", f);
      const out = await setLatencyStats("b1", false);
      expect(out.config.show_latency_stats).toBe(false);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/monitor-boards/b1/latency-stats");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({ show: false });
    });
    it("throws ApiError on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nf" }), { status: 404 })),
      );
      await expect(setLatencyStats("b1", true)).rejects.toMatchObject({ status: 404 });
    });
  });
});
