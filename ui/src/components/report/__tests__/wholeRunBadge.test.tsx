import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ErrorKindTable } from "../ErrorKindTable";
import { ConnectionCostCard } from "../ConnectionCostCard";
import { LoopExitSummary } from "../LoopExitSummary";
import { LoopExitPanel } from "../LoopExitPanel";
import { BranchStatsTable } from "../BranchStatsTable";
import { GroupLatencyTable } from "../GroupLatencyTable";
import { Summary } from "../Summary";
import { StepPhaseBreakdown } from "../StepPhaseBreakdown";
import type { LoopExitView } from "../loopExitView";
import type { ConnectionStats, ReportStep } from "../../../api/schemas";

const BADGE = "전체 구간";

const phase = { count: 5, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 };
const conn: ConnectionStats = {
  dns: phase,
  connect: phase,
  connections_opened: 3,
  requests_total: 30,
  reuse_ratio: 0.9,
};
const view: LoopExitView = {
  stepId: "L1",
  name: "주문 재시도",
  maxPasses: 5,
  entered: 10,
  passes: 15,
  retries: 5,
  retryPct: 33,
  exhausted: 1,
  truncated: 0,
  retriedStepIds: [],
  rows: [],
};
const summary = {
  count: 100,
  errors: 0,
  rps: 5,
  duration_seconds: 20,
  mean_ms: 10,
  p50_ms: 10,
  p95_ms: 20,
  p99_ms: 30,
};
const phased: ReportStep = {
  step_id: "s1",
  count: 10,
  error_count: 0,
  status_counts: { "200": 10 },
  p50_ms: 5,
  p95_ms: 6,
  p99_ms: 7,
  wait: phase,
  download: phase,
};

describe("wholeRunBadge — 나눌 수 없는 표의 「전체 구간」 표지", () => {
  it("ErrorKindTable: 제목 형제에 있고 제목 접근명엔 없다", () => {
    render(<ErrorKindTable kinds={[{ kind: "timeout", count: 3 }]} wholeRunBadge />);
    const region = screen.getByRole("region", { name: "Transport 실패 분류" });
    expect(within(region).getByText(BADGE)).toBeInTheDocument();
    const heading = within(region).getByRole("heading", { name: "Transport 실패 분류" });
    expect(heading.textContent).toBe("Transport 실패 분류");
    expect(heading).not.toContainElement(within(region).getByText(BADGE));
  });

  it("ErrorKindTable: prop이 없으면 표지가 없다", () => {
    render(<ErrorKindTable kinds={[{ kind: "timeout", count: 3 }]} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("ConnectionCostCard", () => {
    const { rerender } = render(<ConnectionCostCard stats={conn} wholeRunBadge />);
    const region = screen.getByRole("region", { name: "연결 비용" });
    expect(within(region).getByText(BADGE)).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: "연결 비용" })).toBeInTheDocument();
    rerender(<ConnectionCostCard stats={conn} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("LoopExitSummary", () => {
    const { rerender } = render(<LoopExitSummary views={[view]} wholeRunBadge />);
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    expect(screen.getByRole("listitem")).not.toHaveTextContent(BADGE);
    rerender(<LoopExitSummary views={[view]} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("LoopExitPanel", () => {
    const { rerender } = render(<LoopExitPanel views={[view]} wholeRunBadge />);
    const region = screen.getByRole("region", { name: "조건 반복 회차 분포" });
    expect(within(region).getByText(BADGE)).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3 }).textContent).not.toContain(BADGE);
    rerender(<LoopExitPanel views={[view]} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("BranchStatsTable", () => {
    const bd = [{ step_id: "if1", branches: [{ branch: "then", count: 3 }] }];
    const meta = new Map([["if1", { name: "분기" }]]);
    const { rerender } = render(<BranchStatsTable breakdown={bd} meta={meta} wholeRunBadge />);
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    rerender(<BranchStatsTable breakdown={bd} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("GroupLatencyTable", () => {
    const rows = [
      { step_id: "p1", count: 4, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4, branches: [] },
    ];
    const meta = new Map([["p1", { name: "페이지" }]]);
    const { rerender } = render(<GroupLatencyTable breakdown={rows} meta={meta} wholeRunBadge />);
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    rerender(<GroupLatencyTable breakdown={rows} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("Summary: 버림 칸·달성 도착률 칸 옆에 표지", () => {
    const openLoop = { target: 80, curve: false, achieved: 78 };
    const { rerender } = render(
      <Summary summary={summary} dropped={600} openLoop={openLoop} wholeRunBadge />,
    );
    expect(screen.getAllByText(BADGE)).toHaveLength(2);
    rerender(<Summary summary={summary} dropped={600} openLoop={openLoop} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("StepPhaseBreakdown 막대 보기: 응답 분리 줄에 표지, prop이 없으면 없다", () => {
    const step: ReportStep = {
      ...phased,
      loop_split: {
        final: { count: 4, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
        retry: { count: 2, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
      },
    };
    const meta = new Map([["s1", { id: "s1", name: "login", method: "GET", url: "http://x" }]]);
    const { rerender } = render(<StepPhaseBreakdown steps={[step]} meta={meta} wholeRunBadge />);
    const finalLine = screen.getByText(/반복을 끝낸 응답/).closest("div")!;
    expect(within(finalLine).getByText(BADGE)).toBeInTheDocument();
    rerender(<StepPhaseBreakdown steps={[step]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("StepPhaseBreakdown 칩 보기: 표 열 머리로 표지가 내려간다", async () => {
    const user = userEvent.setup();
    const meta = new Map([["s1", { id: "s1", name: "login", method: "GET", url: "http://x" }]]);
    const { rerender } = render(<StepPhaseBreakdown steps={[phased]} meta={meta} wholeRunBadge />);
    await user.click(screen.getByRole("button", { name: "칩" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByText(BADGE)).toHaveLength(2);
    rerender(<StepPhaseBreakdown steps={[phased]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("표지의 도움말 단추는 표지 글자와 다른 접근명을 가진다", () => {
    render(<ErrorKindTable kinds={[{ kind: "timeout", count: 3 }]} wholeRunBadge />);
    expect(screen.getByRole("button", { name: "전체 구간 표지 설명" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "전체 구간" })).not.toBeInTheDocument();
  });

  it("StepPhaseBreakdown 막대 보기: 단계 막대 범례에 표지", () => {
    const meta = new Map([["s1", { id: "s1", name: "login", method: "GET", url: "http://x" }]]);
    const { rerender } = render(<StepPhaseBreakdown steps={[phased]} meta={meta} wholeRunBadge />);
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    rerender(<StepPhaseBreakdown steps={[phased]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });
});
