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
