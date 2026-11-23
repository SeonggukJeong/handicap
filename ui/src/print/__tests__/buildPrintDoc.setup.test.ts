import { describe, expect, it } from "vitest";
import { buildPrintDoc, standardBlocks, summaryBlocks } from "../buildPrintDoc";
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

const speedBands = {
  overall: { slow_ms: 3000, basis: "default" as const, own: false, fast: 10, within: 5, over: 0 },
  steps: [],
};
const setupStep = (kinds: Record<string, number>) => ({
  step_id: "p0",
  count: 50,
  errors: 0,
  p50_ms: 84,
  p95_ms: 120,
  max_ms: 163,
  status_counts: { "200": 50 },
  failure_kinds: kinds,
});
const ids = (r: Report) => standardBlocks(build(r), new Map()).map((b) => b.id);

describe("buildPrintDoc 준비 스텝 절", () => {
  const withSetup = (kinds: Record<string, number> = {}, extra: Partial<Report> = {}) =>
    report({ setup: { ok: 47, failed: 3, interrupted: 0, steps: [setupStep(kinds)] }, ...extra });

  it("준비가 있으면 doc.setup과 절 번호가 켜진다", () => {
    const d = build(withSetup());
    expect(d.setup).not.toBeNull();
    expect(d.sectionNo.setup).toBe("3. 준비 스텝 결과");
    expect(d.sectionNo.chart).toBe("4. 시간에 따른 변화");
    const d2 = build(withSetup({}, { speed_bands: speedBands }));
    expect(d2.sectionNo.setup).toBe("3. 준비 스텝 결과");
    expect(d2.sectionNo.speed).toBe("4. 단계별 응답 속도 구간");
  });

  it("setup 블록은 table 뒤 chart 앞, 속도 구간이 있으면 speed 앞", () => {
    expect(ids(withSetup())).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
      "setup",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
    expect(ids(withSetup({}, { speed_bands: speedBands }))).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
      "setup",
      "speed",
      "speed:notes",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
  });

  it("setup:kinds는 실패 종류가 있을 때만", () => {
    expect(ids(withSetup())).not.toContain("setup:kinds");
    const withKinds = ids(withSetup({ status_assert: 3 }));
    expect(withKinds).toContain("setup:kinds");
    expect(withKinds.indexOf("setup:kinds")).toBe(withKinds.indexOf("setup") + 1);
  });

  it("준비가 없으면 블록 목록이 이전과 같다", () => {
    expect(build(report()).setup).toBeNull();
    expect(ids(report())).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
    expect(ids(report({ speed_bands: speedBands }))).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
      "speed",
      "speed:notes",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
  });

  it("요약판 블록에는 준비가 없다", () => {
    const d = build(withSetup({ status_assert: 3 }));
    for (const level of [0, 4, 8] as const) {
      const got = summaryBlocks(d, new Map(), level).map((b) => b.id);
      expect(got).not.toContain("setup");
      expect(got).not.toContain("setup:kinds");
    }
    expect(d.meta.setupNote).toBeDefined();
  });
});
