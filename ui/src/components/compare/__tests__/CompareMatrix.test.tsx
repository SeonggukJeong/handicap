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
    // Mismatch banner must remain reachable via role="status" after Callout conversion
    expect(screen.getByRole("status")).toBeInTheDocument();
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

describe("CompareMatrix sublines (run-identity Task 9, additive optional prop)", () => {
  const twoRunResult: CompareResult = {
    runIds: ["abc123", "xyz789"],
    // baseline is xyz789 (index 1) so the "(base)" suffix never lands on the
    // abc123 button — its accessible name stays exactly "#abc123" below.
    baselineIdx: 1,
    summary: [],
    steps: [],
    status: [],
    verdict: { passed: [null, null] },
    stepMismatch: false,
  };
  const labels = { abc123: "#abc123", xyz789: "#xyz789" };

  it("renders the subline text beside the header button without joining the baseline toggle button's accessible name", () => {
    render(
      <CompareMatrix
        result={twoRunResult}
        labels={labels}
        sublines={{ abc123: "2026-08-09 10:00 · 고정 20 VU · 60s" }}
        onBaselineChange={() => {}}
      />,
    );
    // Subline text renders in the header.
    expect(screen.getByText("2026-08-09 10:00 · 고정 20 VU · 60s")).toBeInTheDocument();
    // getByRole name-matching is exact by default — this only succeeds if the
    // subline text did NOT join the button's accessible name (it must be a
    // sibling of the button, not a descendant).
    expect(screen.getByRole("button", { name: "#abc123" })).toBeInTheDocument();
  });

  it("omits the subline element entirely when the sublines prop is not passed", () => {
    const { container } = render(
      <CompareMatrix result={twoRunResult} labels={labels} onBaselineChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "#abc123" })).toBeInTheDocument();
    expect(container.querySelectorAll("th div")).toHaveLength(0);
  });
});
