// jsdom doesn't implement createObjectURL; provide a no-op for the blob download path to run.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:noop", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
}

import { render as rtlRender, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ReportView } from "../ReportView";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type Profile, type Report } from "../../../api/schemas";
import { api } from "../../../api/client";

import { ko } from "../../../i18n/ko";
vi.mock("../../../api/downloadJson", () => ({
  downloadJson: vi.fn().mockResolvedValue(undefined),
}));
import { downloadJson } from "../../../api/downloadJson";
vi.mock("../../../api/download", () => ({ downloadFile: vi.fn().mockResolvedValue(undefined) }));
import { downloadFile } from "../../../api/download";

const STEP_ID = "01HX0000000000000000000001"; // valid ULID (26 chars, Crockford set)

const FIXTURE: Report = {
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: { BASE_URL: "http://x" },
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: [
    "version: 1",
    "name: x",
    "cookie_jar: auto",
    "variables: {}",
    "steps:",
    `  - id: ${STEP_ID}`,
    "    name: login",
    "    type: http",
    "    request:",
    "      method: POST",
    "      url: ${BASE_URL}/login",
    "    assert: []",
    "    extract: []",
    "",
  ].join("\n"),
  summary: {
    count: 15,
    errors: 1,
    rps: 7.5,
    duration_seconds: 2,
    mean_ms: 20,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [
    {
      ts_second: 100,
      step_id: STEP_ID,
      count: 10,
      error_count: 1,
      status_counts: { "200": 9, "500": 1 },
      p50_ms: 10,
      p95_ms: 40,
      p99_ms: 70,
    },
    {
      ts_second: 101,
      step_id: STEP_ID,
      count: 5,
      error_count: 0,
      status_counts: { "200": 5 },
      p50_ms: 8,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  steps: [
    {
      step_id: STEP_ID,
      count: 15,
      error_count: 1,
      status_counts: { "200": 14, "500": 1 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
      loop_breakdown: [],
    },
  ],
  status_distribution: { "200": 14, "500": 1 },
  dropped: 0,
};

const TEST_PROFILE: Profile = {
  vus: 1,
  ramp_up_seconds: 0,
  duration_seconds: 2,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ReportView", () => {
  it("report_print_link: 보고서 인쇄 링크가 인쇄 화면으로 간다", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.getByRole("link", { name: "보고서 인쇄" })).toHaveAttribute(
      "href",
      "/runs/R1/print",
    );
  });

  it("표본을 바꿔 본 리포트도 인쇄 링크 주소에 sample이 없다 (R13)", () => {
    const switched: Report = {
      ...FIXTURE,
      sample: { selected: "failed", default: "passed", split: true },
    };
    render(<ReportView report={switched} profile={TEST_PROFILE} requestedSample="failed" />);
    expect(screen.getByRole("link", { name: "보고서 인쇄" })).toHaveAttribute(
      "href",
      "/runs/R1/print",
    );
  });

  it("표본을 바꿔 본 리포트도 CSV·XLSX 주소에 sample이 없다 (R13)", async () => {
    const user = userEvent.setup();
    vi.mocked(downloadFile).mockClear();
    const switched: Report = {
      ...FIXTURE,
      sample: { selected: "failed", default: "passed", split: true },
    };
    render(<ReportView report={switched} profile={TEST_PROFILE} requestedSample="failed" />);
    await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
    await user.click(screen.getByRole("menuitem", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
    await user.click(screen.getByRole("menuitem", { name: "XLSX" }));
    const urls = vi.mocked(downloadFile).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u).not.toContain("sample");
  });

  it("표본 단추를 누르면 onSelectSample을 부른다", async () => {
    const user = userEvent.setup();
    const onSelectSample = vi.fn();
    const split: Report = {
      ...FIXTURE,
      sample: { selected: "passed", default: "passed", split: true },
    };
    render(<ReportView report={split} profile={TEST_PROFILE} onSelectSample={onSelectSample} />);
    await user.click(screen.getByRole("radio", { name: "실패한 요청" }));
    expect(onSelectSample).toHaveBeenCalledWith("failed");
  });

  it("표본을 바꾸면 머리말·요약·다른 기준 줄이 그 표본을 따른다", () => {
    const steady = { ramp_seconds: 0, hold_seconds: 10, discard_seconds: 0 };
    const report: Report = {
      ...FIXTURE,
      summary: { ...FIXTURE.summary, errors: 0 },
      sample: { selected: "failed", default: "passed", split: true },
      basis: {
        selected: "steady",
        default: "steady",
        state: "measured",
        config: steady,
        window: { start_ms: 1000, end_ms: 2000, measured_seconds: 10 },
        t0_estimated: false,
        dropped_whole_run: false,
        other: {
          rps: 3,
          p50_ms: 1,
          p95_ms: 2,
          p99_ms: 3,
          error_rate: 0.5,
          count: 100,
          duration_seconds: 10,
        },
      },
    };
    render(<ReportView report={report} profile={TEST_PROFILE} requestedSample="failed" />);
    const head = screen.getByRole("region", { name: ko.report.headlineAria });
    expect(head).toHaveTextContent("실패한 요청 없음");
    expect(head).not.toHaveTextContent("통과한 요청 없음");
    const summary = screen.getByRole("region", { name: /리포트 요약/ });
    expect(summary.textContent?.match(/—/g)?.length).toBe(4);
    expect(screen.getByText(/전체 구간 \(실패한 요청\)/)).toBeInTheDocument();
  });

  it("steady_run_reads_as_fixed_everywhere: 버림이 전체 값이면 버림 비율 분모는 other.count", () => {
    const steady = { ramp_seconds: 0, hold_seconds: 300, discard_seconds: 5 };
    const report: Report = {
      ...FIXTURE,
      summary: { ...FIXTURE.summary, count: 400 },
      dropped: 100,
      run: { ...FIXTURE.run, profile: { vus: 0, duration_seconds: 300, target_rps: 80, steady } },
      basis: {
        selected: "steady",
        default: "steady",
        state: "measured",
        config: steady,
        window: { start_ms: 1000, end_ms: 2000, measured_seconds: 295 },
        t0_estimated: false,
        dropped_whole_run: true,
        other: {
          rps: 3,
          p50_ms: 1,
          p95_ms: 2,
          p99_ms: 3,
          error_rate: 0,
          count: 1000,
          duration_seconds: 300,
        },
      },
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toHaveTextContent(/100 \(9\.1%\)/);
  });

  it("renders summary, charts, status distribution, step table, and download", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /시계열 — 초당 요청 수/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /시계열 — p95/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /시계열 — 초당 에러/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /상태 코드 분포/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /스텝별 통계/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.report.downloadMenu })).toBeInTheDocument();
  });

  it("통계 더 보기를 펴면 「모든 스텝」 행의 요청 수가 summary.count (R24 배선)", async () => {
    const user = userEvent.setup();
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    await user.click(screen.getByRole("button", { name: ko.report.stats.toggleMore }));
    const row = screen.getByText(ko.report.stats.allSteps).closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("cell")[3]).toHaveTextContent(String(FIXTURE.summary.count));
  });

  it("스텝 timeout_seconds가 있으면 적용 타임아웃 줄에 오버라이드 꼬리가 붙는다 (도출 배선 그물)", () => {
    // 프리랩 주입이 아니라 scenario_yaml → parseScenarioDoc → flattenHttpSteps 도출 경로를 관통한다.
    const yamlWithOverride = FIXTURE.scenario_yaml.replace(
      "    assert: []",
      "    timeout_seconds: 10\n    assert: []",
    );
    render(
      <ReportView
        report={{ ...FIXTURE, scenario_yaml: yamlWithOverride }}
        profile={{ ...TEST_PROFILE, connect_timeout_seconds: 5 }}
      />,
    );
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toContain(
      ko.report.appliedTimeoutsStepOverride,
    );
  });

  it("준비 스텝에만 타임아웃 재정의가 있어도 재정의 안내가 나온다", () => {
    const yamlWithSetup = FIXTURE.scenario_yaml.replace(
      "steps:",
      [
        "setup:",
        "  steps:",
        '    - id: "01HX0000000000000000000099"',
        "      name: 준비",
        "      type: http",
        "      request:",
        "        method: GET",
        "        url: http://x/prep",
        "      timeout_seconds: 10",
        "steps:",
      ].join("\n"),
    );
    render(
      <ReportView
        report={{ ...FIXTURE, scenario_yaml: yamlWithSetup }}
        profile={{ ...TEST_PROFILE, connect_timeout_seconds: 5 }}
      />,
    );
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toContain(
      ko.report.appliedTimeoutsStepOverride,
    );
  });

  it("resolves env in step URLs (resolveForDisplay)", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    const stepRegion = screen.getByRole("region", { name: /스텝별 통계/ });
    expect(stepRegion).toHaveTextContent("http://x/login");
  });

  it("renders a Branch decisions section when if_breakdown is present", () => {
    const report: Report = {
      ...FIXTURE,
      scenario_yaml: [
        "version: 1",
        "name: x",
        "steps:",
        '  - id: "01HX0000000000000000000001"',
        "    name: branchy",
        "    type: if",
        '    cond: { left: "1", op: eq, right: "1" }',
        "    then:",
        '      - id: "01HX0000000000000000000002"',
        "        name: then-step",
        "        type: http",
        '        request: { method: GET, url: "/then" }',
        "        assert: []",
        "",
      ].join("\n"),
      if_breakdown: [
        { step_id: "01HX0000000000000000000001", branches: [{ branch: "then", count: 5 }] },
      ],
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    expect(screen.getByText("분기 결정")).toBeInTheDocument();
    expect(screen.getByText(/branchy/)).toBeInTheDocument();
  });

  it("renders the Transport 실패 분류 section when error_kinds is present", () => {
    const report: Report = {
      ...FIXTURE,
      error_kinds: [{ kind: "timeout", count: 3 }],
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    expect(screen.getByText("Transport 실패 분류")).toBeInTheDocument();
  });

  it("omits the Transport 실패 분류 section when error_kinds is absent", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.queryByText("Transport 실패 분류")).not.toBeInTheDocument();
  });

  it("renders no SLO panel when report has no verdict", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
    expect(screen.queryByText("FAIL")).not.toBeInTheDocument();
  });

  it("renders latency charts when report.latency is present", () => {
    const report: Report = {
      ...FIXTURE,
      latency: {
        percentile_curve: [
          { quantile: 0.5, value_us: 10_000 },
          { quantile: 0.99, value_us: 90_000 },
          { quantile: 1.0, value_us: 120_000 },
        ],
        histogram: [
          { lower_us: 1_000, upper_us: 2_000, count: 8 },
          { lower_us: 2_000, upper_us: 4_000, count: 7 },
        ],
      },
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    expect(screen.getByRole("region", { name: /지연 분위 곡선/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /지연 분포/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "지연" })).toBeInTheDocument();
  });

  it("omits latency charts when report.latency is absent", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.queryByRole("region", { name: /지연 분위 곡선/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /지연 분포/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "지연" })).not.toBeInTheDocument();
  });

  describe("download menu", () => {
    it("collapses the 4 downloads into a single menu", async () => {
      const user = userEvent.setup();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      const trigger = screen.getByRole("button", { name: ko.report.downloadMenu });
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
      await user.click(trigger);
      expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    });

    it("downloads CSV with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "CSV" }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportCsvUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-report.csv`,
        "text/csv",
      );
    });

    it("downloads XLSX with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "XLSX" }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportXlsxUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-report.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });

    it("downloads insights CSV with the existing args", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: ko.report.downloadInsightsCsv }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportInsightsCsvUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-insights.csv`,
        "text/csv",
      );
    });

    it("stair run: 「계단 표 CSV」 항목이 stairs CSV를 내려받는다", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockClear();
      const stair = StairReportSchema.parse(
        JSON.parse(
          readFileSync(
            nodePath.resolve(__dirname, "../../../../../testdata/stair_report_golden.json"),
            "utf8",
          ),
        ),
      );
      render(<ReportView report={{ ...FIXTURE, stair }} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: ko.report.downloadStairsCsv }));
      expect(downloadFile).toHaveBeenCalledWith(
        api.reportStairsCsvUrl(FIXTURE.run.id),
        `run-${FIXTURE.run.id}-stairs.csv`,
        "text/csv",
      );
    });

    it("stair 없는 run: 「계단 표 CSV」 항목 없음", async () => {
      const user = userEvent.setup();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      expect(screen.queryByRole("menuitem", { name: ko.report.downloadStairsCsv })).toBeNull();
    });

    it("downloads JSON via the downloadJson helper", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadJson).mockClear();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "JSON" }));
      expect(downloadJson).toHaveBeenCalledWith(`run-${FIXTURE.run.id}.json`, FIXTURE);
    });

    it("shows an error alert when downloadFile rejects", async () => {
      const user = userEvent.setup();
      vi.mocked(downloadFile).mockRejectedValueOnce(new Error("network error"));
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadMenu }));
      await user.click(screen.getByRole("menuitem", { name: "CSV" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("다운로드 실패:");
      expect(alert).toHaveTextContent("network error");
    });

    it("explains each format in a help tip", async () => {
      const user = userEvent.setup();
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      await user.click(screen.getByRole("button", { name: ko.report.downloadHelpAria }));
      const note = screen.getByRole("note");
      expect(note).toHaveTextContent(ko.report.downloadHelp.json);
      expect(note).toHaveTextContent(ko.report.downloadHelp.csv);
      expect(note).toHaveTextContent(ko.report.downloadHelp.xlsx);
      expect(note).toHaveTextContent(ko.report.downloadHelp.insights);
    });
  });

  it("labels a step nested inside a loop using its name", () => {
    const OUTER_ID = "01HX0000000000000000000003"; // loop step id (valid ULID)
    const INNER_ID = "01HX0000000000000000000002"; // inner http step id (valid ULID)
    const scenarioYaml = [
      "version: 1",
      "name: x",
      "cookie_jar: auto",
      "variables: {}",
      "steps:",
      `  - id: ${OUTER_ID}`,
      "    name: my-loop",
      "    type: loop",
      "    repeat: 2",
      "    do:",
      `      - id: ${INNER_ID}`,
      "        name: inner-tick",
      "        type: http",
      "        request:",
      "          method: GET",
      "          url: ${BASE_URL}/tick",
      "        assert: []",
      "        extract: []",
      "",
    ].join("\n");
    const report: Report = {
      ...FIXTURE,
      scenario_yaml: scenarioYaml,
      windows: [
        {
          ts_second: 100,
          step_id: INNER_ID,
          count: 4,
          error_count: 0,
          status_counts: { "200": 4 },
          p50_ms: 5,
          p95_ms: 10,
          p99_ms: 20,
        },
      ],
      steps: [
        {
          step_id: INNER_ID,
          count: 4,
          error_count: 0,
          status_counts: { "200": 4 },
          p50_ms: 5,
          p95_ms: 10,
          p99_ms: 20,
          loop_breakdown: [],
        },
      ],
      status_distribution: { "200": 4 },
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    const stepRegion = screen.getByRole("region", { name: /스텝별 통계/ });
    expect(stepRegion).toHaveTextContent("inner-tick");
    expect(stepRegion).not.toHaveTextContent(INNER_ID);
  });

  it("쉬운 요약 헤더가 최상단에 렌더된다", () => {
    render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toBeInTheDocument();
  });

  it("레이턴시 섹션은 클래스 없음(class='') 보존 — spec §2 허용 편차 ②", () => {
    const report: Report = {
      ...FIXTURE,
      latency: {
        percentile_curve: [
          { quantile: 0.5, value_us: 10_000 },
          { quantile: 0.99, value_us: 90_000 },
          { quantile: 1.0, value_us: 120_000 },
        ],
        histogram: [
          { lower_us: 1_000, upper_us: 2_000, count: 8 },
          { lower_us: 2_000, upper_us: 4_000, count: 7 },
        ],
      },
    };
    render(<ReportView report={report} profile={TEST_PROFILE} />);
    expect(screen.getByRole("region", { name: ko.report.latencyTitle }).className).toBe("");
  });

  // spec §5.1: 유효성+해석 병합 블록 → Verdict → Insight document order
  describe("A11 validity/narrative surfaces", () => {
    const A11_REPORT: Report = {
      ...FIXTURE,
      validity: {
        level: "suspect",
        reasons: [
          {
            kind: "transport_heavy",
            severity: "critical",
            pct: 0.8,
            count: 80,
          },
        ],
      },
      narrative: {
        can_claim: ["client_reachability_issue"],
        cannot_claim: ["sut_capacity", "production_identity"],
      },
      verdict: { passed: true, criteria: [] },
      insights: [{ kind: "slo_pass", severity: "info" }],
    };

    it("document order: ValidityBanner(merged) → VerdictPanel → InsightPanel", () => {
      render(<ReportView report={A11_REPORT} profile={TEST_PROFILE} />);
      const banner = screen.getByRole("region", { name: ko.validity.bannerAria });
      const verdict = screen.getByRole("region", { name: ko.report.verdictSectionLabel });
      const insights = screen.getByRole("region", { name: ko.report.insightsLabel });

      // DOCUMENT_POSITION_FOLLOWING(4) — later node is after earlier in document order
      expect(
        banner.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        verdict.compareDocumentPosition(insights) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("old reports omit validity/narrative → merged block absent (no fake ok)", () => {
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      expect(screen.queryByRole("region", { name: ko.validity.bannerAria })).toBeNull();
      expect(screen.queryByText(ko.validity.level.ok)).toBeNull();
    });
  });
  describe("조건 반복 리포트 표시 (loop-while-report)", () => {
    const LOOP_ID = "01HX0000000000000000000009";
    const LOOP_YAML = [
      "version: 1",
      "name: x",
      "cookie_jar: auto",
      "variables: {}",
      "steps:",
      `  - id: ${LOOP_ID}`,
      "    name: 주문 재시도",
      "    type: loop",
      "    repeat: 5",
      '    while: { left: "{{s}}", op: eq, right: wait }',
      "    do:",
      `      - id: ${STEP_ID}`,
      "        name: login",
      "        type: http",
      "        request:",
      "          method: POST",
      "          url: ${BASE_URL}/login",
      "        assert: []",
      "        extract: []",
      "",
    ].join("\n");
    const LOOP_REPORT: Report = {
      ...FIXTURE,
      scenario_yaml: LOOP_YAML,
      steps: [
        {
          ...FIXTURE.steps[0],
          loop_breakdown: [
            { loop_index: 0, count: 10, error_count: 0 },
            { loop_index: 1, count: 5, error_count: 1 },
          ],
        },
      ],
      validity: {
        level: "limited",
        reasons: [{ kind: "transport_heavy", severity: "warning", pct: 0.2, count: 3 }],
      },
      verdict: { passed: true, criteria: [] },
      loop_exits: [
        {
          step_id: LOOP_ID,
          entered: 10,
          passes: 15,
          exhausted: 1,
          truncated: 0,
          buckets: [
            { pass: 1, completed: 9, exhausted: 0, truncated: 0 },
            { pass: 5, completed: 1, exhausted: 1, truncated: 0 },
          ],
        },
      ],
    };
    const q = {
      badge: () => screen.queryByText(ko.report.loopExit.badge),
      summary: () => screen.queryByRole("list", { name: "조건 반복 풀이" }),
      panel: () => screen.queryByRole("region", { name: "조건 반복 회차 분포" }),
      notice: () => screen.queryByRole("region", { name: "조건 반복 해석 주의" }),
    };

    it("문서 순서: 배너 < 안내 < 판정 < 스텝 제목 < 풀이 줄 < 분포 패널", () => {
      render(<ReportView report={LOOP_REPORT} profile={TEST_PROFILE} />);
      const banner = screen.getByRole("region", { name: ko.validity.bannerAria });
      const notice = screen.getByRole("region", { name: "조건 반복 해석 주의" });
      const verdict = screen.getByRole("region", { name: ko.report.verdictSectionLabel });
      const heading = screen.getByRole("heading", { name: ko.report.stepsHeading });
      const summary = screen.getByRole("list", { name: "조건 반복 풀이" });
      const panel = screen.getByRole("region", { name: "조건 반복 회차 분포" });
      const order = [banner, notice, verdict, heading, summary, panel];
      for (let i = 0; i < order.length - 1; i++) {
        expect(
          order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      expect(q.badge()).not.toBeNull();
    });

    it("loop_exits 없으면 새 요소가 전혀 없다", () => {
      render(<ReportView report={FIXTURE} profile={TEST_PROFILE} />);
      expect(q.badge()).toBeNull();
      expect(q.summary()).toBeNull();
      expect(q.panel()).toBeNull();
      expect(q.notice()).toBeNull();
    });

    it("scenario_yaml이 깨져도 loop id로 그린다", () => {
      render(
        <ReportView
          report={{ ...LOOP_REPORT, scenario_yaml: ": : not yaml [" }}
          profile={TEST_PROFILE}
        />,
      );
      expect(screen.getByText(new RegExp(`「${LOOP_ID}」 — 진입 10회`))).toBeInTheDocument();
    });
  });

  describe("구획 표본 표지 (R9·R14)", () => {
    const LAT = {
      percentile_curve: [
        { quantile: 0.5, value_us: 10_000 },
        { quantile: 1.0, value_us: 120_000 },
      ],
      histogram: [{ lower_us: 1_000, upper_us: 2_000, count: 8 }],
    };
    const WORKERS = [
      { worker_id: "w0", count: 10, errors: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
      { worker_id: "w1", count: 5, errors: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
    ];
    const names = [ko.report.sample.passed, ko.report.sample.failed, ko.report.sample.allShort];
    const threeRegions = () => [
      screen.getByRole("region", { name: /리포트 요약/ }),
      screen.getByRole("region", { name: /시계열 — p95/ }),
      screen.getByRole("region", { name: /스텝별 통계/ }),
    ];
    const noNames = (el: HTMLElement) => {
      for (const n of names) expect(within(el).queryByText(n)).not.toBeInTheDocument();
    };

    it("바꿔 본 리포트: 요약·p95 그래프·분포·스텝 표·워커 표에 하나씩, 요청 수 그래프엔 없다", () => {
      const report: Report = {
        ...FIXTURE,
        sample: { selected: "failed", default: "passed", split: true },
        latency: LAT,
        worker_breakdown: WORKERS,
      };
      render(<ReportView report={report} profile={TEST_PROFILE} requestedSample="failed" />);
      const tag = ko.report.sample.failed;
      for (const el of [
        ...threeRegions(),
        screen.getByRole("region", { name: ko.report.latencyTitle }),
        screen.getByRole("region", { name: ko.report.workerBreakdownLabel }),
      ]) {
        expect(within(el).getAllByText(tag)).toHaveLength(1);
      }
      expect(
        within(screen.getByRole("region", { name: /시계열 — 초당 요청 수/ })).queryByText(tag),
      ).not.toBeInTheDocument();
    });

    it("바꿔 봤고 latency 없고 오류 0건: 분포 구획이 「실패한 요청 없음」을 말한다", () => {
      const report: Report = {
        ...FIXTURE,
        summary: { ...FIXTURE.summary, errors: 0 },
        sample: { selected: "failed", default: "passed", split: true },
      };
      render(<ReportView report={report} profile={TEST_PROFILE} requestedSample="failed" />);
      const region = screen.getByRole("region", { name: ko.report.latencyTitle });
      expect(region).toHaveTextContent("실패한 요청 없음");
      expect(within(region).getByText(ko.report.sample.failed)).toBeInTheDocument();
    });

    it("기본 표본: 표지를 다는 구획 안에 표본 이름이 없고, latency 없으면 분포 구획도 없다", () => {
      const report: Report = {
        ...FIXTURE,
        sample: { selected: "passed", default: "passed", split: true },
        worker_breakdown: WORKERS,
      };
      render(<ReportView report={report} profile={TEST_PROFILE} />);
      for (const el of [
        ...threeRegions(),
        screen.getByRole("region", { name: ko.report.workerBreakdownLabel }),
      ]) {
        noNames(el);
      }
      expect(
        screen.queryByRole("region", { name: ko.report.latencyTitle }),
      ).not.toBeInTheDocument();
    });

    it("기본 표본 + latency 있음: 분포 구획에도 표본 이름이 없다", () => {
      const report: Report = {
        ...FIXTURE,
        sample: { selected: "passed", default: "passed", split: true },
        latency: LAT,
      };
      render(<ReportView report={report} profile={TEST_PROFILE} />);
      noNames(screen.getByRole("region", { name: ko.report.latencyTitle }));
    });

    it("나눌 수 없는 run은 failed를 요청해도 구획 표지·안내·다른 기준 접미가 없다 (R14)", () => {
      const base: Report = {
        ...FIXTURE,
        sample: { selected: "all", default: "all", split: false },
        latency: LAT,
        worker_breakdown: WORKERS,
        basis: {
          selected: "steady",
          default: "steady",
          state: "measured",
          config: { ramp_seconds: 0, hold_seconds: 10, discard_seconds: 0 },
          window: { start_ms: 1000, end_ms: 2000, measured_seconds: 10 },
          t0_estimated: false,
          dropped_whole_run: false,
          other: {
            rps: 3,
            p50_ms: 1,
            p95_ms: 2,
            p99_ms: 3,
            error_rate: 0.5,
            count: 100,
            duration_seconds: 10,
          },
        },
      };
      const { unmount } = render(
        <ReportView report={base} profile={TEST_PROFILE} requestedSample="failed" />,
      );
      for (const el of [
        ...threeRegions(),
        screen.getByRole("region", { name: ko.report.latencyTitle }),
        screen.getByRole("region", { name: ko.report.workerBreakdownLabel }),
      ]) {
        noNames(el);
      }
      expect(screen.getByRole("region", { name: ko.report.headlineAria })).toHaveTextContent(
        "안에 응답",
      );
      const other = screen.getByText(/^전체 구간:/);
      expect(other.textContent).not.toContain("(");
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("radiogroup", { name: ko.report.sample.switchAria }),
      ).not.toBeInTheDocument();
      unmount();
      render(
        <ReportView
          report={{ ...base, latency: undefined }}
          profile={TEST_PROFILE}
          requestedSample="failed"
        />,
      );
      expect(
        screen.queryByRole("region", { name: ko.report.latencyTitle }),
      ).not.toBeInTheDocument();
    });

    it("나눌 수 없는 run: 세 구획에 표본 이름이 없고 분포 구획은 latency 유무대로", () => {
      const base: Report = {
        ...FIXTURE,
        sample: { selected: "all", default: "all", split: false },
      };
      const { unmount } = render(<ReportView report={base} profile={TEST_PROFILE} />);
      for (const el of threeRegions()) noNames(el);
      expect(
        screen.queryByRole("region", { name: ko.report.latencyTitle }),
      ).not.toBeInTheDocument();
      unmount();
      render(<ReportView report={{ ...base, latency: LAT }} profile={TEST_PROFILE} />);
      const region = screen.getByRole("region", { name: ko.report.latencyTitle });
      noNames(region);
      expect(region).not.toHaveTextContent("없음");
    });
  });
});
