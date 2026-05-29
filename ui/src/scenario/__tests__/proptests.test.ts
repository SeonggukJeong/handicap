import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stringify as yamlStringify } from "yaml";
import {
  type Extract,
  type HttpStep,
  type LoopStep,
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

// A loop wraps 1-2 http steps (single-level nesting, Slice 7).
const loopStepArb: fc.Arbitrary<LoopStep> = fc.record({
  id: ULID_ARB,
  name: ident,
  type: fc.constant("loop" as const),
  repeat: fc.integer({ min: 1, max: 20 }),
  do: fc.array(httpStepArb, { minLength: 1, maxLength: 2 }),
});

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: httpStepArb },
  { weight: 1, arbitrary: loopStepArb },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  version: fc.constant(1 as const),
  name: ident,
  cookie_jar: fc.constantFrom("auto" as const, "off" as const),
  variables: fc.dictionary(
    ident,
    fc.stringMatching(/^[a-zA-Z0-9 .,:/_-]{0,30}$/),
    { maxKeys: 3 },
  ),
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
    do: st.do.map(httpStepToYaml),
  };
}

function stepToYaml(st: Step): Record<string, unknown> {
  return st.type === "loop" ? loopStepToYaml(st) : httpStepToYaml(st);
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
