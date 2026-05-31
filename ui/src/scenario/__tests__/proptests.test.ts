import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stringify as yamlStringify } from "yaml";
import {
  type Condition,
  type Extract,
  type HttpStep,
  type IfStep,
  type LoopStep,
  type NestedIfStep,
  type NestedLoopStep,
  type Scenario,
  type Step,
} from "../model";
import { parseScenarioDoc, serializeDoc } from "../yamlDoc";

const ULID_ARB = fc.string({ minLength: 26, maxLength: 26 }).map((s) =>
  s
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "0")
    .padEnd(26, "0")
    .slice(0, 26),
);

const httpMethod = fc.constantFrom(
  "GET" as const,
  "POST" as const,
  "PUT" as const,
  "PATCH" as const,
  "DELETE" as const,
  "HEAD" as const,
  "OPTIONS" as const,
);

const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);

const extractArb: fc.Arbitrary<Extract> = fc.oneof(
  fc.record({
    var: ident,
    from: fc.constant("body" as const),
    path: fc
      .stringMatching(/^[a-zA-Z_.][a-zA-Z0-9_.$]{0,16}$/)
      .map((p) => `$${p.startsWith(".") ? p : "." + p}`),
  }),
  fc.record({
    var: ident,
    from: fc.constant("header" as const),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,12}$/),
  }),
  fc.record({
    var: ident,
    from: fc.constant("cookie" as const),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,12}$/),
  }),
  fc.record({
    var: ident,
    from: fc.constant("status" as const),
  }),
);

const httpStepArb: fc.Arbitrary<HttpStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("http" as const),
  request: fc.record({
    method: httpMethod,
    url: fc.stringMatching(/^\/[a-z0-9/_-]{0,20}$/),
    headers: fc.dictionary(
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,10}$/),
      fc.stringMatching(/^[a-zA-Z0-9 .,:/_-]{0,30}$/),
      { maxKeys: 2 },
    ),
  }),
  assert: fc.array(
    fc.record({
      kind: fc.constant("status" as const),
      code: fc.integer({ min: 100, max: 599 }),
    }),
    { maxLength: 2 },
  ),
  extract: fc.array(extractArb, { maxLength: 2 }),
});

// Condition tree (Slice 9b): leaf compares (with/without `right`) + all/any groups.
const leafWithRightArb: fc.Arbitrary<Condition> = fc.record({
  left: ident.map((v) => `{{${v}}}`),
  op: fc.constantFrom(
    "eq" as const,
    "ne" as const,
    "contains" as const,
    "matches" as const,
    "lt" as const,
    "gt" as const,
    "lte" as const,
    "gte" as const,
  ),
  right: fc.stringMatching(/^[a-z0-9]{1,8}$/),
});
const leafNoRightArb: fc.Arbitrary<Condition> = fc.record({
  left: ident.map((v) => `{{${v}}}`),
  op: fc.constantFrom("exists" as const, "empty" as const),
});
const leafArb: fc.Arbitrary<Condition> = fc.oneof(leafWithRightArb, leafNoRightArb);
// Groups use minLength 1: the model permits empty all/any, but the UI never authors them
// (the condition builder seeds a leaf and blocks removing a group's last child), so the
// round-trip mirrors real authored shapes.
const conditionArb: fc.Arbitrary<Condition> = fc.oneof(
  { weight: 3, arbitrary: leafArb },
  { weight: 1, arbitrary: fc.record({ all: fc.array(leafArb, { minLength: 1, maxLength: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ any: fc.array(leafArb, { minLength: 1, maxLength: 2 }) }) },
);

// Nested (http-only) container forms — what may appear one level down (9c gate).
const nestedLoopArb: fc.Arbitrary<NestedLoopStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("loop" as const),
  repeat: fc.integer({ min: 1, max: 20 }),
  do: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
});

const nestedIfArb: fc.Arbitrary<NestedIfStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("if" as const),
  cond: conditionArb,
  then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
  elif: fc.array(
    fc.record({ cond: conditionArb, then: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }) }),
    { maxLength: 1 },
  ),
  else: fc.array(httpStepArb, { maxLength: 1 }),
});

// A loop wraps 1-2 steps: http or nested-if (9c mutual nesting).
const loopStepArb: fc.Arbitrary<LoopStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("loop" as const),
  repeat: fc.integer({ min: 1, max: 20 }),
  do: fc.array(
    fc.oneof({ weight: 3, arbitrary: httpStepArb }, { weight: 1, arbitrary: nestedIfArb }),
    {
      minLength: 1,
      maxLength: 2,
    },
  ),
});

