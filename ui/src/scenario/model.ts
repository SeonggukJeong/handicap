import { z } from "zod";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const BodyModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("form"), value: z.record(z.string(), z.string()) }).strict(),
  z.object({ kind: z.literal("raw"), value: z.string() }).strict(),
]);
export type Body = z.infer<typeof BodyModel>;

export const RequestModel = z
  .object({
    method: HttpMethod,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    body: BodyModel.optional(),
  })
  .strict();
export type RequestSpec = z.infer<typeof RequestModel>;

export const AssertionModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), code: z.number().int().min(100).max(599) }).strict(),
]);
export type Assertion = z.infer<typeof AssertionModel>;

export const ExtractModel = z.discriminatedUnion("from", [
  z
    .object({
      var: z.string().min(1),
      from: z.literal("body"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("header"),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("cookie"),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      var: z.string().min(1),
      from: z.literal("status"),
    })
    .strict(),
]);
export type Extract = z.infer<typeof ExtractModel>;

export const HttpStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
    extract: z.array(ExtractModel).default([]),
  })
  .strict();
export type HttpStep = z.infer<typeof HttpStepModel>;

export const LoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    // do: http only — single-level for Slice 7. Nested loops rejected here.
    do: z.array(HttpStepModel).min(1, "loop body needs at least one step"),
  })
  .strict();
export type LoopStep = z.infer<typeof LoopStepModel>;

export const CompareOpModel = z.enum([
  "eq",
  "ne",
  "contains",
  "matches",
  "lt",
  "gt",
  "lte",
  "gte",
  "exists",
  "empty",
]);
export type CompareOp = z.infer<typeof CompareOpModel>;

// Recursive condition tree. The three shapes share no discriminant key, so this is
// a z.union (NOT discriminatedUnion), distinguished by key presence (left / all /
// any) — a 1:1 match for the engine's manual serde (scenario.rs::Condition). z.lazy
// because it self-references; this is the model's first use of z.lazy.
export type Condition =
  | { left: string; op: CompareOp; right?: string }
  | { all: Condition[] }
  | { any: Condition[] };

export const ConditionModel: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ left: z.string(), op: CompareOpModel, right: z.string().optional() }).strict(),
    z.object({ all: z.array(ConditionModel) }).strict(),
    z.object({ any: z.array(ConditionModel) }).strict(),
  ]),
);

export const ElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "elif branch needs at least one step"),
  })
  .strict();
export type ElifBranch = z.infer<typeof ElifBranchModel>;

export const IfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "if branch needs at least one step"),
    elif: z.array(ElifBranchModel).default([]),
    else: z.array(HttpStepModel).default([]),
  })
  .strict();
export type IfStep = z.infer<typeof IfStepModel>;

export const StepModel = z.discriminatedUnion("type", [HttpStepModel, LoopStepModel, IfStepModel]);
export type Step = z.infer<typeof StepModel>;

export function isLoopStep(s: Step): s is LoopStep {
  return s.type === "loop";
}
export function isHttpStep(s: Step): s is HttpStep {
  return s.type === "http";
}
export function isIfStep(s: Step): s is IfStep {
  return s.type === "if";
}

/** Depth-first list of every http step, recursing into loop bodies and walking
 *  if branches (then / elif[].then / else). Branches are http-only in 9b; 9c makes
 *  them Step[] and rewrites this into a true recursion (spec SF-1). */
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else if (s.type === "loop") out.push(...s.do);
    else {
      out.push(...s.then);
      for (const e of s.elif) out.push(...e.then);
      out.push(...s.else);
    }
  }
  return out;
}

/** The sequence a step actually lives in — top-level steps, a loop `do` body, or
 *  an if branch — used by the inspector to clamp move up/down. Falls back to the
 *  top-level list if the step is not found nested. */
export function findStepSiblings(steps: ReadonlyArray<Step>, stepId: string): ReadonlyArray<Step> {
  if (steps.some((s) => s.id === stepId)) return steps;
  for (const s of steps) {
    if (s.type === "loop") {
      if (s.do.some((c) => c.id === stepId)) return s.do;
    } else if (s.type === "if") {
      if (s.then.some((c) => c.id === stepId)) return s.then;
      for (const e of s.elif) if (e.then.some((c) => c.id === stepId)) return e.then;
      if (s.else.some((c) => c.id === stepId)) return s.else;
    }
  }
  return steps;
}

export const CookieJarMode = z.enum(["auto", "off"]);
export type CookieJarMode = z.infer<typeof CookieJarMode>;

export const ScenarioModel = z
  .object({
    version: z.literal(1),
    name: z.string().min(1, "name required"),
    cookie_jar: CookieJarMode.default("auto"),
    variables: z.record(z.string(), z.string()).default({}),
    steps: z.array(StepModel).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioModel>;

export function newEmptyScenario(name = "Untitled"): Scenario {
  return {
    version: 1,
    name,
    cookie_jar: "auto",
    variables: {},
    steps: [],
  };
}
