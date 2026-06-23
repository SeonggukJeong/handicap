import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StepPhaseBreakdown } from "../StepPhaseBreakdown";

const steps = [
  {
    step_id: "s1",
    count: 100,
    error_count: 0,
    status_counts: { "200": 100 },
    p50_ms: 48,
    p95_ms: 60,
    p99_ms: 70,
    wait: { count: 100, p50_ms: 45, p95_ms: 55, p99_ms: 60, max_ms: 61 },
    download: { count: 100, p50_ms: 3, p95_ms: 5, p99_ms: 6, max_ms: 7 },
  },
];
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "/login" }]]);

describe("StepPhaseBreakdown", () => {
  it("defaults to waterfall and toggles to chips", async () => {
    const user = userEvent.setup();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
    // waterfall default: bars present (role img or labelled track)
    expect(screen.getByText("login")).toBeInTheDocument();
    // toggle to chips view
    await user.click(screen.getByRole("button", { name: "칩" }));
    expect(screen.getByText(/대기/)).toBeInTheDocument();
  });
});
