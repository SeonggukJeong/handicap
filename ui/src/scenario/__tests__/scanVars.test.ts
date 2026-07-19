import { describe, it, expect } from "vitest";
import {
  scanFlowVars,
  scanEnvVars,
  countFlowVarUsage,
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVarRefs,
  flatProducerNames,
  flatExtractNames,
  collectBranchInternalRefs,
  parallelVarIdentities,
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

// 로컬 헬퍼(기존 테스트에 parseScenarioDoc→model 뽑는 헬퍼가 이미 있으면 그걸 쓸 것).
import { parseScenarioDoc } from "../yamlDoc";
function model(yaml: string) {
  const r = parseScenarioDoc(yaml);
  if ("error" in r) throw new Error(r.error);
  return r.model;
}

describe("flatProducerNames (R2)", () => {
  it("declared keys + non-parallel extracts, excludes parallel-branch extracts", () => {
    const m = model(`version: 1
name: "t"
variables:
  base: "x"
steps:
  - { id: "01HX0000000000000000000010", type: http, name: s1, request: { method: GET, url: "/a" }, extract: [ { var: flat1, from: status } ] }
  - id: "01HX0000000000000000000020"
    type: parallel
    name: par
    branches:
      - name: B
        steps:
          - { id: "01HX0000000000000000000030", type: http, name: b1, request: { method: GET, url: "/b" }, extract: [ { var: ponly, from: status } ] }
`);
    const flat = flatProducerNames(m);
    expect(flat.has("base")).toBe(true); // declared
    expect(flat.has("flat1")).toBe(true); // non-parallel extract
    expect(flat.has("ponly")).toBe(false); // parallel-only extract NOT flat
  });

  it("recurses loop/if bodies but not parallel branches", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    type: loop
    name: lp
    repeat: 1
    do:
      - { id: "01HX0000000000000000000050", type: http, name: h, request: { method: GET, url: "/x" }, extract: [ { var: inLoop, from: status } ] }
`);
    expect(flatProducerNames(m).has("inLoop")).toBe(true);
  });

  it("multi-branch same-name extract is NOT flat (shadow only when a flat producer exists)", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000060"
    type: parallel
    name: par
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000070", type: http, name: b, request: { method: GET, url: "/b" }, extract: [ { var: s, from: status } ] } ]
      - name: C
        steps: [ { id: "01HX0000000000000000000080", type: http, name: c, request: { method: GET, url: "/c" }, extract: [ { var: s, from: status } ] } ]
`);
    expect(flatProducerNames(m).has("s")).toBe(false);
  });
});

