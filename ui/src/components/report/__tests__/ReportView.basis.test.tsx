import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";
import { downloadFile } from "../../../api/download";
import type { Profile, Report, ReportBasis } from "../../../api/schemas";

vi.mock("../../../api/download", () => ({
  downloadFile: vi.fn(() => Promise.resolve()),
  downloadJson: vi.fn(() => Promise.resolve()),
}));

const STEP_ID = "01HX0000000000000000000001";
const BADGE = "전체 구간";

const phase = { count: 5, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 };

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
  windows: [],
  steps: [
    {
      step_id: STEP_ID,
      count: 15,
      error_count: 1,
      status_counts: { "200": 14, "500": 1 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
      loop_breakdown: [{ loop_index: 0, count: 15, error_count: 1 }],
    },
  ],
  status_distribution: { "200": 14, "500": 1 },
  dropped: 0,
  error_kinds: [{ kind: "timeout", count: 3 }],
  connection: {
    dns: phase,
    connect: phase,
    connections_opened: 3,
    requests_total: 30,
    reuse_ratio: 0.9,
  },
};

const PROFILE: Profile = {
  vus: 1,
  ramp_up_seconds: 0,
  duration_seconds: 2,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};

const STEADY = { ramp_seconds: 0, hold_seconds: 300, discard_seconds: 5 };

function basisOf(over: Partial<ReportBasis> = {}): ReportBasis {
  return {
    selected: "steady",
    default: "steady",
    state: "measured",
    config: STEADY,
    window: { start_ms: 1000, end_ms: 2000, measured_seconds: 295 },
    t0_estimated: false,
    dropped_whole_run: false,
    other: {
      rps: 3,
      p50_ms: 1,
      p95_ms: 2,
      p99_ms: 3,
      error_rate: 0,
      count: 1000,
      duration_seconds: 300,
    },
    ...over,
  };
}

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

const WIN = (ts: number) => ({
  ts_second: ts,
  step_id: STEP_ID,
  count: 5,
  error_count: 0,
  status_counts: { "200": 5 },
  p50_ms: 1,
  p95_ms: 2,
  p99_ms: 3,
});

describe("ReportView — 시계열 띠 범례", () => {
  const withWindows = { ...FIXTURE, windows: [WIN(1000), WIN(1001), WIN(1002)] };

  it("basis.window가 있으면 범례가 한 번만 보인다", () => {
    const basis = basisOf({
      window: { start_ms: 1_005_000, end_ms: 1_060_000, measured_seconds: 55 },
    });
    render(<ReportView report={{ ...withWindows, basis }} profile={PROFILE} />);
    expect(screen.getAllByText(/점선 사이가 유지 구간입니다/)).toHaveLength(1);
  });

  it("범례 문단은 첫 차트와 떨어지도록 mb-2", () => {
    const basis = basisOf({
      window: { start_ms: 1_005_000, end_ms: 1_060_000, measured_seconds: 55 },
    });
    render(<ReportView report={{ ...withWindows, basis }} profile={PROFILE} />);
    expect(screen.getByText(/점선 사이가 유지 구간입니다/)).toHaveClass("mb-2");
  });

  it("basis가 없으면 범례가 없다", () => {
    render(<ReportView report={withWindows} profile={PROFILE} />);
    expect(screen.queryByText(/점선 사이가 유지 구간입니다/)).toBeNull();
  });

  it("window가 없는 basis면 범례가 없다", () => {
    render(
      <ReportView
        report={{ ...withWindows, basis: basisOf({ window: null, state: "not_reached" }) }}
        profile={PROFILE}
      />,
    );
    expect(screen.queryByText(/점선 사이가 유지 구간입니다/)).toBeNull();
  });

  it("버림만 있으면(상승 0) 회색 띠 문장이 빠진다", () => {
    const basis = basisOf({
      window: { start_ms: 1_005_000, end_ms: 1_060_000, measured_seconds: 55 },
    });
    render(<ReportView report={{ ...withWindows, basis }} profile={PROFILE} />);
    const text = screen.getByText(/점선 사이가 유지 구간입니다/).textContent ?? "";
    expect(text).toContain("노란 띠는 앞부분 버림 구간입니다.");
    expect(text).not.toContain("회색 띠");
  });
});

