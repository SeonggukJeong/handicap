# 에디터 변수 도구 A — 미정의 경고 + 사용→스텝 네비게이션 + flat 변수 rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: APPROVED -->

**Goal:** 에디터 VariablesPanel에 ① 미정의(오타) 변수 ⚠ 경고 ② 사용-카운트 클릭→참조 스텝 순환 점프 ③ flat 변수 rename(선언·비-parallel extract를 선언 키+모든 `extract.var`+모든 텍스트 참조[cast 보존]+조건 오퍼랜드까지 단일 트랜잭셔널 편집으로)을 더한다. 공유 토대는 engine-충실 cast-base 파싱 + produced/namespaced/referenced 인덱스다.

**Architecture:** 순수 분석 레이어(`flowToken.ts` + `scanVars.ts` 신규 export)가 시나리오 모델에서 produced/namespaced/referenced 집합과 문서순 stepId 인덱스를 도출한다. rename은 `yamlDoc` `renameVariable` Edit variant(맵 키 노드 조작 + extract var 구조적 타깃 + `{{old}}` 토큰 base 재작성, cast/공백 byte-보존)로 표현하고, store는 `reparentStep` 트랜잭셔널 선례(clone→apply→reparse→성공 시에만 커밋)로 실행하며 flat/충돌/shadow/yamlError를 게이트한다. VariablesPanel은 이 분석을 상태별 단일 행 목록으로 렌더한다. 모델(Zod)/proto/migration/YAML 직렬화 *형식* 무접촉 — rename은 기존 문자열 내용만 재작성한다.

**Tech Stack:** TypeScript, React, Zustand, `yaml` 2.9.0 Document API(`visit`/`isScalar`/`Collection.get(key,true)`), Vitest + React Testing Library, Tailwind. UI-only.

## Global Constraints

- **와이어/모델 0-diff (R14)**: `crates/**`·proto·migration·CSV/XLSX export·`ui/src/scenario/model.ts`(Zod schema)·기존 store 액션 시그니처·`reorder.ts`·`dropRules.ts`·`FlowOutline.tsx`(배지 미추가, R11)·`ValidationBanner.tsx` 무변경. 추가만 허용: `flowToken.ts`(신규)·`scanVars.ts` 신규 export·`cast.ts` 신규 `export` 키워드(로직 불변)·`yamlDoc` Edit variant·`store` 신규 액션·`EditorShell`→`VariablesPanel` prop·`ko.ts` 키·`DataBindingPanel` produced-set 교체(R12).
- **cast 컨텍스트 경계(의도적, spec §5)**: base 정규화(`:kw`=cast)를 컨텍스트 무관 균일 적용. 엔진은 JSON leaf에서만 cast하지만 scan/rename 일관성을 위해 url/header 등에서도 `{{age:num}}`을 base `age`로 본다. `cast.ts`의 ADR-0029 검증·엄격 실패 경로는 무변경(export 추가만).
- **문구는 전부 `ko.ts`(ADR-0035, R15)**: 상태 라벨·"분기" 배지·미정의 경고·충돌/불법 에러·rename aria·nav aria 전부 `ko.editor.*`. 인라인 한글/영어 0. `aria-label`도 사용자노출이라 ko 경유. ko 변수치환 명사 뒤 조사는 `을(를)`/`(으)로` 병기형(ui/CLAUDE.md).
- **TDD 순서 (tdd-guard + ui/CLAUDE.md)**: 각 task는 **테스트 파일 편집을 가장 먼저** — pending(modified/untracked) test 파일이 있어야 `ui/src` 편집이 가드를 통과한다(import 미해결 RED 무방). 그 뒤 src.
- **게이트 (매 커밋)**: UI-only라 cargo 게이트는 fast-path skip. 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(lint `--max-warnings=0`·`tsc -b`가 esbuild 미검 타입에러 잡음). 각 task 독립 green 커밋.
- **getSnapshot 함정 (ui/CLAUDE.md)**: 셀렉터 fallback은 모듈-스코프 상수(`EMPTY_VARS`). 파생 분석은 셀렉터 안 인라인 스캔 금지 — `useMemo([model])`.
- **셀 반환 노드 규약 (yaml 2.9.0)**: `YAMLMap.get(key)`=값(컬렉션이면 노드), `get(key, true)`=Scalar 노드. `visit(doc,{Scalar(key,node)})`의 `key ∈ 'key'|'value'|number|null`(맵 키는 `'key'`).

---

## Task 1: 분석 토대 — `flowToken` + `scanVars` cast 정규화·produced/namespaced/ref 인덱스 + `DataBindingPanel` produced-set 교체

**충족 R:** R1, R2, R3, R4, R12, R13

**Files:**
- Create: `ui/src/scenario/flowToken.ts`
- Create: `ui/src/scenario/__tests__/flowToken.test.ts`
- Modify: `ui/src/scenario/cast.ts` (add `export` to `CAST_KEYWORDS` and `trailingCast` — 로직 byte-identical)
- Modify: `ui/src/scenario/scanVars.ts` (cast 정규화 + 신규 export)
- Modify: `ui/src/scenario/__tests__/scanVars.test.ts` (extend)
- Modify: `ui/src/components/DataBindingPanel.tsx` (R12: `availableElsewhere`→`collectProducedVars`)

**Interfaces:**
- Consumes: `model.ts` — `flattenHttpSteps(steps): HttpStep[]`, types `Scenario`/`Step`/`Condition`/`HttpStep`. `cast.ts` — `CAST_KEYWORDS`, `trailingCast(inner): string|null`(테스트 전용 import).
- Produces (later tasks rely on these exact names/types):
  - `flowToken.ts`: `splitFlowToken(inner: string): { base: string; cast: string | null }`
  - `scanVars.ts`:
    - `collectProducedVars(scenario: Scenario): Set<string>`
    - `collectNamespacedProducers(scenario: Scenario): Set<string>`  (`${branch.name}.${var}`)
    - `parallelExtractNames(scenario: Scenario): Set<string>`  (parallel 분기 bare extract 이름 — shadow 판정)
    - `buildVarRefIndex(scenario: Scenario): Map<string, string[]>`  (refName→문서순 stepId)
    - `undefinedVars(scenario: Scenario): Set<string>`
    - (기존) `scanFlowVars`/`countFlowVarUsage`/`scanEnvVars` — 시그니처 불변, cast 정규화만.

- [ ] **Step 1: 실패 테스트 — `flowToken.test.ts` (신규, R1)**

`ui/src/scenario/__tests__/flowToken.test.ts` 생성. `splitFlowToken`의 keyword-only cast 분리 + `cast.ts::trailingCast`와의 동치(드리프트 가드)를 단언한다.

