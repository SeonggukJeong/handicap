# 에디터 아웃라인 경계 넘는 드래그 / re-parent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** `FlowOutline` 드래그를 컨테이너 경계 너머로 확장 — 합법성 규칙(깊이 2·loop↔if 상호 1레벨·parallel 최상위-only·min(1) 소스 가드) 안에서 스텝/컨테이너를 자유 재배치하고, 불법 타깃은 충돌 후보에서 구조적으로 제외한다.

**Architecture:** 순수 레이어 우선 — ① `dropRules.ts`(밴드 열거·합법성·후보 필터, 순수) ② `reorder.ts` 확장(`resolveDrop` 해석) + `yamlDoc.ts` `reparentStep` variant + store 트랜잭셔널 액션 ③ `FlowOutline.tsx` 배선(충돌 확장·half ref·빈-else placeholder·인디케이터). 백엔드/proto/sql/schemas/model 0-diff (spec R8).

**Tech Stack:** React + TS + dnd-kit(기존) + `yaml` Document API. vitest + RTL. 신규 의존성 0.

**Spec:** `docs/superpowers/specs/2026-07-02-editor-reparent-dnd-design.md` (R1–R10 정규 요구사항·§5 엣지 매트릭스 13케이스)

## Global Constraints

- **tdd-guard**: 각 task는 **테스트 파일 편집을 가장 먼저**(pending test 없으면 `ui/src` non-test 편집 차단). import 미해결 RED 무방.
- **커밋 = 게이트**: pre-commit이 `ui/` staged 커밋마다 `pnpm lint && pnpm test && pnpm build`. 반복은 `cd ui && pnpm test <파일명>`(**`--` 없이**).
- **리뷰어 핀 N1**(spec 리뷰 r2): 같은 밴드 드롭의 `toIndex`는 **기존 `computeReorder` 결과 verbatim**(half 무시) — 슬라이스 1 재정렬 byte-identical. 테스트는 `computeReorder`와의 **인덱스 동치 단언**(단순 "moveStep 호출됨" 금지).
- **리뷰어 핀 N2**: dragStart 1회 계산물(합법 밴드 집합·id→band 인덱스)은 **ref**로 충돌 콜백(`[steps]` memo)에 전달.
- **리뷰어 핀 N3**: 트랜잭션은 **별도 store 액션 경로**(`doc.clone()`→적용→재파싱 성공 시 커밋) — generic `dispatch`/`applyEdit(doc,edit): void`의 in-place 계약을 넓히지 말 것.
- **밴드 키 계약**: 최상위=`"top"`, 그 외=`` `${parentId}:${band}` ``, band=`"do"`/`"then"`/`"elif_0"`…(0-based)/`"else"`/`"branch_0"`…(parallel 분기 인덱스). placeholder droppable id=`` `band:${parentId}:${band}` ``.
- **R4① 헤더 시맨틱**: 컨테이너 헤더 행 드롭 = 컨테이너-레벨 재정렬(밴드 진입 아님). 밴드 진입 = 밴드 안 행 또는 빈-else placeholder만.
- **키보드 경로 불변**: 포인터 좌표 없으면 기존 형제-그룹 후보 + `closestCenter`(경계 넘기 비목표).
- **무변경(spec R8)**: `crates/**`·`*.proto`·`*.sql`·`ui/src/api/schemas.ts`·`ui/src/scenario/model.ts` 절대 수정 금지. `store.ts`/`yamlDoc.ts`/`reorder.ts`는 **추가만**(기존 액션·`moveStep`·`computeReorder`/`resolveDragEnd` 시그니처·시맨틱 무변경).
- 테스트 fixture step id = 26자 ULID(I/L/O/U 제외) — 비-ULID면 `parseScenarioDoc` 조용히 실패.
- ADR-0035: 신규 사용자 노출 문구(placeholder 라벨) `ko.ts` 경유.
- 리포트 `.md`는 워크트리 루트 금지(지정 sdd 경로만), `git add`는 각 task 명시 파일만.

---

### Task 1: `dropRules.ts` — 밴드 열거·합법성·후보 필터 (순수 모듈)

**Files:**
- Test: `ui/src/scenario/__tests__/dropRules.test.ts` (신규)
- Create: `ui/src/scenario/dropRules.ts`

**Interfaces:**
- Consumes: `ui/src/scenario/model.ts`의 `isLoopStep`/`isIfStep`/`isParallelStep`/`findStepById`/`findStepSiblings`/`Step`(type) — **model.ts 무변경**.
- Produces (Task 2·3이 사용):
  - `export type BandRef = { parentId: string | null; band: string }`
  - `export const TOP_BAND: BandRef`
  - `export function bandKey(ref: BandRef): string` — `"top"` 또는 `` `${parentId}:${band}` ``
  - `export function enumerateBands(steps): { ref: BandRef; children: ReadonlyArray<Step> }[]` — if의 `else` 밴드는 **비어 있어도 항상 등록**(케이스 12)
  - `export function findParentBand(steps, stepId): BandRef | null`
  - `export function bandChildren(steps, ref): ReadonlyArray<Step> | null`
  - `export function bandIndex(steps): Map<string, string>` — 행 id → 그 행이 속한 bandKey
  - `export function hasNestedContainer(step: Step): boolean`
  - `export function legalTargetBands(steps, activeId): Set<string>`
  - `export function filterDropCandidates(ids, legal, index): string[]`
  - `export function keyboardCandidateIds(steps, activeId, ids): string[]`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/dropRules.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  bandIndex,
  bandKey,
  enumerateBands,
  filterDropCandidates,
  findParentBand,
  hasNestedContainer,
  keyboardCandidateIds,
  legalTargetBands,
} from "../dropRules";
import { parseScenarioDoc } from "../yamlDoc";

// 전 컨테이너 유형 + 중첩 + 단일-자식 + 빈-else fixture. id는 유효 ULID 필수(I/L/O/U 제외).
// S1 http · L1 loop(l1a,l1b 전-http) · I1 if(then t1/elif0 e1/else x1 전-http)
// L2 loop(NestedIf NI(ni1) + l2b) · I2 if(then: NestedLoop NL(nl1), else i2e)
// L3 loop(only1 단일자식) · I3 if(then t3, else 없음) · P parallel(A:[pa1], B:[pb1,pb2])
const FX_YAML = `version: 1
name: fx
steps:
  - id: "01HX0000000000000000000001"
    name: s1
    type: http
    request: { method: GET, url: /s1 }
  - id: "01HX0000000000000000000002"
    name: L1
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000003"
        name: l1a
        type: http
        request: { method: GET, url: /a }
      - id: "01HX0000000000000000000004"
        name: l1b
        type: http
        request: { method: GET, url: /b }
  - id: "01HX0000000000000000000005"
    name: I1
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000006"
        name: t1
        type: http
        request: { method: GET, url: /t1 }
    elif:
      - cond: { left: "1", op: eq, right: "2" }
        then:
          - id: "01HX0000000000000000000007"
            name: e1
            type: http
            request: { method: GET, url: /e1 }
    else:
      - id: "01HX0000000000000000000008"
        name: x1
        type: http
        request: { method: GET, url: /x1 }
  - id: "01HX0000000000000000000009"
    name: L2
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000A"
        name: NI
        type: if
        cond: { left: "1", op: eq, right: "1" }
        then:
          - id: "01HX000000000000000000000B"
            name: ni1
            type: http
            request: { method: GET, url: /ni1 }
      - id: "01HX000000000000000000000C"
        name: l2b
        type: http
        request: { method: GET, url: /l2b }
  - id: "01HX000000000000000000000D"
    name: I2
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX000000000000000000000E"
        name: NL
        type: loop
        repeat: 1
        do:
          - id: "01HX000000000000000000000F"
            name: nl1
            type: http
            request: { method: GET, url: /nl1 }
    else:
      - id: "01HX000000000000000000000G"
        name: i2e
        type: http
        request: { method: GET, url: /i2e }
  - id: "01HX000000000000000000000H"
    name: L3
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000J"
        name: only1
        type: http
        request: { method: GET, url: /only1 }
  - id: "01HX000000000000000000000K"
    name: I3
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX000000000000000000000M"
        name: t3
        type: http
        request: { method: GET, url: /t3 }
  - id: "01HX000000000000000000000N"
    name: P
    type: parallel
    branches:
      - name: A
        steps:
          - id: "01HX000000000000000000000P"
            name: pa1
            type: http
            request: { method: GET, url: /pa1 }
      - name: B
        steps:
          - id: "01HX000000000000000000000Q"
            name: pb1
            type: http
            request: { method: GET, url: /pb1 }
          - id: "01HX000000000000000000000R"
            name: pb2
            type: http
            request: { method: GET, url: /pb2 }
`;

