import { describe, expect, it } from "vitest";
import { bareVarMatch, knownVarNames } from "../condVarHint";
import { parseScenarioDoc } from "../yamlDoc";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  region: "kr"
steps:
  - id: "01HX0000000000000000000001"
    name: "get"
    type: http
    request:
      method: GET
      url: "/flag"
    extract:
      - var: flag
        from: body
        path: "$.ok"
  - id: "01HX0000000000000000000002"
    name: "fan"
    type: parallel
    branches:
      - name: b1
        steps:
          - id: "01HX0000000000000000000003"
            name: "p"
            type: http
            request:
              method: GET
              url: "/p"
            extract:
              - var: pv
                from: body
                path: "$.x"
`;

function model() {
  const r = parseScenarioDoc(YAML);
  if (!("model" in r)) throw new Error("fixture must parse");
  return r.model;
}

describe("knownVarNames", () => {
  it("collects declared, extracted and parallel names as the variables panel lists them", () => {
    const names = knownVarNames(model());
    expect(names.has("region")).toBe(true);
    expect(names.has("flag")).toBe(true);
    expect(names.has("b1.pv")).toBe(true);
    expect(names.has("pv")).toBe(true);
    expect(names.has("nope")).toBe(false);
  });

  it("is empty without a model", () => {
    expect(knownVarNames(null).size).toBe(0);
  });
});

describe("bareVarMatch", () => {
  const known = new Set(["flag", "b1.pv"]);

  it("returns the name when the operand is exactly a known variable name", () => {
    expect(bareVarMatch("flag", known)).toBe("flag");
    expect(bareVarMatch("b1.pv", known)).toBe("b1.pv");
  });

  it("ignores surrounding whitespace", () => {
    expect(bareVarMatch("  flag ", known)).toBe("flag");
  });

  it("does not match templated, partial or unknown operands", () => {
    expect(bareVarMatch("{{flag}}", known)).toBeNull();
    expect(bareVarMatch("${flag}", known)).toBeNull();
    expect(bareVarMatch("flags", known)).toBeNull();
    expect(bareVarMatch("my flag", known)).toBeNull();
    expect(bareVarMatch("true", known)).toBeNull();
    expect(bareVarMatch("", known)).toBeNull();
  });
});
