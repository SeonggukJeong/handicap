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

/** 비-parallel 서브트리(최상위·loop `do`·if `then`/`elif[].then`/`else`)의 http extract
 *  var 집합 — 선언 키 미포함. parallel branches는 미하강: 분기 extract는 flat이 아니라
 *  `{{branch.var}}`로 네임스페이스되기 때문. 선언↔추출 충돌 배지 판정의 flat 항. */
export function flatExtractNames(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  const walk = (steps: ReadonlyArray<Step>): void => {
    for (const s of steps) {
      if (s.type === "http") {
        for (const e of s.extract) out.add(e.var);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "if") {
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
      // parallel: NOT descended (branch extracts are namespaced, not flat).
    }
  };
  walk(scenario.steps);
  return out;
}

/** 선언 키 ∪ parallel 분기 **밖** http extract var (R2) = 선언 ∪ flatExtractNames.
 *  shadow 판정용 — walker는 flatExtractNames와 단일화. */
export function flatProducerNames(scenario: Scenario): Set<string> {
  const out = flatExtractNames(scenario);
  for (const k of Object.keys(scenario.variables)) out.add(k);
  return out;
}

/** key `${branch.name}.${base}` → 그 branch 서브트리에서 base를 참조하는 문서순 stepId (R3).
 *  같은 이름 branch가 여러 parallel 노드에 있으면 합쳐진다(엔진 branch-이름 네임스페이스 충실).
 *  분기 내부 자기 extract는 항상 bare `{{s}}`(base `s`)로 참조되므로 이 맵은 분기 내부 참조만
 *  담고, 다운스트림 `{{B.s}}`(base `B.s`)는 buildVarRefIndex가 담당한다(R4에서 합류). */
export function collectBranchInternalRefs(scenario: Scenario): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches) {
      for (const step of flattenHttpSteps(b.steps)) {
        const refs = new Set<string>();
        collectFromString(step.request.url, refs);
        for (const v of Object.values(step.request.headers)) collectFromString(v, refs);
        const body = step.request.body;
        if (body?.kind === "raw") collectFromString(body.value, refs);
        else if (body?.kind === "form")
          for (const v of Object.values(body.value)) collectFromString(v, refs);
        else if (body?.kind === "json") collectFromJson(body.value, refs);
        for (const base of refs) {
          const key = `${b.name}.${base}`;
          const arr = index.get(key);
          if (arr) arr.push(step.id);
          else index.set(key, [step.id]);
        }
      }
    }
  }
  return index;
}

/** `undefinedVarRefs`의 판정 결과 1건 (Task 3, US1). */
export type UndefinedRef = {
  /** 위반 참조의 문서순 stepId만(정당한 위치 참조 제외). */
  stepIds: string[];
  /** 이 bare 이름을 추출하는 분기명, 문서순·dedup. namespaced 키는 항상 []. */
  candidates: string[];
  /** 위반 참조가 어떤 parallel 분기 서브트리 안에만 있으면 "sibling", 하나라도 그 밖(다운스트림/
   *  namespaced)이면 "downstream"(더 흔하고 수정 가능한 쪽 우선). */
  kind: "downstream" | "sibling";
};

/** parallel 분기 B **자신의** http extract var 집합 — B의 steps를 재귀한다(Trap A: 분기 안
 *  loop `do:`/if `then`/`elif[].then`/`else`까지 하강, 중첩 parallel은 하강 안 함). `flatExtractNames`의
 *  narrowing 관용구를 그대로 본뜬 것 — 대상이 scenario.steps 대신 임의 서브트리라는 점만 다르다. */
