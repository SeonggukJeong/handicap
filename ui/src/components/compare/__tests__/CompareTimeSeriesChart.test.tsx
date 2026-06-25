import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompareTimeSeriesChart } from "../CompareTimeSeriesChart";
import type { OverlayRow, OverlayRun } from "../../../compare/overlaySeries";

const runs: OverlayRun[] = [
  { key: "run0", label: "#111111", color: "#2563eb", baseline: true },
  { key: "run1", label: "#222222", color: "#dc2626", baseline: false },
];
const rows: OverlayRow[] = [
  { elapsed: 0, run0: 10, run1: 20 },
  { elapsed: 1, run0: 12, run1: null },
];

describe("CompareTimeSeriesChart", () => {
  it("renders a labeled region with a legend entry per run, baseline tagged", () => {
    render(
      <CompareTimeSeriesChart
        title="초당 요청 수 (RPS)"
        yLabel="req/s"
        rows={rows}
        runs={runs}
        width={400}
        height={200}
      />,
    );
    // Region role from <section aria-label> wrapper.
    expect(screen.getByRole("region", { name: /초당 요청 수/ })).toBeInTheDocument();
    // Legend entries identified BY TEXT (not index — Recharts <li> trap, ui/CLAUDE.md).
    expect(screen.getByText("#111111 (기준)")).toBeInTheDocument();
    expect(screen.getByText("#222222")).toBeInTheDocument();
  });
});