const parsed = parseScenarioDoc(FX_YAML);
if (!("model" in parsed)) throw new Error("fixture must parse");
const STEPS = parsed.model.steps;

const S1 = "01HX0000000000000000000001";
const L1 = "01HX0000000000000000000002";
const L1A = "01HX0000000000000000000003";
const I1 = "01HX0000000000000000000005";
const X1 = "01HX0000000000000000000008";
const L2 = "01HX0000000000000000000009";
const NI = "01HX000000000000000000000A";
const L3 = "01HX000000000000000000000H";
const ONLY1 = "01HX000000000000000000000J";
const I3 = "01HX000000000000000000000K";
const P = "01HX000000000000000000000N";
const PB1 = "01HX000000000000000000000Q";

describe("enumerateBands / findParentBand / bandIndex", () => {
  it("전 밴드를 열거하고 빈 else도 포함한다 (케이스 12 전제)", () => {
    const keys = enumerateBands(STEPS).map((b) => bandKey(b.ref));
    expect(keys).toContain("top");
    expect(keys).toContain(`${L1}:do`);
    expect(keys).toContain(`${I1}:then`);
    expect(keys).toContain(`${I1}:elif_0`);
    expect(keys).toContain(`${I1}:else`);
    expect(keys).toContain(`${NI}:then`);
    expect(keys).toContain(`${P}:branch_0`);
    expect(keys).toContain(`${P}:branch_1`);
    expect(keys).toContain(`${I3}:else`); // else 부재(default []) → 그래도 등록
  });

  it("findParentBand — top/do/elif/else/branch 정체", () => {
    expect(findParentBand(STEPS, S1)).toEqual({ parentId: null, band: "top" });
    expect(findParentBand(STEPS, L1A)).toEqual({ parentId: L1, band: "do" });
    expect(findParentBand(STEPS, "01HX0000000000000000000007")).toEqual({
      parentId: I1,
      band: "elif_0",
    });
    expect(findParentBand(STEPS, X1)).toEqual({ parentId: I1, band: "else" });
    expect(findParentBand(STEPS, PB1)).toEqual({ parentId: P, band: "branch_1" });
    expect(findParentBand(STEPS, "없는id")).toBeNull();
  });

  it("bandIndex는 행 id → bandKey 맵", () => {
    const idx = bandIndex(STEPS);
    expect(idx.get(S1)).toBe("top");
    expect(idx.get(L1A)).toBe(`${L1}:do`);
    expect(idx.get(PB1)).toBe(`${P}:branch_1`);
  });
});

describe("hasNestedContainer", () => {
  it("중첩 컨테이너 보유 판정", () => {
    const l1 = STEPS.find((s) => s.id === L1)!;
    const l2 = STEPS.find((s) => s.id === L2)!;
    const i2 = STEPS.find((s) => s.id === "01HX000000000000000000000D")!;
    expect(hasNestedContainer(l1)).toBe(false); // 전-http
    expect(hasNestedContainer(l2)).toBe(true); // NestedIf 보유
    expect(hasNestedContainer(i2)).toBe(true); // NestedLoop 보유
  });
});

describe("legalTargetBands — spec §5 매트릭스", () => {
  const legal = (id: string) => legalTargetBands(STEPS, id);

  it("① http는 loop do·if 분기·parallel 레인·최상위 전부 합법", () => {
    const s = legal(S1);
    expect(s.has("top")).toBe(true);
    expect(s.has(`${L1}:do`)).toBe(true);
    expect(s.has(`${I1}:then`)).toBe(true);
    expect(s.has(`${I1}:elif_0`)).toBe(true);
    expect(s.has(`${P}:branch_0`)).toBe(true);
    expect(s.has(`${NI}:then`)).toBe(true); // 중첩 밴드도 http는 OK
  });

  it("② 전-http loop → 최상위 if 분기 합법 / 전-http-분기 if(I1) → 최상위 loop do 합법", () => {
    expect(legal(L1).has(`${I1}:then`)).toBe(true);
    expect(legal(I1).has(`${L1}:do`)).toBe(true);
  });

  it("③④ 중첩 컨테이너를 품은 loop/if는 교차 진입 불법 (3단 차단)", () => {
    expect(legal(L2).has(`${I1}:then`)).toBe(false); // L2가 NestedIf 보유
    expect(legal("01HX000000000000000000000D").has(`${L1}:do`)).toBe(false); // I2가 NestedLoop 보유
  });

  it("⑤ 컨테이너는 중첩 컨테이너의 밴드로 불법 (중첩 밴드=http만)", () => {
    expect(legal(L1).has(`${NI}:then`)).toBe(false);
    expect(legal(I1).has(`${"01HX000000000000000000000E"}:do`)).toBe(false); // NL.do
  });

  it("⑥ loop/if는 parallel 레인 불법", () => {
    expect(legal(L1).has(`${P}:branch_0`)).toBe(false);
    expect(legal(I1).has(`${P}:branch_1`)).toBe(false);
  });

  it("⑦ parallel은 최상위(자기 밴드)만 — 어떤 밴드도 불법", () => {
    const s = legal(P);
    expect(s).toEqual(new Set(["top"]));
  });

  it("⑧ 자기 서브트리 밴드 불법 (사이클)", () => {
    expect(legal(L1).has(`${L1}:do`)).toBe(false);
    expect(legal(L2).has(`${NI}:then`)).toBe(false); // 자손 밴드
  });

  it("⑨ min(1) 밴드 마지막 자식은 자기 밴드만 (경계 밖 전부 불법)", () => {
    expect(legal(ONLY1)).toEqual(new Set([`${L3}:do`]));
  });

  it("⑨-예외 else 소스 마지막 자식은 경계 밖 합법", () => {
    const s = legal(X1); // I1.else의 유일 자식
    expect(s.has("top")).toBe(true);
    expect(s.has(`${L1}:do`)).toBe(true);
  });

  it("⑩ 중첩 컨테이너(NI) → 최상위 합법 (티어 승격; L2.do엔 l2b가 남아 min(1) 통과)", () => {
    expect(legal(NI).has("top")).toBe(true);
  });

  it("⑩-보강(P5a): NL은 I2.then의 유일 자식 — min(1)×중첩 interplay로 자기 밴드만", () => {
    expect(legal("01HX000000000000000000000E")).toEqual(
      new Set([`${"01HX000000000000000000000D"}:then`]),
    );
  });

  it("⑨-예외(P5b): 최상위 유일 스텝도 경계 밖 합법 (top은 min 제약 없음)", () => {
    const mini = parseScenarioDoc(`version: 1
name: mini
steps:
  - id: "01HX0000000000000000000001"
    name: solo
    type: http
    request: { method: GET, url: /solo }
  - id: "01HX0000000000000000000002"
    name: LX
    type: loop
    repeat: 1
    do:
      - id: "01HX0000000000000000000003"
        name: lx1
        type: http
        request: { method: GET, url: /lx1 }
`);
    if (!("model" in mini)) throw new Error("mini fixture must parse");
    // solo는 top의 2개 중 1개가 아니라… top 자체가 min 제약이 없음을 보이려면
    // LX.do로 진입 가능해야 한다(top이 min(1)처럼 취급되면 여기서 갇힌다).
    const s = legalTargetBands(mini.model.steps, "01HX0000000000000000000001");
    expect(s.has(`${"01HX0000000000000000000002"}:do`)).toBe(true);
  });

  it("자기 밴드는 항상 포함 (그룹내 재정렬 보존)", () => {
    expect(legal(S1).has("top")).toBe(true);
    expect(legal(L1A).has(`${L1}:do`)).toBe(true);
  });
});

