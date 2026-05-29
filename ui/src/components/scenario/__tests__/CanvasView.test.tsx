import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasView } from "../CanvasView";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

describe("CanvasView loop node", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("renders a loop container with its inner step and a repeat badge", async () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Checkout loop");
    useScenarioEditor.getState().setLoopRepeat(loopId, 4);
    render(<CanvasView />);
    expect(screen.getByText("Checkout loop")).toBeInTheDocument();
    expect(screen.getByText(/×\s*4/)).toBeInTheDocument(); // repeat badge
  });

  it("has an Add loop button that creates a loop", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    await user.click(screen.getByRole("button", { name: /add loop/i }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps.some((s) => s.type === "loop")).toBe(true);
  });
});
