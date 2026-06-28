import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const NESTED_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
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
`;

describe("FlowOutline render (full nesting)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("renders every leaf + container with full nesting", () => {
    render(<FlowOutline />);
    // top-level http
    expect(screen.getByText("login")).toBeInTheDocument();
    // method badge text (R6: color + text)
    expect(screen.getByText("POST")).toBeInTheDocument();
    // raw url shown (parity with old canvas — raw, not resolved)
    expect(screen.getByText("/login")).toBeInTheDocument();
    // if container + condition summary + THEN band
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText(/\{\{code\}\} eq 200/)).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    // nested loop container + repeat badge + depth-2 leaf
    expect(screen.getByText("inner-loop")).toBeInTheDocument();
    expect(screen.getByText(/×\s*3/)).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument();
    // parallel container + lane labels + branch leaves
    expect(screen.getByText("fan-out")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("feed")).toBeInTheDocument();
    expect(screen.getByText("get-user")).toBeInTheDocument();
    expect(screen.getByText("get-feed")).toBeInTheDocument();
  });

  it("indents nested rows deeper than top-level rows", () => {
    render(<FlowOutline />);
    const top = screen.getByRole("option", { name: /login/ });
    const nested = screen.getByRole("option", { name: /ping/ });
    // depth is encoded as a data attribute (data-depth) for a deterministic assertion
    expect(Number(nested.getAttribute("data-depth"))).toBeGreaterThan(
      Number(top.getAttribute("data-depth")),
    );
  });
});

describe("FlowOutline selection", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("clicking a row selects that step", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    await user.click(screen.getByText("login"));
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
  });

  it("pressing Enter on a focused row selects it (keyboard a11y, M2)", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /ping/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000021");
  });

  it("clicking the empty background clears selection", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    await user.click(screen.getByTestId("outline-blank"));
    expect(useScenarioEditor.getState().selectedStepId).toBeNull();
  });

  it("the selected row carries the accent highlight class", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /login/ });
    expect(row.className).toMatch(/border-accent-500|ring-accent/);
  });
});

describe("FlowOutline url-missing badge + add buttons + empty state", () => {
  beforeEach(() => reset());

  it("renders a ⚠ badge only on http rows whose url is empty", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    name: "no-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
  - id: "01HX0000000000000000000041"
    name: "has-url"
    type: http
    request:
      method: GET
      url: "/ok"
    assert:
      - status: 200
`);
    render(<FlowOutline />);
    expect(screen.getAllByTitle("URL이 비어 있습니다")).toHaveLength(1);
  });

  it("shows the empty-state message and the 4 add buttons", () => {
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    expect(screen.getByText(/HTTP 스텝을 추가해 시작하세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 조건(if)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 동시 실행(parallel)" })).toBeInTheDocument();
  });

  it("the add-HTTP button appends a step and selects it", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    const st = useScenarioEditor.getState();
    expect(st.model!.steps.length).toBe(1);
    expect(st.selectedStepId).not.toBeNull();
  });

  it("selecting a top-level loop morphs the primary add button into the in-loop variant", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps[0].type === "loop" && steps[0].do.length).toBe(2); // seed child + 1
  });
});
