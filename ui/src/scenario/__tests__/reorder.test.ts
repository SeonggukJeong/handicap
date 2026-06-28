import { describe, it, expect, beforeEach } from "vitest";
import { computeReorder, resolveDragEnd } from "../reorder";
import { useScenarioEditor } from "../store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

describe("computeReorder", () => {
  const group = ["a", "b", "c"];
  it("returns the over index within the same group", () => {
    expect(computeReorder(group, "a", "c")).toBe(2);
    expect(computeReorder(group, "c", "a")).toBe(0);
  });
  it("returns null when active === over (no move)", () => {
    expect(computeReorder(group, "b", "b")).toBeNull();
  });
  it("returns null when over is null", () => {
    expect(computeReorder(group, "a", null)).toBeNull();
  });
  it("returns null when over is in a different group (cross-container drop ignored — slice 3)", () => {
    expect(computeReorder(group, "a", "z")).toBeNull();
  });
});

// IDs used in YAML fixtures below
const ID_A = "01HX0000000000000000000001";
const ID_B = "01HX0000000000000000000002";
const ID_C = "01HX0000000000000000000003";
const ID_LOOP = "01HX0000000000000000000010";
const ID_B2 = "01HX0000000000000000000011";
const ID_C2 = "01HX0000000000000000000012";
const ID_D2 = "01HX0000000000000000000013";
const ID_PAR = "01HX0000000000000000000020";
const ID_PA1 = "01HX0000000000000000000021";
const ID_PA2 = "01HX0000000000000000000022";
const ID_PB1 = "01HX0000000000000000000023";

const FLAT_YAML = `version: 1
name: flat
cookie_jar: auto
variables: {}
steps:
  - id: "${ID_A}"
    name: A
    type: http
    request:
      method: GET
      url: "/a"
  - id: "${ID_B}"
    name: B
    type: http
    request:
      method: GET
      url: "/b"
  - id: "${ID_C}"
    name: C
    type: http
    request:
      method: GET
      url: "/c"
`;

const LOOP_YAML = `version: 1
name: loop
cookie_jar: auto
variables: {}
steps:
  - id: "${ID_A}"
    name: A
    type: http
    request:
      method: GET
      url: "/a"
  - id: "${ID_LOOP}"
    name: loop1
    type: loop
    repeat: 2
    do:
      - id: "${ID_B2}"
        name: B2
        type: http
        request:
          method: GET
          url: "/b2"
      - id: "${ID_C2}"
        name: C2
        type: http
        request:
          method: GET
          url: "/c2"
      - id: "${ID_D2}"
        name: D2
        type: http
        request:
          method: GET
          url: "/d2"
`;

const PARALLEL_YAML = `version: 1
name: par
cookie_jar: auto
variables: {}
steps:
  - id: "${ID_A}"
    name: A
    type: http
    request:
      method: GET
      url: "/a"
  - id: "${ID_PAR}"
    name: par1
    type: parallel
    branches:
      - name: branchA
        steps:
          - id: "${ID_PA1}"
            name: PA1
            type: http
            request:
              method: GET
              url: "/pa1"
          - id: "${ID_PA2}"
            name: PA2
            type: http
            request:
              method: GET
              url: "/pa2"
      - name: branchB
        steps:
          - id: "${ID_PB1}"
            name: PB1
            type: http
            request:
              method: GET
              url: "/pb1"
`;

describe("resolveDragEnd", () => {
  beforeEach(() => reset());

  it("flat scenario: same-group drop returns {stepId, toIndex}", () => {
    useScenarioEditor.getState().loadFromString(FLAT_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    expect(resolveDragEnd(steps, ID_A, ID_C)).toEqual({ stepId: ID_A, toIndex: 2 });
    expect(resolveDragEnd(steps, ID_C, ID_A)).toEqual({ stepId: ID_C, toIndex: 0 });
  });

  it("null over returns null", () => {
    useScenarioEditor.getState().loadFromString(FLAT_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    expect(resolveDragEnd(steps, ID_A, null)).toBeNull();
  });

  it("cross-group drop returns null (top-level step dropped over loop-child)", () => {
    useScenarioEditor.getState().loadFromString(LOOP_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    // A is top-level; B2 is inside loop.do — different groups
    expect(resolveDragEnd(steps, ID_A, ID_B2)).toBeNull();
  });

  it("nested loop: correct group-relative toIndex", () => {
    useScenarioEditor.getState().loadFromString(LOOP_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    // B2, C2, D2 are siblings inside loop.do
    expect(resolveDragEnd(steps, ID_B2, ID_D2)).toEqual({ stepId: ID_B2, toIndex: 2 });
    expect(resolveDragEnd(steps, ID_D2, ID_B2)).toEqual({ stepId: ID_D2, toIndex: 0 });
  });

  it("parallel lane: correct group-relative toIndex within same branch", () => {
    useScenarioEditor.getState().loadFromString(PARALLEL_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    // PA1, PA2 are siblings inside branchA
    expect(resolveDragEnd(steps, ID_PA1, ID_PA2)).toEqual({ stepId: ID_PA1, toIndex: 1 });
  });

  it("parallel lane: cross-branch drop returns null", () => {
    useScenarioEditor.getState().loadFromString(PARALLEL_YAML);
    const steps = useScenarioEditor.getState().model?.steps ?? [];
    // PA1 is branchA, PB1 is branchB — different branches
    expect(resolveDragEnd(steps, ID_PA1, ID_PB1)).toBeNull();
  });
});