describe("ReportView — 집계 기준", () => {
  it("basis 없는 리포트에는 전환이 없다", () => {
    render(<ReportView report={FIXTURE} profile={PROFILE} />);
    expect(screen.queryByRole("radiogroup", { name: "집계 기준" })).toBeNull();
    expect(screen.queryByText(BADGE)).toBeNull();
  });

  it("basis가 있으면 전환이 나오고 누르면 onSelectBasis", async () => {
    const user = userEvent.setup();
    const onSelectBasis = vi.fn();
    render(
      <ReportView
        report={{ ...FIXTURE, basis: basisOf() }}
        profile={PROFILE}
        onSelectBasis={onSelectBasis}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "집계 기준" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    expect(onSelectBasis).toHaveBeenCalledWith("whole");
  });

  it("pending이면 리포트 본문이 흐려지고 전환이 aria-busy, 아니면 둘 다 없다", () => {
    const report = { ...FIXTURE, basis: basisOf() };
    const { rerender } = render(<ReportView report={report} profile={PROFILE} pending />);
    expect(screen.getByRole("radiogroup", { name: "집계 기준" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    const body = screen.getByRole("heading", { name: "리포트" }).closest(".opacity-60");
    expect(body).not.toBeNull();
    rerender(
      <MemoryRouter>
        <ReportView report={report} profile={PROFILE} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("radiogroup", { name: "집계 기준" })).not.toHaveAttribute("aria-busy");
    expect(document.querySelector(".opacity-60")).toBeNull();
  });

  it("전환은 헤드라인 위에 있다", () => {
    render(<ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />);
    const group = screen.getByRole("radiogroup", { name: "집계 기준" });
    const title = screen.getByRole("heading", { name: "리포트" });
    expect(group.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("유지 구간 리포트의 나눌 수 없는 표에 표지, 전체 구간이면 표지 0개", () => {
    const { rerender } = render(
      <ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />,
    );
    const err = screen.getByRole("region", { name: "Transport 실패 분류" });
    expect(within(err).getByText(BADGE)).toBeInTheDocument();
    const conn = screen.getByRole("region", { name: "연결 비용" });
    expect(within(conn).getByText(BADGE)).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ReportView
          report={{ ...FIXTURE, basis: basisOf({ selected: "whole" }) }}
          profile={PROFILE}
        />
      </MemoryRouter>,
    );
    const err2 = screen.getByRole("region", { name: "Transport 실패 분류" });
    expect(within(err2).queryByText(BADGE)).toBeNull();
    expect(within(screen.getByRole("region", { name: "연결 비용" })).queryByText(BADGE)).toBeNull();
  });

  it("표지는 제목 접근명에 섞이지 않는다", () => {
    render(<ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />);
    const err = screen.getByRole("region", { name: "Transport 실패 분류" });
    const heading = within(err).getByRole("heading");
    expect(heading.textContent).not.toContain(BADGE);
  });

  it("스텝 표 하위 줄의 표지가 StepPhaseBreakdown을 거쳐 내려온다", async () => {
    const user = userEvent.setup();
    render(<ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />);
    await user.click(screen.getByRole("button", { name: /login/ }));
    const cell = screen.getByText("loop_index").closest("td")!;
    expect(within(cell).getByText(BADGE)).toBeInTheDocument();
  });

  it("스텝 표 하위 줄 표지는 basis가 없으면 없다", async () => {
    const user = userEvent.setup();
    render(<ReportView report={FIXTURE} profile={PROFILE} />);
    await user.click(screen.getByRole("button", { name: /login/ }));
    expect(screen.queryByText(BADGE)).toBeNull();
  });

  it("dropped_whole_run이면 Summary 구역의 버림 수 옆에 표지", () => {
    const report: Report = {
      ...FIXTURE,
      dropped: 100,
      run: {
        ...FIXTURE.run,
        profile: { vus: 0, duration_seconds: 300, target_rps: 80, steady: STEADY },
      },
      basis: basisOf({ dropped_whole_run: true }),
    };
    render(<ReportView report={report} profile={PROFILE} />);
    const summary = screen.getByRole("region", { name: /리포트 요약/ });
    expect(within(summary).getAllByText(BADGE)).toHaveLength(2);
  });

  it("dropped_whole_run이 아니면 Summary 구역에 표지가 없다", () => {
    const report: Report = { ...FIXTURE, basis: basisOf() };
    render(<ReportView report={report} profile={PROFILE} />);
    const summary = screen.getByRole("region", { name: /리포트 요약/ });
    expect(within(summary).queryByText(BADGE)).toBeNull();
  });

  it("달성 도착률은 전체 구간 길이(other.duration_seconds)로 센다", () => {
    const report: Report = {
      ...FIXTURE,
      summary: { ...FIXTURE.summary, count: 400, duration_seconds: 100 },
      dropped: 600,
      run: {
        ...FIXTURE.run,
        profile: { vus: 0, duration_seconds: 300, target_rps: 80, steady: STEADY },
      },
      basis: basisOf({ dropped_whole_run: true }),
    };
    render(<ReportView report={report} profile={PROFILE} />);
    const summary = screen.getByRole("region", { name: /리포트 요약/ });
    expect(summary).toHaveTextContent("78.0");
    expect(summary).not.toHaveTextContent("74.0");
  });
});

describe("ReportView — steady 없는 상승 run의 한 줄", () => {
  const withProfile = (p: Partial<Profile>): Profile => ({ ...PROFILE, ...p });

  it("closed 고정 + 상승이 있으면 Summary 위에 한 줄", () => {
    render(<ReportView report={FIXTURE} profile={withProfile({ ramp_up_seconds: 10 })} />);
    expect(screen.getByText("상승 10초 포함 전체 구간 값")).toBeInTheDocument();
  });

  it("상승 0이면 없다", () => {
    render(<ReportView report={FIXTURE} profile={PROFILE} />);
    expect(screen.queryByText(/포함 전체 구간 값/)).toBeNull();
  });

  it("open-loop 곡선이면 없다", () => {
    render(
      <ReportView
        report={FIXTURE}
        profile={withProfile({
          ramp_up_seconds: 10,
          stages: [{ target: 10, duration_seconds: 5 }],
        })}
      />,
    );
    expect(screen.queryByText(/포함 전체 구간 값/)).toBeNull();
  });

  it("basis가 있으면 없다", () => {
    render(
      <ReportView
        report={{ ...FIXTURE, basis: basisOf() }}
        profile={withProfile({ ramp_up_seconds: 10 })}
      />,
    );
    expect(screen.queryByText(/포함 전체 구간 값/)).toBeNull();
  });
});

describe("ReportView — 내려받기·인쇄 링크가 보고 있는 기준을 넘긴다", () => {
  async function pick(label: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /내려받기/ }));
    await user.click(screen.getByRole("menuitem", { name: label }));
  }

  it("전체 구간을 보고 있으면 CSV가 ?basis=whole과 -whole 이름으로", async () => {
    vi.mocked(downloadFile).mockClear();
    const basis = basisOf({ selected: "whole" });
    render(<ReportView report={{ ...FIXTURE, basis }} profile={PROFILE} />);
    await pick("CSV");
    const [url, name] = vi.mocked(downloadFile).mock.calls[0];
    expect(url.endsWith("/runs/R1/report.csv?basis=whole")).toBe(true);
    expect(name).toBe("run-R1-report-whole.csv");
  });

  it("전체 구간을 보고 있으면 XLSX·인사이트 CSV도 -whole", async () => {
    vi.mocked(downloadFile).mockClear();
    const basis = basisOf({ selected: "whole" });
    render(<ReportView report={{ ...FIXTURE, basis }} profile={PROFILE} />);
    await pick("XLSX");
    await pick("인사이트 CSV");
    const calls = vi.mocked(downloadFile).mock.calls;
    expect(calls[0][0].endsWith("/runs/R1/report.xlsx?basis=whole")).toBe(true);
    expect(calls[0][1]).toBe("run-R1-report-whole.xlsx");
    expect(calls[1][0].endsWith("/runs/R1/report-insights.csv?basis=whole")).toBe(true);
    expect(calls[1][1]).toBe("run-R1-insights-whole.csv");
  });

  it("기본 기준을 보고 있으면 ?basis=steady와 -steady 이름으로", async () => {
    vi.mocked(downloadFile).mockClear();
    render(<ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />);
    await pick("CSV");
    await pick("XLSX");
    await pick("인사이트 CSV");
    const calls = vi.mocked(downloadFile).mock.calls;
    expect(calls[0][0].endsWith("/report.csv?basis=steady")).toBe(true);
    expect(calls[0][1]).toBe("run-R1-report-steady.csv");
    expect(calls[1][0].endsWith("/report.xlsx?basis=steady")).toBe(true);
    expect(calls[1][1]).toBe("run-R1-report-steady.xlsx");
    expect(calls[2][0].endsWith("/report-insights.csv?basis=steady")).toBe(true);
    expect(calls[2][1]).toBe("run-R1-insights-steady.csv");
  });

  it("basis 없는 리포트는 URL·파일 이름이 그대로", async () => {
    vi.mocked(downloadFile).mockClear();
    render(<ReportView report={FIXTURE} profile={PROFILE} />);
    await pick("CSV");
    await pick("XLSX");
    await pick("인사이트 CSV");
    const calls = vi.mocked(downloadFile).mock.calls;
    expect(calls[0][0].endsWith("/runs/R1/report.csv")).toBe(true);
    expect(calls[0][1]).toBe("run-R1-report.csv");
    expect(calls[1][0].endsWith("/runs/R1/report.xlsx")).toBe(true);
    expect(calls[1][1]).toBe("run-R1-report.xlsx");
    expect(calls[2][0].endsWith("/runs/R1/report-insights.csv")).toBe(true);
    expect(calls[2][1]).toBe("run-R1-insights.csv");
  });

  it("인쇄 링크: 기본 기준이 아니면 ?basis=를 싣는다", () => {
    const basis = basisOf({ selected: "whole" });
    render(<ReportView report={{ ...FIXTURE, basis }} profile={PROFILE} />);
    expect(screen.getByRole("link", { name: /인쇄/ })).toHaveAttribute(
      "href",
      "/runs/R1/print?basis=whole",
    );
  });

  it("인쇄 링크: 기본 기준이면 싣지 않는다", () => {
    render(<ReportView report={{ ...FIXTURE, basis: basisOf() }} profile={PROFILE} />);
    expect(screen.getByRole("link", { name: /인쇄/ })).toHaveAttribute("href", "/runs/R1/print");
  });

  it("인쇄 링크: basis 없으면 싣지 않는다", () => {
    render(<ReportView report={FIXTURE} profile={PROFILE} />);
    expect(screen.getByRole("link", { name: /인쇄/ })).toHaveAttribute("href", "/runs/R1/print");
  });
});
