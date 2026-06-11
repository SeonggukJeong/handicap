import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GroupLatencyTable } from "../GroupLatencyTable";
import type { GroupLatency } from "../../../api/schemas";

const rows: GroupLatency[] = [
  {
    step_id: "p1",
    count: 42,
    p50_ms: 300,
    p95_ms: 420,
    p99_ms: 500,
    max_ms: 610,
    branches: [
      { branch: "feed", count: 42, p50_ms: 300, p95_ms: 410, p99_ms: 480, max_ms: 600 },
      { branch: "user", count: 42, p50_ms: 40, p95_ms: 60, p99_ms: 70, max_ms: 90 },
    ],
  },
];

describe("GroupLatencyTable", () => {
  it("renders a page row plus a sub-row per branch", () => {
    render(<GroupLatencyTable breakdown={rows} meta={new Map([["p1", { name: "page load" }]])} />);
    expect(screen.getByRole("region", { name: "Page load latency" })).toBeInTheDocument();
    expect(screen.getByText("page load")).toBeInTheDocument();
    expect(screen.getByText("420")).toBeInTheDocument(); // page p95
    expect(screen.getByText("610")).toBeInTheDocument(); // page max
    expect(screen.getByRole("columnheader", { name: "p95 ms" })).toBeInTheDocument();
    // branch sub-rows: labels = branch names, values locked to their own row
    // (within() so a feed↔user value swap fails, not just presence)
    const feedRow = screen.getByText(/feed/).closest("tr")!;
    expect(within(feedRow).getByText("600")).toBeInTheDocument(); // feed max (bottleneck)
    const userRow = screen.getByText(/user/).closest("tr")!;
    expect(within(userRow).getByText("90")).toBeInTheDocument(); // user max (fast)
  });

  it("falls back to step_id when meta is missing", () => {
    render(<GroupLatencyTable breakdown={rows} meta={new Map()} />);
    expect(screen.getByText("p1")).toBeInTheDocument();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<GroupLatencyTable breakdown={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
