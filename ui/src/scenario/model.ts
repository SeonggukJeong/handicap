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

// ── Nested (one-level-down) container forms: bodies are http-only, so they
//    cannot nest further. These are exactly the pre-9c Loop/If shapes. ──
export const NestedLoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    do: z.array(HttpStepModel).min(1, "loop body needs at least one step"),
  })
  .strict();
export type NestedLoopStep = z.infer<typeof NestedLoopStepModel>;

export const NestedElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "elif branch needs at least one step"),
  })
  .strict();

export const NestedIfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    then: z.array(HttpStepModel).min(1, "if branch needs at least one step"),
    elif: z.array(NestedElifBranchModel).default([]),
    else: z.array(HttpStepModel).default([]),
  })
  .strict();
export type NestedIfStep = z.infer<typeof NestedIfStepModel>;

// Body-element unions enforcing the §5 gate by construction:
//   loop.do      = http | nested-if   (NEVER a loop → no loop-in-loop)
//   if.branches  = http | nested-loop (NEVER an if  → no if-in-if)
const LoopBodyStep = z.discriminatedUnion("type", [HttpStepModel, NestedIfStepModel]);
const IfBranchStep = z.discriminatedUnion("type", [HttpStepModel, NestedLoopStepModel]);

// ── Top-level container forms: accept exactly one level of the OTHER type. ──
export const LoopStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("loop"),
    repeat: z.number().int().min(1, "repeat must be >= 1"),
    // do: http | if (single-level mutual nesting, Slice 9c). Loop-in-loop rejected.
    do: z.array(LoopBodyStep).min(1, "loop body needs at least one step"),
  })
  .strict();
export type LoopStep = z.infer<typeof LoopStepModel>;

export const ElifBranchModel = z
  .object({
    cond: ConditionModel,
    then: z.array(IfBranchStep).min(1, "elif branch needs at least one step"),
  })
  .strict();
export type ElifBranch = z.infer<typeof ElifBranchModel>;

export const IfStepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("if"),
    cond: ConditionModel,
    // branches: http | loop (single-level mutual nesting, Slice 9c). If-in-if rejected.
    then: z.array(IfBranchStep).min(1, "if branch needs at least one step"),
    elif: z.array(ElifBranchModel).default([]),
    else: z.array(IfBranchStep).default([]),
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

/** Depth-first list of every http leaf, recursing through both container types
 *  to any depth (9c: bodies/branches are now Step[]). Return type unchanged. */
export function flattenHttpSteps(steps: ReadonlyArray<Step>): HttpStep[] {
  const out: HttpStep[] = [];
  for (const s of steps) {
    if (s.type === "http") out.push(s);
    else if (s.type === "loop") out.push(...flattenHttpSteps(s.do));
    else {
      out.push(...flattenHttpSteps(s.then));
      for (const e of s.elif) out.push(...flattenHttpSteps(e.then));
      out.push(...flattenHttpSteps(s.else));
    }
  }
  return out;
}

/** The sequence a step actually lives in — used by the inspector to clamp move
 *  up/down. Fully recursive (9c). Falls back to the top-level list if not found. */
export function findStepSiblings(steps: ReadonlyArray<Step>, stepId: string): ReadonlyArray<Step> {
  return siblingsOrNull(steps, stepId) ?? steps;
}

function siblingsOrNull(steps: ReadonlyArray<Step>, stepId: string): ReadonlyArray<Step> | null {
  if (steps.some((s) => s.id === stepId)) return steps;
  for (const s of steps) {
    if (s.type === "loop") {
      const r = siblingsOrNull(s.do, stepId);
      if (r) return r;
    } else if (s.type === "if") {
      let r = siblingsOrNull(s.then, stepId);
      if (r) return r;
      for (const e of s.elif) {
        r = siblingsOrNull(e.then, stepId);
        if (r) return r;
      }
      r = siblingsOrNull(s.else, stepId);
      if (r) return r;
    }
  }
  return null;
}

/** One-line human summary of an if/elif condition tree (leaf "left op right",
 *  groups joined by AND/OR; exists/empty drop the right operand). Shared by the
 *  canvas if-node and the test-run panel. */
export function summarizeCondition(c: Condition): string {
  if ("all" in c) return c.all.map(summarizeCondition).join(" AND ");
  if ("any" in c) return c.any.map(summarizeCondition).join(" OR ");
  const noRight = c.op === "exists" || c.op === "empty";
  return `${c.left || "?"} ${c.op}${noRight ? "" : ` ${c.right ?? ""}`}`;
}

/** Find a step of ANY type by id, descending into both container types (9c).
 *  Needed so the inspector can select a nested loop/if container, not just an
 *  http leaf (flattenHttpSteps only returns leaves). */
export function findStepById(steps: ReadonlyArray<Step>, stepId: string | null): Step | null {
  if (stepId === null) return null;
  for (const s of steps) {
    if (s.id === stepId) return s;
    if (s.type === "loop") {
      const r = findStepById(s.do, stepId);
      if (r) return r;
    } else if (s.type === "if") {
      let r = findStepById(s.then, stepId);
      if (r) return r;
      for (const e of s.elif) {
        r = findStepById(e.then, stepId);
        if (r) return r;
      }
      r = findStepById(s.else, stepId);
      if (r) return r;
    }
  }
  return null;
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
