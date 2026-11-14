import { render, screen, within } from "@testing-library/react";
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

const longName = "POST /kramycard/cache/ajax/setupList.json";
const stepsLong = [
  {
    step_id: "s2",
    count: 50,
    error_count: 0,
    status_counts: { "200": 50 },
    p50_ms: 100,
    p95_ms: 120,
    p99_ms: 130,
    wait: { count: 50, p50_ms: 90, p95_ms: 110, p99_ms: 120, max_ms: 125 },
    download: { count: 50, p50_ms: 10, p95_ms: 15, p99_ms: 18, max_ms: 20 },
  },
];
const metaLong = new Map([
  [
    "s2",
    {
      id: "s2",
      name: longName,
      method: "POST",
      url: "/kramycard/cache/ajax/setupList.json",
    },
  ],
]);

describe("StepPhaseBreakdown", () => {
  it("defaults to waterfall and toggles to chips", async () => {
    const user = userEvent.setup();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
    // waterfall default: role="img" bars are unique to the waterfall view (not chips)
    expect(screen.getByRole("img", { name: /login/ })).toBeInTheDocument();
    // toggle to chips view
    await user.click(screen.getByRole("button", { name: "칩" }));
    expect(screen.getByText(/대기/)).toBeInTheDocument();
  });

  it("waterfall label div has truncate class and title for long step names", () => {
    render(<StepPhaseBreakdown steps={stepsLong as never} meta={metaLong} />);
    // The label div renders the step name as text; bar div has role="img" and is distinct
    const labelEl = screen.getByText(longName);
    expect(labelEl).toHaveClass("truncate");
    expect(labelEl).toHaveAttribute("title", longName);
  });

  describe("retriedStepIds 표지", () => {
    it("막대 보기: 이름 칸 안에 표지, 이름은 truncate+title 유지", () => {
      render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set(["s1"])} />,
      );
      const name = screen.getByTitle("login");
      expect(name).toHaveClass("truncate");
      expect(name).not.toHaveClass("w-40");
      const cell = name.closest(".w-40") as HTMLElement;
      expect(cell).not.toBeNull();
      expect(within(cell).getByText("재시도 포함")).toHaveClass("shrink-0");
    });
    it("표 보기로 전환해도 표지가 보인다", async () => {
      const user = userEvent.setup();
      render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set(["s1"])} />,
      );
      await user.click(screen.getByRole("button", { name: "칩" }));
      expect(screen.getByText("재시도 포함")).toBeInTheDocument();
    });
    it("표지 없는 행은 기존 DOM 그대로, prop 없음 = 빈 Set", () => {
      const a = render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
      const cell = screen.getByTitle("login");
      expect(cell).toHaveClass("w-40");
      expect(cell).toHaveClass("truncate");
      const htmlNone = a.container.innerHTML;
      a.unmount();
      const b = render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set()} />,
      );
      expect(b.container.innerHTML).toBe(htmlNone);
    });
  });
});
