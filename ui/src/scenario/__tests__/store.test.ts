import { describe, expect, it, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";
import type { Extract } from "../model";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  base_url: "http://localhost"
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: GET
      url: "{{base_url}}/"
    assert:
      - status: 200
`;

describe("useScenarioEditor", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("loadFromString sets model and yamlText", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const s = useScenarioEditor.getState();
    expect(s.model?.steps).toHaveLength(1);
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).toContain("01HX0000000000000000000001");
  });

  it("loadFromString with invalid yaml sets yamlError and keeps prior model null", () => {
    useScenarioEditor.getState().loadFromString(":\n::");
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull();
    expect(s.model).toBeNull();
  });

  it("setStepField mutates the doc and rederives the model", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000001", ["request", "method"], "POST");
    const s = useScenarioEditor.getState();
    const step0 = s.model!.steps[0];
    if (step0.type === "http") expect(step0.request.method).toBe("POST");
    expect(s.yamlText).toContain("method: POST");
  });

  it("addStep appends a new step", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const before = useScenarioEditor.getState().model!.steps.length;
    useScenarioEditor.getState().addStep("New step");
    const s = useScenarioEditor.getState();
    expect(s.model!.steps).toHaveLength(before + 1);
    expect(s.model!.steps[before].name).toBe("New step");
  });

  it("removeStep drops by id", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().removeStep("01HX0000000000000000000001");
    expect(useScenarioEditor.getState().model!.steps).toHaveLength(0);
  });

  it("selection state is updated by select()", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
    useScenarioEditor.getState().select(null);
    expect(useScenarioEditor.getState().selectedStepId).toBeNull();
  });

  it("setPendingYamlText holds invalid edits without changing model", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const initialModel = useScenarioEditor.getState().model;
    useScenarioEditor.getState().setPendingYamlText("garbage:::\n::");
    const s = useScenarioEditor.getState();
    // pending text held; model unchanged because pending text is invalid
    expect(s.pendingYamlText).toBe("garbage:::\n::");
    expect(s.model).toBe(initialModel);
  });

  it("commitPendingYaml swaps the doc when text is valid", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const NEW_YAML = VALID_YAML.replace("method: GET", "method: PUT");
    useScenarioEditor.getState().setPendingYamlText(NEW_YAML);
    useScenarioEditor.getState().commitPendingYaml();
    const step0 = useScenarioEditor.getState().model!.steps[0];
    if (step0.type === "http") expect(step0.request.method).toBe("PUT");
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("commitPendingYaml leaves yamlError set when text is invalid", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const initialModel = useScenarioEditor.getState().model;
    useScenarioEditor.getState().setPendingYamlText(":\n::");
    useScenarioEditor.getState().commitPendingYaml();
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull();
    expect(s.model).toBe(initialModel);
  });

  it("removeStep clears selection when the removed step was selected", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    useScenarioEditor.getState().removeStep("01HX0000000000000000000001");
    const s = useScenarioEditor.getState();
    expect(s.selectedStepId).toBeNull();
    expect(s.model!.steps).toHaveLength(0);
  });

  it("removeStep keeps selection if a different step was selected", () => {
    const TWO_STEPS = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "a"
    type: http
    request: { method: GET, url: "/a" }
    assert: [{status: 200}]
  - id: "01HX0000000000000000000002"
    name: "b"
    type: http
    request: { method: GET, url: "/b" }
    assert: [{status: 200}]
`;
    useScenarioEditor.getState().loadFromString(TWO_STEPS);
    useScenarioEditor.getState().select("01HX0000000000000000000002");
    useScenarioEditor.getState().removeStep("01HX0000000000000000000001");
    const s = useScenarioEditor.getState();
    expect(s.selectedStepId).toBe("01HX0000000000000000000002");
    expect(s.model!.steps).toHaveLength(1);
  });
});

describe("store loop actions", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("addLoopStep adds a loop containing one http step", () => {
    const id = useScenarioEditor.getState().addLoopStep("Loop 1");
    const steps = useScenarioEditor.getState().model!.steps;
    const loop = steps.find((s) => s.id === id)!;
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") expect(loop.do).toHaveLength(1);
  });

  it("addStepInLoop appends to the loop body", () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Loop");
    useScenarioEditor.getState().addStepInLoop(loopId, "inner-2");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (loop.type === "loop") expect(loop.do).toHaveLength(2);
  });

  it("setLoopRepeat updates repeat", () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Loop");
    useScenarioEditor.getState().setLoopRepeat(loopId, 5);
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (loop.type === "loop") expect(loop.repeat).toBe(5);
  });
});