describe("flatExtractNames (editor-var-conflict-quickadd R1)", () => {
  it("collects non-parallel extracts; excludes declared-only keys and parallel-branch extracts; descends loop", () => {
    const m = model(`version: 1
name: "t"
variables:
  base: "x"
steps:
  - { id: "01HX0000000000000000000010", type: http, name: s1, request: { method: GET, url: "/a" }, extract: [ { var: flat1, from: status } ] }
  - id: "01HX0000000000000000000040"
    type: loop
    name: lp
    repeat: 1
    do:
      - { id: "01HX0000000000000000000050", type: http, name: h, request: { method: GET, url: "/x" }, extract: [ { var: inLoop, from: status } ] }
  - id: "01HX0000000000000000000020"
    type: parallel
    name: par
    branches:
      - name: B
        steps:
          - { id: "01HX0000000000000000000030", type: http, name: b1, request: { method: GET, url: "/b" }, extract: [ { var: ponly, from: status } ] }
`);
    const ex = flatExtractNames(m);
    expect(ex.has("flat1")).toBe(true); // 최상위 http extract
    expect(ex.has("inLoop")).toBe(true); // loop do 하강
    expect(ex.has("base")).toBe(false); // 선언-only는 extract가 아님 (flatProducerNames와의 차이)
    expect(ex.has("ponly")).toBe(false); // parallel 분기 extract는 flat이 아님(네임스페이스 merge)
  });

  it("descends if then/elif/else", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000070"
    type: if
    name: cond
    cond: { left: "{{a}}", op: exists }
    then:
      - { id: "01HX0000000000000000000071", type: http, name: t1, request: { method: GET, url: "/t" }, extract: [ { var: inThen, from: status } ] }
    elif:
      - cond: { left: "{{b}}", op: exists }
        then:
          - { id: "01HX0000000000000000000072", type: http, name: t2, request: { method: GET, url: "/e" }, extract: [ { var: inElif, from: status } ] }
    else:
      - { id: "01HX0000000000000000000073", type: http, name: t3, request: { method: GET, url: "/l" }, extract: [ { var: inElse, from: status } ] }
`);
    const ex = flatExtractNames(m);
    expect(ex.has("inThen")).toBe(true);
    expect(ex.has("inElif")).toBe(true);
    expect(ex.has("inElse")).toBe(true);
  });
});

describe("collectBranchInternalRefs (R3)", () => {
  it("collects branch-internal bare {{s}} keyed by `${BRANCH}.${base}` (NOT node name), cast-normalized, downstream excluded", () => {
    // NOTE: parallel node name is "par" but the BRANCH is "B" — collectBranchInternalRefs keys by
    // BRANCH name (engine runner.rs:638), so the key is "B.s", never "par.s". Downstream must use {{B.s}}.
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000090"
    type: parallel
    name: par
    branches:
      - name: B
        steps:
          - { id: "01HX00000000000000000000A0", type: http, name: prod, request: { method: GET, url: "/p" }, extract: [ { var: s, from: status } ] }
          - { id: "01HX00000000000000000000B0", type: http, name: use, request: { method: GET, url: "/u?x={{s:num}}" } }
  - { id: "01HX00000000000000000000C0", type: http, name: down, request: { method: GET, url: "/d?y={{B.s}}" } }
`);
    const idx = collectBranchInternalRefs(m);
    expect(idx.get("B.s")).toEqual(["01HX00000000000000000000B0"]); // branch-internal bare {{s:num}}→s, keyed by BRANCH name
    // downstream {{B.s}} (step C0) is not branch-internal → excluded from this map's "B.s".
    expect(idx.get("B.s")).not.toContain("01HX00000000000000000000C0");
  });

  it("does not cross branches", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000D0"
    type: parallel
    name: par
    branches:
      - name: B
        steps: [ { id: "01HX00000000000000000000E0", type: http, name: b, request: { method: GET, url: "/b?x={{s}}" }, extract: [ { var: s, from: status } ] } ]
      - name: C
        steps: [ { id: "01HX00000000000000000000F0", type: http, name: c, request: { method: GET, url: "/c" }, extract: [ { var: s, from: status } ] } ]
`);
    const idx = collectBranchInternalRefs(m);
    expect(idx.get("B.s")).toEqual(["01HX00000000000000000000E0"]);
    expect(idx.get("C.s")).toBeUndefined(); // C never references bare {{s}}
  });
});

describe("parallelVarIdentities (R1/R4)", () => {
  it("one identity per branch extract, isShadow reflects flat collision, dedups display; branch/var kept structurally", () => {
    const m = model(`version: 1
name: "t"
variables: { s: "flat" }
steps:
  - { id: "01HX0000000000000000000100", type: http, name: f, request: { method: GET, url: "/f" }, extract: [ { var: token, from: status } ] }
  - id: "01HX0000000000000000000110"
    type: parallel
    name: auth
    branches:
      - name: auth
        steps: [ { id: "01HX0000000000000000000120", type: http, name: a, request: { method: GET, url: "/a?x={{s}}" }, extract: [ { var: s, from: status }, { var: fresh, from: status } ] } ]
`);
    const ids = parallelVarIdentities(m);
    const byDisplay = new Map(ids.map((i) => [i.display, i]));
    // s is declared (flat) → shadow; fresh is not → non-shadow
    expect(byDisplay.get("auth.s")?.isShadow).toBe(true);
    expect(byDisplay.get("auth.fresh")?.isShadow).toBe(false);
    expect(byDisplay.get("auth.fresh")?.branchName).toBe("auth");
    expect(byDisplay.get("auth.fresh")?.varName).toBe("fresh");
    // non-shadow branchRefIds: {{s}} is inside branch but s is shadow; fresh has no internal ref → []
    expect(byDisplay.get("auth.fresh")?.branchRefIds).toEqual([]);
  });

  it("dot-containing var name keeps a valid display and structural split", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000130"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000140", type: http, name: b, request: { method: GET, url: "/b" }, extract: [ { var: "a.b", from: status } ] } ]
`);
    const id = parallelVarIdentities(m).find((i) => i.varName === "a.b");
    expect(id?.display).toBe("B.a.b");
    expect(id?.branchName).toBe("B");
  });
});

