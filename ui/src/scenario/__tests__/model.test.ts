import { describe, expect, it } from "vitest";
import {
  ScenarioModel,
  StepModel,
  ExtractModel,
  type Scenario,
  type Step,
  type Extract,
  newEmptyScenario,
} from "../model";

describe("ScenarioModel", () => {
  it("accepts a minimal valid scenario", () => {
    const value: Scenario = {
      version: 1,
      name: "demo",
      cookie_jar: "auto",
      variables: { base_url: "http://localhost" },
      steps: [
        {
          id: "01HX0000000000000000000000",
          name: "home",
          type: "http",
          request: { method: "GET", url: "{{base_url}}/", headers: {} },
          assert: [{ kind: "status", code: 200 }],
          extract: [],
        },
      ],
    };
    expect(ScenarioModel.parse(value)).toEqual(value);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      ScenarioModel.parse({
        version: 1,
        name: "x",
        cookie_jar: "auto",
        variables: {},
        steps: [],
        bogus: true,
      }),
    ).toThrow();
  });

  it("rejects an empty step name", () => {
    const step = {
      id: "01HX0000000000000000000000",
      name: "",
      type: "http",
      request: { method: "GET", url: "/" },
      assert: [],
    };
    expect(() => StepModel.parse(step)).toThrow();
  });

  const base: Pick<Step, "id" | "name" | "type" | "assert"> = {
    id: "01HX0000000000000000000001",
    name: "x",
    type: "http",
    assert: [],
  };

  it("accepts a json body variant", () => {
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "json", value: { a: 1 } } },
      }),
    ).not.toThrow();
  });

  it("accepts a form body variant", () => {
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "form", value: { a: "1" } } },
      }),
    ).not.toThrow();
  });

  it("accepts a raw body variant", () => {
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "raw", value: "hello" } },
      }),
    ).not.toThrow();
  });

  it("rejects an HTTP method that is not in the allowed list", () => {
    expect(() =>
      StepModel.parse({
        id: "01HX0000000000000000000002",
        name: "x",
        type: "http",
        request: { method: "TRACE", url: "/" },
        assert: [],
      }),
    ).toThrow();
  });

  it("newEmptyScenario produces something the schema accepts", () => {
    const s = newEmptyScenario("Untitled");
    expect(() => ScenarioModel.parse(s)).not.toThrow();
    expect(s.steps).toHaveLength(0);
    expect(s.cookie_jar).toBe("auto");
  });
});

describe("ExtractModel", () => {
  it("accepts the four variants", () => {
    const cases: Extract[] = [
      { var: "t", from: "body", path: "$.x" },
      { var: "h", from: "header", name: "X-Trace" },
      { var: "c", from: "cookie", name: "JSESSIONID" },
      { var: "s", from: "status" },
    ];
    for (const c of cases) {
      expect(() => ExtractModel.parse(c)).not.toThrow();
    }
  });

  it("rejects body extract without path", () => {
    expect(() => ExtractModel.parse({ var: "x", from: "body" })).toThrow();
  });

  it("rejects header extract without name", () => {
    expect(() => ExtractModel.parse({ var: "x", from: "header" })).toThrow();
  });

  it("rejects unknown from", () => {
    expect(() =>
      ExtractModel.parse({ var: "x", from: "headers", name: "X" }),
    ).toThrow();
  });
});

describe("ScenarioModel + extract", () => {
  it("accepts a step with extracts", () => {
    const value = {
      version: 1,
      name: "demo",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000001",
          name: "login",
          type: "http",
          request: { method: "POST", url: "/x" },
          assert: [],
          extract: [{ var: "token", from: "body", path: "$.access_token" }],
        },
      ],
    };
    expect(() => ScenarioModel.parse(value)).not.toThrow();
  });
});
