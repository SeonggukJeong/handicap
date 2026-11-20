import type { Report } from "../../../api/schemas";
import type { RunMeta } from "../pair";

export type StepSpec = {
  id: string;
  name: string;
  assert?: number[];
  extract?: boolean;
};

const q = (s: string) => JSON.stringify(s);

/** 엔진 저장 형태의 시나리오 YAML: 검사는 `assert: [{status: N}]`, 추출은 `from` 태그. */
export function scenarioYaml(steps: StepSpec[], name = "민원 신청 흐름"): string {
  let y = `version: 1\nname: ${q(name)}\nsteps:\n`;
  for (const s of steps) {
    y += `  - id: ${q(s.id)}\n    name: ${q(s.name)}\n    request:\n`;
    y += `      method: GET\n      url: ${q(`https://api.example.com/${s.id}`)}\n`;
    if (s.assert && s.assert.length > 0) {
      y += `    assert:\n`;
      for (const c of s.assert) y += `      - status: ${c}\n`;
    }
    if (s.extract) {
      y += `    extract:\n      - name: tok\n        from: body\n        path: "$.t"\n`;
    }
  }
  return y;
}

export type ReportStepSpec = {
  id: string;
  counts: Record<string, number>;
  errors: number;
  p95?: number;
  notSent?: number;
};

export type MkReportArgs = {
  id: string;
  steps: ReportStepSpec[];
  yaml: string;
  summary?: Partial<Report["summary"]>;
  profile?: Record<string, unknown>;
  env?: Record<string, string> | null;
  status?: string;
  verdict?: Report["verdict"];
};

const T0 = 1_700_000_000_000;

export const baseProfile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

export function mkReport(a: MkReportArgs): Report {
  const count = a.steps.reduce((n, s) => n + Object.values(s.counts).reduce((x, y) => x + y, 0), 0);
  const errors = a.steps.reduce((n, s) => n + s.errors, 0);
  const status = a.status ?? "completed";
  const profile = a.profile ?? baseProfile;
  const env = a.env ?? null;
  return {
    run: {
      id: a.id,
      scenario_id: "sc1",
      status,
      profile,
      env,
      started_at: T0,
      ended_at: T0 + 300_000,
      created_at: T0,
    },
    scenario_yaml: a.yaml,
    summary: {
      count,
      errors,
      rps: count / 300,
      duration_seconds: 300,
      mean_ms: 840,
      p50_ms: 500,
      p95_ms: 2400,
      p99_ms: 3000,
      ...a.summary,
    },
    windows: [],
    steps: a.steps.map((s) => ({
      step_id: s.id,
      count: Object.values(s.counts).reduce((x, y) => x + y, 0),
      error_count: s.errors,
      status_counts: s.counts,
      p50_ms: 100,
      p95_ms: s.p95 ?? 600,
      p99_ms: 900,
      ...(s.notSent ? { not_sent: s.notSent } : {}),
    })),
    status_distribution: {},
    verdict: a.verdict ?? null,
    dropped: 0,
    latency: null,
  } as Report;
}

export function mkMeta(id: string, over: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    status: "completed",
    started_at: T0,
    ended_at: T0 + 300_000,
    created_at: T0,
    label: null,
    message: null,
    ...over,
  };
}
