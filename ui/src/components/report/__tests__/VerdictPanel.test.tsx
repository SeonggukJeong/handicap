import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VerdictPanel } from "../VerdictPanel";

const cr = (
  metric: string,
  direction: "max" | "min",
  threshold: number,
  actual: number,
  passed: boolean,
) => ({ metric, direction, threshold, actual, passed });

describe("VerdictPanel", () => {
  it("renders PASS with the metric label", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: true,
          criteria: [
            { metric: "p95_ms", direction: "max", threshold: 500, actual: 300, passed: true },
          ],
        }}
      />,
    );
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("p95")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /SLO/ })).toBeInTheDocument();
  });

  it("renders FAIL and formats error_rate as percent", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: false,
          criteria: [
            {
              metric: "error_rate",
              direction: "max",
              threshold: 0.01,
              actual: 0.05,
              passed: false,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("FAIL")).toBeInTheDocument();
    expect(screen.getByText("5.00%")).toBeInTheDocument();
  });
});

describe("VerdictPanel new metric rows", () => {
  it("renders status-class rate as % and count as integer, window rps with ≥", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: false,
          criteria: [
            cr("5xx_rate", "max", 0.05, 0.1, false),
            cr("4xx_count", "max", 0, 3, false),
            cr("min_window_rps", "min", 50, 42.5, false),
          ],
        }}
      />,
    );
    expect(screen.getByText("5xx 비율")).toBeInTheDocument();
    expect(screen.getByText(/10\.00%/)).toBeInTheDocument(); // actual 0.1 → 10.00%
    expect(screen.getByText("4xx 수")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // count, no " ms"
    expect(screen.queryByText("3 ms")).not.toBeInTheDocument();
    expect(screen.getByText("최소 구간 RPS")).toBeInTheDocument();
    expect(screen.getByText(/≥/)).toBeInTheDocument(); // min direction
    expect(screen.getByText("42.5")).toBeInTheDocument(); // 1 decimal
  });
});
