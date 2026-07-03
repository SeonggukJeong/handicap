import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WorkerBreakdownTable } from "../WorkerBreakdownTable";
import type { WorkerBreakdown } from "../../../api/schemas";

const rows: WorkerBreakdown[] = [
  { worker_id: "run-w0", count: 100, errors: 2, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
  { worker_id: "run-w1", count: 50, errors: 0, p50_ms: 12, p95_ms: 25, p99_ms: 40 },
];

describe("WorkerBreakdownTable", () => {
  it("renders one row per worker with ordinal labels, worker_id title, and error rate", () => {
    render(<WorkerBreakdownTable breakdown={rows} />);
    const table = screen.getByRole("table");
    // ordinal labels
    expect(within(table).getByText("워커 1")).toBeInTheDocument();
    expect(within(table).getByText("워커 2")).toBeInTheDocument();
    // worker_id surfaced as the name cell's title (hover)
    expect(within(table).getByText("워커 1").closest("td")).toHaveAttribute("title", "run-w0");
    // request count + error rate (2/100 = 2.0%, 0/50 = 0.0%)
    expect(within(table).getByText("100")).toBeInTheDocument();
    expect(within(table).getByText("2.0%")).toBeInTheDocument();
    expect(within(table).getByText("0.0%")).toBeInTheDocument();
    // worker count carried in the heading
    expect(screen.getByRole("heading")).toHaveTextContent("워커별 분해 (2개 워커)");
  });

  it("renders nothing with fewer than 2 workers", () => {
    const { container } = render(<WorkerBreakdownTable breakdown={[rows[0]]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<WorkerBreakdownTable breakdown={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("nonzero<0.05% 에러율은 '<0.1%'로 floor (R5)", () => {
    const tinyRows: WorkerBreakdown[] = [
      { worker_id: "run-w0", count: 3000, errors: 1, p50_ms: 10, p95_ms: 20, p99_ms: 30 },
      { worker_id: "run-w1", count: 50, errors: 0, p50_ms: 12, p95_ms: 25, p99_ms: 40 },
    ];
    render(<WorkerBreakdownTable breakdown={tinyRows} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("<0.1%")).toBeInTheDocument();
  });
});