function collectSubtreeExtractNames(steps: ReadonlyArray<Step>): Set<string> {
  const out = new Set<string>();
  const walk = (list: ReadonlyArray<Step>): void => {
    for (const s of list) {
      if (s.type === "http") {
        for (const e of s.extract) out.add(e.var);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "if") {
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
      // parallel: 분기 안 재중첩은 비목표(ADR-0033 top-level-only) — 하강 안 함.
    }
  };
  walk(steps);
  return out;
}

/**
 * 참조를 **위치**로 판정하는 미정의 변수 맵(Task 3/4, US1 — VariablesPanel의 유일한 판정 소스,
 * 옛 전역·conservative `undefinedVars`는 Task 4에서 제거됨). 각 `{{token}}` 참조가 트리의
 * **어디**에 있는지로 판정한다:
 *   - parallel 분기 B의 서브트리 **안**(B 안 중첩 loop/if 포함, Trap A) = 선언 ∪ flatExtractNames ∪
 *     B **자신의** extract.
 *   - 그 외(최상위·분기 밖 loop/if·다른 형제 분기) = 선언 ∪ flatExtractNames만(B의 extract는 안 셈).
 *   - namespaced(점 포함) 참조는 위치 무관하게 `collectNamespacedProducers`로 전역 해석 — 같은
 *     parallel 노드 **안**에서 `{{B.v}}`를 참조해도 정의됨으로 본다(런타임은 `join_all` 이후에나
 *     병합돼 미해결이지만, spec §2.2.2가 명시한 의도된 false-negative — 고치지 말 것).
 * `candidates`(bare 전용) = 그 이름을 자신의 extract로 갖는 분기명, 문서순·dedup 배열 — 점으로
 * 쪼개 매칭하지 않는다(namespaced 미정의 키는 항상 `candidates: []`).
 */
export function undefinedVarRefs(scenario: Scenario): Map<string, UndefinedRef> {
  const flatBase = flatProducerNames(scenario); // 선언 ∪ 비-parallel extract
  const namespaced = collectNamespacedProducers(scenario);

  // 최상위 parallel 노드 각 분기의 자기 extract 집합 — candidates 산출 전용, 문서순.
  // `collectSubtreeExtractNames`가 여기와 아래 `walk`의 parallel arm 두 곳에서 각자
  // 다시 호출된다(공유 메모 없음) — 여긴 `scenario.steps`만 스캔해 **최상위** parallel만
  // 보고, `walk`는 자신이 순회하며 만나는 parallel(어떤 깊이든)을 전부 본다. 둘이 지금
  // 일치하는 건 ADR-0033의 top-level-only 강제(분기 안 재중첩 parallel을 UI가 만들 수
  // 없음) 덕분 — 이 강제가 풀려 분기 안에 parallel을 authoring할 수 있게 되면 이 둘의
  // 스캔 범위가 갈라진다(재검토 필요, 아래 `walk` parallel arm의 짝 주석 참고).
  const branchOwn: { name: string; names: Set<string> }[] = [];
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches)
      branchOwn.push({ name: b.name, names: collectSubtreeExtractNames(b.steps) });
  }
  const candidatesFor = (bareName: string): string[] => {
    const out: string[] = [];
    for (const bp of branchOwn)
      if (bp.names.has(bareName) && !out.includes(bp.name)) out.push(bp.name);
    return out;
  };

  const acc = new Map<string, { stepIds: string[]; sawDownstream: boolean }>();
  const record = (name: string, stepId: string, insideBranch: boolean): void => {
    let a = acc.get(name);
    if (!a) {
      a = { stepIds: [], sawDownstream: false };
      acc.set(name, a);
    }
    a.stepIds.push(stepId);
    if (!insideBranch) a.sawDownstream = true;
  };

  // own = 현재 위치가 속한 분기의 자기 extract 집합(분기 밖이면 null). namespaced는 own과 무관하게
  // 전역 `namespaced`로만 해석(위 doc의 declared-limit).
  const judge = (refs: Set<string>, stepId: string, own: Set<string> | null): void => {
    for (const name of refs) {
      if (flatBase.has(name)) continue;
      if (name.includes(".")) {
        if (namespaced.has(name)) continue;
        // `insideBranch=false` here is a *policy* choice, not a positional fact
        // about where this ref sits — namespaced (`B.v`) refs are always
        // classified "downstream" regardless of whether the ref is textually
        // inside a parallel branch, because a dotted ref only resolves after
        // the branch's `join_all` completes (never "sibling" — see `judge`'s
        // doc above and `UndefinedRef.kind`).
        record(name, stepId, false);
        continue;
      }
      if (own !== null && own.has(name)) continue;
      record(name, stepId, own !== null);
    }
  };

  const walk = (steps: ReadonlyArray<Step>, own: Set<string> | null): void => {
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
        judge(refs, s.id, own);
      } else if (s.type === "loop") {
        walk(s.do, own);
      } else if (s.type === "parallel") {
        // `collectSubtreeExtractNames` re-derived here (no shared memo with the
        // `branchOwn` precompute above) — this call sees *whatever* parallel
        // `walk` recurses into, any depth, while `branchOwn` only scans
        // `scenario.steps`-level (top-level) parallels. Currently equivalent
        // by construction (ADR-0033 forbids authoring a parallel nested inside
        // a branch), so this only ever fires for top-level parallels too — see
        // the `branchOwn` comment above for the invariant this depends on.
        for (const b of s.branches) walk(b.steps, collectSubtreeExtractNames(b.steps));
      } else {
        const refs = new Set<string>();
        collectCondRefs(s.cond, refs);
        for (const e of s.elif) collectCondRefs(e.cond, refs);
        judge(refs, s.id, own);
        walk(s.then, own);
        for (const e of s.elif) walk(e.then, own);
        walk(s.else, own);
      }
    }
  };
  walk(scenario.steps, null);

  const out = new Map<string, UndefinedRef>();
  for (const [name, a] of acc) {
    out.set(name, {
      stepIds: a.stepIds,
      candidates: name.includes(".") ? [] : candidatesFor(name),
      kind: a.sawDownstream ? "downstream" : "sibling",
    });
  }
  return out;
}

export interface ParallelVarIdentity {
  branchName: string;
  varName: string;
  /** `${branchName}.${varName}` — 엔진 다운스트림 네임스페이스 형(runner.rs:638). */
  display: string;
  /** varName이 flat producer(선언/비-parallel extract)와 충돌 = rename 비활성 근거. */
  isShadow: boolean;
  /** 분기 내부에서 bare `{{varName}}`을 참조하는 문서순 stepId. */
  branchRefIds: string[];
  /** 다운스트림 `{{display}}`을 참조하는 문서순 stepId. */
  namespacedRefIds: string[];
}

/** top-level parallel 노드의 각 branch × 각 http extract var마다 1 identity (R1/R4).
 *  display로 dedup(동명 branch·여러 스텝의 같은 var). 문자열 분해 없이 구조적 branch/var 유지. */
export function parallelVarIdentities(scenario: Scenario): ParallelVarIdentity[] {
  const flat = flatProducerNames(scenario);
  const branchInternal = collectBranchInternalRefs(scenario);
  const refIndex = buildVarRefIndex(scenario);
  const out: ParallelVarIdentity[] = [];
  const seen = new Set<string>();
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches) {
      for (const step of flattenHttpSteps(b.steps)) {
        for (const e of step.extract) {
          const display = `${b.name}.${e.var}`;
          if (seen.has(display)) continue;
          seen.add(display);
          out.push({
            branchName: b.name,
            varName: e.var,
            display,
            isShadow: flat.has(e.var),
            branchRefIds: branchInternal.get(display) ?? [],
            namespacedRefIds: refIndex.get(display) ?? [],
          });
        }
      }
    }
  }
  return out;
}
