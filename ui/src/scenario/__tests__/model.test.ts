import { describe, expect, it } from "vitest";
import {
  ScenarioModel,
  StepModel,
  ExtractModel,
  RequestModel,
  ParallelStepModel,
  isLoopStep,
  isHttpStep,
  isIfStep,
  flattenHttpSteps,
  findStepById,
  findStepSiblings,
  summarizeCondition,
  type Scenario,
  type HttpStep,
  type Extract,
  type IfStep,
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

  const base: Pick<HttpStep, "id" | "name" | "type" | "assert"> = {
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

describe("RequestModel", () => {
  it("RequestModel accepts an optional disabled sidecar", () => {
    const r = {
      method: "GET" as const,
      url: "https://api/x",
      headers: {},
      disabled: { headers: { "X-Off": "h" } },
    };
    expect(RequestModel.parse(r).disabled).toEqual({ headers: { "X-Off": "h" } });
    // absent disabled stays undefined (byte-identical pre-feature shape)
    expect(
      RequestModel.parse({ method: "GET", url: "https://api/x", headers: {} }).disabled,
    ).toBeUndefined();
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
    expect(() => ExtractModel.parse({ var: "x", from: "headers", name: "X" })).toThrow();
  });
});

const LOOP_YAML_JS = {
  version: 1,
  name: "x",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000001",
      name: "loop",
      type: "loop",
      repeat: 3,
      do: [
        {
          id: "01HX0000000000000000000002",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/x", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    },
  ],
};

describe("loop step model", () => {
  it("accepts a valid loop step", () => {
    const r = ScenarioModel.safeParse(LOOP_YAML_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const s = r.data.steps[0];
      expect(isLoopStep(s)).toBe(true);
      expect(isHttpStep(s)).toBe(false);
    }
  });

  it("rejects repeat = 0", () => {
    const bad = structuredClone(LOOP_YAML_JS);
    bad.steps[0].repeat = 0;
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("rejects a nested loop inside do (single-level)", () => {
    const bad = structuredClone(LOOP_YAML_JS);
    (bad.steps[0].do as unknown[]).push({
      id: "01HX0000000000000000000003",
      name: "inner-loop",
      type: "loop",
      repeat: 2,
      do: [],
    });
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("rejects request key on a loop step", () => {
    const bad = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
    (bad.steps as Record<string, unknown>[])[0].request = { method: "GET", url: "/" };
    expect(ScenarioModel.safeParse(bad).success).toBe(false);
  });

  it("flattenHttpSteps recurses into loop bodies", () => {
    const r = ScenarioModel.safeParse(LOOP_YAML_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const flat = flattenHttpSteps(r.data.steps);
      expect(flat.map((s) => s.id)).toEqual(["01HX0000000000000000000002"]);
    }
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

describe("if step model (9b)", () => {
  const IF_JS = {
    version: 1,
    name: "x",
    cookie_jar: "auto",
    variables: {},
    steps: [
      {
        id: "01HX0000000000000000000010",
        name: "branch",
        type: "if",
        cond: { left: "{{code}}", op: "eq", right: "200" },
        then: [
          {
            id: "01HX0000000000000000000011",
            name: "ok",
            type: "http",
            request: { method: "GET", url: "/ok", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ],
  };

  it("accepts a single-condition if; elif/else default to []", () => {
    const r = ScenarioModel.safeParse(IF_JS);
    expect(r.success).toBe(true);
    if (r.success) {
      const s = r.data.steps[0];
      expect(isIfStep(s)).toBe(true);
      if (isIfStep(s)) {
        // Explicit annotation confirms the guard narrows to IfStep.
        const ifStep: IfStep = s;
        expect(ifStep.elif).toEqual([]);
        expect(ifStep.else).toEqual([]);
      }
    }
  });

  it("accepts a nested all/any condition tree", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = {
      all: [
        { left: "{{code}}", op: "eq", right: "200" },
        {
          any: [
            { left: "{{b}}", op: "contains", right: "ok" },
            { left: "{{r}}", op: "gte", right: "3" },
          ],
        },
      ],
    };
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("accepts an exists op leaf with no right", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = { left: "{{t}}", op: "exists" };
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("accepts elif and else branches", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    const step = (v.steps as Record<string, unknown>[])[0];
    step.elif = [
      {
        cond: { left: "{{code}}", op: "eq", right: "404" },
        then: [
          {
            id: "01HX0000000000000000000012",
            name: "retry",
            type: "http",
            request: { method: "GET", url: "/retry", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ];
    step.else = [
      {
        id: "01HX0000000000000000000013",
        name: "report",
        type: "http",
        request: { method: "POST", url: "/err", headers: {} },
        assert: [],
        extract: [],
      },
    ];
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("rejects an empty then branch (min 1)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].then = [];
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("accepts a loop nested in an if branch (9c mutual nesting)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
      id: "01HX0000000000000000000014",
      name: "inner-loop",
      type: "loop",
      repeat: 2,
      do: [
        {
          id: "01HX0000000000000000000015",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/x", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    });
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("accepts an if nested in a loop body (9c mutual nesting)", () => {
    const v = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
    ((v.steps as Record<string, unknown>[])[0].do as unknown[]).push({
      id: "01HX0000000000000000000016",
      name: "inner-if",
      type: "if",
      cond: { left: "{{c}}", op: "eq", right: "1" },
      then: [
        {
          id: "01HX0000000000000000000017",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/y", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    });
    expect(ScenarioModel.safeParse(v).success).toBe(true);
  });

  it("rejects an if nested in an if branch (same-type forbidden)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
      id: "01HX0000000000000000000018",
      name: "inner-if",
      type: "if",
      cond: { left: "{{c}}", op: "eq", right: "1" },
      then: [
        {
          id: "01HX0000000000000000000019",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/z", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    });
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("rejects two-level nesting: loop > if > loop", () => {
    const v = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
    ((v.steps as Record<string, unknown>[])[0].do as unknown[]).push({
      id: "01HX000000000000000000001A",
      name: "inner-if",
      type: "if",
      cond: { left: "{{c}}", op: "eq", right: "1" },
      then: [
        {
          id: "01HX000000000000000000001B",
          name: "deep-loop",
          type: "loop",
          repeat: 2,
          do: [
            {
              id: "01HX000000000000000000001C",
              name: "h",
              type: "http",
              request: { method: "GET", url: "/d", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
      ],
    });
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("rejects a malformed condition (no left/all/any)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    (v.steps as Record<string, unknown>[])[0].cond = { op: "eq", right: "x" };
    expect(ScenarioModel.safeParse(v).success).toBe(false);
  });

  it("flattenHttpSteps walks then/elif/else branches in order", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    const step = (v.steps as Record<string, unknown>[])[0];
    step.elif = [
      {
        cond: { left: "{{c}}", op: "eq", right: "1" },
        then: [
          {
            id: "01HX0000000000000000000012",
            name: "e",
            type: "http",
            request: { method: "GET", url: "/e", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ];
    step.else = [
      {
        id: "01HX0000000000000000000013",
        name: "x",
        type: "http",
        request: { method: "GET", url: "/x", headers: {} },
        assert: [],
        extract: [],
      },
    ];
    const r = ScenarioModel.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(flattenHttpSteps(r.data.steps).map((s) => s.id)).toEqual([
        "01HX0000000000000000000011",
        "01HX0000000000000000000012",
        "01HX0000000000000000000013",
      ]);
    }
  });

  it("flattenHttpSteps recurses through loop-in-if (loop nested in a branch)", () => {
    const v = structuredClone(IF_JS) as Record<string, unknown>;
    // then = [ existing http (…011), loop{ http(…22) } ]
    ((v.steps as Record<string, unknown>[])[0].then as unknown[]).push({
      id: "01HX0000000000000000000021",
      name: "lp",
      type: "loop",
      repeat: 2,
      do: [
        {
          id: "01HX0000000000000000000022",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/x", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    });
    const r = ScenarioModel.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(flattenHttpSteps(r.data.steps).map((s) => s.id)).toEqual([
        "01HX0000000000000000000011",
        "01HX0000000000000000000022",
      ]);
    }
  });

  it("flattenHttpSteps recurses through if-in-loop (if nested in loop body)", () => {
    const v = structuredClone(LOOP_YAML_JS) as Record<string, unknown>;
    // do = [ existing http, if{ then: http(…2B) } ]
    ((v.steps as Record<string, unknown>[])[0].do as unknown[]).push({
      id: "01HX000000000000000000002A",
      name: "inner-if",
      type: "if",
      cond: { left: "{{c}}", op: "eq", right: "1" },
      then: [
        {
          id: "01HX000000000000000000002B",
          name: "h",
          type: "http",
          request: { method: "GET", url: "/y", headers: {} },
          assert: [],
          extract: [],
        },
      ],
    });
    const r = ScenarioModel.safeParse(v);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(flattenHttpSteps(r.data.steps).map((s) => s.id)).toContain(
        "01HX000000000000000000002B",
      );
    }
  });
});

describe("summarizeCondition", () => {
  it("renders a leaf, exists/empty drop the right operand, groups join with AND/OR", () => {
    expect(summarizeCondition({ left: "status", op: "eq", right: "200" })).toBe("status eq 200");
    expect(summarizeCondition({ left: "token", op: "exists" })).toBe("token exists");
    expect(
      summarizeCondition({
        all: [
          { left: "a", op: "eq", right: "1" },
          { left: "b", op: "ne", right: "2" },
        ],
      }),
    ).toBe("a eq 1 AND b ne 2");
    expect(
      summarizeCondition({
        any: [
          { left: "a", op: "eq", right: "1" },
          { left: "b", op: "eq", right: "2" },
        ],
      }),
    ).toBe("a eq 1 OR b eq 2");
  });
});

const http = (id: string, name = "h") => ({
  id,
  name,
  type: "http" as const,
  request: { method: "GET" as const, url: "/" },
  assert: [],
  extract: [],
});

const parallel = {
  id: "01HX0000000000000000000010",
  name: "fan",
  type: "parallel" as const,
  branches: [
    { name: "user", steps: [http("01HX0000000000000000000011")] },
    { name: "feed", steps: [http("01HX0000000000000000000012")] },
  ],
};

describe("ParallelStepModel", () => {
  it("parses a valid parallel step", () => {
    expect(ParallelStepModel.safeParse(parallel).success).toBe(true);
  });
  it("rejects duplicate branch names (namespace keys)", () => {
    const dup = {
      ...parallel,
      branches: [
        { name: "x", steps: [http("01HX0000000000000000000011")] },
        { name: "x", steps: [http("01HX0000000000000000000012")] },
      ],
    };
    const r = StepModel.safeParse(dup);
    expect(r.success).toBe(false);
  });
  it("rejects a branch with no steps", () => {
    const empty = { ...parallel, branches: [{ name: "a", steps: [] }] };
    expect(ParallelStepModel.safeParse(empty).success).toBe(false);
  });
  it("StepModel accepts parallel as a 4th variant", () => {
    expect(StepModel.safeParse(parallel).success).toBe(true);
  });
});

describe("helpers descend into parallel branches", () => {
  it("flattenHttpSteps collects branch leaves", () => {
    const flat = flattenHttpSteps([parallel as never]);
    expect(flat.map((s) => s.id)).toEqual([
      "01HX0000000000000000000011",
      "01HX0000000000000000000012",
    ]);
  });
  it("findStepById finds a step inside a branch", () => {
    expect(findStepById([parallel as never], "01HX0000000000000000000012")?.id).toBe(
      "01HX0000000000000000000012",
    );
    expect(findStepById([parallel as never], "01HX0000000000000000000010")?.type).toBe("parallel");
  });
  it("findStepSiblings returns the branch's step list", () => {
    const sibs = findStepSiblings([parallel as never], "01HX0000000000000000000011");
    expect(sibs.map((s) => s.id)).toEqual(["01HX0000000000000000000011"]);
  });
});
