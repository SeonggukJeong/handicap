import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TimeSeriesChart } from "../TimeSeriesChart";

describe("TimeSeriesChart", () => {
  it("renders an SVG with the title heading", () => {
    render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={[
          { ts_second: 100, value: 0 },
          { ts_second: 101, value: 50 },
          { ts_second: 102, value: 75 },
        ]}
        width={400}
        height={200}
      />,
    );
    const region = screen.getByRole("region", { name: /Time series — RPS/ });
    expect(region.querySelector("svg")).not.toBeNull();
  });

  it("survives empty data without throwing", () => {
    render(
      <TimeSeriesChart title="Errors" yLabel="errors" data={[]} width={400} height={200} />,
    );
    expect(screen.getByRole("region", { name: /Time series — Errors/ })).toBeInTheDocument();
  });
});
