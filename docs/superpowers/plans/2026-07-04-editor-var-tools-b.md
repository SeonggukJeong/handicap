# 에디터 변수 도구 B — parallel-분기 변수 rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VariablesPanel의 parallel-분기 extract 변수를 `(branch,var)` identity로 승격해, 분기 서브트리 bare `{{var}}`와 다운스트림 `{{branch.var}}`를 branch-스코프로 정확히 재작성하는 scope-aware rename을 추가한다.

**Architecture:** 슬라이스 A(`2026-07-04-editor-var-tools-design.md`) 토대 위 UI-only 확장. (1) `scanVars.ts`에 순수 분석 3함수 추가, (2) `yamlDoc.ts`에 branch-스코프 트랜잭셔널 `renameParallelVar` Edit variant 추가, (3) `store.ts`에 검증+트랜잭셔널 액션 추가(슬라이스 A `renameVariable` 미러), (4) `VariablesPanel.tsx`가 판별(discriminated) editing state로 parallel 행 rename·enriched nav를 배선. 엔진/proto/migration/`model.ts`/YAML 직렬화 형식 0-diff.

**Tech Stack:** TypeScript, React, Zustand, `yaml` 패키지 Document API, Zod, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-04-editor-var-tools-b-design.md` (R1–R14, clean-APPROVED). R-row acceptance가 진실의 원천.

<!-- REVIEW-GATE: APPROVED -->

## Global Constraints

- **UI-only 0-diff (R12)**: `crates`/proto/migration/`model.ts`(Zod 스키마)/YAML 직렬화 **형식** 무접촉. `ui/src` 안에서만. 슬라이스 A 기존 store 액션 시그니처·`scanVars` 기존 export 무변경(추가만). ADR 신규 없음.
- **ko 카탈로그 (R11, ADR-0035)**: 사용자 노출 문구(배지 title·에러) 전부 `ui/src/i18n/ko.ts` 경유. 인라인 한글/영어 0. aria-label도 대상.
- **TDD 순서 (ui/CLAUDE.md tdd-guard)**: 각 task에서 **테스트 파일을 먼저** 편집(pending RED diff 생성)한 뒤 src 편집 — tdd-guard가 watched `ui/src/**` non-test 편집 전 pending test-path 파일을 요구. import 미해결로 RED여도 무방.
- **최종 게이트**: 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` (lint=`--max-warnings=0`; `pnpm build`=`tsc -b`가 nested-default 누출·discriminated-union narrowing을 잡음, `pnpm test`(esbuild)만으론 부족).
- **단일 파일 vitest**: `pnpm test <name>`(‎`--` 붙이지 말 것 — 전체 스위트 돎). 머지 전 인자 없는 전체 `pnpm test` 1회.
- **회귀 (R13)**: 기존 `scanVars`/`store.renameVariable`/`yamlDoc.rename`/`dataBinding`/`insertTemplate` 테스트 **무수정 green**. **예외: `VariablesPanel.test.tsx`는 T4에서 수정** — 기존 MIXED fixture의 `alpha.s`가 non-shadow(‎`s`가 선언/비-parallel extract가 아님)라 slice-A "parallel=연필 없음·`alpha.s` 단일 텍스트" 단언이 새 동작(연필+분리 표시)으로 갱신 대상(M3).
- **셀렉터 함정 (ui/CLAUDE.md)**: 셀렉터 안 인라인 `?? {}`/`?? []` 금지 — 파생은 `useMemo([model])` 안에서, `model===null`이면 `[]`.

---

## Task 1: 분석 레이어 (`scanVars.ts` 신규 3함수)

**Files:**
- Modify: `ui/src/scenario/scanVars.ts` (append exports; 기존 export/헬퍼 무변경)
- Test: `ui/src/scenario/__tests__/scanVars.test.ts` (append cases)

**Interfaces:**
- Consumes: 기존 `scanVars.ts` 내부 헬퍼 `collectFromString`/`collectFromJson`(module-private) + import된 `flattenHttpSteps`, `buildVarRefIndex`(같은 파일 export).
- Produces:
  - `flatProducerNames(scenario: Scenario): Set<string>` — 선언 키 ∪ **parallel 분기 밖** http extract var.
  - `collectBranchInternalRefs(scenario: Scenario): Map<string, string[]>` — key `${branchName}.${base}`, value 문서순 stepId(분기 내부 모든 참조 base).
  - `interface ParallelVarIdentity { branchName: string; varName: string; display: string; isShadow: boolean; branchRefIds: string[]; namespacedRefIds: string[] }`
  - `parallelVarIdentities(scenario: Scenario): ParallelVarIdentity[]`

- [ ] **Step 1: Write failing tests** (append to `ui/src/scenario/__tests__/scanVars.test.ts`)

기존 파일 상단 import에 신규 심볼 추가(같은 `from "../scanVars"` 구문에 병합):

```ts
import {
  flatProducerNames,
  collectBranchInternalRefs,
  parallelVarIdentities,
} from "../scanVars";
```

파일 하단에 append(헬퍼 `parse`는 기존 테스트에 있는 것을 재사용 — 없으면 아래 로컬 헬퍼 추가):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test scanVars`
Expected: FAIL — `flatProducerNames`/`collectBranchInternalRefs`/`parallelVarIdentities` is not a function / undefined.

- [ ] **Step 3: Implement the three functions** (append to `ui/src/scenario/scanVars.ts`, after `undefinedVars`)

`Step` 타입은 파일 상단 `import { flattenHttpSteps, type Scenario, type Step, type Condition } from "./model";`에 이미 있음. 신규:

```ts
/** 선언 키 ∪ parallel 분기 **밖** http extract var (R2). parallel branches는 미하강 —
 *  분기 extract는 flat이 아니라 `{{branch.var}}`로 네임스페이스되기 때문. shadow 판정용. */
