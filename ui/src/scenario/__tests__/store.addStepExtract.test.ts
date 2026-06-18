import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";
import type { Extract } from "../model";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: 01J0000000000000000000000A
    name: login
    type: http
    request:
      method: POST
      url: https://x/login
`;

const ID = "01J0000000000000000000000A";

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("addStepExtract", () => {
  it("appends an extract to the http step and round-trips to YAML", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const ex: Extract = { var: "token", from: "body", path: "$.data.token" };
    useScenarioEditor.getState().addStepExtract(ID, ex);
    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") expect(step.extract).toContainEqual(ex);
    expect(useScenarioEditor.getState().yamlText).toContain("extract:");
    expect(useScenarioEditor.getState().yamlText).toContain("$.data.token");
  });

  it("appends a second extract (duplicate var allowed)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().addStepExtract(ID, { var: "t", from: "body", path: "$.a" });
    useScenarioEditor.getState().addStepExtract(ID, { var: "t", from: "body", path: "$.b" });
    const step = useScenarioEditor.getState().model!.steps[0];
    if (step.type === "http") expect(step.extract).toHaveLength(2);
  });

  it("no-ops for a missing step id (R7)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const before = useScenarioEditor.getState().yamlText;
    useScenarioEditor
      .getState()
      .addStepExtract("01J0000000000000000000000Z", { var: "x", from: "status" });
    expect(useScenarioEditor.getState().yamlText).toBe(before);
  });

  it("commits a pending YAML buffer before writing (no stale-doc clobber)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    // Simulate Monaco edit in flight: rename via pending buffer, uncommitted.
    const edited = YAML.replace("name: login", "name: signin");
    useScenarioEditor.getState().setPendingYamlText(edited);
    useScenarioEditor.getState().addStepExtract(ID, { var: "token", from: "body", path: "$.t" });
    const step = useScenarioEditor.getState().model!.steps[0];
    // pending rename was committed first, then extract appended on top.
    if (step.type === "http") {
      expect(step.name).toBe("signin");
      expect(step.extract).toHaveLength(1);
    }
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("no-ops when the pending buffer is unparseable (keeps user edits)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nsteps: [oops");
    useScenarioEditor.getState().addStepExtract(ID, { var: "x", from: "status" });
    // Buffer preserved, no extract written, model unchanged (still parseable original).
    expect(useScenarioEditor.getState().pendingYamlText).not.toBeNull();
    const step = useScenarioEditor.getState().model!.steps[0];
    if (step.type === "http") expect(step.extract).toHaveLength(0);
  });
});
