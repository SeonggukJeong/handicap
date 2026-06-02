import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VerdictPanel } from "../VerdictPanel";

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