// An if step's branches hold http or nested-loop (9c mutual nesting).
const ifBranchArb: fc.Arbitrary<HttpStep | NestedLoopStep> = fc.oneof(
  { weight: 3, arbitrary: httpStepArb },
  { weight: 1, arbitrary: nestedLoopArb },
);
const ifStepArb: fc.Arbitrary<IfStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("if" as const),
  cond: conditionArb,
  then: fc.array(ifBranchArb, { minLength: 1, maxLength: 2 }),
  elif: fc.array(
    fc.record({ cond: conditionArb, then: fc.array(ifBranchArb, { minLength: 1, maxLength: 2 }) }),
    {
      maxLength: 2,
    },
  ),
  else: fc.array(ifBranchArb, { maxLength: 2 }),
});

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: httpStepArb },
  { weight: 1, arbitrary: loopStepArb },
  { weight: 1, arbitrary: ifStepArb },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  version: fc.constant(1 as const),
  name: ident,
  cookie_jar: fc.constantFrom("auto" as const, "off" as const),
  variables: fc.dictionary(ident, fc.stringMatching(/^[a-zA-Z0-9 .,:/_-]{0,30}$/), { maxKeys: 3 }),
  steps: fc.array(stepArb, { maxLength: 3 }),
});

describe("scenario round-trip property", () => {
  it("model after first parse == model after re-parse of serialized output", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const yaml = scenarioToCanonicalYaml(s);
        const parsed = parseScenarioDoc(yaml);
        if ("error" in parsed) {
          throw new Error(`parseScenarioDoc failed: ${parsed.error}\n--\n${yaml}`);
        }
        const round = serializeDoc(parsed.doc);
        const reparsed = parseScenarioDoc(round);
        if ("error" in reparsed) {
          throw new Error(`re-parse failed: ${reparsed.error}\n--\n${round}`);
        }
        expect(reparsed.model).toEqual(parsed.model);
      }),
      { numRuns: 40 },
    );
  });
});

function httpStepToYaml(st: HttpStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: st.id,
    name: st.name,
    type: st.type,
    request: {
      method: st.request.method,
      url: st.request.url,
      headers: st.request.headers ?? {},
    },
    assert: st.assert.map((a) => ({ status: a.code })),
  };
  if (st.extract && st.extract.length > 0) {
    out.extract = st.extract.map((e) => {
      if (e.from === "body") return { var: e.var, from: "body", path: e.path };
      if (e.from === "header") return { var: e.var, from: "header", name: e.name };
      if (e.from === "cookie") return { var: e.var, from: "cookie", name: e.name };
      return { var: e.var, from: "status" };
    });
  }
  return out;
}

function loopStepToYaml(st: LoopStep): Record<string, unknown> {
  return {
    id: st.id,
    name: st.name,
    type: st.type,
    repeat: st.repeat,
    do: st.do.map(stepToYaml),
  };
}

// Canonical condition serialization: omit `right` for exists/empty (mirrors the
// engine's serde + the UI's cleanCond), recurse into all/any groups.
function condToYaml(c: Condition): Record<string, unknown> {
  if ("all" in c) return { all: c.all.map(condToYaml) };
  if ("any" in c) return { any: c.any.map(condToYaml) };
  const out: Record<string, unknown> = { left: c.left, op: c.op };
  if (c.op !== "exists" && c.op !== "empty") out.right = c.right;
  return out;
}

// elif/else only emitted when non-empty, matching IfStepModel's `.default([])`.
function ifStepToYaml(st: IfStep): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: st.id,
    name: st.name,
    type: st.type,
    cond: condToYaml(st.cond),
    then: st.then.map(stepToYaml),
  };
  if (st.elif.length > 0) {
    out.elif = st.elif.map((e) => ({ cond: condToYaml(e.cond), then: e.then.map(stepToYaml) }));
  }
  if (st.else.length > 0) out.else = st.else.map(stepToYaml);
  return out;
}

function stepToYaml(st: Step): Record<string, unknown> {
  if (st.type === "loop") return loopStepToYaml(st);
  if (st.type === "if") return ifStepToYaml(st);
  return httpStepToYaml(st);
}

function scenarioToCanonicalYaml(s: Scenario): string {
  const obj = {
    version: s.version,
    name: s.name,
    cookie_jar: s.cookie_jar,
    variables: s.variables,
    steps: s.steps.map(stepToYaml),
  };
  return yamlStringify(obj);
}