```ts
import { describe, it, expect } from "vitest";
import { splitFlowToken } from "../flowToken";
import { CAST_KEYWORDS, trailingCast } from "../cast";

describe("splitFlowToken", () => {
  it("splits a trailing cast keyword and trims the base", () => {
    expect(splitFlowToken("token:num")).toEqual({ base: "token", cast: "num" });
    expect(splitFlowToken("token:json")).toEqual({ base: "token", cast: "json" });
    expect(splitFlowToken(" token : num ".trim())).toEqual({ base: "token", cast: "num" });
    // FLOW_VAR_RE trims outer ws, but inner spaces survive → base trimmed, cast kept (engine lockstep)
    expect(splitFlowToken("token : num")).toEqual({ base: "token", cast: "num" });
  });

  it("keeps a non-keyword :suffix as part of the base (engine reads {{count:foo}} as name count:foo)", () => {
    expect(splitFlowToken("count:foo")).toEqual({ base: "count:foo", cast: null });
    expect(splitFlowToken("a:b:num")).toEqual({ base: "a:b", cast: "num" }); // only the trailing keyword strips
  });

  it("has no cast for a bare name or a namespaced ref", () => {
    expect(splitFlowToken("plain")).toEqual({ base: "plain", cast: null });
    expect(splitFlowToken("branch.var")).toEqual({ base: "branch.var", cast: null });
  });

  // Drift guard (spec §3-1): splitFlowToken's cast detection ≡ trailingCast filtered by CAST_KEYWORDS.
  it("is equivalent to trailingCast ∩ CAST_KEYWORDS on a battery of inputs", () => {
    const inputs = ["token:num", "count:foo", "a", "branch.var", "x:bool", "y:", "z:json", "n:str", "q:date", "a:b:num"];
    for (const inp of inputs) {
      const tc = trailingCast(inp);
      const expectedCast = tc !== null && CAST_KEYWORDS.includes(tc) ? tc : null;
      expect(splitFlowToken(inp).cast).toBe(expectedCast);
    }
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test flowToken` → FAIL (`Cannot find module '../flowToken'` + `trailingCast`/`CAST_KEYWORDS` not exported from cast).

- [ ] **Step 3: `cast.ts` — `CAST_KEYWORDS`·`trailingCast`에 `export` 추가 (로직 불변)**

`ui/src/scenario/cast.ts`에서 두 선언에 `export` 키워드만 추가한다(정규식·검증·본문 byte-identical — spec §5 "trailingCast·검증 무변경"은 로직 불변을 의미하고, §4.1은 `flowToken.test.ts`가 이 둘을 import해 동치를 단언하도록 export를 전제한다):

```ts
// 7행: const CAST_KEYWORDS ... → export
export const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool", "json"];
```

```ts
// 64행: function trailingCast ... → export (본문·정규식 불변)
export function trailingCast(inner: string): string | null {
  const m = /(?:^|[^-]):\s*([A-Za-z][A-Za-z0-9]*)$/.exec(inner);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: `flowToken.ts` — `splitFlowToken` 구현 (신규, 순수·무의존)**

`ui/src/scenario/flowToken.ts` 생성. `cast.ts::trailingCast`와 **정확히 같은 정규식**(끝 `$`, 후행 `\s*` 없음)을 써 동치를 by-construction 보장하고, 자체 `CAST_KEYWORDS`를 둔다(무의존 — 드리프트는 test가 잡는다). 마지막 `:` 앞이 base다.

```ts
// 엔진 CAST_KEYWORDS와 동일 목록(cast.ts). 무의존 유지를 위해 여기서 재선언하고,
// flowToken.test.ts가 cast.ts의 것과 동치임을 단언해 드리프트를 막는다(spec §3-1/§4.1).
const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool", "json"];

// cast.ts::trailingCast와 동일 정규식 — trailing `:kw`를 `kw ∈ CAST_KEYWORDS`일 때만 cast로 분리.
const TRAILING_CAST = /(?:^|[^-]):\s*([A-Za-z][A-Za-z0-9]*)$/;

/**
 * `{{INNER}}` 토큰의 inner를 base 변수명과 optional cast로 분리한다.
 * trailing `:kw`는 kw가 엔진 CAST_KEYWORDS(str/num/bool/json)일 때만 cast로 떼고,
 * 그 외 `:word`는 base의 일부다(엔진은 `{{count:foo}}`를 변수명 `count:foo`로 읽는다).
 * base는 trim된다. 순수·무의존.
 */
export function splitFlowToken(inner: string): { base: string; cast: string | null } {
  const m = TRAILING_CAST.exec(inner);
  if (m && CAST_KEYWORDS.includes(m[1])) {
    // 매치된 콜론 = 마지막 콜론(뒤엔 `\s*kw$`뿐, 콜론 없음).
    const colon = inner.lastIndexOf(":");
    return { base: inner.slice(0, colon).trim(), cast: m[1] };
  }
  return { base: inner.trim(), cast: null };
}
```

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test flowToken` → PASS. `cd ui && pnpm test cast` → 기존 cast 테스트 PASS(export 추가는 무해).

- [ ] **Step 6: 실패 테스트 — `scanVars.test.ts` 확장 (R1·R2·R3·R4·R13)**

`ui/src/scenario/__tests__/scanVars.test.ts`에 신규 import + describe 블록을 추가한다(기존 케이스는 그대로 — 단 cast 정규화로 인해 아래 R13 신규 케이스만 추가).

```ts
// 상단 import 확장:
import {
  scanFlowVars, scanEnvVars, countFlowVarUsage,
  collectProducedVars, collectNamespacedProducers, parallelExtractNames,
  buildVarRefIndex, undefinedVars,
} from "../scanVars";
```

파일 하단에 추가:

```ts
// 헬퍼: parallel 1분기(extract s) + 그 분기가 {{s}}(bare) 참조, 그리고 다운스트림 http가 {{alpha.s}}·{{typo.s}}·{{missing}} 참조.
const parallelScen = ScenarioModel.parse({
  version: 1, name: "p", cookie_jar: "auto", variables: { declared: "v" },
  steps: [
    {
      id: "01HX0000000000000000000050", name: "par", type: "parallel",
      branches: [
        {
          name: "alpha",
          steps: [
            {
              id: "01HX0000000000000000000051", name: "leaf", type: "http",
              request: { method: "GET", url: "/{{s}}", headers: {} }, assert: [],
              extract: [{ from: "body", path: "$.tok", var: "s" }],
            },
          ],
        },
      ],
    },
    {
      id: "01HX0000000000000000000052", name: "after", type: "http",
      request: { method: "GET", url: "/x?a={{alpha.s}}&b={{typo.s}}&c={{missing}}", headers: {} },
      assert: [], extract: [{ from: "body", path: "$.u", var: "flatVar" }],
    },
  ],
});

describe("splitFlowToken normalization in scanners (R1/R13)", () => {
  it("countFlowVarUsage keys a cast token by its base (token, not token:num)", () => {
    const s = scenario([
      { id: "01HX0000000000000000000001", name: "a", type: "http",
        request: { method: "GET", url: "/x", headers: {}, body: { kind: "json", value: { n: "{{token:num}}" } } },
        assert: [], extract: [] },
    ]);
    expect(countFlowVarUsage(s).get("token")).toBe(1);
    expect(countFlowVarUsage(s).get("token:num")).toBeUndefined();
  });
  it("keeps a non-keyword :suffix as the whole base (count:foo)", () => {
    const s = scenario([
      { id: "01HX0000000000000000000001", name: "a", type: "http",
        request: { method: "GET", url: "/x", headers: {}, body: { kind: "json", value: { n: "{{count:foo}}" } } },
        assert: [], extract: [] },
    ]);
    expect(scanFlowVars(s).has("count:foo")).toBe(true);
    expect(scanFlowVars(s).has("count")).toBe(false);
  });
});

describe("collectProducedVars (R2)", () => {
  it("unions declared keys and every http extract var (parallel branches included)", () => {
    const p = collectProducedVars(parallelScen);
    expect(p.has("declared")).toBe(true); // 선언
    expect(p.has("s")).toBe(true);        // parallel 분기 extract bare
    expect(p.has("flatVar")).toBe(true);  // flat extract
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
    expect(idx.get("s")).toEqual(["01HX0000000000000000000051"]);        // 분기 내부 bare
    expect(idx.get("alpha.s")).toEqual(["01HX0000000000000000000052"]);  // 다운스트림 namespaced
    expect(idx.get("missing")).toEqual(["01HX0000000000000000000052"]);  // bare 미정의
  });
  it("counts derive from index length (a var used twice in one step = one stepId)", () => {
    const s = scenario([
      { id: "01HX0000000000000000000001", name: "a", type: "http",
        request: { method: "GET", url: "/{{id}}/{{id}}", headers: { "X-Id": "{{id}}" } }, assert: [], extract: [] },
    ]);
    expect(buildVarRefIndex(s).get("id")).toEqual(["01HX0000000000000000000001"]);
    expect(countFlowVarUsage(s).get("id")).toBe(1);
  });
});

describe("undefinedVars (R4)", () => {
  it("flags dangling refs but not valid namespaced / branch-internal bare refs", () => {
    const u = undefinedVars(parallelScen);
    expect(u.has("alpha.s")).toBe(false); // 유효 namespaced
    expect(u.has("s")).toBe(false);       // 분기 내부 bare는 collectProducedVars가 해소(conservative)
    expect(u.has("typo.s")).toBe(true);   // 당글링 namespaced
    expect(u.has("missing")).toBe(true);  // bare 미정의
  });
  it("treats {{vu_id}} as a real undefined flow var (no reserved-system subtraction)", () => {
    const s = scenario([
      { id: "01HX0000000000000000000001", name: "a", type: "http",
        request: { method: "GET", url: "/x?v={{vu_id}}", headers: {} }, assert: [], extract: [] },
    ]);
    expect(undefinedVars(s).has("vu_id")).toBe(true);
  });
});
```

- [ ] **Step 7: RED 확인**

Run: `cd ui && pnpm test scanVars` → FAIL (신규 export 미존재).

- [ ] **Step 8: `scanVars.ts` — cast 정규화 + 신규 export 구현**

`collectFromString`을 `splitFlowToken(...).base`로 정규화(R1 — `scanFlowVars`·`countFlowVarUsage`·`collectCondRefs` 세 소비처 공유). `countFlowVarUsage`는 `buildVarRefIndex`에서 `.length` 파생(중복 워커 금지). 신규 export 5종 추가.

파일 상단 import:
```ts
import { flattenHttpSteps, type Scenario, type Step, type Condition } from "./model";
import { splitFlowToken } from "./flowToken";
```

`collectFromString`(38–42행 교체 — cast 정규화):
```ts
function collectFromString(s: string, out: Set<string>): void {
  for (const m of s.matchAll(FLOW_VAR_RE)) {
    out.add(splitFlowToken(m[1]).base);
  }
}
```

기존 `countFlowVarUsage`(99–137행) 전체를 아래로 교체 — 단일 워커 `buildVarRefIndex` + 파생 count + 신규 export. `collectFromJson`/`collectCondRefs`/`FLOW_VAR_RE`는 그대로 재사용:

```ts
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
  for (const step of flattenHttpSteps(scenario.steps))
    for (const e of step.extract) out.add(e.var);
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
      for (const step of flattenHttpSteps(b.steps))
        for (const e of step.extract) out.add(e.var);
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
```

> 주의: 기존 `bump`/`walk` 로컬 헬퍼는 `buildVarRefIndex`로 흡수됐다. `collectCondRefs`(77–88행)·`collectFromJson`(44–53행)·`FLOW_VAR_RE`(3행)는 그대로 남긴다.

- [ ] **Step 9: GREEN 확인 (scanVars + 기존 소비처)**

Run: `cd ui && pnpm test scanVars` → PASS. 이어 cast 정규화가 기존 소비처를 안 깼는지: `cd ui && pnpm test insertTemplate DataBinding` → PASS.

- [ ] **Step 10: `DataBindingPanel.tsx` — `availableElsewhere`를 `collectProducedVars`로 교체 (R12)**

기존 인라인 produced-set(308–315행)을 공유 함수 호출로 교체(byte-identical 동작). `flattenHttpSteps`가 이 파일에서 미사용이 되면 import에서 제거(lint `--max-warnings=0`).

import 교체(4–5행):
```ts
import { type Scenario } from "../scenario/model";
import { scanFlowVars, collectProducedVars } from "../scenario/scanVars";
```

308–315행 교체:
```ts
  // scenario.variables + 모든 extract(분기 포함)로 채워지는 var 집합 (공유 collectProducedVars).
  const availableElsewhere = useMemo<Set<string>>(() => collectProducedVars(scenario), [scenario]);
```

- [ ] **Step 11: 커밋 (게이트 통과)**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/scenario/flowToken.ts ui/src/scenario/__tests__/flowToken.test.ts \
        ui/src/scenario/cast.ts ui/src/scenario/scanVars.ts \
        ui/src/scenario/__tests__/scanVars.test.ts ui/src/components/DataBindingPanel.tsx
git commit -m "feat(editor): flow-var 분석 토대 — splitFlowToken cast 정규화·produced/namespaced/ref 인덱스"
```

---

## Task 2: rename 편집 경로 — `yamlDoc.renameVariable`(트랜잭셔널 노드 편집) + `store.renameVariable`(flat/충돌/shadow/yamlError 게이트)

**충족 R:** R6, R7, R8

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (Edit variant + applyEdit case + `renameExtractVars`/`escapeRegExp` 헬퍼 + `isScalar`/`visit` import)
- Create: `ui/src/scenario/__tests__/yamlDoc.rename.test.ts`
- Modify: `ui/src/scenario/store.ts` (interface + `renameVariable` 액션 + `actions` shim + `RenameVarError` export)
- Create: `ui/src/scenario/__tests__/store.renameVariable.test.ts`

**Interfaces:**
- Consumes: Task 1 `scanVars` — `parallelExtractNames`, `collectProducedVars`, `collectNamespacedProducers`, `buildVarRefIndex`. `yamlDoc` — `applyEdit`, `parseScenarioDoc`, `serializeDoc`, `plainScalar`(파일 내부). `yaml` — `isScalar`, `visit`.
- Produces:
  - `yamlDoc.ts` Edit: `{ type: "renameVariable"; oldName: string; newName: string }`
  - `store.ts`: `renameVariable(oldName: string, newName: string): RenameVarError | null` (null=성공·커밋됨)
  - `store.ts`: `export type RenameVarError = "self" | "invalid" | "shadow" | "collision"`

- [ ] **Step 1: 실패 테스트 — `yamlDoc.rename.test.ts` (신규, R6)**

`ui/src/scenario/__tests__/yamlDoc.rename.test.ts` 생성. (a)–(d) + cast/공백/따옴표 보존 + 헤더키 무오염 + `{{B.old}}` 불매치를 `applyEdit`로 검증한다.

```ts
import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { applyEdit } from "../yamlDoc";

