import { describe, it, expect } from "vitest";
import {
  scanFlowVars,
  scanEnvVars,
  countFlowVarUsage,
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVars,
} from "../scanVars";
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

const scen = ScenarioModel.parse({
  version: 1,
  name: "t",
  steps: [
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "s",
      type: "http",
      request: { method: "GET", url: "${BASE_URL}/x?t=${vu_id}", headers: { H: "${API_HOST}" } },
    },
  ],
});

describe("scanEnvVars", () => {
  it("collects ${ENV} names from http request fields, excluding reserved system vars", () => {
    expect([...scanEnvVars(scen)].sort()).toEqual(["API_HOST", "BASE_URL"]);
  });
});

describe("countFlowVarUsage", () => {
  it("counts http request-field usage per variable across steps", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/x?u={{tok}}", headers: {} },
        assert: [],
        extract: [],
      },
      {
        id: "01HX0000000000000000000002",
        name: "b",
        type: "http",
        request: { method: "GET", url: "/y", headers: { Authorization: "Bearer {{tok}}" } },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("tok")).toBe(2);
  });

  it("counts a variable referenced multiple times in one step as ONE step", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/{{id}}/{{id}}", headers: { "X-Id": "{{id}}" } },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("id")).toBe(1);
  });

  it("counts if + elif CONDITION operands that scanFlowVars omits (teeth)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000010",
          name: "gate",
          type: "if",
          cond: { left: "{{code}}", op: "eq", right: "{{want}}" },
          then: [
            {
              id: "01HX0000000000000000000011",
              name: "t",
              type: "http",
              request: { method: "GET", url: "/ok", headers: {} },
              assert: [],
              extract: [],
            },
          ],
          elif: [
            {
              cond: { left: "{{code}}", op: "eq", right: "404" },
              then: [
                {
                  id: "01HX0000000000000000000012",
                  name: "e",
                  type: "http",
                  request: { method: "GET", url: "/nf", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
            },
          ],
          else: [],
        },
      ],
    });
    const u = countFlowVarUsage(s);
    // {{code}}는 같은 if 스텝의 cond + elif cond 둘 다 → 1 스텝
    expect(u.get("code")).toBe(1);
    // {{want}}는 if cond에만 → 조건 스캔이 동작함을 증명(scanFlowVars는 못 봄)
    expect(u.get("want")).toBe(1);
    expect(scanFlowVars(s).has("want")).toBe(false); // 대조: 옛 스캐너는 조건을 빠뜨린다
  });

  it("recurses across nested containers (if-in-loop: condition + leaf both reached)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000030",
          name: "lp",
          type: "loop",
          repeat: 1,
          do: [
            {
              id: "01HX0000000000000000000031",
              name: "ifinner",
              type: "if",
              cond: { left: "{{nestedCond}}", op: "exists" },
              then: [
                {
                  id: "01HX0000000000000000000032",
                  name: "h",
                  type: "http",
                  request: { method: "GET", url: "/{{nestedUrl}}", headers: {} },
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
    const u = countFlowVarUsage(s);
    expect(u.get("nestedCond")).toBe(1); // 중첩 if 조건 도달
    expect(u.get("nestedUrl")).toBe(1); // 중첩 http leaf 도달
  });

  it("returns no entry for an unreferenced variable name", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/static", headers: {} },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("ghost")).toBeUndefined();
  });

  it("counts http leaf inside parallel branches[].steps", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000050",
          name: "par",
          type: "parallel",
          branches: [
            {
              name: "alpha",
              steps: [
                {
                  id: "01HX0000000000000000000051",
                  name: "leaf",
                  type: "http",
                  request: { method: "GET", url: "/{{branchVar}}", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(countFlowVarUsage(s).get("branchVar")).toBe(1);
  });

  it("counts condition operands inside all/any group nodes", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000060",
          name: "gate",
          type: "if",
          cond: {
            all: [
              { left: "{{ga}}", op: "exists" },
              { left: "{{gb}}", op: "exists" },
            ],
          },
          then: [
            {
              id: "01HX0000000000000000000061",
              name: "t",
              type: "http",
              request: { method: "GET", url: "/ok", headers: {} },
              assert: [],
              extract: [],
            },
          ],
          elif: [],
          else: [],
        },
      ],
    });
    const u = countFlowVarUsage(s);
    expect(u.get("ga")).toBe(1); // all 그룹 첫 번째 피연산자
    expect(u.get("gb")).toBe(1); // all 그룹 두 번째 피연산자
  });
});