describe("setStepExtract", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("replaces the extract list and reflects in yamlText", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const stepId = "01HX0000000000000000000001";
    const extracts: Extract[] = [{ var: "token", from: "body", path: "$.access_token" }];
    useScenarioEditor.getState().setStepExtract(stepId, extracts);
    const s = useScenarioEditor.getState();
    const step0 = s.model!.steps[0];
    if (step0.type === "http") expect(step0.extract).toEqual(extracts);
    expect(s.yamlText).toContain("$.access_token");
  });
});

describe("useScenarioEditor — if actions", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(VALID_YAML);
  });

  it("addIfStep appends an if step and returns its id", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    expect(step?.type).toBe("if");
  });

  it("setIfCond replaces the condition", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    useScenarioEditor.getState().setIfCond(id, { left: "{{x}}", op: "eq", right: "1" });
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") expect(step.cond).toEqual({ left: "{{x}}", op: "eq", right: "1" });
    else throw new Error("expected if step");
  });

  it("addStepInBranch adds an http step to else and returns its id", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    const childId = useScenarioEditor.getState().addStepInBranch(id, { kind: "else" }, "E");
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") {
      expect(step.else).toHaveLength(1);
      expect(step.else[0].id).toBe(childId);
    } else throw new Error("expected if step");
  });

  it("addElif then setElifCond then removeElif", () => {
    const id = useScenarioEditor.getState().addIfStep("Branch");
    useScenarioEditor.getState().addElif(id);
    useScenarioEditor.getState().setElifCond(id, 0, { left: "{{c}}", op: "eq", right: "2" });
    let step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") {
      expect(step.elif).toHaveLength(1);
      const ec = step.elif[0].cond;
      if (!("all" in ec) && !("any" in ec)) expect(ec.right).toBe("2");
    } else throw new Error("expected if step");
    useScenarioEditor.getState().removeElif(id, 0);
    step = useScenarioEditor.getState().model!.steps.find((s) => s.id === id);
    if (step?.type === "if") expect(step.elif).toHaveLength(0);
  });

  it("addIfInLoop nests an if in a top-level loop body and returns its id (9c)", () => {
    const loopId = useScenarioEditor.getState().addLoopStep("Loop");
    const ifId = useScenarioEditor.getState().addIfInLoop(loopId, "Inner if");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId);
    if (loop?.type === "loop") {
      const nested = loop.do.find((c) => c.id === ifId);
      expect(nested?.type).toBe("if");
    } else throw new Error("expected loop step");
  });

  it("addLoopInBranch nests a loop in a top-level if branch and returns its id (9c)", () => {
    const ifId = useScenarioEditor.getState().addIfStep("Branch");
    const loopId = useScenarioEditor
      .getState()
      .addLoopInBranch(ifId, { kind: "then" }, "Inner loop");
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === ifId);
    if (step?.type === "if") {
      const nested = step.then.find((c) => c.id === loopId);
      expect(nested?.type).toBe("loop");
    } else throw new Error("expected if step");
  });
});

describe("useScenarioEditor — parallel addBranch", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("addBranch generates a non-colliding default name based on existing branch names", () => {
    const parallelId = useScenarioEditor.getState().addParallelStep("Fan-out");
    // After addParallelStep the node has branch1 + branch2; addBranch should produce branch3
    useScenarioEditor.getState().addBranch(parallelId);
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === parallelId);
    if (step?.type !== "parallel") throw new Error("expected parallel step");
    expect(step.branches).toHaveLength(3);
    expect(step.branches[2].name).toBe("branch3");
  });

  it("addBranch with a collision at size+1 increments to the next free slot", () => {
    const parallelId = useScenarioEditor.getState().addParallelStep("Fan-out");
    // addParallelStep seeds branch1 + branch2; rename branch2 → branch3
    // existing names = {branch1, branch3}; size=2, n starts at 3, collides → n=4
    useScenarioEditor.getState().setBranchName(parallelId, 1, "branch3");
    useScenarioEditor.getState().addBranch(parallelId);
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === parallelId);
    if (step?.type !== "parallel") throw new Error("expected parallel step");
    expect(step.branches[2].name).toBe("branch4");
  });
});
