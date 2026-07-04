import { flattenHttpSteps, type Scenario, type Step, type Condition } from "./model";
import { splitFlowToken } from "./flowToken";

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
    out.add(splitFlowToken(m[1]).base);
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
 * refName → 그 ref를 참조하는 STEP들의 문서순 stepId 배열. 표면 = 각 http 스텝의
 * url/header/body PLUS if/elif 조건 오퍼랜드(scanFlowVars가 건너뛰는). loop `do`,
 * if `then`/`elif[].then`/`else`, parallel `branches[].steps`를 재귀한다. 한 스텝에서
 * 같은 ref를 여러 번 써도 그 스텝은 1회만 기록(Set). refName은 splitFlowToken.base로
 * 정규화되고 bare `{{x}}`→`x`, namespaced `{{b.v}}`→`b.v`로 등장 형태대로 키된다.
 */
export function buildVarRefIndex(scenario: Scenario): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const record = (stepId: string, refs: Set<string>): void => {
    for (const name of refs) {
      const arr = index.get(name);
      if (arr) arr.push(stepId);
      else index.set(name, [stepId]);
    }
  };
  const walk = (steps: ReadonlyArray<Step>): void => {
    for (const s of steps) {
      if (s.type === "http") {
        const refs = new Set<string>();
        collectFromString(s.request.url, refs);
        for (const v of Object.values(s.request.headers)) collectFromString(v, refs);
        const body = s.request.body;
        if (body?.kind === "raw") collectFromString(body.value, refs);
        else if (body?.kind === "form")
          for (const v of Object.values(body.value)) collectFromString(v, refs);
        else if (body?.kind === "json") collectFromJson(body.value, refs);
        record(s.id, refs);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "parallel") {
        for (const b of s.branches) walk(b.steps);
      } else {
        const refs = new Set<string>();
        collectCondRefs(s.cond, refs);
        for (const e of s.elif) collectCondRefs(e.cond, refs);
        record(s.id, refs);
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
    }
  };
  walk(scenario.steps);
  return index;
}

/**
 * Per-variable count of how many STEPS reference each `{{var}}` (cast-normalized).
 * Derived from buildVarRefIndex (single walker) — a var used multiple times in one
 * step counts once. Read-only usage hint; condition operands included (a hint must
 * not lie). Return type/semantics unchanged from before (R13).
 */
export function countFlowVarUsage(scenario: Scenario): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [name, ids] of buildVarRefIndex(scenario)) counts.set(name, ids.length);
  return counts;
}

/** 선언 키 ∪ 모든 http 스텝(분기 포함)의 extract var bare 이름 (R2). */
export function collectProducedVars(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(scenario.variables)) out.add(k);
  for (const step of flattenHttpSteps(scenario.steps)) for (const e of step.extract) out.add(e.var);
  return out;
}

/** parallel 분기 B의 http extract var마다 `${B.name}.${var}` (R3/R4). parallel은
 *  top-level-only(ADR-0033)이라 최상위 스텝만 훑는다. */
export function collectNamespacedProducers(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches)
      for (const step of flattenHttpSteps(b.steps))
        for (const e of step.extract) out.add(`${b.name}.${e.var}`);
  }
  return out;
}

/** parallel 분기에서 추출되는 bare 이름 집합 (R8 shadow 판정). */
export function parallelExtractNames(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches)
      for (const step of flattenHttpSteps(b.steps)) for (const e of step.extract) out.add(e.var);
  }
  return out;
}

/** 참조되지만 producer가 없는 이름 = refs − produced − namespaced (R4). 예약 시스템
 *  감산 없음 — `{{}}`는 flow 네임스페이스라 `${vu_id}` system과 무관. */
export function undefinedVars(scenario: Scenario): Set<string> {
  const produced = collectProducedVars(scenario);
  const namespaced = collectNamespacedProducers(scenario);
  const out = new Set<string>();
  for (const name of buildVarRefIndex(scenario).keys())
    if (!produced.has(name) && !namespaced.has(name)) out.add(name);
  return out;
}
