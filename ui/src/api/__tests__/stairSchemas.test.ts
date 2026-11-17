import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { ProfileSchema, ReportSchema, StairConfigSchema, StairReportSchema } from "../schemas";
import { api } from "../client";

const golden = JSON.parse(
  readFileSync(nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"), "utf8"),
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
