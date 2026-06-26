import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LatencyHistogramChart } from "../LatencyHistogramChart";

describe("LatencyHistogramChart", () => {
  it("renders an SVG bar chart for non-empty buckets", () => {
    render(
      <LatencyHistogramChart
        width={400}
        height={200}
        buckets={[
          { lower_us: 1_000, upper_us: 2_000, count: 10 },
          { lower_us: 2_000, upper_us: 4_000, count: 25 },
          { lower_us: 4_000, upper_us: 8_000, count: 5 },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: /지연 분포/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("지연 분포");
  });

  it("shows empty-state text when no buckets", () => {
    render(<LatencyHistogramChart buckets={[]} />);
    expect(screen.getByText(/지연 데이터가 없습니다/)).toBeInTheDocument();
  });

  it("renders the lower-edge latency label on the x-axis", () => {
    render(
      <LatencyHistogramChart
        width={400}
        height={200}
        buckets={[{ lower_us: 1_000, upper_us: 2_000, count: 10 }]}
      />,
    );
    expect(screen.getByRole("region", { name: /지연 분포/ })).toHaveTextContent("1.0 ms");
  });
});