export function flatProducerNames(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(scenario.variables)) out.add(k);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test scanVars`
Expected: PASS (new + all existing scanVars cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "feat(editor): scanVars parallel-var identity analysis (flatProducerNames·collectBranchInternalRefs·parallelVarIdentities)"
```

---

## Task 2: `renameParallelVar` yamlDoc Edit variant

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (add Edit variant + applyEdit case; reuse `renameExtractVars`/`escapeRegExp`/`CAST_KEYWORDS`/`visit`)
- Test: `ui/src/scenario/__tests__/yamlDoc.renameParallel.test.ts` (new)

**Interfaces:**
- Consumes: `applyEdit(doc, edit)`, `parseDocument`, existing local `renameExtractVars`, `escapeRegExp`, imported `CAST_KEYWORDS`, `visit`, `isMap`, `isSeq`.
- Produces: `Edit` union gains `{ type: "renameParallelVar"; branchName: string; oldName: string; newName: string }`; `applyEdit` handles it (mutates doc in place — caller clones for transactionality).

- [ ] **Step 1: Write failing tests** (`ui/src/scenario/__tests__/yamlDoc.renameParallel.test.ts`, new file)

```ts
import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { applyEdit } from "../yamlDoc";

function apply(yaml: string, branchName: string, oldName: string, newName: string): string {
  const doc = parseDocument(yaml);
  applyEdit(doc, { type: "renameParallelVar", branchName, oldName, newName });
  return String(doc);
}

const BASE = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: prod
            request: { method: GET, url: "/p" }
            extract: [ { var: s, from: status } ]
          - id: "01HX0000000000000000000030"
            type: http
            name: use
            request:
              method: GET
              url: "/u?x={{s}}&keep={{other}}"
              headers: { Authorization: "Bearer {{s:str}}" }
      - name: C
        steps:
          - id: "01HX0000000000000000000040"
            type: http
            name: cprod
            request: { method: GET, url: "/c?x={{s}}" }
            extract: [ { var: s, from: status } ]
  - id: "01HX0000000000000000000050"
    type: http
    name: down
    request: { method: GET, url: "/d?y={{B.s}}&z={{C.s}}" }
`;

