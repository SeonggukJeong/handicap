import { describe, expect, it } from "vitest";
import { buildPrintDoc } from "../buildPrintDoc";
import { ko } from "../../i18n/ko";
import type { Report, Run } from "../../api/schemas";

const profile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

const YAML = `version: 1\nname: 민원\nsteps:\n  - id: s0\n    name: 단계0\n    request:\n      method: GET\n      url: https://api.example.com/p0\n`;

const run: Run = {
  id: "01HZZZZZZZZZZZZZZZZZa91f3c",
  scenario_id: "sc1",
  scenario_yaml: YAML,
  status: "completed",
  profile: profile as Run["profile"],
  env: null,
  started_at: 1_700_000_000_000,
  ended_at: 1_700_000_060_000,
  created_at: 1_700_000_000_000,
  message: null,
  verdict: null,
  last_metric_ts: null,
  label: null,
};

const report = (over: Partial<Report> = {}): Report => ({
  run: {
    id: run.id,
    scenario_id: "sc1",
    status: "completed",
    profile,
    env: null,
    started_at: run.started_at,
    ended_at: run.ended_at,
    created_at: run.created_at,
  },
  scenario_yaml: YAML,
  summary: {
    count: 1000,
    errors: 10,
    rps: 50,
    duration_seconds: 60,
    mean_ms: 20,
    p50_ms: 15,
    p95_ms: 80,
    p99_ms: 120,
  },
  windows: [],
  steps: [
    {
      step_id: "s0",
      count: 100,
      error_count: 0,
      status_counts: { "200": 100 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  status_distribution: { "200": 100 },
  verdict: null,
  dropped: 0,
  latency: null,
  ...over,
});

const build = (r: Report) =>
  buildPrintDoc({ run, report: r, fallbackScenarioName: null, now: Date.UTC(2026, 10, 5) });

describe("buildPrintDoc 준비 스텝 배선", () => {
  it("report.setup이 있으면 meta.setupNote가 요약 아래 안내 줄과 같은 글자다", () => {
    const doc = build(report({ setup: { ok: 1, failed: 0, interrupted: 0, steps: [] } }));
    expect(doc.meta.setupNote).toBe(ko.report.setup.summaryLine);
    expect(doc.meta.setupNote).toContain("준비 스텝");
  });

  it("report.setup이 없으면 setupNote 키가 없다", () => {
    expect("setupNote" in build(report()).meta).toBe(false);
  });
});