// Task 3 신규 fixture(브리프 필수): parallelScen + 다운스트림 http가 {{s}}를 BARE로 추가 참조.
// 기존 parallelScen 단독으론 이 판정에 대해 RED가 안 난다(모든 옛 참조가 namespaced/typo/missing이라
// 새 규칙에서도 그대로 green) — 이 fixture가 있어야 "다운스트림 bare → 미정의" 핵심 가드가 RED로 선다.
const parallelScenDownstreamBare = ScenarioModel.parse({
  version: 1,
  name: "p2",
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
      request: {
        method: "GET",
        url: "/x?a={{alpha.s}}&b={{typo.s}}&c={{missing}}&d={{s}}",
        headers: {},
      },
      assert: [],
      extract: [{ from: "body", path: "$.u", var: "flatVar" }],
    },
  ],
});

// 형제 분기: A 안에서 B가 추출하는 var를 bare로 참조.
const parallelScenSiblingBare = ScenarioModel.parse({
  version: 1,
  name: "p4",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000300",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "A",
          steps: [
            {
              id: "01HX0000000000000000000301",
              name: "a1",
              type: "http",
              request: { method: "GET", url: "/x?v={{v}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
        {
          name: "B",
          steps: [
            {
              id: "01HX0000000000000000000302",
              name: "b1",
              type: "http",
              request: { method: "GET", url: "/y", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.v", var: "v" }],
            },
          ],
        },
      ],
    },
  ],
});

// cond 전용: if 조건 오퍼랜드에서만 참조되는 미정의 이름(함정 B 가드).
const condOnlyScen = ScenarioModel.parse({
  version: 1,
  name: "c",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000400",
      name: "gate",
      type: "if",
      cond: { left: "{{condOnly}}", op: "exists" },
      then: [
        {
          id: "01HX0000000000000000000401",
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

// shadow: 다운스트림 bare가 flat(비-parallel) producer와 parallel 분기 producer 둘 다에 걸침 —
// flat producer가 있으면 정의됨으로 보고해야 한다(shadow, 8a 의도된 관대함).
const shadowScen = ScenarioModel.parse({
  version: 1,
  name: "shadow",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000500",
      name: "flatProducer",
      type: "http",
      request: { method: "GET", url: "/f", headers: {} },
      assert: [],
      extract: [{ from: "body", path: "$.t", var: "token" }],
    },
    {
      id: "01HX0000000000000000000510",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "auth",
          steps: [
            {
              id: "01HX0000000000000000000511",
              name: "a",
              type: "http",
              request: { method: "GET", url: "/a", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.tok", var: "token" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000000520",
      name: "use",
      type: "http",
      request: { method: "GET", url: "/u?a={{auth.token}}&b={{token}}", headers: {} },
      assert: [],
      extract: [],
    },
  ],
});

// candidates=2: 두 형제 분기가 같은 bare 이름을 추출 + 다운스트림 bare 참조.
const twoCandidatesScen = ScenarioModel.parse({
  version: 1,
  name: "two",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000600",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "A",
          steps: [
            {
              id: "01HX0000000000000000000601",
              name: "a",
              type: "http",
              request: { method: "GET", url: "/a", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.x", var: "dup" }],
            },
          ],
        },
        {
          name: "B",
          steps: [
            {
              id: "01HX0000000000000000000602",
              name: "b",
              type: "http",
              request: { method: "GET", url: "/b", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.x", var: "dup" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000000610",
      name: "after",
      type: "http",
      request: { method: "GET", url: "/u?v={{dup}}", headers: {} },
      assert: [],
      extract: [],
    },
  ],
});

// 의도된 false-negative(8a §2.2.2 한계, "고치지 말 것"): 같은 parallel 노드의 형제 분기 A 안에서
// namespaced {{B.v}}를 참조 — 런타임엔 join_all 이후에나 병합돼 미해결이지만 8a는 정의됨으로 본다.
const sameNodeNamespacedScen = ScenarioModel.parse({
  version: 1,
  name: "dn",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000700",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "A",
          steps: [
            {
              id: "01HX0000000000000000000701",
              name: "a",
              type: "http",
              request: { method: "GET", url: "/x?v={{B.v}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
        {
          name: "B",
          steps: [
            {
              id: "01HX0000000000000000000702",
              name: "b",
              type: "http",
              request: { method: "GET", url: "/y", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.v", var: "v" }],
            },
          ],
        },
      ],
    },
  ],
});

// Trap A: 분기 안에 loop이 중첩된 시나리오. UI Zod BranchModel은 http-only(steps: HttpStepModel[])라
// ScenarioModel.parse로는 만들 수 없다 — model.test.ts:664 선례와 동일하게 as unknown as Scenario로
// 우회(엔진 Branch.steps: Vec<Step>과의 표현력 비대칭은 US2 노트에 기록된 기지 한계, §7 비목표).
const parallelScenNestedLoopBranch = {
  version: 1,
  name: "p5",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000800",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "beta",
          steps: [
            {
              id: "01HX0000000000000000000801",
              name: "lp",
              type: "loop",
              repeat: 1,
              do: [
                {
                  id: "01HX0000000000000000000802",
                  name: "extractor",
                  type: "http",
                  request: { method: "GET", url: "/x", headers: {} },
                  assert: [],
                  extract: [{ from: "body", path: "$.tok", var: "nested" }],
                },
              ],
            },
            {
              id: "01HX0000000000000000000803",
              name: "user",
              type: "http",
              request: { method: "GET", url: "/y?v={{nested}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
      ],
    },
  ],
} as unknown as Scenario;

describe("undefinedVarRefs (Task 3 — position-aware, US1)", () => {
  it("flags a downstream bare ref to a branch extract as undefined (core guard): downstream kind, 1 candidate, stepIds exclude the branch-internal step", () => {
    const refs = undefinedVarRefs(parallelScenDownstreamBare);
    const s = refs.get("s");
    expect(s).toBeDefined();
    expect(s?.stepIds).toEqual(["01HX0000000000000000000052"]); // downstream only, NOT branch-internal 051
    expect(s?.kind).toBe("downstream");
    expect(s?.candidates).toEqual(["alpha"]);
  });

  it("does not flag a branch-internal bare ref to its own branch's extract (existing :606 intent preserved)", () => {
    expect(undefinedVarRefs(parallelScen).has("s")).toBe(false);
  });

  it("does not flag a bare ref to an extract nested in a loop inside the SAME branch (Trap A guard)", () => {
    expect(undefinedVarRefs(parallelScenNestedLoopBranch).has("nested")).toBe(false);
  });

  it("flags a bare ref to a SIBLING branch's extract: sibling kind, that branch as sole candidate", () => {
    const refs = undefinedVarRefs(parallelScenSiblingBare);
    const v = refs.get("v");
    expect(v).toBeDefined();
    expect(v?.stepIds).toEqual(["01HX0000000000000000000301"]);
    expect(v?.candidates).toEqual(["B"]);
    expect(v?.kind).toBe("sibling");
  });

  it("catches an undefined name referenced only in an if condition operand (Trap B guard): downstream kind, no candidates", () => {
    const refs = undefinedVarRefs(condOnlyScen);
    const c = refs.get("condOnly");
    expect(c).toBeDefined();
    expect(c?.stepIds).toEqual(["01HX0000000000000000000400"]);
    expect(c?.kind).toBe("downstream");
    expect(c?.candidates).toEqual([]);
  });

  it("gives an undefined namespaced key (typo.s) empty candidates — never dot-split against branch extracts", () => {
    const refs = undefinedVarRefs(parallelScen);
    const typo = refs.get("typo.s");
    expect(typo).toBeDefined();
    expect(typo?.candidates).toEqual([]);
    expect(typo?.kind).toBe("downstream");
  });

  it("treats a valid namespaced {{B.v}} as defined, and a downstream bare ref as defined when a flat producer shadows the branch extract", () => {
    const refs = undefinedVarRefs(shadowScen);
    expect(refs.has("auth.token")).toBe(false); // namespaced, valid
    expect(refs.has("token")).toBe(false); // bare, shadowed by the flat (non-parallel) producer
  });

  it("does NOT flag {{B.v}} referenced from inside sibling branch A as undefined (deliberate false-negative, spec §2.2.2 — do not tighten)", () => {
    expect(undefinedVarRefs(sameNodeNamespacedScen).has("B.v")).toBe(false);
  });

  it("candidates accuracy — 0/1/2 cases", () => {
    // 0: bare name with no producing branch at all.
    expect(undefinedVarRefs(parallelScenDownstreamBare).get("missing")?.candidates).toEqual([]);
    // 1: exactly one branch produces it (see core-guard test above too).
    expect(undefinedVarRefs(parallelScenDownstreamBare).get("s")?.candidates).toEqual(["alpha"]);
    // 2: two sibling branches produce the same bare name, document order, dedup.
    expect(undefinedVarRefs(twoCandidatesScen).get("dup")?.candidates).toEqual(["A", "B"]);
  });

  // 이관(구 undefinedVars (R4) describe, Task 4 — undefinedVars export 제거로 살아있는
  // 불변식만 이관): 예약 시스템 변수 무감산 — {{}}는 flow 네임스페이스라 ${vu_id} system과 무관.
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
    expect(undefinedVarRefs(s).has("vu_id")).toBe(true);
  });
});

// Task 3 리뷰 이관: kind tie-break("다운스트림 위반 하나라도 있으면 downstream 우선")에 커밋된
// 테스트가 없었다 — sibling-only 분기는 이 discriminator에 직접 분기하므로 여기서 고정한다.
// 형제 분기 A가 B의 extract를 bare로 참조(sibling-only라면 kind="sibling")+같은 이름을 최상위
// 다운스트림 스텝도 bare로 참조 → kind="downstream"·stepIds가 분기/최상위 경계를 문서순으로 가로지름.
const siblingPlusDownstreamScen = ScenarioModel.parse({
  version: 1,
  name: "tie",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000000900",
      name: "par",
      type: "parallel",
      branches: [
        {
          name: "A",
          steps: [
            {
              id: "01HX0000000000000000000901",
              name: "a1",
              type: "http",
              request: { method: "GET", url: "/x?v={{v}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
        {
          name: "B",
          steps: [
            {
              id: "01HX0000000000000000000902",
              name: "b1",
              type: "http",
              request: { method: "GET", url: "/y", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.v", var: "v" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000000903",
      name: "after",
      type: "http",
      request: { method: "GET", url: "/z?v={{v}}", headers: {} },
      assert: [],
      extract: [],
    },
  ],
});

describe("undefinedVarRefs kind tie-break (Task 3 review carry-over, no prior committed test)", () => {
  it("downstream wins when a name is violated both inside a sibling branch and downstream; stepIds cross the branch/top-level boundary in document order", () => {
    const refs = undefinedVarRefs(siblingPlusDownstreamScen);
    const v = refs.get("v");
    expect(v).toBeDefined();
    expect(v?.kind).toBe("downstream");
    expect(v?.stepIds).toEqual(["01HX0000000000000000000901", "01HX0000000000000000000903"]);
    expect(v?.candidates).toEqual(["B"]);
  });
});

// fix-2 blocker regression guard: TWO SEPARATE top-level parallel nodes — P1's branch
// `auth` extracts `token`; a LATER node P2's branch `use` bare-references `{{token}}`.
// Verified in the engine (runner.rs:684-686): each branch's outputs are merged into
// `iter_vars` via `join_all` before the node returns, and P1 fully join_all's before P2
// starts (top-level steps run sequentially) — so `{{token}}` genuinely resolves inside
// P2's branch. This is NOT a same-node sibling violation (spec §2.4 scopes the sibling
// copy to a reference inside branch A to branch B's extract WITHIN THE SAME parallel
// node) — pre-fix, `branchOwn`/`own` carried no parallel-node identity so this was
// misclassified "sibling" (wrong hint + hidden "선언 추가" action for an ordinary shape).
const crossNodeDownstreamBare = ScenarioModel.parse({
  version: 1,
  name: "cross",
  cookie_jar: "auto",
  variables: {},
  steps: [
    {
      id: "01HX0000000000000000001100",
      name: "p1",
      type: "parallel",
      branches: [
        {
          name: "auth",
          steps: [
            {
              id: "01HX0000000000000000001101",
              name: "login",
              type: "http",
              request: { method: "GET", url: "/login", headers: {} },
              assert: [],
              extract: [{ from: "body", path: "$.token", var: "token" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000001200",
      name: "p2",
      type: "parallel",
      branches: [
        {
          name: "use",
          steps: [
            {
              id: "01HX0000000000000000001201",
              name: "consume",
              type: "http",
              request: { method: "GET", url: "/x?t={{token}}", headers: {} },
              assert: [],
              extract: [],
            },
          ],
        },
      ],
    },
  ],
});

describe("undefinedVarRefs cross-node parallel classification (fix-2 blocker)", () => {
  it("a bare ref in a LATER top-level parallel node's branch to an EARLIER node's branch extract is downstream (join_all sequences the two nodes), not sibling", () => {
    const refs = undefinedVarRefs(crossNodeDownstreamBare);
    const t = refs.get("token");
    expect(t).toBeDefined();
    expect(t?.kind).toBe("downstream");
    expect(t?.candidates).toEqual(["auth"]);
  });
});
