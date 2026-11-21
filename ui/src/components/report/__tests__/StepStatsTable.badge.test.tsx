import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StepStatsTable } from "../StepStatsTable";
import type { ReportStep } from "../../../api/schemas";

const BADGE = "전체 구간";
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "http://x/login" }]]);
const phase = { count: 5, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 };
const base: ReportStep = {
  step_id: "s1",
  count: 15,
  error_count: 1,
  status_counts: { "200": 14, "500": 1 },
  p50_ms: 10,
  p95_ms: 50,
  p99_ms: 90,
};
const split = {
  final: { count: 4, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
  retry: { count: 2, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
};

describe("StepStatsTable — wholeRunBadge", () => {
  it("반복 횟수별 집계 줄에 표지가 붙는다", async () => {
    const user = userEvent.setup();
    const step = { ...base, loop_breakdown: [{ loop_index: 0, count: 15, error_count: 1 }] };
    const { rerender } = render(<StepStatsTable steps={[step]} meta={meta} wholeRunBadge />);
    await user.click(screen.getByRole("button", { name: /login/ }));
    const cell = screen.getByText("loop_index").closest("td")!;
    expect(within(cell).getByText(BADGE)).toBeInTheDocument();
    expect(screen.getAllByText(BADGE)).toHaveLength(1);
    rerender(<StepStatsTable steps={[step]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("응답 분리 줄에 표지가 붙는다", () => {
    const step = { ...base, loop_split: split };
    const { rerender } = render(<StepStatsTable steps={[step]} meta={meta} wholeRunBadge />);
    const finalRow = screen.getByText(/반복을 끝낸 응답/).closest("tr")!;
    expect(within(finalRow).getByText(BADGE)).toBeInTheDocument();
    rerender(<StepStatsTable steps={[step]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("대기·다운로드 열 머리에 표지가 붙는다", () => {
    const step = { ...base, wait: phase, download: phase };
    const { rerender } = render(<StepStatsTable steps={[step]} meta={meta} wholeRunBadge />);
    expect(screen.getAllByText(BADGE)).toHaveLength(2);
    rerender(<StepStatsTable steps={[step]} meta={meta} />);
    expect(screen.queryByText(BADGE)).not.toBeInTheDocument();
  });

  it("지금 렌더의 스텝 제목·열 머리 접근명은 prop이 없을 때 그대로다", () => {
    render(<StepStatsTable steps={[base]} meta={meta} />);
    expect(screen.getByRole("heading", { name: "스텝" })).toBeInTheDocument();
  });
});
