import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const SC = `version: 1
name: "t"
variables: { flatVar: "x" }
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: prod
            request: { method: GET, url: "/p?x={{s}}&d={{dangling}}" }
            extract: [ { var: s, from: status }, { var: flatVar, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: down
    request: { method: GET, url: "/d?y={{B.s}}" }
`;

function load(yaml: string) {
  useScenarioEditor.getState().loadFromString(yaml);
}

describe("store.renameParallelVar (R6/R7)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  it("happy: renames non-shadow parallel var, commits, downstream+internal rewritten", () => {
    load(SC);
    const err = useScenarioEditor.getState().renameParallelVar("B", "s", "s2");
    expect(err).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toContain("{{s2}}");
    expect(yaml).toContain("{{B.s2}}");
    expect(yaml).toContain("var: s2");
  });

  it("invalid: empty / illegal chars / self", () => {
    load(SC);
    const s = () => useScenarioEditor.getState();
    expect(s().renameParallelVar("B", "s", "")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "a b")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "a{b")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "s")).toBe("self");
  });

  it("invalid(shadow, defensive): oldName is also a flat producer", () => {
    load(SC);
    // flatVar is declared AND extracted in branch B → shadow identity
    expect(useScenarioEditor.getState().renameParallelVar("B", "flatVar", "z")).toBe("shadow");
  });

  it("collision: into-shadow (newName is a flat producer)", () => {
    load(SC);
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "flatVar")).toBe("collision");
  });

  it("collision: namespaced target already produced/referenced", () => {
    load(SC);
    // rename s→s so B.s exists; try renaming to a name whose namespaced form is referenced downstream.
    // {{B.s}} already referenced; renaming a *different* var into "s" collides via B.s.
    const two = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000050", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status }, { var: t, from: status } ] } ]
  - id: "01HX0000000000000000000060"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.s}}" }
`;
    load(two);
    // rename (B,t)→s : B.s already produced+referenced → collision
    expect(useScenarioEditor.getState().renameParallelVar("B", "t", "s")).toBe("collision");
  });

  it("collision: branch-internal dangling bare (F3/§⑤)", () => {
    load(SC);
    // branch B references bare {{dangling}} but does not extract it → rename s→dangling would merge
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "dangling")).toBe("collision");
  });

  it("yamlError: no-op returns invalid, does not mutate", () => {
    load("version: 1\nname: t\nvariables: {}\nsteps: []\n");
    // force a broken buffer
    useScenarioEditor.setState({ yamlError: "boom" });
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "s2")).toBe("invalid");
  });
});