function rename(yaml: string, oldName: string, newName: string): string {
  const doc = parseDocument(yaml);
  applyEdit(doc, { type: "renameVariable", oldName, newName });
  return String(doc);
}

describe("applyEdit renameVariable", () => {
  it("(a) renames the variables map key, preserving value + comment + position", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: "keepme" # note\n  other: x\nsteps: []\n`,
      "old", "fresh",
    );
    expect(out).toContain("fresh: \"keepme\" # note");
    expect(out).not.toMatch(/\bold:/);
    expect(out).toContain("other: x"); // 형제 무변
  });

  it("(b) renames extract[].var structurally, not any scalar equal to oldName", () => {
    const out = rename(
      `version: 1\nname: t\nvariables: {}\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: /x\n      headers:\n        X-Val: old\n` + // 헤더 값이 리터럴 "old" — 오염 금지
        `    extract:\n      - from: body\n        path: $.t\n        var: old\n`,
      "old", "tok",
    );
    expect(out).toContain("var: tok");       // (b) extract var 변경
    expect(out).toContain("X-Val: old");     // 헤더 값 "old"는 불변(bare-scalar-any-match 금지)
  });

  it("(c) rewrites {{old}} / {{old:cast}} base only, preserving cast + surrounding bytes", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: "/a/{{old}}/b?x={{ old : num }}&y={{oldX}}&z={{team.old}}"\n` +
        `      headers: {}\n`,
      "old", "new",
    );
    expect(out).toContain("/a/{{new}}/b");        // bare
    expect(out).toContain("{{ new : num }}");     // cast + 공백 보존
    expect(out).toContain("{{oldX}}");            // 접두 불매치(정확일치)
    expect(out).toContain("{{team.old}}");        // namespaced 불매치
  });

  it("(d) rewrites condition operands in the (c) pass without creating a right key", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: g\n    type: if\n` +
        `    cond:\n      left: "{{old}}"\n      op: exists\n` +
        `    then:\n      - id: 01HX0000000000000000000002\n        name: t\n        type: http\n` +
        `        request: { method: GET, url: /ok, headers: {} }\n`,
      "old", "new",
    );
    expect(out).toContain("left: \"{{new}}\"");
    expect(out).not.toContain("right:"); // exists는 right 없음 — 신규 생성 금지
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test yamlDoc.rename` → FAIL (Edit variant/case 미존재).

- [ ] **Step 3: `yamlDoc.ts` — Edit variant + import 확장**

1행 import에 `isScalar`, `visit` 추가:
```ts
import { parseDocument, Document, isMap, isSeq, isScalar, visit, Scalar, YAMLMap, YAMLSeq, type Node } from "yaml";
```

Edit union(11–70행)에 variant 추가(`insertSteps` 앞, 세미콜론 위치 주의 — 마지막 멤버는 `insertSteps`가 유지):
```ts
  | { type: "renameVariable"; oldName: string; newName: string }
```

- [ ] **Step 4: `yamlDoc.ts` — `applyEdit`에 `renameVariable` case 추가**

`applyEdit`의 `case "insertSteps"` 앞(461행 근처)에 추가:
```ts
    case "renameVariable": {
      const { oldName, newName } = edit;
      // (a) variables 맵 키를 in-place rename — 값 노드·주석·위치 보존(deleteIn+setIn 금지).
      const vars = doc.getIn(["variables"]);
      if (isMap(vars)) {
        for (const pair of vars.items) {
          const k = pair.key;
          const kv = isScalar(k) ? k.value : k;
          if (kv === oldName) {
            if (isScalar(k)) k.value = newName;
            else pair.key = plainScalar(newName);
            break;
          }
        }
      }
      // (b) 구조적: 전 스텝 트리의 extract[].var === oldName → newName (bare-scalar-any-match 금지).
      renameExtractVars(doc.getIn(["steps"]), oldName, newName);
      // (c)+(d) 텍스트: 모든 스칼라 VALUE의 {{old}}/{{old:cast}} base만 재작성(cast·공백·나머지 byte 보존).
      const re = new RegExp(`\\{\\{(\\s*)${escapeRegExp(oldName)}(?=[:}\\s])`, "g");
      visit(doc, {
        Scalar(key, node) {
          if (key === "key") return; // 맵 키는 verbatim (헤더/JSON 키; variables 키는 (a) 소유)
          if (typeof node.value !== "string") return;
          const next = node.value.replace(re, (_m, ws: string) => `{{${ws}${newName}`);
          if (next !== node.value) node.value = next;
        },
      });
      return;
    }
```

- [ ] **Step 5: `yamlDoc.ts` — `renameExtractVars`·`escapeRegExp` 헬퍼 추가**

`plainScalar`(466행) 근처, 파일 하단 헬퍼 영역에 추가:
```ts
// extract[].var를 구조적으로만 rename — 스텝 트리를 searchSeq처럼 하강(loop do / if
// then·elif[].then·else / parallel branches[].steps). 헤더/URL이 우연히 oldName과
// 같아도 건드리지 않는다(bare-scalar-any-match 금지, ui/CLAUDE.md "id 키 일괄 교체" 클래스).
function renameExtractVars(steps: unknown, oldName: string, newName: string): void {
  if (!isSeq(steps)) return;
  for (const item of steps.items) {
    if (!isMap(item)) continue;
    const extract = item.get("extract");
    if (isSeq(extract)) {
      for (const ex of extract.items) {
        if (!isMap(ex)) continue;
        const v = ex.get("var", true); // Scalar 노드(YAMLMap.get keepScalar)
        if (isScalar(v) && v.value === oldName) v.value = newName;
      }
    }
    renameExtractVars(item.get("do"), oldName, newName);
    renameExtractVars(item.get("then"), oldName, newName);
    renameExtractVars(item.get("else"), oldName, newName);
    const elif = item.get("elif");
    if (isSeq(elif))
      for (const eb of elif.items) if (isMap(eb)) renameExtractVars(eb.get("then"), oldName, newName);
    const branches = item.get("branches");
    if (isSeq(branches))
      for (const br of branches.items) if (isMap(br)) renameExtractVars(br.get("steps"), oldName, newName);
  }
}

// 정규식 특수문자 이스케이프 (변수명은 `[^\s{}:]+`라 `.` 등 포함 가능).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 6: GREEN 확인 (yamlDoc.rename + 기존 yamlDoc)**

Run: `cd ui && pnpm test yamlDoc.rename yamlDoc` → PASS(신규 + 기존 yamlDoc 무회귀).

- [ ] **Step 7: 실패 테스트 — `store.renameVariable.test.ts` (신규, R7·R8)**

`ui/src/scenario/__tests__/store.renameVariable.test.ts` 생성. happy(트랜잭셔널 커밋)·충돌·빈/불법·self·shadow·yamlError no-op을 반환코드 + 상태로 단언한다.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const FLAT = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: s
    type: http
    request:
      method: GET
      url: "/x?a={{token}}&b={{token:num}}"
      headers: {}
