import { flattenHttpSteps, type Scenario } from "./model";

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
