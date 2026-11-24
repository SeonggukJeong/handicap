import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";
import type { Profile, Report } from "../../../api/schemas";

vi.mock("../../../api/download", () => ({
  downloadFile: vi.fn(() => Promise.resolve()),
  downloadJson: vi.fn(() => Promise.resolve()),
}));

const SETUP_ID = "01HX0000000000000000000001";
const STEP_ID = "01HX0000000000000000000002";

const YAML = [
  "version: 1",
  "name: x",
  "cookie_jar: auto",
  "variables: {}",
  "setup:",
  "  steps:",
  `    - id: ${SETUP_ID}`,
  "      name: 로그인 준비",
  "      type: http",
  "      request:",
  "        method: POST",
  "        url: http://x/login",
  "steps:",
  `  - id: ${STEP_ID}`,
  "    name: 조회",
  "    type: http",
  "    request:",
  "      method: GET",
  "      url: http://x/o",
  "",
].join("\n");

const BASE: Report = {
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
  scenario_yaml: YAML,
  summary: {
    count: 15,
    errors: 0,
    rps: 7.5,
    duration_seconds: 2,
    mean_ms: 20,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [],
  steps: [
    {
      step_id: STEP_ID,
      count: 15,
      error_count: 0,
      status_counts: { "200": 15 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  status_distribution: { "200": 15 },
  dropped: 0,
};

const PROFILE = { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 } as Profile;

function renderIt(report: Report) {
  return render(
    <MemoryRouter>
      <ReportView report={report} profile={PROFILE} />
    </MemoryRouter>,
  );
}

const SUMMARY_LINE =
  "요약·판정에는 준비 스텝이 들어 있지 않습니다. 본 스텝은 준비 스텝을 마친 상태에서 측정했습니다.";

describe("ReportView 준비 스텝", () => {
  it("setup이 없으면 구획도 안내 줄도 없다", () => {
    renderIt(BASE);
    expect(screen.queryByRole("region", { name: "준비 스텝" })).not.toBeInTheDocument();
    expect(screen.queryByText(SUMMARY_LINE)).not.toBeInTheDocument();
  });

  it("setup이 있으면 구획과 안내 줄이 나오고 이름은 준비 스텝에서 온다", () => {
    renderIt({
      ...BASE,
      setup: {
        ok: 1,
        failed: 1,
        interrupted: 0,
        steps: [
          {
            step_id: SETUP_ID,
            count: 2,
            errors: 1,
            p50_ms: 5,
            p95_ms: 6,
            max_ms: 7,
            status_counts: { "200": 1 },
            failure_kinds: { status_assert: 1 },
          },
        ],
      },
    });
    expect(screen.getByRole("region", { name: "준비 스텝" })).toBeInTheDocument();
    expect(screen.getByText(SUMMARY_LINE)).toBeInTheDocument();
    expect(screen.getByText("로그인 준비")).toBeInTheDocument();
  });

  const ZERO_SUMMARY = { ...BASE.summary, count: 0, errors: 0, rps: 0 };
  const SETUP_ONLY_LINE = "본 스텝이 없어서 준비 스텝만 실행했습니다.";
  const NO_REQUESTS_LINE = "요청이 기록되지 않았습니다 — 시나리오 URL과 워커 상태를 확인하세요.";
  const SETUP_REPORT = {
    ok: 1,
    failed: 0,
    interrupted: 0,
    steps: [
      {
        step_id: SETUP_ID,
        count: 1,
        errors: 0,
        p50_ms: 5,
        p95_ms: 6,
        max_ms: 7,
        status_counts: { "200": 1 },
        failure_kinds: {},
      },
    ],
  };

  it("본 스텝이 없고 준비 스텝만 있는 run의 맨 위 문장은 준비만 실행했다고 말한다", () => {
    const setupOnlyYaml = YAML.slice(0, YAML.indexOf("steps:\n  - id:")) + "steps: []\n";
    renderIt({
      ...BASE,
      scenario_yaml: setupOnlyYaml,
      summary: ZERO_SUMMARY,
      steps: [],
      status_distribution: {},
      setup: SETUP_REPORT,
    });
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(SETUP_ONLY_LINE);
    expect(region).not.toHaveTextContent(NO_REQUESTS_LINE);
  });

  const SETUP_FAILED_LINE =
    "준비 스텝이 실패해서 본 스텝을 실행하지 못했습니다 — 아래 「준비 스텝」에서 원인을 확인하세요.";
  const SETUP_INTERRUPTED_LINE =
    "준비 스텝이 끝나기 전에 실행이 끝나서 본 스텝을 실행하지 못했습니다.";

  it("본 스텝이 있는데 준비가 실패해 0건이면 맨 위 문장이 준비 실패를 말한다", () => {
    renderIt({
      ...BASE,
      summary: ZERO_SUMMARY,
      steps: [],
      status_distribution: {},
      setup: { ...SETUP_REPORT, ok: 0, failed: 1 },
    });
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(SETUP_FAILED_LINE);
    expect(region).not.toHaveTextContent(NO_REQUESTS_LINE);
    expect(region).not.toHaveTextContent(SETUP_ONLY_LINE);
  });

  it("준비가 끝나기 전에 실행이 끝나 0건이면 맨 위 문장이 그렇게 말한다", () => {
    renderIt({
      ...BASE,
      summary: ZERO_SUMMARY,
      steps: [],
      status_distribution: {},
      setup: { ...SETUP_REPORT, ok: 0, failed: 0, interrupted: 2 },
    });
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(SETUP_INTERRUPTED_LINE);
    expect(region).not.toHaveTextContent(NO_REQUESTS_LINE);
  });

  it("준비는 끝났는데 본 요청이 0건이면 맨 위 문장은 예전 그대로다", () => {
    renderIt({
      ...BASE,
      summary: ZERO_SUMMARY,
      steps: [],
      status_distribution: {},
      setup: SETUP_REPORT,
    });
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(NO_REQUESTS_LINE);
    expect(region).not.toHaveTextContent(SETUP_FAILED_LINE);
  });
});

describe("ReportView 상태 코드 규칙과 유효성 안내", () => {
  const withRule = (rule: 1 | 2, reasons: NonNullable<Report["validity"]>["reasons"]): Report => ({
    ...BASE,
    run: { ...BASE.run, ...(rule === 2 ? { status_rule: 2 } : {}) } as Report["run"],
    validity: { level: "limited", reasons },
  });

  it("규칙 2: 이름표(시나리오 YAML)의 스텝 이름과 새 안내 글이 나온다", () => {
    renderIt(
      withRule(2, [
        { kind: "status_unchecked_errors", severity: "warning", step_id: STEP_ID, count: 1204 },
        { kind: "no_response_validation", severity: "warning" },
      ]),
    );
    expect(
      screen.getByText(
        "상태 코드를 보지 않는 스텝 「조회」이 4xx·5xx 응답 1,204건을 받았습니다. 상태 코드로는 오류로 세지 않았습니다",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("상태 코드 검사와 판정 기준이 없어 성공·실패를 확정할 수 없습니다"),
    ).toBeInTheDocument();
  });

  it("규칙 1: 옛 안내 글", () => {
    renderIt(withRule(1, [{ kind: "no_response_validation", severity: "warning" }]));
    expect(
      screen.getByText("응답 검증(status assert)과 SLO 기준이 없어 성공·실패를 확정할 수 없습니다"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("상태 코드 검사와 판정 기준이 없어 성공·실패를 확정할 수 없습니다"),
    ).not.toBeInTheDocument();
  });
});