describe("renameParallelVar (R5)", () => {
  it("(a) renames extract var only in matching branch, not branch C", () => {
    const out = apply(BASE, "B", "s", "s2");
    // branch B's extract renamed
    expect(out).toContain("var: s2");
    // branch C's extract var untouched. NOTE: extracts are flow-style (`[ { var: s, from: status } ]`)
    // and the `yaml` package preserves flow style on round-trip → serialized as `var: s, from: status`
    // (NOT `var: s\n`). Assert the flow form.
    const cBlock = out.slice(out.indexOf("name: C"));
    expect(cBlock).toContain("var: s,");
    expect(cBlock).not.toContain("var: s2");
  });

  it("(b) rewrites branch-internal bare {{s}} (with cast) but not {{other}} or branch-B-external bare", () => {
    const out = apply(BASE, "B", "s", "s2");
    expect(out).toContain("/u?x={{s2}}&keep={{other}}"); // {{s}}→{{s2}}, {{other}} preserved
    expect(out).toContain('Bearer {{s2:str}}'); // cast preserved
    // branch C's internal bare {{s}} NOT rewritten (different branch identity)
    expect(out).toContain("/c?x={{s}}");
  });

  it("(c) rewrites downstream {{B.s}} but not {{C.s}}", () => {
    const out = apply(BASE, "B", "s", "s2");
    expect(out).toContain("{{B.s2}}");
    expect(out).toContain("{{C.s}}"); // different branch namespace untouched
  });

  it("multi-node same-name branch: both nodes' extract + internal bare rewritten (F2)", () => {
    const twoNode = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000060"
    type: parallel
    name: n1
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000070", type: http, name: a, request: { method: GET, url: "/a?x={{s}}" }, extract: [ { var: s, from: status } ] } ]
  - id: "01HX0000000000000000000080"
    type: parallel
    name: n2
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000090", type: http, name: b, request: { method: GET, url: "/b?x={{s}}" }, extract: [ { var: s, from: status } ] } ]
`;
    const out = apply(twoNode, "B", "s", "s2");
    expect(out).toContain("/a?x={{s2}}");
    expect(out).toContain("/b?x={{s2}}");
    expect((out.match(/var: s2/g) ?? []).length).toBe(2); // both branches' extract renamed
    expect(out).not.toContain("var: s,"); // no un-renamed extract remains (flow-style; both nodes hit)
  });

  it("namespaced exact-match: {{B.sX}}/{{B.s.z}} not matched", () => {
    const tricky = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000A0"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX00000000000000000000B0", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status } ] } ]
  - id: "01HX00000000000000000000C0"
    type: http
    name: d
    request: { method: GET, url: "/d?a={{B.sX}}&b={{B.s.z}}&c={{B.s}}" }
`;
    const out = apply(tricky, "B", "s", "s2");
    expect(out).toContain("{{B.sX}}"); // longer name — not matched
    expect(out).toContain("{{B.s.z}}"); // dotted suffix — not matched
    expect(out).toContain("{{B.s2}}"); // exact — matched
  });

  it("preserves quote style and does not touch map keys", () => {
    const withKeys = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000D0"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX00000000000000000000E0"
            type: http
            name: a
            request:
              method: POST
              url: "/a"
              headers: { s: "literal-key" }
            extract: [ { var: s, from: status } ]
`;
    const out = apply(withKeys, "B", "s", "s2");
    expect(out).toContain("s: \"literal-key\""); // header KEY 's' not renamed
    expect(out).toContain("var: s2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test yamlDoc.renameParallel`
Expected: FAIL — applyEdit has no `renameParallelVar` case (TS union error / no-op).

- [ ] **Step 3: Add the Edit variant + applyEdit case**

In `ui/src/scenario/yamlDoc.ts`, add to the `Edit` union (after the `renameVariable` line ~82):

```ts
  | { type: "renameParallelVar"; branchName: string; oldName: string; newName: string }
```

In `applyEdit`'s switch (place the new case right after the `case "renameVariable": { ... }` block, before `case "insertSteps"`):

```ts
    case "renameParallelVar": {
      const { branchName, oldName, newName } = edit;
      const castAlt = CAST_KEYWORDS.join("|");
      // (b) 분기 내부 bare — 슬라이스 A와 대칭 lookahead(splitFlowToken base 정확일치).
      const bareRe = new RegExp(
        `\\{\\{(\\s*)${escapeRegExp(oldName)}(?=\\s*\\}\\}|\\s*:\\s*(?:${castAlt})\\s*\\}\\})`,
        "g",
      );
      // (a)+(b): 이름이 branchName인 모든 top-level parallel branch(여러 노드 포함).
      const steps = doc.getIn(["steps"]);
      if (isSeq(steps)) {
        for (const node of steps.items) {
          if (!isMap(node)) continue;
          const branches = node.get("branches");
          if (!isSeq(branches)) continue;
          for (const br of branches.items) {
            if (!isMap(br)) continue;
            if (br.get("name") !== branchName) continue;
            const brSteps = br.get("steps");
            if (!isSeq(brSteps)) continue;
            // (a) 구조적 extract var — branch-스코프.
            renameExtractVars(brSteps, oldName, newName);
            // (b) 분기 내부 bare {{oldName}} base만 재작성(map 키 미오염).
            visit(brSteps, {
              Scalar(key, n) {
                if (key === "key") return;
                if (typeof n.value !== "string") return;
                const next = n.value.replace(bareRe, (_m, ws: string) => `{{${ws}${newName}`);
                if (next !== n.value) n.value = next;
              },
            });
          }
        }
      }
      // (c) 다운스트림 {{branchName.oldName}} → {{branchName.newName}}, 전-doc, base 정확일치.
      const nsRe = new RegExp(
        `\\{\\{(\\s*)${escapeRegExp(branchName)}\\.${escapeRegExp(oldName)}(?=\\s*\\}\\}|\\s*:\\s*(?:${castAlt})\\s*\\}\\})`,
        "g",
      );
      visit(doc, {
        Scalar(key, n) {
          if (key === "key") return;
          if (typeof n.value !== "string") return;
          const next = n.value.replace(nsRe, (_m, ws: string) => `{{${ws}${branchName}.${newName}`);
          if (next !== n.value) n.value = next;
        },
      });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test yamlDoc.renameParallel`
Expected: PASS. Also run `pnpm test yamlDoc` to confirm existing `yamlDoc.rename` (slice A) untouched green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.renameParallel.test.ts
git commit -m "feat(editor): yamlDoc renameParallelVar edit — branch-scoped extract·bare·downstream namespaced rewrite"
```

---

## Task 3: `renameParallelVar` store action (검증 + 트랜잭셔널)

**Files:**
- Modify: `ui/src/scenario/store.ts` (add to `ScenarioEditorState` + implement; import 2 new scanVars fns)
- Test: `ui/src/scenario/__tests__/store.renameParallelVar.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `flatProducerNames`, `collectBranchInternalRefs`; existing `collectNamespacedProducers`, `buildVarRefIndex`; Task 2 Edit variant; existing `applyEdit`/`parseScenarioDoc`/`serializeDoc`; existing `RenameVarError` type.
- Produces: `renameParallelVar(branchName: string, oldName: string, newName: string): RenameVarError | null` on the store.

- [ ] **Step 1: Write failing tests** (`ui/src/scenario/__tests__/store.renameParallelVar.test.ts`, new)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const SC = `version: 1
name: "t"
variables: { flatVar: "x" }
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: prod
            request: { method: GET, url: "/p?x={{s}}&d={{dangling}}" }
            extract: [ { var: s, from: status }, { var: flatVar, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: down
    request: { method: GET, url: "/d?y={{B.s}}" }
`;

function load(yaml: string) {
  useScenarioEditor.getState().loadFromString(yaml);
}

describe("store.renameParallelVar (R6/R7)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  it("happy: renames non-shadow parallel var, commits, downstream+internal rewritten", () => {
    load(SC);
    const err = useScenarioEditor.getState().renameParallelVar("B", "s", "s2");
    expect(err).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toContain("{{s2}}");
    expect(yaml).toContain("{{B.s2}}");
    expect(yaml).toContain("var: s2");
  });

  it("invalid: empty / illegal chars / self", () => {
    load(SC);
    const s = () => useScenarioEditor.getState();
    expect(s().renameParallelVar("B", "s", "")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "a b")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "a{b")).toBe("invalid");
    expect(s().renameParallelVar("B", "s", "s")).toBe("self");
  });

  it("invalid(shadow, defensive): oldName is also a flat producer", () => {
    load(SC);
    // flatVar is declared AND extracted in branch B → shadow identity
    expect(useScenarioEditor.getState().renameParallelVar("B", "flatVar", "z")).toBe("shadow");
  });

  it("collision: into-shadow (newName is a flat producer)", () => {
    load(SC);
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "flatVar")).toBe("collision");
  });

  it("collision: namespaced target already produced/referenced", () => {
    load(SC);
    // rename s→s so B.s exists; try renaming to a name whose namespaced form is referenced downstream.
    // {{B.s}} already referenced; renaming a *different* var into "s" collides via B.s.
    const two = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000050", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status }, { var: t, from: status } ] } ]
  - id: "01HX0000000000000000000060"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.s}}" }
