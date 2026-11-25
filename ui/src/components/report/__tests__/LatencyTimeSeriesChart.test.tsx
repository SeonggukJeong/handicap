import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ko } from "../../../i18n/ko";
import { LatencyTimeSeriesChart } from "../LatencyTimeSeriesChart";

const base = [
  { ts_second: 100, mean: 10, p95: 20, capped: false },
  { ts_second: 101, mean: 12, p95: 25, capped: false },
  { ts_second: 102, mean: 11, p95: 22, capped: false },
];

describe("LatencyTimeSeriesChart", () => {
  it("제목·범례·안내와 선 두 개", () => {
    const { container } = render(<LatencyTimeSeriesChart data={base} width={600} height={220} />);
    const region = screen.getByRole("region", {
      name: ko.report.timeSeriesAria(ko.report.latencyChart.title),
    });
    expect(region).toBeInTheDocument();
    expect(screen.getByText(ko.report.latencyChart.title)).toBeInTheDocument();
    expect(screen.getByText(ko.report.latencyChart.mean)).toBeInTheDocument();
    expect(screen.getByText(ko.report.latencyChart.p95)).toBeInTheDocument();
    expect(screen.getByText(ko.report.latencyChart.hint)).toBeInTheDocument();
    expect(container.querySelectorAll("path.recharts-line-curve").length).toBe(2);
  });

  it("capped 점이 있을 때만 hintCapped", () => {
    const { rerender } = render(<LatencyTimeSeriesChart data={base} width={600} height={220} />);
    expect(screen.queryByText(ko.report.latencyChart.hintCapped)).not.toBeInTheDocument();
    rerender(
      <LatencyTimeSeriesChart
        data={[base[0], { ts_second: 101, mean: 60000, p95: 60000, capped: true }, base[2]]}
        width={600}
        height={220}
      />,
    );
    expect(screen.getByText(ko.report.latencyChart.hintCapped)).toBeInTheDocument();
  });

  it("혼자 남은 평균 값은 점 표지로 그린다", () => {
    const { container } = render(
      <LatencyTimeSeriesChart
        data={[
          { ts_second: 100, mean: null, p95: null, capped: false },
          { ts_second: 101, mean: 7, p95: null, capped: false },
          { ts_second: 102, mean: null, p95: null, capped: false },
        ]}
        width={600}
        height={220}
      />,
    );
    const meanLayer = container.querySelector("g.recharts-line");
    expect(meanLayer).not.toBeNull();
    expect(meanLayer!.querySelectorAll("circle").length).toBe(1);
  });
});