`;

const PARALLEL = `version: 1
name: t
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000050
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000051
            name: leaf
            type: http
            request: { method: GET, url: "/{{s}}", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

describe("store.renameVariable", () => {
  beforeEach(reset);

  it("happy: renames declaration key + all references (cast preserved), commits transactionally", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    const err = useScenarioEditor.getState().renameVariable("token", "auth");
    expect(err).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toContain("auth: seed");
    expect(yaml).toContain("{{auth}}");
    expect(yaml).toContain("{{auth:num}}"); // cast 보존
    expect(yaml).not.toContain("{{token"); // 옛 참조 없음
    expect(useScenarioEditor.getState().yamlError).toBeNull();
  });

  it("no-op on self / blank / illegal / collision — state unchanged, error code returned", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    const before = useScenarioEditor.getState().yamlText;
    expect(useScenarioEditor.getState().renameVariable("token", "token")).toBe("self");
    expect(useScenarioEditor.getState().renameVariable("token", "")).toBe("invalid");
    expect(useScenarioEditor.getState().renameVariable("token", "a b")).toBe("invalid");
    expect(useScenarioEditor.getState().renameVariable("token", "a:b")).toBe("invalid");
    // 충돌: 이미 참조되는 이름(자기 참조 token은 self가 먼저지만, 새 var 추가로 충돌 유발)
    useScenarioEditor.getState().setVariable("taken", "x");
    expect(useScenarioEditor.getState().renameVariable("token", "taken")).toBe("collision");
    expect(useScenarioEditor.getState().yamlText).toContain("token: seed"); // 무변이
  });

  it("no-op (shadow) when oldName is also extracted in a parallel branch", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(PARALLEL);
    expect(useScenarioEditor.getState().renameVariable("s", "renamed")).toBe("shadow");
  });

  it("no-op during yamlError (edit gate) — does not corrupt state", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    s.setPendingYamlText("version: 1\nname: t\nsteps: [\n"); // 깨진 버퍼
    s.commitPendingYaml(); // yamlError 세팅
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    expect(useScenarioEditor.getState().renameVariable("token", "auth")).toBe("invalid");
  });
});
```

- [ ] **Step 8: RED 확인**

Run: `cd ui && pnpm test store.renameVariable` → FAIL (`renameVariable` 미존재).

- [ ] **Step 9: `store.ts` — `RenameVarError` type + interface + 액션 구현**

import 확장(13행 근처 — scanVars 헬퍼):
```ts
import {
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
} from "./scanVars";
```

`RenameVarError` export(파일 상단, interface 위):
```ts
export type RenameVarError = "self" | "invalid" | "shadow" | "collision";
```

interface `ScenarioEditorState`에 시그니처 추가(`removeVariable` 근처):
```ts
  /** flat 변수(선언·비-parallel extract) rename. 선언 키 + 모든 extract.var + 모든
   *  {{old}} 참조(cast 보존) + 조건 오퍼랜드를 트랜잭셔널로 재작성. 실패 시 no-op +
   *  에러코드 반환(null=성공·커밋됨). yamlError·shadow·충돌·불법 newName에서 no-op. */
  renameVariable(oldName: string, newName: string): RenameVarError | null;
```

액션 구현(`removeVariable` 액션 근처, `reparentStep` 트랜잭셔널 패턴 미러):
```ts
  renameVariable(oldName, newName) {
    const doc = get().doc;
    const model = get().model;
    if (!doc || !model) return "invalid";
    if (get().yamlError !== null) return "invalid"; // 편집 게이트(R7) — 깨진 버퍼 중 무변이
    if (newName === oldName) return "self";
    if (!/^[^\s{}:]+$/.test(newName)) return "invalid";
    if (parallelExtractNames(model).has(oldName)) return "shadow"; // 슬라이스 B
    const collisions = new Set<string>([
      ...collectProducedVars(model),
      ...collectNamespacedProducers(model),
      ...buildVarRefIndex(model).keys(),
    ]);
    if (collisions.has(newName)) return "collision";
    // 트랜잭셔널(reparentStep 선례): clone → apply → reparse → 성공 시에만 커밋.
    const clone = doc.clone();
    applyEdit(clone, { type: "renameVariable", oldName, newName });
    const reparsed = parseScenarioDoc(serializeDoc(clone));
    if ("error" in reparsed) return "invalid"; // 합법성 게이트 — 원본 doc 무오염
    set({
      doc: reparsed.doc,
      model: reparsed.model,
      yamlText: serializeDoc(reparsed.doc),
      yamlError: null,
    });
    return null;
  },
```

- [ ] **Step 10: `store.ts` — `actions` shim에 `renameVariable` 등록 (CRITICAL)**

`actions` 객체(360–399행)에 추가 — 안 하면 `getInitialState()`가 이 액션을 빠뜨려 테스트 reset 후 `renameVariable`이 사라진다:
```ts
    renameVariable: s.renameVariable,
```

- [ ] **Step 11: GREEN 확인**

Run: `cd ui && pnpm test store.renameVariable store.test` → PASS(신규 + 기존 store 무회귀).

- [ ] **Step 12: 커밋 (게이트 통과)**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.rename.test.ts \
        ui/src/scenario/store.ts ui/src/scenario/__tests__/store.renameVariable.test.ts
git commit -m "feat(editor): 변수 rename — yamlDoc 트랜잭셔널 노드 편집 + store flat/충돌/shadow 게이트"
```

---

## Task 3: VariablesPanel 통합 행 + 인라인 rename UI + nav + `ko` 문구 + `EditorShell` 배선

**충족 R:** R5, R9, R10, R11, R15

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (통합 행·rename·nav·상태 배지)
- Modify: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (4상태·affordance 게이트·rename·nav)
- Modify: `ui/src/components/scenario/EditorShell.tsx` (`onJumpToStep` prop 전달)
- Modify: `ui/src/i18n/ko.ts` (신규 키)

**Interfaces:**
- Consumes: Task 1 `scanVars` — `collectProducedVars`, `collectNamespacedProducers`, `parallelExtractNames`, `buildVarRefIndex`, `undefinedVars`. Task 2 `store` — `renameVariable(oldName, newName): RenameVarError | null`. `EditorShell.jumpToStep(id: string): void` (기존, 60–64행).
- Produces: `VariablesPanel` prop `onJumpToStep?: (id: string) => void`.

- [ ] **Step 1: 실패 테스트 — `VariablesPanel.test.tsx` 확장 (R5·R9·R10·R11)** (테스트 먼저 — tdd-guard는 `ui/src` 편집 전 pending test를 요구; `ko.editor.*` 미해결 RED 무방, Write/Edit는 타입체크 안 함)

기존 파일에 `onJumpToStep` mock 렌더 + 4상태 fixture 케이스를 추가한다. store reset(`getInitialState`) + `loadFromString`은 기존 패턴을 따른다.

