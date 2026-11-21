import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";
import type { Profile, Report, ReportBasis } from "../../../api/schemas";

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
    expect(within(summary).getAllByText(BADGE).length).toBeGreaterThan(0);
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
