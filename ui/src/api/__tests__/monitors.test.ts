import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newPanel,
  PreviewSchema,
  StatusSchema,
  BoardSchema,
  CheckResultSchema,
  CheckRecordSchema,
  getRecord,
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
          results: [
            { at_ms: 1, verdict: "ok", latency_ms: null, reason: null, detail: null, display: [] },
          ],
          consecutive_fail: 0,
          check_budget_seconds: 5,
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
      result: {
        at_ms: 1,
        verdict: "fail",
        latency_ms: null,
        reason: "x",
        detail: null,
        display: [],
      },
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
        record_limit_kb: 128,
        panels: [{ ...newPanel(), latency_source: { kind: "step", step_id: "S" } }],
      },
    });
    expect(b.config.panels[0]?.environment_id).toBeNull();
  });
  it("schema_optional_group_fields", () => {
    const cfg = {
      font_scale: "large",
      display_style: "border",
      blink: "fail",
      show_latency_stats: false,
      record_limit_kb: 128,
    };
    const mkBoard = (config: object) => ({
      id: "b",
      name: "n",
      enabled: true,
      created_at: 1,
      updated_at: 2,
      config,
    });
    const plain = BoardSchema.parse(mkBoard({ ...cfg, panels: [newPanel()] }));
    expect(plain.config.groups).toBeUndefined();
    expect(plain.config.panels[0]?.group_id).toBeUndefined();
    expect(plain.config.panels[0]?.step_id).toBeUndefined();
    const grp = { id: "G", scenario_id: "S", environment_id: null, interval_seconds: 10 };
    const full = BoardSchema.parse(
      mkBoard({ ...cfg, groups: [grp], panels: [{ ...newPanel(), group_id: "G", step_id: "T" }] }),
    );
    expect(full.config.groups).toEqual([grp]);
    expect(full.config.panels[0]?.group_id).toBe("G");
    expect(full.config.panels[0]?.step_id).toBe("T");
    const st = {
      now_ms: 1,
      board_updated_at: 2,
      enabled: true,
      started_at_ms: null,
      panels: [
        { panel_id: "p", results: [], consecutive_fail: 0, fail_since_ms: null, running: false },
      ],
    };
    expect(StatusSchema.safeParse(st).success).toBe(false);
    for (const v of ["upstream_failed", "branch_skipped"]) {
      expect(
        CheckResultSchema.safeParse({
          at_ms: 1,
          verdict: v,
          latency_ms: null,
          reason: "x",
          detail: null,
          display: [],
        }).success,
      ).toBe(true);
    }
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
    const cfg = {
      font_scale: "large",
      display_style: "fill",
      blink: "off",
      record_limit_kb: 128,
      panels: [panel],
    };
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
  it("board requires record_limit_kb", () => {
    const base = {
      font_scale: "large",
      display_style: "fill",
      blink: "off",
      show_latency_stats: true,
      panels: [],
    };
    const mk = (config: unknown) => ({
      id: "b",
      name: "n",
      enabled: false,
      created_at: 1,
      updated_at: 1,
      config,
    });
    expect(BoardSchema.parse(mk({ ...base, record_limit_kb: 256 })).config.record_limit_kb).toBe(
      256,
    );
    expect(() => BoardSchema.parse(mk(base))).toThrow();
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
          record_limit_kb: 128,
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

describe("CheckRecordSchema", () => {
  const result = {
    at_ms: 1,
    verdict: "ok",
    latency_ms: 5,
    reason: null,
    detail: null,
    display: [],
  };
  it("record_schema_parses_server_shape", () => {
    const r = CheckRecordSchema.parse({
      at_ms: 1,
      limit_kb: 128,
      result,
      trace: null,
      clipped: [],
    });
    expect(r.trace).toBeNull();
    expect(r.clipped).toEqual([]);
    expect(() =>
      CheckRecordSchema.parse({ at_ms: 1, limit_kb: 128, result, trace: null }),
    ).toThrow();
    expect(() =>
      CheckRecordSchema.parse({
        at_ms: 1,
        limit_kb: 128,
        result,
        trace: null,
        clipped: [{ step: 0, side: "both" }],
      }),
    ).toThrow();
  });

  it("getRecord_fetches_record_url_and_404_is_ApiError", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ at_ms: 7, limit_kb: 128, result, trace: null, clipped: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    vi.stubGlobal("fetch", f);
    const out = await getRecord("b1", "p1", 7);
    expect(out.at_ms).toBe(7);
    expect(f.mock.calls[0][0]).toBe("/api/monitor-boards/b1/panels/p1/records/7");
    await expect(getRecord("b1", "p1", 7)).rejects.toMatchObject({ status: 404 });
  });
});