// 헬퍼: parallel 1분기(extract s) + 그 분기가 {{s}}(bare) 참조, 그리고 다운스트림 http가 {{alpha.s}}·{{typo.s}}·{{missing}} 참조.
const parallelScen = ScenarioModel.parse({
  version: 1,
  name: "p",
  cookie_jar: "auto",
  variables: { declared: "v" },
  steps: [
    {
      id: "01HX0000000000000000000050",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "alpha",
          steps: [
            {
              id: "01HX0000000000000000000051",
              name: "leaf",
              type: "http",
              request: { method: "GET", url: "/{{s}}", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.tok", var: "s" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000000052",
      name: "after",
      type: "http",
      request: { method: "GET", url: "/x?a={{alpha.s}}&b={{typo.s}}&c={{missing}}", headers: {} },
      assert: [],
      extract: [{ from: "body", path: "$.u", var: "flatVar" }],
    },
  ],
});

describe("splitFlowToken normalization in scanners (R1/R13)", () => {
  it("countFlowVarUsage keys a cast token by its base (token, not token:num)", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: {
          method: "GET",
          url: "/x",
          headers: {},
          body: { kind: "json", value: { n: "{{token:num}}" } },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("token")).toBe(1);
    expect(countFlowVarUsage(s).get("token:num")).toBeUndefined();
  });
  it("keeps a non-keyword :suffix as the whole base (count:foo)", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: {
          method: "GET",
          url: "/x",
          headers: {},
          body: { kind: "json", value: { n: "{{count:foo}}" } },
        },
        assert: [],
        extract: [],
      },
    ]);
    expect(scanFlowVars(s).has("count:foo")).toBe(true);
    expect(scanFlowVars(s).has("count")).toBe(false);
  });
});

describe("collectProducedVars (R2)", () => {
  it("unions declared keys and every http extract var (parallel branches included)", () => {
    const p = collectProducedVars(parallelScen);
    expect(p.has("declared")).toBe(true); // 선언
    expect(p.has("s")).toBe(true); // parallel 분기 extract bare
    expect(p.has("flatVar")).toBe(true); // flat extract
  });
});

describe("collectNamespacedProducers (R3)", () => {
  it("emits ${branch}.${var} for each parallel branch extract", () => {
    const ns = collectNamespacedProducers(parallelScen);
    expect(ns.has("alpha.s")).toBe(true);
    expect(ns.has("s")).toBe(false); // bare는 여기 없음
  });
});

describe("parallelExtractNames (R8 shadow)", () => {
  it("returns bare names extracted inside any parallel branch", () => {
    expect([...parallelExtractNames(parallelScen)]).toEqual(["s"]);
  });
});

describe("buildVarRefIndex (R3/R10)", () => {
  it("keys refs as-appears (bare vs branch.var), cast-normalized, in document-order stepIds", () => {
    const idx = buildVarRefIndex(parallelScen);
    expect(idx.get("s")).toEqual(["01HX0000000000000000000051"]); // 분기 내부 bare
    expect(idx.get("alpha.s")).toEqual(["01HX0000000000000000000052"]); // 다운스트림 namespaced
    expect(idx.get("missing")).toEqual(["01HX0000000000000000000052"]); // bare 미정의
  });
  it("counts derive from index length (a var used twice in one step = one stepId)", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/{{id}}/{{id}}", headers: { "X-Id": "{{id}}" } },
        assert: [],
        extract: [],
      },
    ]);
    expect(buildVarRefIndex(s).get("id")).toEqual(["01HX0000000000000000000001"]);
    expect(countFlowVarUsage(s).get("id")).toBe(1);
  });
});

describe("undefinedVars (R4)", () => {
  it("flags dangling refs but not valid namespaced / branch-internal bare refs", () => {
    const u = undefinedVars(parallelScen);
    expect(u.has("alpha.s")).toBe(false); // 유효 namespaced
    expect(u.has("s")).toBe(false); // 분기 내부 bare는 collectProducedVars가 해소(conservative)
    expect(u.has("typo.s")).toBe(true); // 당글링 namespaced
    expect(u.has("missing")).toBe(true); // bare 미정의
  });
  it("treats {{vu_id}} as a real undefined flow var (no reserved-system subtraction)", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/x?v={{vu_id}}", headers: {} },
        assert: [],
        extract: [],
      },
    ]);
    expect(undefinedVars(s).has("vu_id")).toBe(true);
  });
});
