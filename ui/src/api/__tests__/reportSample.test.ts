import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../client";
import { queryKeys } from "../hooks";
import { CriterionResultSchema, ReportSchema, reportSample } from "../schemas";

const minimalReport = {
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: x\nsteps: []\n",
  summary: {
    count: 10,
    errors: 1,
    rps: 5.0,
    duration_seconds: 2,
    mean_ms: 30,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [],
  steps: [],
  status_distribution: { "200": 9, "500": 1 },
  dropped: 0,
};

describe("report sample wire", () => {
  it("sample 있는 리포트·없는 리포트 둘 다 통과한다", () => {
    const withSample = ReportSchema.parse({
      ...minimalReport,
      sample: { selected: "passed", default: "passed", split: true },
    });
    expect(withSample.sample).toEqual({ selected: "passed", default: "passed", split: true });
    expect(ReportSchema.parse(minimalReport).sample).toBeUndefined();
  });

  it("sample의 모르는 키·모르는 이름은 거절한다", () => {
    expect(() =>
      ReportSchema.parse({
        ...minimalReport,
        sample: { selected: "all", default: "all", split: false, x: 1 },
      }),
    ).toThrow();
    expect(() =>
      ReportSchema.parse({
        ...minimalReport,
        sample: { selected: "some", default: "all", split: false },
      }),
    ).toThrow();
  });

  it("no_sample: true 행이 통과하고 생략 행도 통과한다", () => {
    const row = {
      metric: "p99_ms",
      direction: "max",
      threshold: 100,
      actual: 0,
      passed: false,
    };
    expect(CriterionResultSchema.parse({ ...row, no_sample: true }).no_sample).toBe(true);
    expect(CriterionResultSchema.parse(row).no_sample).toBeUndefined();
  });

  it("reportSample은 sample이 없으면 all/all/false", () => {
    expect(reportSample(ReportSchema.parse(minimalReport))).toEqual({
      selected: "all",
      default: "all",
      split: false,
    });
    expect(
      reportSample(
        ReportSchema.parse({
          ...minimalReport,
          sample: { selected: "failed", default: "passed", split: true },
        }),
      ),
    ).toEqual({ selected: "failed", default: "passed", split: true });
  });
});

describe("getRunReport URL", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function urlOf(call: () => Promise<unknown>): Promise<string> {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await call().catch(() => undefined);
    return (fetchMock.mock.calls[0] as unknown as [string])[0];
  }

  it("basis와 sample을 이 순서로 붙인다", async () => {
    expect(await urlOf(() => api.getRunReport("r", "whole", "all"))).toMatch(
      /\/report\?basis=whole&sample=all$/,
    );
    expect(await urlOf(() => api.getRunReport("r", undefined, "all"))).toMatch(
      /\/report\?sample=all$/,
    );
    expect(await urlOf(() => api.getRunReport("r", "steady"))).toMatch(/\/report\?basis=steady$/);
    expect(await urlOf(() => api.getRunReport("r"))).toMatch(/\/report$/);
  });
});

describe("queryKeys.runReport sample", () => {
  it("표본이 다르면 열쇠가 다르고 run 접두사는 같다", () => {
    const base = queryKeys.runReport("r");
    const all = queryKeys.runReport("r", undefined, "all");
    expect(base).not.toEqual(all);
    expect(all.slice(0, 3)).toEqual(["runs", "r", "report"]);
  });
});