`;
    load(two);
    // rename (B,t)→s : B.s already produced+referenced → collision
    expect(useScenarioEditor.getState().renameParallelVar("B", "t", "s")).toBe("collision");
  });

  it("collision: branch-internal dangling bare (F3/§⑤)", () => {
    load(SC);
    // branch B references bare {{dangling}} but does not extract it → rename s→dangling would merge
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "dangling")).toBe("collision");
  });

  it("yamlError: no-op returns invalid, does not mutate", () => {
    load("version: 1\nname: t\nvariables: {}\nsteps: []\n");
    // force a broken buffer
    useScenarioEditor.setState({ yamlError: "boom" });
    expect(useScenarioEditor.getState().renameParallelVar("B", "s", "s2")).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test store.renameParallelVar`
Expected: FAIL — `renameParallelVar` is not a function.

- [ ] **Step 3: Implement**

3a. Extend the scanVars import in `store.ts` (existing block at lines 14–19) to add the two new fns:

```ts
import {
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
  flatProducerNames,
  collectBranchInternalRefs,
} from "./scanVars";
```

3b. Add the method signature to `ScenarioEditorState` (right after the `renameVariable(...)` declaration ~line 50):

```ts
  /** parallel-분기 extract 변수(non-shadow) rename. 이름이 branchName인 모든 branch의
   *  extract.var + 분기 내부 bare {{old}} + 다운스트림 {{branch.old}}를 트랜잭셔널 재작성.
   *  yamlError·shadow·충돌·불법 newName·self에서 no-op + 에러코드(null=성공·커밋됨). */
  renameParallelVar(branchName: string, oldName: string, newName: string): RenameVarError | null;
```

