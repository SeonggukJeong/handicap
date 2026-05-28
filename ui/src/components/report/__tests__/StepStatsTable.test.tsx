import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StepStatsTable } from "../StepStatsTable";

describe("StepStatsTable", () => {
  it("renders rows for each step with metadata when available", () => {
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 100,
            error_count: 2,
            status_counts: { "200": 98, "500": 2 },
            p50_ms: 10,
            p95_ms: 50,
            p99_ms: 90,
          },
          {
            step_id: "stepB",
            count: 50,
            error_count: 0,
            status_counts: { "200": 50 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
          },
        ]}
        meta={meta}
      />,
    );
    const region = screen.getByRole("region", { name: /Per-step stats/ });
    expect(region).toHaveTextContent("login");
    expect(region).toHaveTextContent("POST");
    expect(region).toHaveTextContent("http://x/login");
    expect(region).toHaveTextContent("100");
    expect(region).toHaveTextContent("stepB"); // missing meta → falls back to id
  });
});