describe("filterDropCandidates / keyboardCandidateIds", () => {
  it("포인터 후보 = 합법 밴드의 행 + 합법 placeholder만", () => {
    const legal = legalTargetBands(STEPS, S1);
    const idx = bandIndex(STEPS);
    const ids = [S1, L1, L1A, PB1, `band:${I3}:else`, `band:${I1}:then`, "없는id"];
    const out = filterDropCandidates(ids, legal, idx);
    expect(out).toContain(L1A); // 합법 밴드(L1:do)의 행
    expect(out).toContain(`band:${I3}:else`); // 합법 빈-else placeholder
    expect(out).not.toContain("없는id");
  });

  it("불법 밴드의 행은 후보 제외 — loop 드래그 시 parallel 레인 행 제외 (R3)", () => {
    const legal = legalTargetBands(STEPS, L1);
    const idx = bandIndex(STEPS);
    const out = filterDropCandidates([S1, PB1, "01HX000000000000000000000B"], legal, idx);
    expect(out).toContain(S1); // top 행
    expect(out).not.toContain(PB1); // parallel 레인
    expect(out).not.toContain("01HX000000000000000000000B"); // NI.then(중첩 밴드)
  });

  it("키보드 후보 = 기존 형제 그룹 제한 유지", () => {
    const out = keyboardCandidateIds(STEPS, L1A, [S1, L1, L1A, "01HX0000000000000000000004", PB1]);
    expect(out).toContain(L1A);
    expect(out).toContain("01HX0000000000000000000004");
    expect(out).not.toContain(S1);
    expect(out).not.toContain(PB1);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test dropRules`
Expected: FAIL — `Cannot find module '../dropRules'`

- [ ] **Step 3: `ui/src/scenario/dropRules.ts` 구현**

```ts
import {
  findStepById,
  findStepSiblings,
  isIfStep,
  isLoopStep,
  isParallelStep,
  type Step,
} from "./model";

// 컨테이너 "밴드"(자식 시퀀스) 좌표계 — 경계 넘는 드롭의 합법성 판정 단일 소스(spec R2).
// band 키는 yamlDoc 경로·엔진 elif 0-based와 1:1: "do"/"then"/"elif_{i}"/"else"/"branch_{i}".
export type BandRef = { parentId: string | null; band: string };
export const TOP_BAND: BandRef = { parentId: null, band: "top" };

export function bandKey(ref: BandRef): string {
  return ref.parentId === null ? "top" : `${ref.parentId}:${ref.band}`;
}

export type BandEntry = { ref: BandRef; children: ReadonlyArray<Step> };

/** 트리의 전 밴드 열거. if의 else는 비어 있어도 등록 — 빈 else가 placeholder
 *  드롭 타깃(spec 케이스 12; else만 min(1)이 아닌 유일한 밴드). */
export function enumerateBands(steps: ReadonlyArray<Step>): BandEntry[] {
  const out: BandEntry[] = [{ ref: TOP_BAND, children: steps }];
  const walk = (list: ReadonlyArray<Step>) => {
    for (const s of list) {
      if (isLoopStep(s)) {
        out.push({ ref: { parentId: s.id, band: "do" }, children: s.do });
        walk(s.do);
      } else if (isIfStep(s)) {
        out.push({ ref: { parentId: s.id, band: "then" }, children: s.then });
        walk(s.then);
        s.elif.forEach((e, i) => {
          out.push({ ref: { parentId: s.id, band: `elif_${i}` }, children: e.then });
          walk(e.then);
        });
        out.push({ ref: { parentId: s.id, band: "else" }, children: s.else });
        walk(s.else);
      } else if (isParallelStep(s)) {
        s.branches.forEach((b, i) => {
          out.push({ ref: { parentId: s.id, band: `branch_${i}` }, children: b.steps });
          walk(b.steps);
        });
      }
    }
  };
  walk(steps);
  return out;
}

export function findParentBand(steps: ReadonlyArray<Step>, stepId: string): BandRef | null {
  for (const b of enumerateBands(steps)) {
    if (b.children.some((c) => c.id === stepId)) return b.ref;
  }
  return null;
}

export function bandChildren(
  steps: ReadonlyArray<Step>,
  ref: BandRef,
): ReadonlyArray<Step> | null {
  const k = bandKey(ref);
  const found = enumerateBands(steps).find((e) => bandKey(e.ref) === k);
  return found ? found.children : null;
}

/** 행 id → 그 행이 속한 bandKey. dragStart 1회 계산해 충돌 후보 필터가
 *  프레임마다 트리를 재탐색하지 않게 한다(N2 — ref로 전달). */
export function bandIndex(steps: ReadonlyArray<Step>): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of enumerateBands(steps)) {
    for (const c of b.children) m.set(c.id, bandKey(b.ref));
  }
  return m;
}

/** 드래그 서브트리에 중첩 컨테이너가 있는가 — 목적지 타입 규칙과 곱해지는
 *  깊이 조건(spec §3-2: 전-http loop만 if 분기로, 전-http-분기 if만 loop do로). */
export function hasNestedContainer(step: Step): boolean {
  if (isLoopStep(step)) return step.do.some((c) => c.type !== "http");
  if (isIfStep(step))
    return (
      step.then.some((c) => c.type !== "http") ||
      step.elif.some((e) => e.then.some((c) => c.type !== "http")) ||
      step.else.some((c) => c.type !== "http")
    );
  if (isParallelStep(step)) return true; // parallel은 어차피 밴드 진입 불가(방어)
  return false;
}

function subtreeIds(step: Step): Set<string> {
  const out = new Set<string>([step.id]);
  const add = (list: ReadonlyArray<Step>) =>
    list.forEach((c) => subtreeIds(c).forEach((id) => out.add(id)));
  if (isLoopStep(step)) add(step.do);
  else if (isIfStep(step)) {
    add(step.then);
    step.elif.forEach((e) => add(e.then));
    add(step.else);
  } else if (isParallelStep(step)) step.branches.forEach((b) => add(b.steps));
  return out;
}

function bandAccepts(steps: ReadonlyArray<Step>, ref: BandRef, dragged: Step): boolean {
  if (ref.parentId === null) return true; // 최상위 = 전 유형
  const parent = findStepById(steps, ref.parentId);
  if (!parent) return false;
  if (isParallelStep(parent)) return dragged.type === "http"; // 레인 = http만
  if (dragged.type === "http") return true; // http는 모든 밴드
  if (dragged.type === "parallel") return false; // parallel = 최상위-only
  const parentIsTop = steps.some((s) => s.id === parent.id);
  if (!parentIsTop) return false; // 중첩 컨테이너 밴드 = http만 (깊이 2 상한)
  if (isLoopStep(parent)) return dragged.type === "if" && !hasNestedContainer(dragged);
  if (isIfStep(parent)) return dragged.type === "loop" && !hasNestedContainer(dragged);
  return false;
}

/** dragStart에 1회 계산하는 합법 드롭 밴드 집합(bandKey). 자기 밴드는 항상
 *  포함(그룹내 재정렬 보존). 소스 규칙: min(1) 밴드(do/then/elif_j/branch_i —
 *  model.ts:139-210)의 마지막 자식은 경계 밖 금지(else·최상위 소스 예외, spec §3-3). */
export function legalTargetBands(steps: ReadonlyArray<Step>, activeId: string): Set<string> {
  const out = new Set<string>();
  const dragged = findStepById(steps, activeId);
  const own = findParentBand(steps, activeId);
  if (!dragged || !own) return out;
  out.add(bandKey(own));
  const siblings = findStepSiblings(steps, activeId);
  const min1Source = own.parentId !== null && own.band !== "else";
  if (min1Source && siblings.length === 1) return out;
  const excluded = subtreeIds(dragged);
  for (const b of enumerateBands(steps)) {
    if (b.ref.parentId !== null && excluded.has(b.ref.parentId)) continue;
    if (bandAccepts(steps, b.ref, dragged)) out.add(bandKey(b.ref));
  }
  return out;
}

/** 포인터 충돌 후보 필터(순수): droppable id 중 합법 밴드의 행 +
 *  합법 빈-밴드 placeholder(`band:{parentId}:{band}`)만. 불법 밴드는 여기서
 *  제외돼 over가 절대 잡히지 않는다 = 불법 드롭 구조 차단(spec R3). */
export function filterDropCandidates(
  ids: ReadonlyArray<string>,
  legal: ReadonlySet<string>,
  index: ReadonlyMap<string, string>,
): string[] {
  return ids.filter((id) => {
    const ph = /^band:([^:]+):(.+)$/.exec(id);
    if (ph) return legal.has(`${ph[1]}:${ph[2]}`);
    const k = index.get(id);
    return k !== undefined && legal.has(k);
  });
}

/** 키보드(포인터 좌표 없음) 후보 — 기존 형제-그룹 제한 그대로(spec R3:
 *  키보드 re-parent는 비목표, 절반-동작 방지). */
export function keyboardCandidateIds(
  steps: ReadonlyArray<Step>,
  activeId: string,
  ids: ReadonlyArray<string>,
): string[] {
  const sib = new Set(findStepSiblings(steps, activeId).map((s) => s.id));
  return ids.filter((id) => sib.has(id));
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test dropRules`
Expected: PASS (매트릭스 전수 — describe 4블록)

- [ ] **Step 5: Commit** (단일 FOREGROUND 호출·타임아웃 600000ms·폴링 금지)

```bash
git add ui/src/scenario/dropRules.ts ui/src/scenario/__tests__/dropRules.test.ts
git commit -m "feat(ui): dropRules 경계 드롭 합법성 순수 모듈 (spec R2/R3 — 매트릭스 13케이스)"
```

---

### Task 2: `resolveDrop` 해석 + `reparentStep` (yamlDoc variant + 트랜잭셔널 store 액션)

**Files:**
- Test: `ui/src/scenario/__tests__/reparent.test.ts` (신규)
- Modify: `ui/src/scenario/reorder.ts` (append-only — 기존 함수 무변경), `ui/src/scenario/yamlDoc.ts` (Edit union + case + `bandSeqPath` 헬퍼 추가), `ui/src/scenario/store.ts` (인터페이스 + 액션 추가)

**Interfaces:**
- Consumes: Task 1의 `bandChildren`/`bandKey`/`findParentBand`; 기존 `computeReorder`(reorder.ts)·`findStepPath`·`applyEdit`·`parseScenarioDoc`/`serializeDoc`(yamlDoc)·`Document.clone()`(yaml 2.9).
- Produces (Task 3이 사용):
  - `export type DropResolution = { kind: "move"; stepId: string; toIndex: number } | { kind: "reparent"; stepId: string; target: { parentId: string | null; band: string; index: number } }`
  - `export function resolveDrop(steps, activeId, overId, half): DropResolution | null` (reorder.ts)
  - store `reparentStep(stepId: string, target: { parentId: string | null; band: string; index: number }): void`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/reparent.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { computeReorder, resolveDrop } from "../reorder";
import { applyEdit, parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../store";

// Task 1 fixture 축약판 — top: s1, L1(l1a,l1b), I1(then t1 / else 없음→빈 else), L3(only1)
const YAML = `version: 1
name: fx
steps:
  - id: "01HX0000000000000000000001"
    name: s1
    type: http
    request: { method: GET, url: /s1 }
  # keep-me — 노드 이동 시 주석 보존 단언용(P5c; 선두 아닌 item 주석은 노드에 붙는다)
  - id: "01HX0000000000000000000002"
    name: L1
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000003"
        name: l1a
        type: http
        request: { method: GET, url: /a }
      - id: "01HX0000000000000000000004"
        name: l1b
        type: http
        request: { method: GET, url: /b }
  - id: "01HX0000000000000000000005"
    name: I1
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000006"
        name: t1
        type: http
        request: { method: GET, url: /t1 }
  - id: "01HX000000000000000000000H"
    name: L3
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000J"
        name: only1
        type: http
        request: { method: GET, url: /only1 }
`;

const S1 = "01HX0000000000000000000001";
const L1 = "01HX0000000000000000000002";
const L1A = "01HX0000000000000000000003";
const L1B = "01HX0000000000000000000004";
const I1 = "01HX0000000000000000000005";
const T1 = "01HX0000000000000000000006";
const L3 = "01HX000000000000000000000H";

function freshModel() {
  const p = parseScenarioDoc(YAML);
  if (!("model" in p)) throw new Error("fixture must parse");
  return p;
}

describe("resolveDrop — 같은 밴드 (N1 핀: computeReorder 동치)", () => {
  it("같은 밴드 드롭은 half와 무관하게 computeReorder 결과 verbatim", () => {
    const { model } = freshModel();
    const topIds = model.steps.map((s) => s.id);
    for (const overId of topIds) {
      for (const half of ["above", "below", null] as const) {
        const expected = computeReorder(topIds, S1, overId);
        const got = resolveDrop(model.steps, S1, overId, half);
        expect(got).toEqual(
          expected === null ? null : { kind: "move", stepId: S1, toIndex: expected },
        );
      }
    }
  });

  it("케이스 13: 컨테이너 헤더 행(over=L1, 같은 top 밴드) = 재정렬이지 밴드 진입 아님", () => {
    const { model } = freshModel();
    const got = resolveDrop(model.steps, S1, L1, "below");
    expect(got).toEqual({ kind: "move", stepId: S1, toIndex: 1 });
  });
});

describe("resolveDrop — 교차 밴드", () => {
  it("행 위 above/below → 그 행 앞/뒤 인덱스로 reparent", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, L1A, "above")).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: L1, band: "do", index: 0 },
    });
    expect(resolveDrop(model.steps, S1, L1A, "below")).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: L1, band: "do", index: 1 },
    });
  });

  it("빈-else placeholder id → index 0 reparent (케이스 12)", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, `band:${I1}:else`, null)).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: I1, band: "else", index: 0 },
    });
  });

  it("컨테이너째 이동: L1(전-http) → I1.then의 t1 아래", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, L1, T1, "below")).toEqual({
      kind: "reparent",
      stepId: L1,
      target: { parentId: I1, band: "then", index: 1 },
    });
  });

  it("over null / 미지 id → null", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, null, null)).toBeNull();
    expect(resolveDrop(model.steps, S1, "01HX000000000000000000ZZZZ", "above")).toBeNull();
  });
});

describe("applyEdit reparentStep — YAML AST verbatim 이동", () => {
  it("top http → loop.do (앞으로 이동해도 타깃 노드 참조가 유지된다)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: S1, parentId: L1, band: "do", index: 1 });
    const text = serializeDoc(doc);
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error(`must reparse: ${text}`);
    const l1 = reparsed.model.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([L1A, S1, L1B]);
    expect(reparsed.model.steps.map((s) => s.id)).toEqual([L1, I1, L3]);
  });

  it("loop 자식 → 최상위 (티어 승격 방향)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1A, parentId: null, band: "top", index: 0 });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    expect(reparsed.model.steps[0].id).toBe(L1A);
    const l1 = reparsed.model.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([L1B]);
  });

  it("빈(부재) else로 이동 시 else seq를 block으로 생성", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: S1, parentId: I1, band: "else", index: 0 });
    const text = serializeDoc(doc);
    expect(text).toContain("else:");
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    expect(i1.type === "if" && i1.else.map((c) => c.id)).toEqual([S1]);
  });

  it("전-http 컨테이너째 이동: L1 → I1.then (Loop↔NestedLoop YAML 동형 + 주석 동반 이동)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1, parentId: I1, band: "then", index: 1 });
    const text = serializeDoc(doc);
    expect(text).toContain("# keep-me"); // P5c: verbatim 노드 이동 = 노드-부착 주석 보존
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    expect(i1.type === "if" && i1.then.map((c) => c.id)).toEqual([T1, L1]);
  });

  it("이동 노드의 내용은 verbatim (repeat/do 보존)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1, parentId: I1, band: "then", index: 0 });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    const moved = i1.type === "if" ? i1.then[0] : null;
    expect(moved && moved.type === "loop" && moved.repeat).toBe(2);
    expect(moved && moved.type === "loop" && moved.do.map((c) => c.id)).toEqual([L1A, L1B]);
  });
});

describe("store.reparentStep — 트랜잭셔널 (N3 핀)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("합법 이동은 doc/model/yamlText 일괄 갱신", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().reparentStep(S1, { parentId: L1, band: "do", index: 0 });
    const st = useScenarioEditor.getState();
    expect(st.yamlError).toBeNull();
    const l1 = st.model!.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([S1, L1A, L1B]);
    expect(st.yamlText).toContain("s1");
  });

  it("재파싱을 깨는 이동(마지막 자식 빼내기)은 상태 무변이 no-op", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const before = useScenarioEditor.getState().yamlText;
    // L3.do의 유일 자식을 최상위로 — do가 비어 min(1) 위반 → reparse 실패해야 함
    useScenarioEditor.getState().reparentStep("01HX000000000000000000000J", {
      parentId: null,
      band: "top",
      index: 0,
    });
    const st = useScenarioEditor.getState();
    expect(st.yamlText).toBe(before); // 트랜잭션: 원본 doc 무변이
    expect(st.yamlError).toBeNull(); // 에러 상태도 오염 없음 (조용한 no-op — 게이트는 R2가 담당)
    const l3 = st.model!.steps.find((s) => s.id === L3)!;
    expect(l3.type === "loop" && l3.do).toHaveLength(1);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test reparent`
Expected: FAIL — `resolveDrop`/`reparentStep` 미정의 (`computeReorder`는 기존이라 import 성공)

- [ ] **Step 3: `reorder.ts`에 `resolveDrop` append** (기존 `computeReorder`/`resolveDragEnd` 무변경)

```ts
import { bandChildren, bandKey, findParentBand } from "./dropRules";
```

(파일 상단 기존 import 아래에 추가. 그리고 파일 끝에:)

```ts
export type DropResolution =
  | { kind: "move"; stepId: string; toIndex: number }
  | {
      kind: "reparent";
      stepId: string;
      target: { parentId: string | null; band: string; index: number };
    };

/** 경계-넘기 드롭 해석(spec R4). 같은 밴드 = 기존 computeReorder 결과 verbatim
 *  (half 무시 — 슬라이스 1 재정렬 byte-identical, 리뷰 핀 N1). 교차 밴드 = over 행의
 *  above/below로 앞/뒤 인덱스. placeholder(`band:{parentId}:{band}`) = index 0.
 *  합법성은 상류(충돌 후보 필터)가 보장 — 이 함수는 기계적 해석만. */
export function resolveDrop(
  steps: Step[],
  activeId: string,
  overId: string | null,
  half: "above" | "below" | null,
): DropResolution | null {
  if (overId === null) return null;
  const ph = /^band:([^:]+):(.+)$/.exec(overId);
  if (ph) {
    return {
      kind: "reparent",
      stepId: activeId,
      target: { parentId: ph[1], band: ph[2], index: 0 },
    };
  }
  const ownBand = findParentBand(steps, activeId);
  const overBand = findParentBand(steps, overId);
  if (ownBand === null || overBand === null) return null;
  if (bandKey(ownBand) === bandKey(overBand)) {
    const sibIds = (bandChildren(steps, ownBand) ?? []).map((s) => s.id);
    const toIndex = computeReorder(sibIds, activeId, overId);
    return toIndex === null ? null : { kind: "move", stepId: activeId, toIndex };
  }
  const children = bandChildren(steps, overBand) ?? [];
  const overIdx = children.findIndex((s) => s.id === overId);
  if (overIdx === -1) return null;
  const index = half === "below" ? overIdx + 1 : overIdx;
  return {
    kind: "reparent",
    stepId: activeId,
    target: {
      parentId: overBand.parentId,
      band: overBand.parentId === null ? "top" : overBand.band,
      index,
    },
  };
}
```

- [ ] **Step 4: `yamlDoc.ts` — Edit union + `bandSeqPath` + `reparentStep` case**

Edit union(`yamlDoc.ts:11` 근처)의 `| { type: "moveStep"; ... }` 아래에 추가:

```ts
  | { type: "reparentStep"; stepId: string; parentId: string | null; band: string; index: number }
```

`branchPath`(`:446` 근처) 아래에 헬퍼 추가:

```ts
// 밴드 키 → doc 경로 (dropRules bandKey 계약과 1:1 — "do"/"then"/"else"/
// "elif_{i}"(0-based)/"branch_{i}"; parentId null = 최상위 steps).
function bandSeqPath(
  doc: Document,
  parentId: string | null,
  band: string,
): Array<string | number> | null {
  if (parentId === null) return ["steps"];
  const p = findStepPath(doc, parentId);
  if (p === null) return null;
  if (band === "do" || band === "then" || band === "else") return [...p, band];
  const elif = /^elif_(\d+)$/.exec(band);
  if (elif) return [...p, "elif", Number(elif[1]), "then"];
  const br = /^branch_(\d+)$/.exec(band);
  if (br) return [...p, "branches", Number(br[1]), "steps"];
  return null;
}
```

`applyEdit`의 `case "moveStep"` 아래에 case 추가:

```ts
    case "reparentStep": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      const targetSeqPath = bandSeqPath(doc, edit.parentId, edit.band);
      if (targetSeqPath === null) return;
      const parentPath = path.slice(0, -1);
      const fromIdx = path[path.length - 1] as number;
      const parent = doc.getIn(parentPath) as YAMLSeq;
      // 타깃 seq *노드*를 splice-out 전에 잡는다 — splice-out이 형제 인덱스를
      // 밀면 경로 기반 재해석이 어긋나지만 노드 참조는 불변(리뷰 r1 FR류 방어).
      let target = doc.getIn(targetSeqPath);
      if (!isSeq(target)) {
        // 빈(부재) else 밴드 — block seq로 생성(빈 flow seq splice = 한 줄 flow 직렬화 함정)
        doc.setIn(targetSeqPath, doc.createNode([]));
        target = doc.getIn(targetSeqPath);
      }
      const targetSeq = target as YAMLSeq;
      targetSeq.flow = false;
      const node = parent.items[fromIdx];
      parent.items.splice(fromIdx, 1);
      // 방어: 같은 seq로의 강하 케이스(리졸버는 same-band를 moveStep으로 위임하지만
      // variant 자체는 total하게) — splice-out으로 밀린 인덱스 보정.
      const idx = targetSeq === parent && edit.index > fromIdx ? edit.index - 1 : edit.index;
      targetSeq.items.splice(Math.min(idx, targetSeq.items.length), 0, node);
      return;
    }
```

- [ ] **Step 5: `store.ts` — 인터페이스 + 트랜잭셔널 액션**

인터페이스(`moveStep` 선언 `:57` 아래):

```ts
  reparentStep(
    stepId: string,
    target: { parentId: string | null; band: string; index: number },
  ): void;
```

액션(`moveStep` 구현 `:223-225` 아래) — **generic `dispatch`를 쓰지 않는다**(N3):

```ts
  reparentStep(stepId, target) {
    const doc = get().doc;
    if (!doc) return;
    // 트랜잭셔널(spec R6): clone에 적용 → 재파싱 성공 시에만 커밋. generic dispatch는
    // in-place 변이 후 재파싱 실패 시 롤백이 없다(아래 dispatch 참조) — re-parent는
    // 불법 상태를 만들 수 있는 첫 edit라 원본 doc을 직접 변이하지 않는다.
    const clone = doc.clone();
    applyEdit(clone, { type: "reparentStep", stepId, ...target });
    const reparsed = parseScenarioDoc(serializeDoc(clone));
    if ("error" in reparsed) return; // 합법성 게이트(R2) 뚫린 버그 가드 — 상태 무변이 no-op
    set({
      doc: reparsed.doc,
      model: reparsed.model,
      yamlText: serializeDoc(reparsed.doc),
      yamlError: null,
    });
  },
```

**그리고 (P1 must-fix — 빠뜨리면 `tsc -b` 게이트 실패):** `store.ts` 하단 `getInitialState` 셤의 `actions` 캡처 블록(`store.ts:327-365` — 모든 액션을 나열)에 한 줄 추가:

```ts
    reparentStep: s.reparentStep,
```

(캡처 누락 시 `() => ScenarioEditorState` 반환 리터럴에 required 프로퍼티가 빠져 `pnpm test`는 green인데 `pnpm build`(`tsc -b`)만 빨간 — 이 plan이 선제하려는 바로 그 클래스.)

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test reparent`
Expected: PASS (resolveDrop 동치·교차·placeholder / applyEdit 5케이스 / store 트랜잭션 2케이스)

Run: `cd ui && pnpm test reorder`
Expected: PASS (기존 6케이스 그대로 — `computeReorder`/`resolveDragEnd` 무변경 증거)

- [ ] **Step 7: Commit** (단일 FOREGROUND·600000ms)

```bash
git add ui/src/scenario/__tests__/reparent.test.ts ui/src/scenario/reorder.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts
git commit -m "feat(ui): resolveDrop 해석 + reparentStep 트랜잭셔널 edit (spec R4/R6 — N1 동치·N3 clone 커밋)"
```

---

### Task 3: `FlowOutline` 배선 — 충돌 확장·half ref·placeholder·인디케이터 + ko 키

**Files:**
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx` (갱신 — 신규 describe append)
- Modify: `ui/src/components/scenario/FlowOutline.tsx`, `ui/src/i18n/ko.ts`

**Interfaces:**
- Consumes: Task 1 `legalTargetBands`/`bandIndex`/`filterDropCandidates`/`bandKey`/`findParentBand`/`TOP_BAND`(type `BandRef`); Task 2 `resolveDrop` + store `reparentStep`.
- Produces: 없음(최종 배선).

- [ ] **Step 1: 실패하는 테스트 먼저** — `FlowOutline.test.tsx`에 describe append (기존 테스트 무변경)

> **spec R3/R5 RTL acceptance 다운그레이드 기록(P4)**: spec이 R3/R5 acceptance로 적은
> "onDragEnd 불법 조합 주입 → 액션 미호출"·"인디케이터 클래스 단언"은 jsdom에서 실 드래그가
> 불가하고(editor-drag-fixes 확립 정책) `OutlineRow`/`DragCtx`가 모듈-private이라, **동등
> 보증을 순수 레이어로 이동**했다 — 불법 차단은 Task 1 `filterDropCandidates`(후보 제외 =
> over 불가 = 액션 미호출의 상류 보증) + Task 2 `resolveDrop`, 인디케이터/placeholder 시각은
> 라이브 R9 held-drag(②)가 권위. 최종 리뷰어는 이 매핑을 spec-drift가 아니라 의도된
> 등가-이전으로 볼 것.

```tsx
describe("FlowOutline re-parent 배선 (spec R3/R5)", () => {
  it("ko placeholder 키가 존재하고, 드래그 중이 아니면 placeholder가 렌더되지 않는다", () => {
    // ko 키 단언이 Task 3 Step 3 전까지 RED(esbuild 런타임 undefined) — 이 task의 RED 씨앗.
    expect(ko.editor.emptyBandDropHint).toBeTruthy();
    useScenarioEditor.getState().loadFromString(REPARENT_YAML);
    render(<FlowOutline />);
    expect(screen.queryByText(ko.editor.emptyBandDropHint)).not.toBeInTheDocument();
  });

  it("케이스 13 순수 계약 핀 — 헤더 행 드롭은 재정렬(FlowOutline이 쓰는 resolveDrop과 동일 모듈)", () => {
    useScenarioEditor.getState().loadFromString(REPARENT_YAML);
    const steps = useScenarioEditor.getState().model!.steps;
    const res = resolveDrop(steps, steps[0].id, steps[1].id, "below");
    expect(res?.kind).toBe("move");
  });
});
```

(`ko` import는 기존 파일에 이미 있으면 재사용 — 없으면 `import { ko } from "../../../i18n/ko";` 추가.)

파일 상단에 필요한 import 추가(`resolveDrop` — `../../../scenario/reorder`)와 fixture 추가:

```tsx
const REPARENT_YAML = `version: 1
name: rp
steps:
  - id: "01HX0000000000000000000001"
    name: ping
    type: http
    request: { method: GET, url: /ping }
  - id: "01HX0000000000000000000005"
    name: gate
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000006"
        name: t1
        type: http
        request: { method: GET, url: /t1 }
`;
```

(기존 파일의 store reset/render 관용구 — `beforeEach` `useScenarioEditor.setState(useScenarioEditor.getInitialState())` — 를 그대로 따른다. 기존 테스트가 이미 하고 있으면 추가하지 않는다.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: 신규 테스트 1(ko 키 단언)이 FAIL(`emptyBandDropHint` 미존재 → undefined → toBeTruthy RED), 신규 테스트 2는 Task 2 완료 상태라 PASS(순수 계약 핀 = 회귀 가드), 기존 PASS 유지

- [ ] **Step 3: `ko.ts` — editor 섹션에 키 1개 추가** (드래그 관련 키 근처)

```ts
    emptyBandDropHint: "여기로 드롭",
```

- [ ] **Step 4: `FlowOutline.tsx` 배선** (아래 조각을 정확히 적용)

**4a. import 추가/확장:**

```tsx
import { useCallback, useMemo, useRef, useState } from "react";
```

(기존 첫 줄 교체 — `useRef` 추가.) `@dnd-kit/core` import에 `useDroppable`, `type DragMoveEvent` 추가. 그리고:

```tsx
import { resolveDrop } from "../../scenario/reorder";
import {
  bandIndex,
  bandKey,
  filterDropCandidates,
  findParentBand,
  keyboardCandidateIds,
  legalTargetBands,
  TOP_BAND,
  type BandRef,
} from "../../scenario/dropRules";
```

(기존 `import { resolveDragEnd } from "../../scenario/reorder";` 줄은 `resolveDrop`으로 **교체** — `resolveDragEnd`는 이제 FlowOutline에서 미사용이지만 reorder.ts엔 그대로 남는다[기존 테스트·시그니처 무변경]. `findStepSiblings` import는 키보드 후보 헬퍼로 대체되어도 남겨둔다 — `keyboardCandidateIds`가 내부에서 쓰므로 FlowOutline 직접 사용이 사라지면 import에서 제거해 lint unused를 피한다.)

**4b. 드래그 컨텍스트 타입 + placeholder 컴포넌트** (`RowContent` 위 모듈 스코프):

```tsx
// 드래그 중 시각/판정 컨텍스트 — 행 트리에 prop으로 흘린다(store 미접촉).
interface DragCtx {
  activeId: string | null;
  legal: ReadonlySet<string> | null;
  over: { id: string; half: "above" | "below" } | null;
  overBandKey: string | null;
}
const IDLE_DRAG: DragCtx = { activeId: null, legal: null, over: null, overBandKey: null };

// 빈 else 밴드의 드롭 타깃(spec R4③ — else만 빈-가능 밴드). 드래그 중·합법일 때만 렌더.
function EmptyBandDrop({ parentId, band }: { parentId: string; band: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `band:${parentId}:${band}`,
    data: { parentId, band, index: 0 },
  });
  return (
    <div
      ref={setNodeRef}
      className={`mx-2 my-1 rounded border border-dashed px-2 py-1 text-xs ${
        isOver
          ? "border-accent-500 bg-accent-50 text-accent-700"
          : "border-slate-300 text-slate-400"
      }`}
    >
      {ko.editor.emptyBandDropHint}
    </div>
  );
}
```

**4c. `ContainerBands` — 밴드 키를 renderGroup에 전달 + 빈 else 옵트인** (기존 함수 교체):

```tsx
function ContainerBands({
  step,
  depth,
  renderGroup,
  includeEmptyElse = false,
}: {
  step: Step;
  depth: number;
  renderGroup: (
    children: Step[],
    childDepth: number,
    band: { parentId: string; band: string },
  ) => React.ReactNode;
  includeEmptyElse?: boolean;
}) {
  if (isLoopStep(step)) {
    return (
      <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
        {renderGroup(step.do, depth + 1, { parentId: step.id, band: "do" })}
      </div>
    );
  }
  if (isIfStep(step)) {
    const bands: Array<{ label: string; key: string; children: Step[] }> = [
      { label: "THEN", key: "then", children: step.then },
      ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, key: `elif_${i}`, children: e.then })),
      ...(step.else.length > 0 || includeEmptyElse
        ? [{ label: "ELSE", key: "else", children: step.else }]
        : []),
    ];
    return (
      <>
        {bands.map((b) => (
          <div key={b.label} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.label}
            </div>
            <div className="flex flex-col gap-1">
              {renderGroup(b.children, depth + 1, { parentId: step.id, band: b.key })}
            </div>
          </div>
        ))}
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        {step.branches.map((b, i) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.name}
            </div>
            <div className="flex flex-col gap-1">
              {renderGroup(b.steps, depth + 1, { parentId: step.id, band: `branch_${i}` })}
            </div>
          </div>
        ))}
      </>
    );
  }
  return null;
}
```

(`OutlineRowPreview`의 `renderGroup={(children, childDepth) => …}` 콜백은 파라미터 수가 적어 TS 호환 — **무변경**.)

**4d. `OutlineRow` — band/index/drag prop + data payload + 인디케이터 + 밴드 하이라이트 + placeholder** (기존 함수 교체; `rowAria`/`dragHandle`/`RowContent` 부분은 기존 그대로 유지):

```tsx
function OutlineRow({
  step,
  depth,
  band = TOP_BAND,
  index = 0,
  drag = IDLE_DRAG,
}: {
  step: Step;
  depth: number;
  band?: BandRef;
  index?: number;
  drag?: DragCtx;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
      data: { parentId: band.parentId, band: band.band, index },
    });
  // …(selectedStepId/select/selected/accent/hidden/nodeTransform/rowClassBase/rowAria/dragHandle
  //   블록은 기존 코드 그대로 — 변경 없음)…

  // 삽입 예정 위치 인디케이터(spec R5): over 행의 above/below에 accent 라인.
  // 컨테이너는 sortable 노드=외곽 wrapper라 border-b가 "컨테이너 뒤" 시맨틱과 일치(R4①).
  const overHere = drag.over?.id === step.id;
  const indicator = overHere
    ? drag.over!.half === "above"
      ? "border-t-2 border-t-accent-500"
      : "border-b-2 border-b-accent-500"
    : "";

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    const includeEmptyElse =
      isIfStep(step) &&
      drag.activeId !== null &&
      (drag.legal?.has(`${step.id}:else`) ?? false) &&
      step.else.length === 0;
    return (
      <div ref={setNodeRef} style={{ transform: nodeTransform }} className={`${hidden} ${indicator}`}>
        <div
          {...rowAria}
          style={{ marginLeft: `${depth * 16}px` }}
          className={`${rowClassBase} items-center`}
        >
          {dragHandle}
          <RowContent step={step} />
        </div>
        <ContainerBands
          step={step}
          depth={depth}
          includeEmptyElse={includeEmptyElse}
          renderGroup={(children, childDepth, childBand) => {
            const key = bandKey({ parentId: childBand.parentId, band: childBand.band });
            const isOverBand = drag.overBandKey === key;
            const legalHere = drag.legal?.has(key) ?? false;
            return (
              // P2: 이 wrapper는 밴드 컨테이너(flex flex-col gap-1)와 행 사이에 끼므로
              // 자신이 flex flex-col gap-1을 실어야 행 간 4px gap이 보존된다(상시 렌더).
              <div
                className={`flex flex-col gap-1${isOverBand ? " rounded bg-accent-50/60" : ""}`}
              >
                <SortableContext
                  items={children.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {children.map((c, i) => (
                    <OutlineRow
                      key={c.id}
                      step={c}
                      depth={childDepth}
                      band={childBand}
                      index={i}
                      drag={drag}
                    />
                  ))}
                </SortableContext>
                {children.length === 0 && drag.activeId !== null && legalHere && (
                  <EmptyBandDrop parentId={childBand.parentId} band={childBand.band} />
                )}
              </div>
            );
          }}
        />
      </div>
    );
  }
  return (
    <div
      ref={setNodeRef}
      {...rowAria}
      style={{ marginLeft: `${depth * 16}px`, transform: nodeTransform }}
      className={`${rowClassBase} items-center ${hidden} ${indicator}`}
    >
      {dragHandle}
      <RowContent step={step} />
    </div>
  );
}
```

**4e. `FlowOutline()` 본문 — refs·충돌 확장·핸들러·drag 전달** (해당 블록 교체):

```tsx
  const moveStep = useScenarioEditor((s) => s.moveStep);
  const reparentStep = useScenarioEditor((s) => s.reparentStep);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overInfo, setOverInfo] = useState<{ id: string; half: "above" | "below" } | null>(null);
  // dragStart 1회 계산물은 ref로 충돌 콜백([steps] memo)에 전달(리뷰 핀 N2).
  const dragCalcRef = useRef<{ legal: Set<string>; index: Map<string, string> } | null>(null);
  // R4 pointer-half: DragEndEvent엔 포인터 좌표가 없어 충돌 콜백이 판정을 기록.
  const halfRef = useRef<{ overId: string; half: "above" | "below" } | null>(null);
  const activeStep = activeId ? findStepById(steps, activeId) : null;
```

충돌 콜백 교체:

```tsx
  // 포인터 = 합법 밴드 전체(경계 넘기, spec R3) / 키보드 = 기존 형제-그룹 제한.
  // 후보 중 드롭 대상은 nearestByHeader(헤더 근접) 유지. 판정 half를 ref에 기록(R4).
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const dragId = args.active.id as string;
      const pointerY = args.pointerCoordinates?.y;
      const allIds = args.droppableContainers.map((c) => c.id as string);
      if (pointerY == null) {
        const kb = new Set(keyboardCandidateIds(steps, dragId, allIds));
        const candidates = args.droppableContainers.filter((c) => kb.has(c.id as string));
        return closestCenter({ ...args, droppableContainers: candidates });
      }
      const calc = dragCalcRef.current;
      const candidateIds = new Set(
        calc
          ? filterDropCandidates(allIds, calc.legal, calc.index)
          : keyboardCandidateIds(steps, dragId, allIds),
      );
      const candidates = args.droppableContainers.filter((c) => candidateIds.has(c.id as string));
      if (candidates.length === 0) return [];
      const items = candidates.flatMap((c) => {
        const rect = args.droppableRects.get(c.id);
        if (!rect) return [];
        const cStep = findStepById(steps, c.id as string);
        const isContainer =
          cStep != null && (isLoopStep(cStep) || isIfStep(cStep) || isParallelStep(cStep));
        return [{ id: c.id as string, top: rect.top, height: rect.height, isContainer }];
      });
      const overId = nearestByHeader(items, pointerY, HEADER_BAND_PX);
      if (overId == null) return [];
      const it = items.find((i) => i.id === overId);
      if (it) {
        const center = it.isContainer ? it.top + HEADER_BAND_PX / 2 : it.top + it.height / 2;
        halfRef.current = { overId, half: pointerY < center ? "above" : "below" };
      }
      return [{ id: overId }];
    },
    [steps],
  );
```

핸들러 교체:

```tsx
  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    dragCalcRef.current = { legal: legalTargetBands(steps, id), index: bandIndex(steps) };
    halfRef.current = null;
    setOverInfo(null);
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const overId = (event.over?.id ?? null) as string | null;
    const h = halfRef.current;
    const next =
      overId === null
        ? null
        : { id: overId, half: h && h.overId === overId ? h.half : ("below" as const) };
    setOverInfo((prev) =>
      prev?.id === next?.id && prev?.half === next?.half ? prev : next,
    );
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    setOverInfo(null);
    const { active, over } = event;
    const dragId = active.id as string;
    const overId = (over?.id ?? null) as string | null;
    const half = overId !== null && halfRef.current?.overId === overId ? halfRef.current.half : null;
    dragCalcRef.current = null;
    halfRef.current = null;
    const res = resolveDrop(steps, dragId, overId, half);
    if (res?.kind === "move") moveStep(res.stepId, res.toIndex);
    else if (res?.kind === "reparent") reparentStep(res.stepId, res.target);
  };
  const handleDragCancel = () => {
    setActiveId(null);
    setOverInfo(null);
    dragCalcRef.current = null;
    halfRef.current = null;
  };
```

drag 컨텍스트 도출 + 전달 (`selectedLoopId` memo 아래):

```tsx
  const overBandKey = useMemo(() => {
    if (!overInfo) return null;
    const ph = /^band:([^:]+):(.+)$/.exec(overInfo.id);
    if (ph) return `${ph[1]}:${ph[2]}`;
    const b = findParentBand(steps, overInfo.id);
    return b ? bandKey(b) : null;
  }, [overInfo, steps]);
  const drag: DragCtx = {
    activeId,
    legal: dragCalcRef.current?.legal ?? null,
    over: overInfo,
    overBandKey,
  };
```

`<DndContext>`에 `onDragMove={handleDragMove}` 추가. 최상위 map 교체:

```tsx
            <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {steps.map((s, i) => (
                <OutlineRow key={s.id} step={s} depth={0} band={TOP_BAND} index={i} drag={drag} />
              ))}
            </SortableContext>
```

- [ ] **Step 5: GREEN + 전체 스위트**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS (기존 + 신규 2)

Run: `cd ui && pnpm test`
Expected: 전체 PASS (targeted-green ≠ full-green — 머지 전 전체 1회 필수)

- [ ] **Step 6: R7/R8 전수 검증 grep**

```bash
# R8: 무변경 경로 (전부 출력 없음이어야 함)
git diff master...HEAD --name-only | grep -E '^crates/|\.proto$|\.sql$' || echo "R8 paths OK"
git diff master...HEAD -- ui/src/api/schemas.ts ui/src/scenario/model.ts
# → 출력 없음 = OK

# R8: 기존 함수 시그니처 무변경 (computeReorder/resolveDragEnd/moveStep 시맨틱)
git diff master...HEAD -- ui/src/scenario/reorder.ts | grep -E '^-' | grep -v '^---' | grep -vE '^-$'
# → 삭제 줄 없음(append + import 추가만) = OK

# R7: 하드코딩 한국어 sweep — 개선 패턴(ui/CLAUDE.md: '"[가-힣]'는 "(미매치)"류를 놓침)
grep -nE '"[^"]*[가-힣]' ui/src/scenario/dropRules.ts ui/src/components/scenario/FlowOutline.tsx | grep -v 'ko\.' || echo "R7 OK"
# → FlowOutline의 기존 문자열(THEN/ELIF 등은 영어 구조 라벨=기존 유지) 외 신규 한국어 리터럴 0
grep -nE '(aria-label|title)="[A-Za-z]|(aria-label|title)=\{[^}]*"[A-Za-z]' ui/src/components/scenario/FlowOutline.tsx
# → 기존과 동일(신규 영어 aria 0)
```

- [ ] **Step 7: Commit** (단일 FOREGROUND·600000ms)

```bash
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): FlowOutline 경계 넘는 드래그 배선 — 충돌 확장·half ref·빈-else placeholder·인디케이터 (spec R1/R3/R4/R5)"
```

---

## 구현 후 (오케스트레이터 체크리스트 — implementer 범위 밖)

1. **최종 whole-feature 리뷰**: `handicap-reviewer` APPROVE (+ finish-slice §0 보안 grep — 이 슬라이스는 에디터 내부 전용·요청실행/템플릿/env/업로드/trace-뷰어 무접촉이라 N/A 예상).
2. **라이브 검증**(spec §6, R9 하드 단언): vite dev(`localhost` — IPv6 함정) 또는 dist 서빙 + Playwright `browser_run_code_unsafe` held-drag —
   ① **경계 넘는 held-drag 중 취소/dead-zone 미발생**(R9 하드 — §3-6 최상위 리스크 직접 검증: loop 밖 http를 do 안으로 끌며 mid-drag `over` 유지 관측)
   ② mid-drag 인디케이터(accent 라인)·빈-else placeholder 렌더 실측
   ③ 드롭 후 YAML 모달로 구조 확인(loop 밖→안·분기 간·컨테이너째 이동·티어 전환)
   ④ 불법 드롭 "안 붙음"(parallel 레인에 loop 끌기 → over 미발생·드롭 no-op)
   ⑤ 같은-그룹 재정렬 회귀(기존 동작 그대로)
   ⑥ R10 밸브 판단 재료: 조작감 메모(타깃 예측 가능성).
3. `/finish-slice`: build-log·roadmap-status B13 frontier(슬라이스 3 완료 = B13 완결 여부 판단)·CLAUDE 상태줄·메모리 → ff-merge → `ExitWorktree`.