3c. Implement the action in the store object (place right after the `renameVariable(...) { ... }` block ~line 175):

```ts
  renameParallelVar(branchName, oldName, newName) {
    const doc = get().doc;
    const model = get().model;
    if (!doc || !model) return "invalid";
    if (get().yamlError !== null) return "invalid"; // 편집 게이트(R6)
    if (newName === oldName) return "self";
    if (!/^[^\s{}:]+$/.test(newName)) return "invalid";
    const flat = flatProducerNames(model);
    if (flat.has(oldName)) return "shadow"; // 방어적 — 패널이 shadow 행 pencil 미표시
    if (flat.has(newName)) return "collision"; // into-shadow
    const display2 = `${branchName}.${newName}`;
    if (collectNamespacedProducers(model).has(display2) || buildVarRefIndex(model).has(display2))
      return "collision"; // namespaced target already produced/referenced
    if ((collectBranchInternalRefs(model).get(display2) ?? []).length > 0) return "collision"; // 분기-내부 dangling bare
    // 트랜잭셔널(reparentStep/renameVariable 선례): clone → apply → reparse → 성공 시에만 커밋.
    const clone = doc.clone();
    applyEdit(clone, { type: "renameParallelVar", branchName, oldName, newName });
    const reparsed = parseScenarioDoc(serializeDoc(clone));
    if ("error" in reparsed) return "invalid"; // 원본 doc 무오염
    set({
      doc: reparsed.doc,
      model: reparsed.model,
      yamlText: serializeDoc(reparsed.doc),
      yamlError: null,
    });
    return null;
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test store.renameParallelVar`
Expected: PASS. Also `pnpm test store` to confirm existing store tests (incl. `store.renameVariable`) untouched green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.renameParallelVar.test.ts
git commit -m "feat(editor): store renameParallelVar action — non-shadow validation + transactional commit"
```

---

## Task 4: VariablesPanel 배선 + ko + roadmap

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (discriminated editing state·parallel rename·enriched nav·shadow title)
- Modify: `ui/src/i18n/ko.ts` (add `variableBranchShadowTitle`·`variableBranchInfoTitle`; remove `variableBranchTitle`)
- Modify: `docs/roadmap.md` (§B15 defer list — R14)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1 `parallelVarIdentities` (+ `type ParallelVarIdentity`); Task 3 `renameParallelVar`; existing `renameVariable`, `useScenarioEditor`, `ko`.
- Produces: (UI only — no new exports).

**Accepted limitation (S2):** the parallel-row pencil reuses `renameVariableAria(display)`/`variableRenameInputAria(display)` (per spec §4.5 — string interpolation carries the identity). In the pathological case where a flat var is literally named `B.s` AND branch `B` extracts `s`, both pencils get the aria-label `"B.s 이름 바꾸기"`, so a page-level unscoped `getByRole("button",{name})` would be ambiguous. This is cosmetic/test-fragility only — the discriminated `EditKey` routes edit/commit **state** correctly (the actual F1 correctness bug is fixed), and no test constructs this scenario. Use `within(...)`/scoped queries if a future test needs both rows.

- [ ] **Step 1: Write failing tests** (extend `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`)

Add cases (reuse the file's existing render harness / store-load helpers — mirror slice A's parallel-row tests). Fixtures build a parallel node with a non-shadow extract `fresh` (renamable) and a shadow extract that collides with a declared var.

```ts
// non-shadow parallel row: pencil present, rename commits via renameParallelVar
it("non-shadow parallel row shows rename pencil and commits (R8)", async () => {
  const user = userEvent.setup();
  loadScenario(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: a
            request: { method: GET, url: "/a?x={{fresh}}" }
            extract: [ { var: fresh, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.fresh}}" }
`);
  render(<VariablesPanel />);
  // pencil aria uses display "B.fresh"
  await user.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("B.fresh") }));
  const input = screen.getByRole("textbox", { name: ko.editor.variableRenameInputAria("B.fresh") });
  await user.clear(input);
  await user.type(input, "renamed{Enter}");
  const yaml = useScenarioEditor.getState().yamlText;
  expect(yaml).toContain("{{renamed}}");
  expect(yaml).toContain("{{B.renamed}}");
});

// shadow parallel row: NO pencil, shadow title
it("shadow parallel row has no rename pencil and shows shadow title (R9)", () => {
  loadScenario(`version: 1
name: "t"
variables: { s: "x" }
steps:
  - id: "01HX0000000000000000000040"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000050", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status } ] } ]
`);
  render(<VariablesPanel />);
  expect(screen.queryByRole("button", { name: ko.editor.renameVariableAria("B.s") })).toBeNull();
  expect(screen.getByTitle(ko.editor.variableBranchShadowTitle)).toBeInTheDocument();
});

// collision inline error
it("parallel rename collision shows inline error, no commit (R8)", async () => {
  const user = userEvent.setup();
  loadScenario(`version: 1
name: "t"
variables: { taken: "x" }
steps:
  - id: "01HX0000000000000000000060"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000070", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: fresh, from: status } ] } ]
`);
  render(<VariablesPanel />);
  await user.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("B.fresh") }));
  const input = screen.getByRole("textbox", { name: ko.editor.variableRenameInputAria("B.fresh") });
  await user.clear(input);
  await user.type(input, "taken{Enter}"); // into-shadow collision
  expect(screen.getByText(ko.editor.variableRenameCollision("taken"))).toBeInTheDocument();
  expect(useScenarioEditor.getState().yamlText).toContain("var: fresh"); // not committed
});
```

Note: adapt `render`/load helpers to the existing file's harness (it renders `<VariablesPanel />` after `useScenarioEditor.getState().loadFromString(...)` with a `beforeEach` store reset; import `userEvent`/`screen`/`ko` as the file already does).

**Also update the existing MIXED-fixture test (must change — its `alpha.s` is non-shadow):** In the first test `"renders declared / flat-extract / parallel-extract / undefined rows…"`, the current parallel-row block asserts a single `getByText("alpha.s")` + `renameVariableAria("alpha.s")` is `toBeNull()`. Under slice B, `alpha.s` (‎`s` is not declared and only extracted in the branch → non-shadow) now renders a split display (`alpha.` prefix span + `s`), a rename pencil, and an info-title badge. Replace those two assertions with:

```ts
    // parallel-extract alpha.s (non-shadow) — split display + rename pencil + info-title badge
    expect(screen.getByText("alpha.")).toBeInTheDocument(); // 고정 prefix span
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("alpha.s") }),
    ).toBeInTheDocument();
    expect(screen.getByTitle(ko.editor.variableBranchInfoTitle)).toBeInTheDocument();
```

The R9 shadow test (`선언 + parallel 분기가 동일 이름을 추출(shadow)…`, declared `s` + branch `alpha` extracts `s`) and the yamlError test need **no change**: they query `renameVariableAria("s")`/`("token")`, and the parallel `alpha.s` row there is shadow (no pencil) — unaffected. No existing test asserts `variableBranchTitle`, so removing that key is safe.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test VariablesPanel`
Expected: FAIL — no rename pencil on parallel rows / `variableBranchShadowTitle` undefined.

- [ ] **Step 3a: ko.ts — swap the branch title keys**

In `ui/src/i18n/ko.ts`, replace the `variableBranchTitle` line (~462) with two keys:

```ts
    variableBranchInfoTitle: "분기 변수 — 다운스트림에서 {{분기명.변수}}로 참조됩니다",
    variableBranchShadowTitle: "이름 충돌 — 이름 바꾸기 불가",
```

(Remove the old `variableBranchTitle: "분기 변수는 이름 바꾸기를 지원하지 않습니다",` line.)

- [ ] **Step 3b: VariablesPanel.tsx — discriminated editing, parallel rename, enriched nav**

Full changes:

1. Import `parallelVarIdentities` (drop `collectNamespacedProducers` if now unused) + type:

```ts
import {
  collectProducedVars,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVars,
  parallelVarIdentities,
} from "../../scenario/scanVars";
```

2. Widen `VarRow` parallel variant + add `EditKey`:

```ts
type VarRow =
  | { kind: "declared"; name: string; value: string; renamable: boolean; refIds: string[] }
  | { kind: "flat-extract"; name: string; refIds: string[] }
  | {
      kind: "parallel-extract";
      branchName: string;
      varName: string;
      display: string;
      isShadow: boolean;
      refIds: string[];
    }
  | { kind: "undefined"; name: string; refIds: string[] };

type EditKey = { kind: "flat"; name: string } | { kind: "parallel"; branchName: string; varName: string };
```

3. State: `editing` becomes `EditKey | null`; add `renameParallelVar` from store:

```ts
  const renameParallelVar = useScenarioEditor((s) => s.renameParallelVar);
  const [editing, setEditing] = useState<EditKey | null>(null);
```

4. `rows` useMemo — replace the `namespaced` iteration with `parallelVarIdentities` + enriched refIds. (Keep declared/flat/undefined branches as slice A.)

```ts
  const rows = useMemo<VarRow[]>(() => {
    if (!model) return [];
    const declaredKeys = new Set(Object.keys(model.variables));
    const produced = collectProducedVars(model);
    const parallelNames = parallelExtractNames(model);
    const refIndex = buildVarRefIndex(model);
    const undef = undefinedVars(model);
    const out: VarRow[] = [];
    for (const [name, value] of Object.entries(model.variables))
      out.push({
        kind: "declared",
        name,
        value,
        renamable: !parallelNames.has(name),
        refIds: refIndex.get(name) ?? [],
      });
    for (const name of produced)
      if (!declaredKeys.has(name) && !parallelNames.has(name))
        out.push({ kind: "flat-extract", name, refIds: refIndex.get(name) ?? [] });
    for (const id of parallelVarIdentities(model)) {
      const refIds = id.isShadow
        ? id.namespacedRefIds
        : [...new Set([...id.branchRefIds, ...id.namespacedRefIds])];
      out.push({
        kind: "parallel-extract",
        branchName: id.branchName,
        varName: id.varName,
        display: id.display,
        isShadow: id.isShadow,
        refIds,
      });
    }
    for (const name of undef)
      out.push({ kind: "undefined", name, refIds: refIndex.get(name) ?? [] });
    return out;
  }, [model]);
```

5. Rename handlers — flat (updated to EditKey) + parallel (new):

```ts
  const startRename = (name: string) => {
    setEditing({ kind: "flat", name });
    setDraft(name);
    setRenameError(null);
  };
  const startRenameParallel = (branchName: string, varName: string) => {
    setEditing({ kind: "parallel", branchName, varName });
    setDraft(varName);
    setRenameError(null);
  };
  const cancelRename = () => {
    setEditing(null);
    setRenameError(null);
  };
  const commitRename = (oldName: string) => {
    const nn = draft.trim();
    if (nn === "" || nn === oldName) return cancelRename();
    const err = renameVariable(oldName, nn);
    if (err === "collision") return setRenameError(ko.editor.variableRenameCollision(nn));
    if (err !== null) return setRenameError(ko.editor.variableRenameInvalid);
    cancelRename();
  };
  const commitRenameParallel = (branchName: string, oldVar: string) => {
    const nv = draft.trim();
    if (nv === "" || nv === oldVar) return cancelRename();
    const err = renameParallelVar(branchName, oldVar, nv);
    if (err === "collision") return setRenameError(ko.editor.variableRenameCollision(nv));
    if (err !== null) return setRenameError(ko.editor.variableRenameInvalid);
    cancelRename();
  };
```

6. `nav`/`usageCell` — thread a prefixed cycle key + explicit aria name (fixes F1 cycleRef collision):

```ts
  const nav = (cycleKey: string, refIds: string[]) => {
    if (refIds.length === 0) return;
    const i = cycleRef.current.get(cycleKey) ?? 0;
    onJumpToStep?.(refIds[i % refIds.length]);
    cycleRef.current.set(cycleKey, i + 1);
  };

  const usageCell = (cycleKey: string, ariaName: string, refIds: string[]) =>
    refIds.length === 0 ? (
      <span className="text-xs text-slate-400">{ko.editor.variableUnused}</span>
    ) : (
      <button
        type="button"
        aria-label={ko.editor.variableUsageNavAria(ariaName)}
        onClick={() => nav(cycleKey, refIds)}
        className="text-xs text-accent-600 hover:underline"
      >
        {ko.editor.variableUsage(refIds.length)}
      </button>
    );
```

7. `nameCell` (flat/declared) — update the editing check to the discriminated key:

```ts
  const nameCell = (name: string) =>
    editing?.kind === "flat" && editing.name === name ? (
      /* ...existing input block, onBlur={() => commitRename(name)}... */
    ) : (
      /* ...existing span + pencil (onClick={() => startRename(name)})... */
    );
```

(Only the guard `editing === name` → `editing?.kind === "flat" && editing.name === name` changes; input/pencil bodies unchanged from slice A.)

8. Update the four render branches' `usageCell` calls to prefixed keys, and rewrite the `parallel-extract` branch:

- declared: `{usageCell(\`d:${row.name}\`, row.name, row.refIds)}`
- flat-extract: `{usageCell(\`f:${row.name}\`, row.name, row.refIds)}`
- undefined: `{usageCell(\`u:${row.name}\`, row.name, row.refIds)}`
- parallel-extract branch — full replacement:

```tsx
          if (row.kind === "parallel-extract") {
            const isEditing =
              editing?.kind === "parallel" &&
              editing.branchName === row.branchName &&
              editing.varName === row.varName;
            return (
              <li key={`p:${row.display}`} className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-xs text-slate-400">{row.branchName}.</span>
                {row.isShadow ? (
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                    title={row.display}
                  >
                    {row.varName}
                  </span>
                ) : isEditing ? (
                  <div className="flex-1 min-w-0">
                    <Input
                      size="sm"
                      autoFocus
                      aria-label={ko.editor.variableRenameInputAria(row.display)}
                      className="min-w-0 font-mono"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setRenameError(null);
                      }}
                      onBlur={() => commitRenameParallel(row.branchName, row.varName)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRenameParallel(row.branchName, row.varName);
                        else if (e.key === "Escape") cancelRename();
                      }}
                    />
                    {renameError && <p className="mt-0.5 text-xs text-red-600">{renameError}</p>}
                  </div>
                ) : (
                  <>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                      title={row.display}
                    >
                      {row.varName}
                    </span>
                    <button
                      type="button"
                      aria-label={ko.editor.renameVariableAria(row.display)}
                      disabled={yamlError !== null}
                      onClick={() => startRenameParallel(row.branchName, row.varName)}
                      className="shrink-0 text-slate-400 hover:text-accent-600 text-xs disabled:opacity-40"
                    >
                      <span aria-hidden="true">✎</span>
                    </button>
                  </>
                )}
                <span
                  className="shrink-0 rounded bg-slate-100 px-1.5 text-xs text-slate-500"
                  title={
                    row.isShadow
                      ? ko.editor.variableBranchShadowTitle
                      : ko.editor.variableBranchInfoTitle
                  }
                >
                  {ko.editor.variableBranch}
                </span>
                {usageCell(`p:${row.display}`, row.display, row.refIds)}
              </li>
            );
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test VariablesPanel`
Expected: PASS (new + existing panel cases).

- [ ] **Step 5: Roadmap update (R14)**

Add a §B15 defer entry in `docs/roadmap.md` (mirror §B14 format), listing the §7 non-goals: bulk 변수 편집, FlowOutline 스텝-레벨 배지, producer-스텝 nav, position-aware shadow rename, shadow flat+parallel flat-identity 행 복원, merge/오타-재연결 rename. Reference `docs/superpowers/specs/2026-07-04-editor-var-tools-b-design.md` §7.

- [ ] **Step 6: Full gate + hardcoded sweep, then commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```

Hardcoded-Korean sweep (R11) — expect 0 new hits in changed files:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-tools-b
grep -nE "'\"[^\"]*[가-힣]" ui/src/components/scenario/VariablesPanel.tsx || echo "clean"
grep -nE '(aria-label|title)=\{[^}]*"[A-Za-z가-힣]' ui/src/components/scenario/VariablesPanel.tsx || echo "clean"
```

Commit:

```bash
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/i18n/ko.ts \
  ui/src/components/scenario/__tests__/VariablesPanel.test.tsx docs/roadmap.md
git commit -m "feat(editor): VariablesPanel parallel-var rename·enriched nav·shadow title + ko + roadmap B15"
```

---

## Self-Review (writer's checklist — done)

**Spec coverage:** R1→T1(`parallelVarIdentities` structural, cross-node dedup)·R2→T1(`flatProducerNames`)·R3→T1(`collectBranchInternalRefs`)·R4→T4(enriched refIds in `rows` memo)·R5→T2(three sub-rewrites, multi-node)·R6→T3(transactional clone/reparse)·R7→T3(5 no-op conditions)·R8→T4(non-shadow pencil, inline error)·R9→T4(shadow title, no pencil)·R10→T4(prefixed cycle keys, enriched nav)·R11→T4(ko keys, sweep)·R12→Global Constraints(0-diff)·R13→each task's "existing tests untouched green"·R14→T4 Step 5. All covered.

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The one adaptation note (T4 Step 1 "adapt loadScenario/render to existing harness") points at the concrete slice-A pattern, not a vague instruction.

**Type consistency:** `ParallelVarIdentity` fields (branchName/varName/display/isShadow/branchRefIds/namespacedRefIds) used identically in T1 (produce) and T4 (consume). `renameParallelVar(branchName, oldName, newName): RenameVarError | null` signature identical in T3 interface, store declaration, and T4 call site. `EditKey` discriminants (`"flat"`/`"parallel"`) consistent across handlers and render guards. Edit variant field names (`branchName/oldName/newName`) consistent T2↔T3.
