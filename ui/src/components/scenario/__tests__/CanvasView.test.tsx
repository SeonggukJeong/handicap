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

describe("CanvasView add if", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("has an Add if button that creates an if step and selects it", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    await user.click(screen.getByRole("button", { name: /add if/i }));
    const state = useScenarioEditor.getState();
    expect(state.model!.steps.some((s) => s.type === "if")).toBe(true);
    expect(state.selectedStepId).not.toBeNull();
  });

  it("empty-canvas hint names every addable node kind (step, loop, if)", () => {
    render(<CanvasView />);
    expect(screen.getByText(/add a step, loop, or if to begin/i)).toBeInTheDocument();
  });
});

describe("CanvasView if node", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`);
  });

  it("renders an if container with its condition summary and a THEN band", () => {
    render(<CanvasView />);
    expect(screen.getByText("branch")).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    expect(screen.getByText(/\{\{code\}\} eq 200/)).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument(); // inner http child node
  });
});
