import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepTable } from "../components/StepCodeTable";
import { ReportHeader } from "../components/ReportHeader";
import { buildPrintDoc, type PrintDoc } from "../buildPrintDoc";
import { buildSpeedModel } from "../speedBands";
import { buildStairRows } from "../stairTable";
import { stepStatus, type RankedRow } from "../stepStatus";
import type { StepRow } from "../stepTable";
import { matchedOf, rr, summ, case1Input } from "./speedFixtures";
import { ko } from "../../i18n/ko";
import { StairReportSchema, type Report, type Run, type ReportSampleName } from "../../api/schemas";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const NO_SAMPLE = ko.report.sample.noSample;
const DASH = ko.print.fmt.noTarget;

const profile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  criteria: { max_p95_ms: 3000, max_p99_ms: 5000 },
};
const yaml =
  "version: 1\nname: x\nsteps:\n  - id: s0\n    name: a\n    request:\n      method: GET\n      url: https://api.example.com/p\n";

const run: Run = {
  id: "01HZZZZZZZZZZZZZZZZZa91f3c",
  scenario_id: "sc1",
  scenario_yaml: yaml,
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

const failedReport = (sample: Report["sample"], windows = true): Report => ({
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
  scenario_yaml: yaml,
  summary: {
    count: 200,
    errors: 200,
    rps: 3,
    duration_seconds: 60,
    mean_ms: 0,
    p50_ms: 0,
    p95_ms: 0,
    p99_ms: 0,
  },
  windows: windows
    ? [
        {
          ts_second: 1_700_000_000,
          step_id: "s0",
          count: 200,
          error_count: 200,
          status_counts: { "503": 200 },
          p50_ms: 0,
          p95_ms: 0,
          p99_ms: 0,
        },
      ]
    : [],
  steps: [
    {
      step_id: "s0",
      count: 200,
      error_count: 200,
      status_counts: { "503": 200 },
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
    },
  ],
  status_distribution: { "503": 200 },
  verdict: {
    passed: false,
    criteria: [
      {
        metric: "p95_ms",
        direction: "max",
        threshold: 3000,
        actual: 0,
        passed: false,
        no_sample: true,
      },
      {
        metric: "p99_ms",
        direction: "max",
        threshold: 5000,
        actual: 0,
        passed: false,
        no_sample: true,
      },
    ],
  },
  dropped: 0,
  latency: null,
  ...(sample ? { sample } : {}),
});

const PASSED = { selected: "passed", default: "passed", split: true } as const;
const ALL = { selected: "all", default: "all", split: false } as const;

const docOf = (r: Report): PrintDoc =>
  buildPrintDoc({ run, report: r, fallbackScenarioName: null, now: NOW });

const row = (over: Partial<StepRow>): RankedRow => {
  const r: StepRow = {
    index: 0,
    no: "1",
    stepId: "s0",
    name: "단계",
    requestLine: null,
    executed: true,
    count: 5,
    errorCount: 0,
    p95Ms: 0,
    perCode: [],
    cells: {},
    residual: 0,
    residualUncertain: false,
    notSent: 0,
    factsKnown: true,
    ...over,
  };
  return { ...r, status: stepStatus(r, null) };
};

const p95Cell = (r: RankedRow, sample?: ReportSampleName): string => {
  const { container } = render(
    <StepTable columns={[]} items={[{ kind: "step", row: r }]} sample={sample} />,
  );
  return container.querySelectorAll("tbody tr td")[2].textContent ?? "";
};

describe("인쇄 — 통과한 요청 없는 칸", () => {
  it("단계 표: 전부 실패한 단계는 0ms가 아니라 「–」 (통과한 요청 기준)", () => {
    const text = p95Cell(row({ count: 200, errorCount: 200, p95Ms: 0 }), "passed");
    expect(text).toBe(DASH);
    expect(text).not.toContain("1ms 미만");
  });

  it("단계 표: 모든 요청 기준(옛 run)은 지금 그대로 값을 찍는다", () => {
    expect(p95Cell(row({ count: 200, errorCount: 200, p95Ms: 0 }))).not.toBe(DASH);
  });

  it("문장 목록에 0ms가 없고 판정 문장은 「통과한 요청 없음」을 말한다", () => {
    const doc = docOf(failedReport(PASSED));
    const texts = doc.lines.map((l) => l.text).join("\n");
    expect(texts).not.toMatch(/(?<![\d,.])0ms/);
    expect(texts).toContain(NO_SAMPLE);
  });

  it("문장 목록: 응답 시간 없는 run은 95% 응답시간 문장을 내지 않는다", () => {
    const rep = failedReport(PASSED);
    rep.verdict = null;
    rep.run.profile = { ...profile, criteria: undefined };
    const doc = docOf(rep);
    expect(doc.lines.map((l) => l.text).join("\n")).not.toContain("95% 응답");
  });

  it("KPI 카드: 평균·p95 값은 「–」, 판정 줄은 「측정」 대신 「통과한 요청 없음」", () => {
    const doc = docOf(failedReport(PASSED));
    const by = Object.fromEntries(doc.kpis.map((c) => [c.key, c]));
    expect(by.mean.value).toBe(DASH);
    expect(by.p95.value).toBe(DASH);
    expect(by.p95.target).toBe(`목표 3,000ms 이하 ${ko.print.kpi.missed} (${NO_SAMPLE})`);
    expect(by.p95.target).not.toContain("측정");
    expect(by.rps.value).not.toBe(DASH);
  });

  it("KPI 카드: 옛 run 값은 그대로", () => {
    const rep = failedReport(ALL);
    rep.steps[0].not_sent = 0;
    rep.verdict = null;
    const by = Object.fromEntries(docOf(rep).kpis.map((c) => [c.key, c]));
    expect(by.p95.value).not.toBe(DASH);
  });

  it("기준 표: no_sample 행의 실측 칸은 「통과한 요청 없음」", () => {
    const doc = docOf(failedReport(PASSED));
    const p99 = doc.otherRows.find((r) => r.name.includes("99"));
    expect(p99?.actual).toBe(NO_SAMPLE);
  });

  it("머리 줄: 통과한 요청 기준", () => {
    const doc = docOf(failedReport(PASSED));
    expect(doc.meta.sampleNote).toBe("응답 시간 표본: 통과한 요청");
    const { container } = render(<ReportHeader doc={doc} />);
    expect(container.textContent).toContain("응답 시간 표본: 통과한 요청");
  });

  it("머리 줄: 옛 run은 모든 요청(실패한 요청 포함)", () => {
    const doc = docOf(failedReport(undefined));
    expect(doc.meta.sampleNote).toBe("응답 시간 표본: 모든 요청 (실패한 요청 포함)");
  });

  it("머리 줄: 창이 없으면 줄을 내지 않는다", () => {
    const doc = docOf(failedReport(PASSED, false));
    expect(doc.meta.sampleNote).toBeUndefined();
  });
});

describe("인쇄 — 계단 표", () => {
  const golden = StairReportSchema.parse(
    JSON.parse(
      readFileSync(
        nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"),
        "utf8",
      ),
    ),
  );
  const p99Col = 6;
  const STAIR_DASH = "—";

  it("p99가 0이면 값을 찍지 않고 「–」", () => {
    const idx = 0;
    const base = buildStairRows(golden).rows[idx].cells[p99Col];
    expect(base).not.toBe(STAIR_DASH);
    const steps = golden.steps.map((s, k) => (k === idx ? { ...s, p99_us: 0 } : s));
    expect(buildStairRows({ ...golden, steps }).rows[idx].cells[p99Col]).toBe(STAIR_DASH);
  });
});

describe("인쇄 — 속도 구간 주석", () => {
  const manyNamed = () => {
    const a = case1Input();
    const ranked = [
      rr(0, "로그인", {}, a.criteria),
      rr(1, "민원 목록", {}, a.criteria),
      rr(2, "민원 상세", {}, a.criteria),
      rr(3, "첨부 업로드", { errorCount: 150 }, a.criteria),
      rr(4, "신청 제출", { errorCount: 266 }, a.criteria),
    ];
    return {
      bands: a.bands,
      ranked,
      summary: summ(10000, 540),
      matched: matchedOf(a.criteria, a.failing),
      criteria: a.criteria,
      anyNotSent: false,
    };
  };
  const noteText = (split: boolean): string =>
    buildSpeedModel({ ...manyNamed(), split })
      .notes.map((n) => n.map((s) => s.text).join(""))
      .join("\n");

  it("나눌 수 있는 run: 새 문구만 있고 실패 비율 안내(noteNamed·More)는 없다", () => {
    const t = noteText(true);
    expect(t).toContain("※ 막대에는 통과한 요청만 들어 있습니다.");
    expect(t).not.toContain(ko.print.speed.noteBars);
    expect(t).not.toContain("실패한 응답은 금방 돌아오는 경우가 많아");
    expect(t).not.toContain("실패 비율이 10% 이상입니다");
  });

  it("옛 run: 지금 문구 그대로", () => {
    const t = noteText(false);
    expect(t).toContain("※ 막대에는 실패한 응답의 시간도 들어 있습니다.");
    expect(t).toContain("실패한 응답은 금방 돌아오는 경우가 많아");
    expect(t).toContain("외 1단계도 실패 비율이 10% 이상입니다.");
  });
});
