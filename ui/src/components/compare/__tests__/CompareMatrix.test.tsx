import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { CompareMatrix } from "../CompareMatrix";
import type { CompareResult } from "../../../compare/compareReports";
import { runColor } from "../../../compare/runLabel";

const result: CompareResult = {
  runIds: ["A", "B"],
  baselineIdx: 0,
  summary: [
    {
      label: "p95_ms",
      metric: "p95_ms",
      cells: [
        { value: 152, delta: null },
        { value: 184, delta: { pct: 0.21, polarity: "bad" } },
      ],
    },
  ],
  steps: [],
  status: [],
  verdict: { passed: [true, false] },
  stepMismatch: true,
};

describe("CompareMatrix verdict polarity (spec R8)", () => {
  const labels = { A: "#A", B: "#B" };
  function verdictResult(passed: (boolean | null)[]): CompareResult {
    return {
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary: [],
      steps: [],
      status: [],
      verdict: { passed },
      stepMismatch: false,
    };
  }

  it("baseline PASS & candidate FAIL → ▲악화 on candidate, none on baseline", () => {
    render(
      <CompareMatrix
        result={verdictResult([true, false])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/악화/)).toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });

  it("baseline FAIL & candidate PASS → ▼개선", () => {
    render(
      <CompareMatrix
        result={verdictResult([false, true])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/개선/)).toBeInTheDocument();
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
  });

  it("equal verdicts → neutral (no glyph)", () => {
    render(
      <CompareMatrix
        result={verdictResult([true, true])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });
});

describe("CompareMatrix", () => {
  it("renders one table with a shared colgroup so run columns align", () => {
    // Single-table layout (commit d74fe7d): header, verdict, and every section
    // live in ONE <table> governed by a single <colgroup> (label col + one per
    // run), so each run's values sit directly under its header button. jsdom has
    // no layout engine, so we assert the structure that guarantees alignment.
    const { container } = render(
      <CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={() => {}} />,
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("colgroup col")).toHaveLength(result.runIds.length + 1);
  });

  it("renders sections, fires baseline change, shows mismatch banner", async () => {
    const user = userEvent.setup();
    const onBaselineChange = vi.fn();
    render(
      <CompareMatrix
        result={result}
        labels={{ A: "#A", B: "#B" }}
        onBaselineChange={onBaselineChange}
      />,
    );
    expect(screen.getByText("p95_ms")).toBeInTheDocument();
    expect(screen.getByText(/일부만 비교/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /#B/ }));
    expect(onBaselineChange).toHaveBeenCalledWith("B");
  });

  it("renders a per-run color swatch in each header matching the overlay palette (spec §3.2/R3)", () => {
    render(
      <CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={() => {}} />,
    );
    const colA = screen.getByRole("button", { name: /#A/ });
    const colB = screen.getByRole("button", { name: /#B/ });
    const swatchA = colA.querySelector('span[aria-hidden="true"]');
    const swatchB = colB.querySelector('span[aria-hidden="true"]');
    expect(swatchA).not.toBeNull();
    expect(swatchB).not.toBeNull();
    expect(swatchA).toHaveStyle({ backgroundColor: runColor(0) });
    expect(swatchB).toHaveStyle({ backgroundColor: runColor(1) });
  });
});
