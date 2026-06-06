import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GroupLatencyTable } from "../GroupLatencyTable";
import type { GroupLatency } from "../../../api/schemas";

const rows: GroupLatency[] = [
  { step_id: "p1", count: 42, p50_ms: 300, p95_ms: 420, p99_ms: 500, max_ms: 610 },
];

describe("GroupLatencyTable", () => {
  it("renders a row per parallel node with the resolved name and stats", () => {
    render(<GroupLatencyTable breakdown={rows} meta={new Map([["p1", { name: "page load" }]])} />);
    expect(screen.getByRole("region", { name: "Page load latency" })).toBeInTheDocument();
    expect(screen.getByText("page load")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("420 ms")).toBeInTheDocument(); // p95
    expect(screen.getByText("610 ms")).toBeInTheDocument(); // max
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
