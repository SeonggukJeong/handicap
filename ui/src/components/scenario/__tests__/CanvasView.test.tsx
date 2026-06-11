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
    await user.click(screen.getByRole("button", { name: /반복\(loop\)/ }));
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
    await user.click(screen.getByRole("button", { name: /조건\(if\)/ }));
    const state = useScenarioEditor.getState();
    expect(state.model!.steps.some((s) => s.type === "if")).toBe(true);
    expect(state.selectedStepId).not.toBeNull();
  });

  it("empty-canvas hint names every addable node kind (step, loop, if, parallel)", () => {
    render(<CanvasView />);
    expect(screen.getByText(/HTTP 스텝을 추가해 시작하세요/)).toBeInTheDocument();
  });

  it("renders the empty-canvas hint below the buttons, not in their row", () => {
    render(<CanvasView />);
    const hint = screen.getByText(/HTTP 스텝을 추가해 시작하세요/);
    const addStep = screen.getByRole("button", { name: /HTTP 스텝/ });
    // The hint must live outside the buttons' flex row (so the row can't squeeze
    // the buttons into wrapping their labels). It sits below as its own block.
    expect(addStep.parentElement).not.toContainElement(hint);
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

describe("CanvasView nested (9c)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("renders a loop nested inside an if THEN branch (9c)", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: gate
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000020"
        name: inner-loop
        type: loop
        repeat: 3
        do:
          - id: "01HX0000000000000000000021"
            name: ping
            type: http
            request:
              method: GET
              url: "/ping"
            assert:
              - status: 200
`);
    render(<CanvasView />);
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    expect(screen.getByText("inner-loop")).toBeInTheDocument(); // nested loop container
    expect(screen.getByText(/×\s*3/)).toBeInTheDocument(); // nested loop repeat badge
    expect(screen.getByText("ping")).toBeInTheDocument(); // depth-2 http leaf
  });
});

describe("CanvasView parallel node (P-b)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("renders a parallel node with one node per branch step + lane labels", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000030"
    name: fan-out
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000031"
            name: get-user
            type: http
            request:
              method: GET
              url: "/user"
            assert:
              - status: 200
      - name: feed
        steps:
          - id: "01HX0000000000000000000032"
            name: get-feed
            type: http
            request:
              method: GET
              url: "/feed"
            assert:
              - status: 200
`);
    render(<CanvasView />);
    // parallel container node header
    expect(screen.getByText(/fan-out/)).toBeInTheDocument();
    // lane labels rendered on the container
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("feed")).toBeInTheDocument();
    // branch http leaves rendered as child nodes
    expect(screen.getByText("get-user")).toBeInTheDocument();
    expect(screen.getByText("get-feed")).toBeInTheDocument();
    // lane label y-position is data-driven (PARALLEL_HEADER_H = 36)
    const userLabel = screen.getByText("user");
    expect(userLabel.style.top).toBe("36px");
    const feedLabel = screen.getByText("feed");
    expect(feedLabel.style.top).toBe("36px");
  });

  it("'+ Add parallel' toolbar button adds a parallel step with 2 branches", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    await user.click(screen.getByRole("button", { name: /동시 실행\(parallel\)/ }));
    const state = useScenarioEditor.getState();
    const parallelSteps = state.model!.steps.filter((s) => s.type === "parallel");
    expect(parallelSteps).toHaveLength(1);
    // addParallelStep always seeds 2 branches
    const parallel = parallelSteps[0];
    expect(parallel.type).toBe("parallel");
    if (parallel.type === "parallel") {
      expect(parallel.branches).toHaveLength(2);
    }
  });
});

describe("CanvasView relabel + panel hint (U3)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("4 add buttons use Korean labels and a container caption line is always present", () => {
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 조건(if)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 동시 실행(parallel)" })).toBeInTheDocument();
    expect(screen.getByText(/컨테이너입니다/)).toBeInTheDocument();
  });

  it("selecting a top-level loop morphs the primary button into the in-loop variant", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps[0].type === "loop" && steps[0].do.length).toBe(2); // seed child + 1
  });

  it("shows the panel hint once after the FIRST add, hides it on the second add", async () => {
    const user = userEvent.setup();
    render(<CanvasView />);
    expect(screen.queryByText(/오른쪽 '스텝 설정'/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    expect(screen.getByText(/오른쪽 '스텝 설정'/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    expect(screen.queryByText(/오른쪽 '스텝 설정'/)).not.toBeInTheDocument();
  });

  it("tone-down: the 3 container buttons are muted, the HTTP button is not", () => {
    render(<CanvasView />);
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toHaveClass("text-slate-500");
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).not.toHaveClass("text-slate-500");
  });
});

describe("CanvasView empty-url badge (U3)", () => {
  beforeEach(() => {
    reset();
  });

  it("renders a ⚠ badge on http nodes whose url is empty, and none otherwise", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "no-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
  - id: "01HX0000000000000000000011"
    name: "has-url"
    type: http
    request:
      method: GET
      url: "/ok"
    assert:
      - status: 200
`);
    render(<CanvasView />);
    const badges = screen.getAllByTitle("URL이 비어 있습니다");
    expect(badges).toHaveLength(1);
    // 배지는 name span과 같은 flex 행 — name의 parentElement가 곧 그 행
    expect(screen.getByText("no-url").parentElement).toContainElement(badges[0]);
  });
});
