import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import {
  ProfileSchema,
  ReportSchema,
  RunSchema,
  StairConfigSchema,
  StairReportSchema,
} from "../schemas";
import { api } from "../client";

const golden = JSON.parse(
  readFileSync(
    nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"),
    "utf8",
  ),
);

const base = {
  run: {
    id: "R",
    scenario_id: "S",
    status: "completed",
    profile: {},
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: x\nsteps: []\n",
  summary: {
    count: 5,
    errors: 0,
    rps: 2.5,
    duration_seconds: 2,
    mean_ms: 22,
    p50_ms: 20,
    p95_ms: 30,
    p99_ms: 30,
  },
  windows: [],
  steps: [],
  status_distribution: { "200": 5 },
  dropped: 0,
};

describe("StairReportSchema", () => {
  it("parses the Rust golden (with nulls)", () => {
    const r = StairReportSchema.parse(golden);
    expect(r.headline.kind).toBe("saturated");
    expect(r.steps[0].head_p99_ratio).toBe(1);
    expect(r.headline.through_target).toBeNull();
  });
  it("ReportSchema accepts stair and still accepts reports without it", () => {
    const r = ReportSchema.parse({ ...base, stair: golden });
    expect(r.stair?.steps.length).toBe(golden.steps.length);
    expect(ReportSchema.parse(base).stair).toBeUndefined();
  });
  it("accepts null head_p99_ratio (always-serialized Option)", () => {
    const g = structuredClone(golden);
    g.steps[0].head_p99_ratio = null;
    expect(StairReportSchema.parse(g).steps[0].head_p99_ratio).toBeNull();
  });
  it("accepts null on every always-serialized Option path", () => {
    const g = structuredClone(golden);
    g.knee_target = null;
    g.max_in_flight = null;
    g.dropped_total = null;
    g.headline.saturated_target = null;
    g.headline.last_ok_target = null;
    g.headline.through_target = null;
    for (const st of g.steps) {
      st.achieved = null;
      st.launched_rate = null;
      st.dropped = null;
      st.head_p99_ratio = null;
    }
    for (const sec of g.seconds) {
      sec.launched = null;
      sec.completed = null;
      sec.dropped = null;
    }
    expect(StairReportSchema.safeParse(g).success).toBe(true);
  });
  it("rejects an unknown state", () => {
    const g = structuredClone(golden);
    g.steps[0].state = "weird";
    expect(StairReportSchema.safeParse(g).success).toBe(false);
  });
});

describe("StairConfigSchema / ProfileSchema.stair", () => {
  const cfg = { targets: [100, 200], hold_seconds: 30, ramp_seconds: 2, discard_seconds: 5 };
  it("p99_cap_ms is optional", () => {
    expect(StairConfigSchema.parse(cfg).p99_cap_ms).toBeUndefined();
    expect(StairConfigSchema.parse({ ...cfg, p99_cap_ms: 500 }).p99_cap_ms).toBe(500);
  });
  it("profile stair round-trips", () => {
    const p = ProfileSchema.parse({
      vus: 0,
      duration_seconds: 64,
      target_rps: 200,
      stair: { ...cfg, p99_cap_ms: 500 },
    });
    expect(p.stair).toEqual({ ...cfg, p99_cap_ms: 500 });
    expect(ProfileSchema.parse({ vus: 1, duration_seconds: 1 }).stair).toBeUndefined();
  });
});

describe("reportStairsCsvUrl", () => {
  it("points at report-stairs.csv", () => {
    expect(api.reportStairsCsvUrl("a/b")).toMatch(/\/runs\/a%2Fb\/report-stairs\.csv$/);
  });
});

const autoStopGolden = JSON.parse(
  readFileSync(
    nodePath.resolve(__dirname, "../../../../testdata/stair_autostop_report_golden.json"),
    "utf8",
  ),
);

describe("auto-stop schemas", () => {
  it("parses the auto-stop report golden (partial/skipped states, record)", () => {
    const r = StairReportSchema.parse(autoStopGolden);
    expect(r.steps.map((x) => x.state)).toContain("partial");
    expect(r.steps.map((x) => x.state)).toContain("skipped");
    expect(r.steps[4].partial).toEqual({ seconds: 4, phase: "discard" });
    expect(r.auto_stop?.stop?.kind).toBe("saturation");
    expect(r.auto_stop?.stop?.phase).toBeNull();
    expect(r.auto_stop?.suspended_seconds).toBe(2);
  });
  it("still parses the (a) golden without auto_stop", () => {
    expect(StairReportSchema.parse(golden).auto_stop).toBeUndefined();
  });
  const run = {
    id: "R",
    scenario_id: "S",
    scenario_yaml: "x",
    status: "completed",
    profile: { vus: 0, duration_seconds: 10 },
    env: {},
    started_at: 1,
    ended_at: 2,
    created_at: 0,
  };
  it("RunSchema accepts auto_stop with inner nulls, and absent key", () => {
    const rec = {
      stop: {
        kind: "emergency",
        mode: null,
        failed_steps: [],
        decided_step: 1,
        judged_through: 1,
        phase: null,
        decided_at_ms: 1,
        stopped_at_ms: 2,
        emergency: {
          max_error_rate: 0.5,
          max_p99_us: 1,
          seconds: 3,
          error_hit: true,
          p99_hit: false,
        },
        slot_limited: false,
      },
      suspended_seconds: 0,
    };
    expect(RunSchema.parse({ ...run, auto_stop: rec }).auto_stop?.stop?.kind).toBe("emergency");
    expect(
      RunSchema.parse({ ...run, auto_stop: { stop: null, suspended_seconds: 0 } }).auto_stop?.stop,
    ).toBeNull();
    expect(RunSchema.parse(run).auto_stop).toBeUndefined();
  });
  const cfg = { targets: [100], hold_seconds: 30, ramp_seconds: 2, discard_seconds: 5 };
  it("profile stair.auto_stop round-trips with nulls", () => {
    const auto_stop = {
      saturation: null,
      emergency: { error_rate_pct: 50, p99_ms: 3000, consecutive_seconds: 5, min_requests: 20 },
    };
    const p = ProfileSchema.parse({ vus: 0, duration_seconds: 5, stair: { ...cfg, auto_stop } });
    expect(p.stair?.auto_stop).toEqual(auto_stop);
  });
  it("StairConfigSchema stays strict", () => {
    expect(StairConfigSchema.safeParse({ ...cfg, bogus: 1 }).success).toBe(false);
  });
});
