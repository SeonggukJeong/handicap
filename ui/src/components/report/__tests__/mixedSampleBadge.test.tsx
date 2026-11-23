import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GroupLatency, ReportSetup, ReportStep } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { GroupLatencyTable } from "../GroupLatencyTable";
import { SetupSection } from "../SetupSection";
import { StepPhaseBreakdown } from "../StepPhaseBreakdown";
import { StepStatsTable } from "../StepStatsTable";

const BADGE = ko.report.sample.mixedBadge;
const phase = { count: 5, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 };
const split = {
  final: { count: 4, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
  retry: { count: 2, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
};
const step: ReportStep = {
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
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "/login" }]]);

describe("「실패 포함」 표지 — 나눈 run에서만", () => {
  it("SetupSection: 제목 줄 옆에 있고 접힘 단추 이름엔 없다", () => {
    const setup: ReportSetup = {
      ok: 5,
      failed: 0,
      interrupted: 0,
      steps: [
        {
          step_id: "s1",
          count: 5,
          errors: 0,
          p50_ms: 1,
          p95_ms: 2,
          max_ms: 3,
          status_counts: { "200": 5 },
          failure_kinds: {},
        },
      ],
    };
    const props = {
      setup,
      stepMeta: new Map([["s1", { name: "로그인" }]]),
      loadModel: "vu" as const,
      steadyNote: false,
    };
    const { rerender } = render(<SetupSection {...props} mixedSample />);
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /준비/ })).not.toHaveTextContent(BADGE);
    rerender(<SetupSection {...props} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("GroupLatencyTable: 제목 옆", () => {
    const rows: GroupLatency[] = [
      { step_id: "p1", count: 4, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4, branches: [] },
    ];
    const m = new Map([["p1", { name: "page" }]]);
    const { rerender } = render(<GroupLatencyTable breakdown={rows} meta={m} mixedSample />);
    const region = screen.getByRole("region", { name: ko.report.pageLoadLatencyLabel });
    expect(within(region).getByText(BADGE)).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3 }).textContent).not.toContain(BADGE);
    rerender(<GroupLatencyTable breakdown={rows} meta={m} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("StepStatsTable: 대기·다운로드 열 머리와 조건 반복 분리 행", () => {
    const { rerender } = render(
      <StepStatsTable steps={[{ ...step, loop_split: split }]} meta={meta} mixedSample />,
    );
    const heads = screen.getAllByRole("columnheader");
    const withBadge = heads.filter((h) => h.textContent?.includes(BADGE));
    expect(withBadge).toHaveLength(2); // 대기 p50, 다운로드 p50 — 열 머리마다 하나
    expect(screen.getAllByText(BADGE)).toHaveLength(3); // + 분리 행 하나
    rerender(<StepStatsTable steps={[{ ...step, loop_split: split }]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("StepPhaseBreakdown 막대 보기: 범례와 분리 줄", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StepPhaseBreakdown steps={[{ ...step, loop_split: split }]} meta={meta} mixedSample />,
    );
    expect(screen.getAllByText(BADGE).length).toBeGreaterThanOrEqual(2);
    rerender(<StepPhaseBreakdown steps={[{ ...step, loop_split: split }]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
    // 표 보기로 바꿔도 같은 규칙
    rerender(
      <StepPhaseBreakdown steps={[{ ...step, loop_split: split }]} meta={meta} mixedSample />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.phaseViewChips }));
    expect(screen.getAllByText(BADGE).length).toBeGreaterThanOrEqual(3);
  });
});
