import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PercentileCurveChart } from "../PercentileCurveChart";

describe("PercentileCurveChart", () => {
  it("renders an SVG line chart for the percentile curve", () => {
    render(
      <PercentileCurveChart
        curve={[
          { quantile: 0.5, value_us: 20_000 },
          { quantile: 0.99, value_us: 80_000 },
          { quantile: 1.0, value_us: 120_000 },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: /지연 분위 곡선/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("지연 분위 곡선");
  });

  it("renders quantile labels on the x-axis", () => {
    render(
      <PercentileCurveChart
        curve={[
          { quantile: 0.5, value_us: 20_000 },
          { quantile: 0.99, value_us: 80_000 },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: /지연 분위 곡선/ });
    // p50 and p99 labels should appear in the chart
    expect(region).toHaveTextContent("p50");
    expect(region).toHaveTextContent("p99");
  });
});
