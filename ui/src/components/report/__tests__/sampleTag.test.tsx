import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkerBreakdown } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { SampleTag } from "../SampleTag";
import { Summary } from "../Summary";
import { StepStatsTable } from "../StepStatsTable";
import { TimeSeriesChart } from "../TimeSeriesChart";
import { WorkerBreakdownTable } from "../WorkerBreakdownTable";

const TAG = "실패한 요청";

const summary = {
  count: 100,
  errors: 5,
  rps: 10,
  duration_seconds: 10,
  mean_ms: 30,
  p50_ms: 10,
  p95_ms: 50,
  p99_ms: 90,
};
const step = {
  step_id: "s1",
  count: 10,
  error_count: 1,
  status_counts: { "200": 9, "500": 1 },
  p50_ms: 5,
  p95_ms: 6,
  p99_ms: 7,
  loop_breakdown: [],
};
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "/login" }]]);
const workers: WorkerBreakdown[] = [
  { worker_id: "w0", count: 10, errors: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
  { worker_id: "w1", count: 10, errors: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
];
const data = [
  { ts_second: 1, value: 1 },
  { ts_second: 2, value: 2 },
];

function chart(sampleTag?: string | null) {
  return (
    <TimeSeriesChart
      title="p95"
      yLabel="ms"
      data={data}
      width={400}
      height={200}
      sampleTag={sampleTag}
    />
  );
}

describe("구획 표본 표지", () => {
  it("Summary: p50 카드에만, 없음·null이면 없다", () => {
    const { rerender } = render(<Summary summary={summary} sampleTag={TAG} />);
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(within(region).getAllByText(TAG)).toHaveLength(1);
    expect(screen.getByText("p50").closest("div")).toHaveTextContent(TAG);
    for (const l of ["p95", "p99"]) {
      expect(screen.getByText(l).closest("div")).not.toHaveTextContent(TAG);
    }
    rerender(<Summary summary={summary} sampleTag={null} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
    rerender(<Summary summary={summary} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
  });

  it("TimeSeriesChart: 제목 곁, 제목 접근 이름엔 없다", () => {
    const { rerender } = render(chart(TAG));
    expect(screen.getByRole("heading", { name: "p95" })).toBeInTheDocument();
    expect(screen.getByText(TAG)).toBeInTheDocument();
    rerender(chart(null));
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
    rerender(chart());
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
  });

  it("StepStatsTable: 제목 곁, 제목 접근 이름엔 없다", () => {
    const { rerender } = render(<StepStatsTable steps={[step]} meta={meta} sampleTag={TAG} />);
    expect(screen.getByRole("heading", { name: ko.report.stepsHeading })).toBeInTheDocument();
    expect(screen.getByText(TAG)).toBeInTheDocument();
    rerender(<StepStatsTable steps={[step]} meta={meta} sampleTag={null} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
    rerender(<StepStatsTable steps={[step]} meta={meta} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
  });

  it("WorkerBreakdownTable: 제목 곁, 제목 접근 이름엔 없다", () => {
    const { rerender } = render(<WorkerBreakdownTable breakdown={workers} sampleTag={TAG} />);
    expect(screen.getByRole("heading", { name: "워커별 분해 (2개 워커)" })).toBeInTheDocument();
    expect(screen.getByText(TAG)).toBeInTheDocument();
    rerender(<WorkerBreakdownTable breakdown={workers} sampleTag={null} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
    rerender(<WorkerBreakdownTable breakdown={workers} />);
    expect(screen.queryByText(TAG)).not.toBeInTheDocument();
  });
});

describe("SampleTag", () => {
  it("이름이 두 줄로 꺾이지 않는다", () => {
    render(<SampleTag name={TAG} className="ml-2" />);
    const el = screen.getByText(TAG);
    expect(el).toHaveClass("whitespace-nowrap");
    expect(el).toHaveClass("ml-2");
  });
});
