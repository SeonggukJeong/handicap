import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionCostCard } from "../ConnectionCostCard";

const stats = {
  dns: { count: 5, p50_ms: 2, p95_ms: 8, p99_ms: 8, max_ms: 9 },
  connect: { count: 5, p50_ms: 15, p95_ms: 40, p99_ms: 40, max_ms: 41 },
  connections_opened: 5,
  requests_total: 1000,
  reuse_ratio: 0.995,
};

describe("ConnectionCostCard", () => {
  it("renders reuse ratio, connections opened, and dns/connect percentiles", () => {
    render(<ConnectionCostCard stats={stats} />);
    expect(screen.getByText(/99\.5%|99,5%/)).toBeInTheDocument(); // reuse ratio
    expect(screen.getByText("5")).toBeInTheDocument(); // connections opened
    expect(screen.getByText(/DNS/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /연결/ })).toBeInTheDocument();
  });
});
