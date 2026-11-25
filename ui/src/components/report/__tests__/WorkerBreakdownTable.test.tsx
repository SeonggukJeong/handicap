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

  describe("1ms 미만·60초 칸 (stats)", () => {
    const st = (p50: number, p95: number, p99: number) => ({
      min_us: 0,
      mean_us: 0,
      max_us: 0,
      stdev_us: 0,
      p50_us: p50,
      p90_us: p95,
      p95_us: p95,
      p99_us: p99,
      capped: false,
    });
    it("1ms 미만은 µs, 60초 칸은 「≥ 60,000」", () => {
      const w: WorkerBreakdown[] = [
        {
          worker_id: "a",
          count: 10,
          errors: 0,
          p50_ms: 0,
          p95_ms: 43,
          p99_ms: 60030,
          stats: st(350, 43000, 60_000_000),
        },
        { worker_id: "b", count: 10, errors: 0, p50_ms: 0, p95_ms: 43, p99_ms: 7 },
      ];
      render(<WorkerBreakdownTable breakdown={w} />);
      const r1 = screen.getByText("워커 1").closest("tr")!;
      const c1 = within(r1).getAllByRole("cell");
      expect(c1[4]).toHaveTextContent("350 µs");
      expect(c1[5]).toHaveTextContent("43");
      expect(c1[5]).not.toHaveTextContent("µs");
      expect(c1[6]).toHaveTextContent("≥ 60,000");
      const c2 = within(screen.getByText("워커 2").closest("tr")!).getAllByRole("cell");
      expect(c2[4].textContent).toBe("0");
      expect(c2[5].textContent).toBe("43");
    });
    it("통과 표본에 통과 0건이면 stats가 있어도 「—」", () => {
      const w: WorkerBreakdown[] = [
        {
          worker_id: "a",
          count: 5,
          errors: 5,
          p50_ms: 0,
          p95_ms: 0,
          p99_ms: 0,
          stats: st(350, 350, 350),
        },
        { worker_id: "b", count: 5, errors: 0, p50_ms: 1, p95_ms: 1, p99_ms: 1 },
      ];
      render(<WorkerBreakdownTable breakdown={w} sample="passed" />);
      const c = within(screen.getByText("워커 1").closest("tr")!).getAllByRole("cell");
      expect(c[4].textContent).toBe("—");
    });
  });
});
