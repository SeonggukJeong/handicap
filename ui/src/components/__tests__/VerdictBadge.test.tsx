import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerdictBadge } from "../VerdictBadge";

describe("VerdictBadge", () => {
  it("renders — for null/undefined", () => {
    render(<VerdictBadge verdict={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it("renders PASS for passed verdict", () => {
    render(<VerdictBadge verdict={{ passed: true, criteria: [] }} />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
  });
  it("renders FAIL with failed-criteria title (metric-aware formatting, shared with VerdictPanel)", () => {
    render(
      <VerdictBadge
        verdict={{
          passed: false,
          criteria: [
            { metric: "p95_ms", direction: "max", threshold: 300, actual: 420, passed: false },
            {
              metric: "error_rate",
              direction: "max",
              threshold: 0.01,
              actual: 0.05,
              passed: false,
            },
            { metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true },
          ],
        }}
      />,
    );
    const badge = screen.getByText("FAIL");
    expect(badge).toBeInTheDocument();
    // latency → " ms", rate → "%" via shared fmt(); passed criterion (rps) filtered out.
    expect(badge).toHaveAttribute("title", "p95_ms 420 ms > 300 ms, error_rate 5.00% > 1.00%");
  });
});
