import { describe, it, expect } from "vitest";
import { scanFlowVars } from "../scanVars";
import type { Scenario } from "../model";
import { ScenarioModel } from "../model";

function scenario(steps: Scenario["steps"]): Scenario {
  return { version: 1, name: "t", cookie_jar: "auto", variables: {}, steps };
}

describe("scanFlowVars", () => {
  it("finds {{var}} in url, headers, form values, and json string leaves", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: {
          method: "POST",
          url: "{{base}}/login?ref={{ref}}",
          headers: { Authorization: "Bearer {{token}}" },
          body: {
            kind: "json",
            value: { user: "{{username}}", age: 30, nested: { k: "{{deep}}" } },
          },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)].sort()).toEqual(
      ["base", "deep", "ref", "token", "username"].sort(),
    );
  });

  it("scans form body values but not keys", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000002",
        name: "f",
        type: "http",
        request: {
          method: "POST",
          url: "/x",
          headers: {},
          body: { kind: "form", value: { user: "{{u}}", literalKey: "static" } },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual(["u"]);
  });

  it("recurses into loop do: bodies", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000003",
        name: "loop",
        type: "loop",
        repeat: 2,
        do: [
          {
            id: "01HX0000000000000000000004",
            name: "inner",
            type: "http",
            request: { method: "GET", url: "/item/{{id}}", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual(["id"]);
  });

  it("scans {{vars}} inside if-branch http steps (via flattenHttpSteps)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000010",
          name: "b",
          type: "if",
          // NOTE: condition operands ({{code}}) are intentionally NOT scanned in 9b —
          // only branch http steps are. Condition vars are typically extract-derived.
          cond: { left: "{{code}}", op: "eq", right: "200" },
          then: [
            {
              id: "01HX0000000000000000000011",
              name: "t",
              type: "http",
              request: { method: "GET", url: "/{{path}}", headers: { "X-Tok": "{{tok}}" } },
              assert: [],
              extract: [],
            },
          ],
          elif: [
            {
              cond: { left: "{{code}}", op: "eq", right: "404" },
              then: [
                {
                  id: "01HX0000000000000000000013",
                  name: "el",
                  type: "http",
                  request: { method: "GET", url: "/{{elifvar}}", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
            },
          ],
          else: [
            {
              id: "01HX0000000000000000000012",
              name: "e",
              type: "http",
              request: { method: "GET", url: "/{{other}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
      ],
    });
    expect([...scanFlowVars(s)].sort()).toEqual(["elifvar", "other", "path", "tok"]);
  });

  it("scans {{vars}} inside nested loop-in-if and if-in-loop http steps (9c)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        // Direction 1: loop-in-if — http {{deep}} lives in a loop nested in an if's then.
        {
          id: "01HX0000000000000000000010",
          name: "branch",
          type: "if",
          cond: { left: "{{code}}", op: "eq", right: "200" },
          then: [
            {
              id: "01HX0000000000000000000020",
              name: "lp",
              type: "loop",
              repeat: 2,
              do: [
                {
                  id: "01HX0000000000000000000021",
                  name: "h",
                  type: "http",
                  request: { method: "GET", url: "/{{deep}}", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
            },
          ],
          elif: [],
          else: [],
        },
        // Direction 2: if-in-loop — http {{deep2}} lives in an if nested in a loop's body.
        {
          id: "01HX0000000000000000000030",
          name: "lp2",
          type: "loop",
          repeat: 1,
          do: [
            {
              id: "01HX0000000000000000000031",
              name: "ifinner",
              type: "if",
              cond: { left: "{{code}}", op: "eq", right: "200" },
              then: [
                {
                  id: "01HX0000000000000000000032",
                  name: "h2",
                  type: "http",
                  request: { method: "GET", url: "/{{deep2}}", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
              elif: [],
              else: [],
            },
          ],
        },
      ],
    });
    // Both nested http vars reached; condition operands ({{code}}) intentionally un-scanned (9b).
    expect([...scanFlowVars(s)].sort()).toEqual(["deep", "deep2"]);
  });

  it("excludes {{vars}} that live in disabled rows", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "s",
        type: "http",
        request: {
          method: "GET" as const,
          url: "https://api/{{active}}",
          headers: {},
          disabled: { headers: { "X-Off": "{{ghost}}" }, form: { skip: "{{ghost2}}" } },
        },
        assert: [],
        extract: [],
      },
    ]);
    const vars = scanFlowVars(s);
    expect(vars.has("active")).toBe(true);
    expect(vars.has("ghost")).toBe(false);
    expect(vars.has("ghost2")).toBe(false);
  });

  it("ignores ${ENV} and system tokens", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000005",
        name: "e",
        type: "http",
        request: { method: "GET", url: "${BASE_URL}/x?v=${vu_id}", headers: {} },
        assert: [],
        extract: [],
      },
    ]);
    expect([...scanFlowVars(s)]).toEqual([]);
  });
});
