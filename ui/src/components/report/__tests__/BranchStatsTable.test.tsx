import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { BranchStatsTable } from "../BranchStatsTable";
import type { IfBreakdown } from "../../../api/schemas";

describe("BranchStatsTable", () => {
  const breakdown: IfBreakdown[] = [
    {
      step_id: "if1",
      branches: [
        { branch: "else", count: 100 },
        { branch: "then", count: 930 },
        { branch: "elif_0", count: 210 },
        { branch: "none", count: 0 },
      ],
    },
  ];
  const meta = new Map([["if1", { name: "branch-on-status" }]]);

  it("renders one row per if-node, branch rows hidden until expanded", () => {
    render(<BranchStatsTable breakdown={breakdown} meta={meta} />);
    expect(screen.getByText(/branch-on-status/)).toBeInTheDocument();
    expect(screen.queryByText("then")).not.toBeInTheDocument();
  });

  it("expands to per-branch decision counts incl the none bucket, in display order", async () => {
    const user = userEvent.setup();
    render(<BranchStatsTable breakdown={breakdown} meta={meta} />);
    await user.click(screen.getByRole("button", { name: /branch-on-status/i }));
    expect(screen.getByText("then")).toBeInTheDocument();
    expect(screen.getByText("elif_0")).toBeInTheDocument();
    expect(screen.getByText("else")).toBeInTheDocument();
    expect(screen.getByText("(미매치)")).toBeInTheDocument();
    // display order: then < elif_0 < else < none
    const labels = screen.getAllByTestId("branch-label").map((e) => e.textContent);
    expect(labels).toEqual(["then", "elif_0", "else", "(미매치)"]);
  });

  it("renders nothing when there are no if-nodes", () => {
    const { container } = render(<BranchStatsTable breakdown={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
