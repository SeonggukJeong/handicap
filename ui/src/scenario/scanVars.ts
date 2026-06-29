import { flattenHttpSteps, type Scenario, type Step, type Condition } from "./model";

const FLOW_VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

// ${ NAME } / ${ NAME:-default } — name only (mirrors templateParams.ENV_RE, datalist 힌트용).
const ENV_VAR_RE = /\$\{\s*([^}:]+?)\s*(?::-[^}]*)?\}/g;
const ENV_RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

function collectEnvFromString(s: string, out: Set<string>): void {
  for (const m of s.matchAll(ENV_VAR_RE)) {
    if (!ENV_RESERVED.has(m[1])) out.add(m[1]);
  }
}

function collectEnvFromJson(value: unknown, out: Set<string>): void {
  if (typeof value === "string") collectEnvFromString(value, out);
  else if (Array.isArray(value)) for (const v of value) collectEnvFromJson(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectEnvFromJson(v, out);
}

/** 시나리오가 참조하는 `${ENV}` 변수명(예약 시스템 변수 제외) — InsertTemplateModal
 *  파라미터화 datalist 힌트용. scanFlowVars의 env 대응(같은 http-leaf request 필드 스캔). */
export function scanEnvVars(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const step of flattenHttpSteps(scenario.steps)) {
    collectEnvFromString(step.request.url, out);
    for (const v of Object.values(step.request.headers)) collectEnvFromString(v, out);
    const body = step.request.body;
    if (body?.kind === "raw") collectEnvFromString(body.value, out);
    else if (body?.kind === "form")
      for (const v of Object.values(body.value)) collectEnvFromString(v, out);
    else if (body?.kind === "json") collectEnvFromJson(body.value, out);
  }
  return out;
}

function collectFromString(s: string, out: Set<string>): void {
  for (const m of s.matchAll(FLOW_VAR_RE)) {
    out.add(m[1]);
  }
}

function collectFromJson(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectFromString(value, out);
  } else if (Array.isArray(value)) {
    for (const v of value) collectFromJson(v, out);
  } else if (value && typeof value === "object") {
    // Only string leaves are templated by the engine (8a) — keys are verbatim.
    for (const v of Object.values(value)) collectFromJson(v, out);
  }
}

/**
 * All distinct `{{var}}` names referenced by a scenario, across url, header
 * values, form body values, and JSON body string leaves — recursing into loop
 * `do:` bodies via flattenHttpSteps. `${ENV}` / `${vu_id}` are a different
 * namespace and are not returned (mirrors engine template.rs).
 */
export function scanFlowVars(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const step of flattenHttpSteps(scenario.steps)) {
    collectFromString(step.request.url, out);
    for (const v of Object.values(step.request.headers)) collectFromString(v, out);
    const body = step.request.body;
    if (body?.kind === "raw") collectFromString(body.value, out);
    else if (body?.kind === "form") {
      for (const v of Object.values(body.value)) collectFromString(v, out);
    } else if (body?.kind === "json") {
      collectFromJson(body.value, out);
    }
  }
  return out;
}

function collectCondRefs(c: Condition, out: Set<string>): void {
  if ("all" in c) {
    for (const x of c.all) collectCondRefs(x, out);
    return;
  }
  if ("any" in c) {
    for (const x of c.any) collectCondRefs(x, out);
    return;
  }
  collectFromString(c.left, out);
  if (c.right !== undefined) collectFromString(c.right, out);
}

/**
 * Per-variable count of how many STEPS reference each `{{var}}`. Surfaces = the
 * same http request fields as scanFlowVars (url / header values / body) PLUS
 * if/elif condition operands (which scanFlowVars intentionally skips). Recurses
 * through every container (loop `do`, if `then`/`elif[].then`/`else`, parallel
 * `branches[].steps`), including one-level nesting. A var referenced multiple
 * times within one step counts once for that step. Read-only — powers the
 * editor's per-variable usage hint; a hint must not lie, hence condition coverage.
 */
export function countFlowVarUsage(scenario: Scenario): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (refs: Set<string>): void => {
    for (const name of refs) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const walk = (steps: ReadonlyArray<Step>): void => {
    for (const s of steps) {
      if (s.type === "http") {
        const refs = new Set<string>();
        collectFromString(s.request.url, refs);
        for (const v of Object.values(s.request.headers)) collectFromString(v, refs);
        const body = s.request.body;
        if (body?.kind === "raw") {
          collectFromString(body.value, refs);
        } else if (body?.kind === "form") {
          for (const v of Object.values(body.value)) collectFromString(v, refs);
        } else if (body?.kind === "json") {
          collectFromJson(body.value, refs);
        }
        bump(refs);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "parallel") {
        for (const b of s.branches) walk(b.steps);
      } else {
        // if: the if step itself "uses" its own cond + every elif cond operand
        const refs = new Set<string>();
        collectCondRefs(s.cond, refs);
        for (const e of s.elif) collectCondRefs(e.cond, refs);
        bump(refs);
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
    }
  };
  walk(scenario.steps);
  return counts;
}
