import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { CompareMatrix } from "../CompareMatrix";
import type { CompareResult } from "../../../compare/compareReports";

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
});