```ts
// 기존 import에 추가:
import { render, screen, within, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { ko } from "../../../i18n/ko";

const MIXED = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request:
      method: GET
      url: "/x?a={{token}}&b={{alpha.s}}&c={{missing}}"
      headers: {}
    extract:
      - from: body
        path: $.u
        var: flatVar
  - id: 01HX0000000000000000000050
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000051
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

describe("VariablesPanel — unified rows", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  it("renders declared / flat-extract / parallel-extract / undefined rows with gated affordances", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // 선언 token: 연필 있음(flat non-shadow)
    expect(screen.getByRole("button", { name: ko.editor.renameVariableAria("token") })).toBeInTheDocument();
    // flat-extract flatVar: 연필 있음, 값/× 없음
    expect(screen.getByRole("button", { name: ko.editor.renameVariableAria("flatVar") })).toBeInTheDocument();
    // parallel-extract alpha.s: "분기" 배지 + 연필 없음
    expect(screen.getByText("alpha.s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.renameVariableAria("alpha.s") })).toBeNull();
    // 미정의 missing: "정의안됨" + 연필 없음
    expect(screen.getByText(ko.editor.variableUndefined)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.renameVariableAria("missing") })).toBeNull();
  });

  it("nav count is a button when refs≥1 and cycles stepIds in document order; unused is not a button", () => {
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: a
    type: http
    request: { method: GET, url: "/x?a={{token}}", headers: {} }
  - id: 01HX0000000000000000000002
    name: b
    type: http
    request: { method: GET, url: "/y?b={{token}}", headers: {} }
`;
    useScenarioEditor.getState().loadFromString(scenario);
    const onJump = vi.fn();
    render(<VariablesPanel onJumpToStep={onJump} />);
    const nav = screen.getByRole("button", { name: ko.editor.variableUsageNavAria("token") });
    fireEvent.click(nav);
    fireEvent.click(nav);
    fireEvent.click(nav); // 3rd wraps
    expect(onJump).toHaveBeenNthCalledWith(1, "01HX0000000000000000000001");
    expect(onJump).toHaveBeenNthCalledWith(2, "01HX0000000000000000000002");
    expect(onJump).toHaveBeenNthCalledWith(3, "01HX0000000000000000000001"); // 순환
  });

  it("inline rename commits on Enter and shows an inline error on collision", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // rename token → collide with 'flatVar' (existing producer)
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }));
    const input = screen.getByRole("textbox", { name: ko.editor.variableRenameInputAria("token") });
    fireEvent.change(input, { target: { value: "flatVar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(ko.editor.variableRenameCollision("flatVar"))).toBeInTheDocument();
    expect(useScenarioEditor.getState().yamlText).toContain("token: seed"); // 미커밋

    // valid rename commits
    fireEvent.change(input, { target: { value: "auth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useScenarioEditor.getState().yamlText).toContain("auth: seed");
    expect(useScenarioEditor.getState().yamlText).toContain("{{auth}}");
  });

  it("disables the rename pencil while yamlError is set", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    useScenarioEditor.getState().commitPendingYaml(); // yamlError 세팅 — model은 보존됨(store.commitPendingYaml)
    render(<VariablesPanel />);
    // model 보존이라 행은 렌더되지만 rename 연필은 disabled (R9 편집 게이트)
    expect(screen.getByRole("button", { name: ko.editor.renameVariableAria("token") })).toBeDisabled();
  });
});
```

> 참고(ui/CLAUDE.md): `title`+텍스트를 동시에 가진 버튼의 accessible name은 텍스트가 이긴다. 연필 버튼은 텍스트 없이 `aria-label`만 두면 `renameVariableAria`로 정확매치된다. "분기" 배지는 `title`(=`variableBranchTitle`)+텍스트(`variableBranch`).

- [ ] **Step 2: `ko.ts` — 신규 문구 키 추가 (R15)**

`ko.editor` 카탈로그(454행 근처, 기존 `variableUsage`/`variableUnused` 곁)에 추가(테스트가 이미 pending이라 tdd-guard 통과):
```ts
    variableExtracted: "추출됨",
    variableBranch: "분기",
    variableBranchTitle: "분기 변수는 이름 바꾸기를 지원하지 않습니다",
    variableUndefined: "정의안됨",
    variableUndefinedAria: (name: string) => `${name} — 정의되지 않은 변수`,
    renameVariableAria: (name: string) => `${name} 이름 바꾸기`,
    variableRenameInputAria: (name: string) => `${name} 새 이름`,
    variableRenameCollision: (name: string) => `이미 존재하는 이름입니다: ${name}`,
    variableRenameInvalid: "변수 이름에 공백·{ } : 문자를 쓸 수 없습니다",
    variableUsageNavAria: (name: string) => `${name}을(를) 사용하는 스텝으로 이동`,
```

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test VariablesPanel` → FAIL (통합 행·rename·nav 미구현; `onJumpToStep` prop 미존재).

- [ ] **Step 4: `VariablesPanel.tsx` — 통합 행·rename·nav 재구성**

전체 컴포넌트를 아래로 교체(모듈 상수 `EMPTY_VARS` 유지, 셀렉터 안 인라인 스캔 금지·`useMemo([model])`):

```tsx
import { useMemo, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Input } from "../ui/Input";
import {
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVars,
} from "../../scenario/scanVars";

// 셀렉터 fallback은 안정 참조여야 한다(getSnapshot 함정, ui/CLAUDE.md).
const EMPTY_VARS: Record<string, string> = {};

type VarRow =
  | { kind: "declared"; name: string; value: string; renamable: boolean; refIds: string[] }
  | { kind: "flat-extract"; name: string; refIds: string[] }
  | { kind: "parallel-extract"; display: string; refIds: string[] }
  | { kind: "undefined"; name: string; refIds: string[] };

export function VariablesPanel({ onJumpToStep }: { onJumpToStep?: (id: string) => void }) {
  const model = useScenarioEditor((s) => s.model);
  const variables = useScenarioEditor((s) => s.model?.variables ?? EMPTY_VARS);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);
  const renameVariable = useScenarioEditor((s) => s.renameVariable);

  const [newKey, setNewKey] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // rename 중인 declared/flat 이름
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // nav 순환 인덱스(로컬·identity별) — 사이드이펙트라 ref(리렌더 불요).
  const cycleRef = useRef<Map<string, number>>(new Map());

  const rows = useMemo<VarRow[]>(() => {
    if (!model) return [];
    const declaredKeys = new Set(Object.keys(model.variables));
    const produced = collectProducedVars(model);
    const namespaced = collectNamespacedProducers(model);
    const parallelNames = parallelExtractNames(model);
    const refIndex = buildVarRefIndex(model);
    const undef = undefinedVars(model);
    const out: VarRow[] = [];
    // 선언(연필은 flat non-shadow일 때만)
    for (const [name, value] of Object.entries(model.variables))
      out.push({ kind: "declared", name, value, renamable: !parallelNames.has(name), refIds: refIndex.get(name) ?? [] });
    // flat-extract = produced − 선언 − parallel(shadow) — 비-parallel 스텝에서만 추출된 이름
    for (const name of produced)
      if (!declaredKeys.has(name) && !parallelNames.has(name))
        out.push({ kind: "flat-extract", name, refIds: refIndex.get(name) ?? [] });
    // parallel-extract(namespaced identity로 표시)
    for (const display of namespaced)
      out.push({ kind: "parallel-extract", display, refIds: refIndex.get(display) ?? [] });
    // 미정의
    for (const name of undef) out.push({ kind: "undefined", name, refIds: refIndex.get(name) ?? [] });
    return out;
  }, [model]);

  const startRename = (name: string) => {
    setEditing(name);
    setDraft(name);
    setRenameError(null);
  };
  const cancelRename = () => {
    setEditing(null);
    setRenameError(null);
  };
  const commitRename = (oldName: string) => {
    const nn = draft.trim();
    if (nn === "" || nn === oldName) return cancelRename(); // 변경 없음
    const err = renameVariable(oldName, nn); // store가 검증 단일소스 — 실패 시 no-op + 코드
    if (err === "collision") return setRenameError(ko.editor.variableRenameCollision(nn));
    if (err !== null) return setRenameError(ko.editor.variableRenameInvalid);
    cancelRename();
  };

  const nav = (id: string, refIds: string[]) => {
    if (refIds.length === 0) return;
    const i = cycleRef.current.get(id) ?? 0;
    onJumpToStep?.(refIds[i % refIds.length]);
    cycleRef.current.set(id, i + 1);
  };

  // 사용 카운트 렌더(버튼 vs "미사용")
  const usageCell = (id: string, refIds: string[]) =>
    refIds.length === 0 ? (
      <span className="text-xs text-slate-400">{ko.editor.variableUnused}</span>
    ) : (
      <button
        type="button"
        aria-label={ko.editor.variableUsageNavAria(id)}
        onClick={() => nav(id, refIds)}
        className="text-xs text-accent-600 hover:underline"
      >
        {ko.editor.variableUsage(refIds.length)}
      </button>
    );

  // rename 어퍼던스(연필 or 인라인 draft input) — declared/flat 공통
  const nameCell = (name: string) =>
    editing === name ? (
      <div className="flex-1 min-w-0">
        <Input
          size="sm"
          autoFocus
          aria-label={ko.editor.variableRenameInputAria(name)}
          className="min-w-0 font-mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitRename(name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(name);
            else if (e.key === "Escape") cancelRename();
          }}
        />
        {renameError && <p className="mt-0.5 text-xs text-red-600">{renameError}</p>}
      </div>
    ) : (
      <>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={name}>
          {name}
        </span>
        <button
          type="button"
          aria-label={ko.editor.renameVariableAria(name)}
          disabled={yamlError !== null}
          onClick={() => startRename(name)}
          className="shrink-0 text-slate-400 hover:text-accent-600 text-xs disabled:opacity-40"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </>
    );

  return (
    <section aria-label={ko.editor.variablesTitle} className="flex flex-col gap-3">
      <div className="flex items-center">
        <h3 className="text-sm font-semibold text-slate-700">{ko.editor.variablesTitle}</h3>
        <VarCheatSheet />
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          if (row.kind === "declared") {
            return (
              <li key={`d:${row.name}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  {row.renamable ? (
                    nameCell(row.name)
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={row.name}>
                      {row.name}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVariable(row.name)}
                    aria-label={ko.editor.removeVariableAria(row.name)}
                    className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                  >
                    ×
                  </button>
                </div>
                <AutoGrowTextarea
                  aria-label={ko.editor.variableValueAria(row.name)}
                  className="font-mono"
                  value={row.value}
                  onChange={(e) => setVariable(row.name, e.target.value)}
                />
                {usageCell(row.name, row.refIds)}
              </li>
            );
          }
          if (row.kind === "flat-extract") {
            return (
              <li key={`f:${row.name}`} className="flex items-center gap-2">
                {nameCell(row.name)}
                <span className="shrink-0 text-xs text-slate-400">{ko.editor.variableExtracted}</span>
                {usageCell(row.name, row.refIds)}
              </li>
            );
          }
          if (row.kind === "parallel-extract") {
            return (
              <li key={`p:${row.display}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={row.display}>
                  {row.display}
                </span>
                <span
                  className="shrink-0 rounded bg-slate-100 px-1.5 text-xs text-slate-500"
                  title={ko.editor.variableBranchTitle}
                >
                  {ko.editor.variableBranch}
                </span>
                {usageCell(row.display, row.refIds)}
              </li>
            );
          }
          // undefined
          return (
            <li key={`u:${row.name}`} className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                title={ko.editor.variableUndefinedAria(row.name)}
              >
                {row.name}
              </span>
              <span className="shrink-0 text-xs text-amber-600">
                <span aria-hidden="true">⚠ </span>
                {ko.editor.variableUndefined}
              </span>
              {usageCell(row.name, row.refIds)}
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.variablesEmpty}</li>
        )}
      </ul>

      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Input
            className="min-w-0 font-mono"
            placeholder="new_var"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
          }}
          disabled={newKey.trim().length === 0}
          className="shrink-0 px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          {ko.editor.variablesAdd}
        </button>
      </div>
    </section>
  );
}
```

> 함정(ui/CLAUDE.md): `Input`은 부모 `text-xs` 밀도 상속 트랩 대상 — rename draft input은 `size="sm"`으로 12px 유지(주변 행이 text-xs). nav 링크 색은 `accent-600`(button-accent 토큰). "미사용"/"정의안됨"은 데이터가 아니라 상태 라벨이라 accent 아님(slate/amber).

- [ ] **Step 5: `EditorShell.tsx` — `onJumpToStep` 전달 (R10)**

113행 `<VariablesPanel />`를 교체:
```tsx
            <VariablesPanel onJumpToStep={jumpToStep} />
```

- [ ] **Step 6: GREEN 확인 (VariablesPanel + EditorShell + FlowOutline 무회귀)**

Run: `cd ui && pnpm test VariablesPanel EditorShell FlowOutline` → PASS. R11: FlowOutline 테스트 무수정 green + diff에 `FlowOutline.tsx` 배지 없음(`git diff --stat`으로 FlowOutline 미변경 확인).

- [ ] **Step 7: 커밋 (게이트 통과)**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/scenario/VariablesPanel.tsx \
        ui/src/components/scenario/__tests__/VariablesPanel.test.tsx \
        ui/src/components/scenario/EditorShell.tsx ui/src/i18n/ko.ts
git commit -m "feat(editor): VariablesPanel 4상태 행 — 미정의 경고·사용→스텝 nav·flat rename UI"
```

---

## Task 4: roadmap 등재 + 한글 하드코딩 sweep + Playwright 시각 실측

**충족 R:** R16, R15(sweep), §6(라이브)

**Files:**
- Modify: `docs/roadmap.md` (연기 항목 등재 — Python 스플라이스)

- [ ] **Step 1: `docs/roadmap.md` — §7 연기 항목 등재 (R16)**

`docs/roadmap.md`의 §B(에디터/변수 도구 관련 섹션)에 아래 불릿을 **Python 스플라이스**로 삽입한다(루트 CLAUDE.md 규칙 — 초장문 라인 Edit 정확매치 취약, 작은 unique 앵커 `s.index()`+`assert count==1`로 splice). 삽입 문구:
```
  - 에디터 변수 도구 B(parallel-분기 변수 rename): scope-aware — 분기 서브트리 bare {{var}} + 다운스트림 {{branch.var}} 재작성, 패널 (branch,var) identity로 rename 활성화(슬라이스 A는 분기/shadow 행 rename 비활성+배지).
  - 변수 도구 후속: parallel-row 내부-분기 bare nav 보강((branch,var) identity 통합; shadow flat-extract+parallel[같은 이름이 flat 스텝·분기 양쪽서 추출]은 슬라이스 A에서 namespaced 행만 뜨고 flat identity 행이 없어 bare 참조가 non-navigable — 같은 통합으로 해소)·bulk 변수 편집(BulkEditPanel+kvBulk 확장)·FlowOutline 스텝-레벨 미정의 배지·producer 스텝으로의 nav·merge/오타-재연결 rename(충돌 차단 정책과 상충).
```
확인: `grep -n "에디터 변수 도구 B" docs/roadmap.md` → 1건.

- [ ] **Step 2: 커밋 (docs-only fast-path)**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): 에디터 변수 도구 B·후속 연기 항목 등재"
```

- [ ] **Step 3: 한글/영어 하드코딩 sweep (R15) — orchestrator 직접 재실행**

이 슬라이스가 만진 파일에 인라인 문구가 없음을 확인한다(ui/CLAUDE.md — `'"[가-힣]'`는 따옴표 직후 비-한글 리터럴을 놓치니 `[^"]*` 형 + ternary-attr sweep 둘 다). subagent self-report 불신 — orchestrator가 손수 돌린다:
```bash
cd ui/src
# ① 인라인 한글 문구(따옴표/백틱 안 어디든 — ui/CLAUDE.md 권장 robust형, `"[가-힣]` 아님)
grep -rnE '"[^"]*[가-힣]|`[^`]*[가-힣]' components/scenario/VariablesPanel.tsx components/DataBindingPanel.tsx || echo "clean-1"
# ② 삼항/보간 속성 영어 라벨(따옴표 직후가 식별자라 ①이 못 잡는 패턴)
grep -rnE '(aria-label|title|placeholder)=\{[^}]*"[A-Za-z]' components/scenario/VariablesPanel.tsx || echo "clean-2"
```
기대: VariablesPanel의 모든 사용자 노출 문구가 `ko.editor.*` 경유(리터럴 0). 잔존이 보이면 fix 후 재확인.

- [ ] **Step 4: Playwright 시각 실측 (§6, [[implementation-rigor-over-spec]] — DOM-존재만으론 PASS 금지)**

`/live-verify`는 백엔드 스택 **불필요**(순수 에디터-타임 정적 분석 — run/report/엔진 무접촉). 대신 `/scenarios/new`(클라이언트-only) vite dev로 실 UI를 띄워 4가지를 실측한다. Monaco `setValue` 불가·멀티라인 fill auto-indent 오염(ui/CLAUDE.md) — 시나리오는 **실 UI로 구성**(변수 패널 `추가`·스텝 디테일 `URL` 필드 fill으로 `{{token}}` 참조 주입).

```bash
# vite dev (IPv6 [::1]만 바인드 — Playwright는 localhost로 navigate)
cd ui && pnpm dev   # 5173 (다른 워크트리 5173 선점 확인: lsof -i :5173)
```

실측 항목(각 DOM-존재가 아닌 관측으로 판정):
1. **rename**: 변수 `token` 추가 → 스텝 URL에 `/x?a={{token}}` 입력 → 변수 패널 연필 클릭 → `auth` 입력 → Enter → YAML 모달(`</>` 열기)에서 `auth: ` 선언 + `{{auth}}` 참조 반영 실측(`token` 흔적 0).
2. **미정의 경고**: URL에 `{{typo}}` 입력(producer 없음) → 패널에 `typo` 행이 ⚠ "정의안됨"으로 렌더.
3. **parallel namespaced**: parallel 스텝 + 분기 `alpha`에서 `s` 추출 → 다운스트림 http에 `{{alpha.s}}`(유효)·`{{beta.s}}`(당글링) → 유효는 "분기" 배지·미경고, 당글링은 ⚠ 정의안됨.
4. **사용 카운트 nav**: 두 스텝이 `{{token}}` 참조 → 패널 카운트 버튼(`2개 스텝에서 사용`) 클릭 → 첫 스텝 선택(아웃라인 강조), 재클릭 → 둘째 스텝, 3회째 순환.

관찰 근거: rename은 YAML 모달 텍스트(실 반영), 경고/배지는 패널 DOM 텍스트, nav는 선택 상태 변화(`[data-step-id]`/아웃라인 `aria-selected`/강조)로 판정. 스크린샷은 allowed-root(`.playwright-mcp`) 절대경로 저장(Playwright MCP cwd 함정, docs/dev/live-verify-playwright.md).

- [ ] **Step 5: 전체 게이트 최종 1회 + build-log 준비**

Run: `cd ui && pnpm lint && pnpm test && pnpm build` (전체 — targeted green ≠ full green, S-D). 이후 finish-slice에서 build-log/roadmap-status/CLAUDE 상태줄/메모리 기록.

---

## Self-Review

**1. Spec coverage** (R1–R16 → task):
- R1 splitFlowToken cast 정규화 → T1(flowToken + collectFromString). R2 collectProducedVars → T1. R3 collectNamespacedProducers/buildVarRefIndex → T1. R4 undefinedVars → T1. R5 4상태 행 → T3. R6 yamlDoc renameVariable (a)–(d) → T2. R7 트랜잭셔널+yamlError 게이트 → T2(store, reparentStep 미러). R8 flat/충돌/shadow/불법 no-op → T2(store 반환코드). R9 인라인 rename 어퍼던스 게이트 → T3. R10 nav 순환 → T3 + EditorShell. R11 패널-only(FlowOutline 무변경) → T3(Step 6 확인). R12 DataBindingPanel produced-set → T1. R13 기존 소비처 무회귀 → T1(Step 9). R14 0-diff 불변식 → Global Constraints + 각 task diff 스코프. R15 ko + sweep → T3(ko) + T4(sweep). R16 roadmap 등재 → T4.
- 갭 없음.

**2. Placeholder scan**: 모든 step에 실 코드/명령/기대출력. "적절한 에러처리" 류 없음.

**3. Type consistency**: `splitFlowToken`·`collectProducedVars`·`collectNamespacedProducers`·`parallelExtractNames`·`buildVarRefIndex`·`undefinedVars`(T1) ↔ 소비처(T2 store, T3 panel) 시그니처 일치. `renameVariable(oldName,newName): RenameVarError|null`(T2 정의) ↔ T3 panel `commitRename` 소비 일치. Edit `{type:"renameVariable",oldName,newName}`(T2 union) ↔ store `applyEdit(clone, {...})` 일치. `onJumpToStep?`(T3 prop) ↔ EditorShell `jumpToStep` 전달 일치.

**설계 결정 노트 (리뷰어용)**:
- **cast.ts export**: spec §4.1 "flowToken.test.ts가 keyword-일치 동치 단언"은 `trailingCast`/`CAST_KEYWORDS` import를 전제 → `cast.ts`에 `export` 키워드만 추가(정규식/검증/본문 byte-identical). flowToken.ts는 자체 목록으로 "순수·무의존" 유지, 테스트가 두 목록의 동치를 by-construction(동일 정규식) + battery로 가드.
- **store.renameVariable 반환코드**: spec §4.3은 void + §4.4 panel "동일 검증 선-실행"을 명시했으나, 검증을 store 반환코드(`RenameVarError|null`) 단일소스로 통합해 panel이 delegate → **검증 로직 중복 0**(드리프트 불가). 관측 동작(실패 시 무변이 + 인라인 에러) 동일. 신규 액션이라 R14 시그니처-무변경과 무충돌.
