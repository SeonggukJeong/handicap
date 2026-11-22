# 준비 스텝 슬라이스 B1 (에디터: 추가·순서 바꾸기·끌어 옮기기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** QA가 에디터에서 준비 스텝을 바로 추가하고, 준비 구획 안 순서를 바꾸고, 준비 구획과 본 스텝 사이로 스텝을 끌어 옮긴다. 갤러리 「로그인 흐름」은 준비 스텝 형태로 시작한다.

**Architecture:** 준비 구획을 기존 끌기 밴드 좌표계의 한 밴드(`setup`)로 넣는다 — 규칙(`dropRules.ts`)·해석(`reorder.ts`)·YAML 편집(`yamlDoc.ts`)이 준비 목록을 선택 인자로 받고, 준비 행은 본 스텝 행 컴포넌트(`OutlineRow`)로 그린다. 빈 준비 구획의 놓을 자리는 포인터가 목록 맨 위 영역에 있을 때만 열린다(순수 판정 함수 + 내용 좌표).

**Tech Stack:** TypeScript · React · Zustand · Zod · `yaml` Document API · dnd-kit · vitest/RTL · Playwright(라이브)

**Spec:** `docs/superpowers/specs/2026-11-23-vu-setup-steps-b1-design.md`. US 블록은 spec 머리(「사용자 스토리 (US)」).

**목업(시각 기준, 사용자 승인 2026-11-23):** `docs/superpowers/specs/2026-11-23-vu-setup-steps-b1-mockups/b1-screens.html` — 장면 1 「다」(놓을 자리 `.dropzone`, 아래 버튼 `.setup-add`), 장면 2(상자 안 버튼 `.box-add`, `.setup-box.target`, `.setup-box.refuse`), 장면 3 Inspector, 장면 4 갤러리. **이 파일의 CSS가 시각 기준이다**: 값을 그대로 Tailwind 클래스로 옮긴다(목업의 `--a*`는 `accent-*`, `--s*`는 `slate-*`). 「가」·「나」·「다-2」는 기각안이고 노란 테두리(`.new`)는 구현하지 않는다. 목업과 이 plan의 글이 어긋나면 목업이 이긴다(문구와 「놓을 자리가 열리는 시점」만은 spec·plan이 이긴다 — 목업의 결정 메모 참조).

## Global Constraints

- `ui/`만 고친다. `crates/`·proto·마이그레이션 **0-diff**.
- 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). 새 키 둘: `ko.editor.addSetupStep = "+ 준비 스텝"`, `ko.editor.setupDropHint = "여기에 놓으면 준비 스텝이 됩니다"`. 화면 문구에 「로그인」을 쓰지 않는다(갤러리 템플릿의 내용은 예외).
- **기존 테스트 파일 `ui/src/scenario/__tests__/dropRules.test.ts`·`reorder.test.ts`·`reparent.test.ts`는 한 글자도 고치지 않는다**(본 스텝끼리의 끌기 불변의 회귀 가드). 새 테스트는 새 파일에.
- 준비 구획을 건드리지 않는 편집은 YAML에 `setup:` 키를 만들지 않는다.
- http가 아닌 스텝이 준비 구획에 들어가는 길을 만들지 않는다.
- 「준비가 있는가」는 `setupSteps(model).length > 0`으로만 판단한다.
- Zustand 셀렉터 안에서 새 배열·객체를 만들지 않는다(`s.model`을 고르고 `useMemo`).
- 놀라운 동작을 변호하는 주석을 쓰지 않는다(working-rules §7) — 고치거나 report에 적는다.
- 회귀 가드 테스트는 되돌려 확인한다(고친 줄을 옛 상태로 → RED → 원복 → GREEN). 결과를 task report에 적는다.
- 테스트 파일은 `__tests__/` 안에만. **테스트 파일을 먼저 고친 뒤 src를 고친다**(`tdd-guard`).
- src 편집은 Edit 도구로만 한다(python·sed로 고치지 않는다 — 훅을 건너뛴다).
- 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(인자 없는 전체). 커밋은 단일 foreground 호출, `| tail` 금지, `--no-verify` 금지. 커밋 메시지 끝에 저장소의 attribution 줄(디스패치 brief가 준다).
- task report는 `.superpowers/sdd/`에만. 워크트리 루트에 `.md`를 만들거나 `git add`하지 않는다.

## Review Focus

1. **준비 없는 시나리오에서 첫 행을 집었다 제자리에 놓기**(움직이지 않고 누르기 포함) — 준비 스텝이 되면 안 된다. → Task 2 판정 함수 테스트 + Task 7 + 라이브 US5 ⓐⓑⓒ.
2. **손으로 쓴 flow 표기 `setup: {steps: []}`에 끌어 넣기** — block 표기로 바뀌고 서버가 읽어야 한다. → Task 3 테스트 + 라이브(저장 200).
3. **마지막 본 스텝을 준비로 끈 뒤 되돌리기** — 본 스텝 0개에서 준비 스텝을 본 스텝 자리로 끌 수 있어야 한다. → Task 2(`"band:top"`) + Task 7.
4. **준비 스텝을 키보드로 집었을 때** — 후보가 준비 형제뿐이어야 한다(본 스텝이 후보가 되면 순서가 엉뚱하게 바뀐다). → Task 2.
5. **준비 스텝을 끄는 동안 끄는 미리보기가 안 뜸** — `FlowOutline`이 끄는 스텝을 본 스텝에서만 찾으면 생긴다. jsdom은 못 잡는다. → Task 6 구현 지시 + 라이브 US1.

## 파일 구조

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/scenario/dropRules.ts` | 준비 밴드·놓을 자리 id·놓을 자리 열림 판정 | 2 |
| `ui/src/scenario/reorder.ts` | `resolveDrop`이 준비 밴드·부모 없는 놓을 자리를 해석 | 2 |
| `ui/src/scenario/yamlDoc.ts` | `reparentStep`의 준비 목적지 · Edit `addSetupStep` | 3 |
| `ui/src/scenario/store.ts` | `addSetupStep` | 3 |
| `ui/src/components/scenario/Inspector.tsx` | 준비 스텝의 ↑↓ | 4 |
| `ui/src/scenario/templates.ts` | 「로그인 흐름」 준비 스텝 형태 | 5 |
| `ui/src/components/scenario/FlowOutline.tsx` | 준비 행 = `OutlineRow` · 추가 버튼 · 준비 ↔ 본 끌기 · 강조/흐림 | 6 |
| `ui/src/components/scenario/FlowOutline.tsx` · `ui/src/scenario/dropRules.ts` | 빈 준비 놓을 자리(맨 위 영역) · 빈 본 스텝 놓을 자리 · 그릴지 말지 판정 | 7 |
| `ui/src/i18n/ko.ts` | 새 문구 둘 | 6 |

테스트 픽스처 id(새 테스트 파일들이 각자 둔다) — `"01HX0000000000000000000S01"` 꼴: `S1`·`S2`·`S3`(준비), `B1`·`B2`(본 http), `K1`(loop)·`C1`·`C2`(loop 안 http), `F1`(if)·`C3`(if then 안 http), `P1`(parallel)·`C4`·`C5`(레인 안 http). **id 글자에 `I`·`L`·`O`·`U`를 쓰지 않는다** — `ULID_RE`(`model.ts`)가 거절해 픽스처가 통째로 안 읽히고, 「아무 일도 없다」류 테스트가 공허하게 통과한다(기존 `setupEdit.test.ts`의 `L1 = "…L01"`이 그 상태다 — Task 3이 고친다). **YAML 픽스처를 쓰는 테스트 파일은 모두 「픽스처가 읽힌다」를 먼저 단언한다**(`loadFromString` 뒤 `expect(st().yamlError).toBeNull()`과 `expect(st().model).not.toBeNull()`, 또는 `parseScenarioDoc` 결과에 `"model" in parsed`).

---

### Task 1: 놓을 자리 실측 (orchestrator가 직접 한다 — subagent에 넘기지 않는다)

spec D11의 값과 방식은 가설이다. 구현 전에 실제 브라우저로 확인해 이 plan의 「Task 1 결과」에 적는다. **버리는 코드다 — 커밋하지 않는다.**

**Files:** 임시로 `ui/src/components/scenario/FlowOutline.tsx`(끝나면 되돌린다). 결과는 이 plan 파일.

- [ ] **Step 1:** `tdd-guard`를 풀 임시 `it.todo`를 `ui/src/components/scenario/__tests__/FlowOutline.setup.test.tsx`에 한 줄 더한다.
- [ ] **Step 2:** `FlowOutline.tsx`에 임시 코드: 목록 내용의 맨 위에 ref를 건 빈 `div`, `handleDragStart`에서 `grabY = activatorEvent.clientY − ref.getBoundingClientRect().top`, `handleDragMove`에서 `y = grabY + event.delta.y`를 `console.log`, `y < 24 && grabY − y > 8`이면 목록 맨 위에 높이 40px·아래 여백 10px의 `div`(목업 `.dropzone` 치수)를 끼운다.
- [ ] **Step 3:** `cd ui && pnpm dev`(소유자 확인 뒤 — 루트 CLAUDE.md 포트 함정), Playwright로 `http://localhost:5173/scenarios/new`(템플릿 「데이터 기반」 또는 스텝 6개 이상)에서 눌러 끄는 방식(`page.mouse.down → move → 관측 → up`)으로 잰다. 세 마운트 각각(기본 / 「스텝 넓게 보기」 / 「변수 넓게」):
  1. 목록을 실제로 스크롤하는 요소(행을 품은 조상 가운데 `scrollHeight > clientHeight`이고 스크롤되는 것 — `document.documentElement` 포함).
  2. 그 요소를 스크롤시키며 끌 때 `delta.y`가 스크롤만큼 반영되는가(`y`가 내용 좌표로 맞는가).
  3. `overflow-anchor: none`을 그 요소에 건 것과 안 건 것에서, scrollTop ≈ 10px 상태로 놓을 자리를 열었을 때 깜빡임.
  4. 첫 행을 집어 위로 20px → 열림, 집은 자리로 돌아옴 → 닫힘. 셋째 행을 집어 둘째 행 근처까지만 → 한 번도 안 열림. 맨 위를 지나쳐 위로 → 열린 채.
  5. 열리고 닫힐 때 끄는 미리보기(`DragOverlay`)가 포인터 아래에 있는가.
  6. 스크롤된 긴 목록에서 화면 아래쪽 행·패널 위쪽 가장자리 바로 아래 행을 각각 집어 맨 위까지 — 자동 스크롤로 닿아 열리는가.
- [ ] **Step 4:** 결과를 아래 「Task 1 결과」에 적는다: 마운트별 스크롤 요소, `overflow-anchor`를 걸 자리, 24px·8px를 그대로 쓸지 바꿀지(바꾸면 Task 2의 상수 값을 이 plan에서 고친다), 「내용 맨 위」를 재는 요소.
- [ ] **Step 5:** 임시 코드와 `it.todo`를 되돌린다 — Edit로 되돌리거나 파일마다 `git restore --source=HEAD -- <경로>`(단독 호출; `checkout`·`stash`는 쓰지 않는다). `git status --porcelain`이 이 plan 파일만 보여야 한다. plan을 커밋한다(docs만).
- [ ] **Step 6: 결과가 plan을 얼마나 바꾸는가** — 숫자(24px·8px)나 `overflow-anchor`를 걸 요소만 달라지면 이 plan의 값을 고치고 진행한다. **방식**이 달라지면(예: `delta`가 문서 스크롤을 반영하지 않아 스크롤을 직접 따라가야 한다, 「내용 맨 위」를 잴 수 없다) Task 7 절을 고쳐 쓴 뒤 `spec-plan-reviewer`에 그 절의 재검토를 받고 나서 Task 7을 디스패치한다.
- [ ] **STOP 조건:** spec D11의 네 성질 가운데 하나라도 어떤 방식으로도 만족시킬 수 없으면 구현을 멈추고 사용자에게 보고한다.

#### Task 1 결과

(구현 세션이 채운다 — 채우기 전에는 Task 7을 디스패치하지 않는다.)

---

### Task 2: 준비 밴드 — 규칙과 해석 (순수 함수)

**Files:**
- Modify: `ui/src/scenario/dropRules.ts`, `ui/src/scenario/reorder.ts`
- Test (새 파일): `ui/src/scenario/__tests__/setupBand.test.ts`

**Interfaces — Produces** (뒤 task가 쓴다):

```ts
// dropRules.ts
export const SETUP_BAND: BandRef;            // { parentId: null, band: "setup" }
export const SETUP_DROP_ID = "band:setup";   // 빈 준비 구획의 놓을 자리 id
export const TOP_DROP_ID = "band:top";       // 본 스텝이 0개일 때의 놓을 자리 id
export function bandKey(ref: BandRef): string;                 // 준비 = "setup", 최상위 = "top"
export function dropId(ref: BandRef): string;                  // SETUP_DROP_ID | TOP_DROP_ID | `band:${parentId}:${band}`
export function parseDropId(id: string): BandRef | null;       // 놓을 자리 id가 아니면 null
export function enumerateBands(steps: ReadonlyArray<Step>, setup?: ReadonlyArray<Step>): BandEntry[];
export function findParentBand(steps: ReadonlyArray<Step>, stepId: string, setup?: ReadonlyArray<Step>): BandRef | null;
export function bandChildren(steps: ReadonlyArray<Step>, ref: BandRef, setup?: ReadonlyArray<Step>): ReadonlyArray<Step> | null;
export function bandIndex(steps: ReadonlyArray<Step>, setup?: ReadonlyArray<Step>): Map<string, string>;
export function legalTargetBands(steps: ReadonlyArray<Step>, activeId: string, setup?: ReadonlyArray<Step>): Set<string>;
export function keyboardCandidateIds(steps: ReadonlyArray<Step>, activeId: string, ids: ReadonlyArray<string>, setup?: ReadonlyArray<Step>): string[];
export const SETUP_ZONE_REACH_PX = 24;
export const SETUP_ZONE_LIFT_PX = 8;
/** 빈 준비 구획의 놓을 자리가 열려 있는가. 두 값 모두 목록 내용 좌표(내용 맨 위 = 0, 아래로 +). */
export function setupZoneOpen(pointerY: number, grabY: number): boolean;
// reorder.ts
export function resolveDrop(steps: Step[], activeId: string, overId: string | null, half: "above" | "below" | null, setup?: ReadonlyArray<Step>): DropResolution | null;
```

`setup` 인자를 안 넘겨도(기본 `[]`) `enumerateBands`는 준비 밴드를 **항상** 등록한다(빈 채로) — 그래서 `legalTargetBands`는 인자 없이도 http를 끌 때 `"setup"`을 합법 집합에 더한다(지금과 다른 유일한 점). 기존 테스트는 그래도 무수정 통과한다: 정확-집합 단언 셋(`dropRules.test.ts`의 parallel 합법 집합, 마지막 자식 둘)은 끄는 것이 parallel이거나 마지막 자식이라 준비가 들지 않고, 나머지는 `.has`다. 그 밖의 함수는 인자 없이 지금과 같은 결과다.

규칙(spec §3):
- `bandKey`: `parentId === null && band === "setup"` → `"setup"`, 그 밖의 `parentId === null` → `"top"`.
- `enumerateBands`: 맨 앞에 최상위, 그다음 준비 밴드(자식 = `setup`), 그리고 `setup`·`steps` 둘 다 같은 재귀로 훑는다.
- `bandAccepts`: 준비 밴드면 `dragged.type === "http"` — **지금의 첫 줄(`ref.parentId === null → true`)보다 앞에** 둔다.
- `legalTargetBands`: 끄는 스텝·형제·출발 밴드를 준비 목록에서도 찾는다. 준비 밴드와 최상위는 최소 1개 밴드가 아니다(마지막 하나도 나간다).
- `keyboardCandidateIds`: 준비 스텝이면 후보는 준비 형제.
- `filterDropCandidates`(시그니처 그대로): 놓을 자리 id는 `parseDropId` → `bandKey`로 판정한다(정규식 사본을 없앤다).
- `resolveDrop`: 놓을 자리 id는 `parseDropId`로 읽어 `{ kind: "reparent", target: { parentId, band, index: 0 } }`(`SETUP_DROP_ID` → `band: "setup"`, `TOP_DROP_ID` → `band: "top"`). 교차 밴드의 `target.band`는 준비면 `"setup"`, 최상위면 `"top"`(지금의 「`parentId === null`이면 `"top"`」을 그대로 두면 준비 목적지가 최상위가 된다).
- `setupZoneOpen(pointerY, grabY)` = `pointerY < SETUP_ZONE_REACH_PX && grabY - pointerY > SETUP_ZONE_LIFT_PX`. (Task 1이 값을 바꿨으면 그 값.)

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `setupBand.test.ts`. 픽스처(모델 객체 — `StepModel.parse`로 만들어 유효함을 보장한다): `setup = [http S1, http S2]`, `steps = [http B1, loop K1{do:[C1, C2]}, http B2]`, `loopOne = [loop K1{do:[C1]}]`, `withIf = [http B1, if F1{then:[C3]}]`, `withPar = [http B1, parallel P1{branches:[[C4],[C5]]}]`.

```ts
it("bandKey: 준비는 setup, 최상위는 top", …)            // bandKey(SETUP_BAND)==="setup", bandKey(TOP_BAND)==="top"
it("준비 밴드는 비어 있어도 등록된다", …)                // enumerateBands(steps).some(b => bandKey(b.ref)==="setup")
it("bandIndex가 준비 스텝을 setup으로 싣는다", …)        // bandIndex(steps, setup).get(S1)==="setup"
it("최상위 http는 준비로 갈 수 있다", …)                 // legalTargetBands(steps, B1, setup).has("setup")
it("loop 안 http(형제 있음)는 준비로 갈 수 있다", …)     // (…, C1, setup).has("setup")
it("loop 안 마지막 http는 준비로 못 간다", …)            // legalTargetBands(loopOne, C1, setup) toEqual(new Set([`${K1}:do`]))
it("loop는 준비로 못 간다", …)                           // (steps, K1, setup).has("setup")===false, has("top")===true
it("if·parallel도 준비로 못 간다", …)                    // (withIf, F1, setup).has("setup")===false; (withPar, P1, setup).has("setup")===false
it("준비 스텝은 최상위·loop do로 갈 수 있다", …)          // (steps, S1, setup): has("top") && has(`${K1}:do`) && has("setup")
it("하나뿐인 준비 스텝도 나갈 수 있다", …)               // setup=[S1]: has("top")
it("하나뿐인 본 스텝도 준비로 갈 수 있다", …)            // steps=[B1]: has("setup")
it("준비 스텝의 키보드 후보는 준비 형제뿐", …)           // keyboardCandidateIds(steps, S1, [S1,S2,B1,B2], setup) toEqual [S1,S2]
it("본 스텝의 키보드 후보는 지금과 같다", …)             // (steps, B1, [S1,S2,B1,K1,B2], setup) toEqual [B1,K1,B2]
it("parseDropId/dropId 왕복", …)                         // SETUP_DROP_ID↔SETUP_BAND, TOP_DROP_ID↔TOP_BAND, `band:${K1}:do`↔{parentId:K1,band:"do"}, parseDropId(B1)===null
it("filterDropCandidates가 band:setup을 합법일 때만 남긴다", …)
it("resolveDrop: 준비 안 같은 밴드 → move", …)           // (steps, S1, S2, "below", setup) toEqual {kind:"move", stepId:S1, toIndex:1}
it("resolveDrop: 본 → 준비 행 위/아래", …)               // (steps, B1, S2, "above", setup).target toEqual {parentId:null, band:"setup", index:1}; "below" → index 2
it("resolveDrop: 준비 → 본 행 아래", …)                  // (steps, S1, B1, "below", setup).target toEqual {parentId:null, band:"top", index:1}
it("resolveDrop: band:setup → 준비 인덱스 0", …)         // (steps, B1, SETUP_DROP_ID, null, []) target {parentId:null, band:"setup", index:0}
it("resolveDrop: band:top → 최상위 인덱스 0", …)         // ([], S1, TOP_DROP_ID, null, setup) target {parentId:null, band:"top", index:0}
it("setupZoneOpen: 영역·들어 올림 두 조건", …)
//   (30, 100)→false  (10, 100)→true  (-50, 100)→true  (20, 23)→false(3px만 위)  (14, 23)→true  (23, 23)→false
```

- [ ] **Step 2:** `cd ui && pnpm test setupBand` → FAIL(없는 export).
- [ ] **Step 3:** `dropRules.ts`·`reorder.ts`를 위 Interfaces·규칙대로 고친다.
- [ ] **Step 4:** `pnpm test setupBand dropRules reorder reparent` → 모두 PASS, 기존 세 파일은 무수정.
- [ ] **Step 5: 되돌려 확인** — ① `bandAccepts`의 준비 줄을 첫 줄 뒤로 옮김 → 「loop는 준비로 못 간다」와 기존 `dropRules.test.ts`의 parallel 합법 집합 단언이 RED ② `keyboardCandidateIds`에서 준비 형제 찾기를 뺌 → 「준비 스텝의 키보드 후보…」 RED ③ `resolveDrop`의 `"top"` 고쳐 쓰기를 되살림 → 「본 → 준비 행 위/아래」 RED. 각각 원복 후 GREEN.
- [ ] **Step 6:** UI 게이트 전체 + 커밋 `feat(ui): 끌기 규칙에 준비 밴드 — dropRules·resolveDrop`.

---

### Task 3: YAML 편집 — 준비 목적지 옮기기 · 준비 스텝 추가

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts`(`bandSeqPath`, `reparentStep` 가지, 새 Edit), `ui/src/scenario/store.ts`
- Test (새 파일): `ui/src/scenario/__tests__/setupReparent.test.ts`

**Interfaces:**
- Consumes: 밴드 이름 `"setup"`(Task 2의 `SETUP_BAND.band`).
- Produces: Edit `{ type: "addSetupStep"; id: string; name: string }` · store `addSetupStep(name: string): string | null`(YAML 오류 상태면 `null`) · store `reparentStep(stepId, { parentId: null, band: "setup", index })`가 동작.
- 기존 테스트 파일 `ui/src/scenario/__tests__/setupEdit.test.ts`도 고친다(아래 Step 1의 「선재 결함」).

규칙(spec §4):
- `bandSeqPath(doc, null, "setup")` → `["setup", "steps"]`. 이 판정은 지금의 첫 줄(`parentId === null → ["steps"]`)보다 앞.
- `reparentStep`: `bandSeqPath`가 돌려준 경로의 첫 칸이 `"setup"`이면(판정은 이 경로로 한다 — `edit.band`를 따로 보지 않는다) 옮길 노드를 빼내기 **전에** `ensureSetupSeq(doc)`로 목적지 seq를 얻는다(「빈 else」 가지의 `doc.setIn(…, createNode([]))`를 타지 않는다). 나머지(같은 seq 인덱스 보정, 출발지가 준비면 `dropEmptySetup`)는 그대로. 옮기는 것은 **노드 그대로**다(새로 만들지 않는다 — 스텝 안 주석이 따라가야 한다).
- `addSetupStep`: `ensureSetupSeq(doc)` 끝에 `addStep`과 같은 내용의 http 노드(`GET` `/`, `assert: [{ status: 200 }]`).
- store `addSetupStep`은 `addStep`과 같은 꼴(오류 게이트 → `newStepId()` → `dispatch`).

- [ ] **Step 1: 실패하는 테스트** — `setupReparent.test.ts`(store를 `loadFromString`으로 채우고 액션을 부른 뒤 `yamlText`·`model`을 본다). 픽스처(이 파일에 둔다): `SETUP_ONE` = 준비 [S1] + 본 [B1, loop K1{C1,C2}]. `SETUP_TWO` = 준비 [S1,S2] + 본 [B1]. `MAIN_ONLY` = 준비 없음, 본 [http B1, loop K1{C1,C2}, http B2] — B1의 `request:` **안**(`method:`와 `url:` 사이)에 주석 `# 본 메모`. 주석을 `- id:` 줄 위에 두지 않는다(seq의 맨 앞 주석은 seq에 붙어 노드를 따라가지 않는다). 각 테스트 머리에서 픽스처가 읽혔는지 단언한다.

  **선재 결함(같은 커밋에서 고친다)**: `setupEdit.test.ts`의 `const L1 = "01HX0000000000000000000L01"`은 ULID가 아니라 `WITH_LOOP` 픽스처가 안 읽히고, 「loop 안의 스텝·컨테이너·없는 id는 옮기지 않는다」가 공허하게 통과한다. `L1`의 값을 `"01HX0000000000000000000K01"`로 바꾸고 그 테스트 머리에 `expect(st().model).not.toBeNull()`을 더한다. 바꾼 뒤 그 테스트가 RED면 가려져 있던 진짜 결함이다 — 고치지 말고 멈춰 report한다.

```ts
it("본 → 준비: setup 키가 steps 키 앞에 생긴다", …)
//   MAIN_ONLY, reparentStep(B1, {parentId:null, band:"setup", index:0})
//   model.setup.steps.map(id) toEqual [B1]; model.steps.some(B1)===false
//   yamlText.indexOf("\nsetup:") < yamlText.indexOf("\nsteps:"); yamlText에 "{"로 시작하는 setup 줄 없음(/setup: *\{/ not match)
it("옮긴 스텝 안의 주석이 따라간다", …)
//   위와 같은 이동 뒤: model.setup.steps[0].id===B1 그리고 yamlText에서 "# 본 메모"의 위치가 "\nsetup:"과 "\nsteps:" 사이
it("위치를 지정해 끼운다", …)
//   SETUP_TWO: reparentStep(B1, {…band:"setup", index:1}) → setup ids [S1,B1,S2], model.steps toEqual []
it("loop 안 http → 준비", …)                 // MAIN_ONLY: reparentStep(C1, {…"setup", index:0}) → setup [C1], loop do [C2]
it("손으로 쓴 flow 표기 setup을 block으로", …)
//   `setup: {steps: []}\nsteps:\n  - …B1…` → 이동 뒤 yamlText가 /setup: *\{/ 에 안 맞고 parseScenarioDoc 성공, setup [B1]
it("준비 → 본(위치 지정), 마지막이면 setup 키 삭제", …)
//   SETUP_ONE: reparentStep(S1, {parentId:null, band:"top", index:0}) → steps ids [S1,B1,K1], model.setup===undefined, yamlText에 "setup:" 없음
it("준비 → loop do", …)                       // SETUP_ONE: reparentStep(S1, {parentId:K1, band:"do", index:1}) → loop do ids [C1,S1,C2], model.setup===undefined
it("loop를 준비에 넣으려 하면 아무 일도 없다", …)
//   MAIN_ONLY: const before = yamlText; reparentStep(K1, {…"setup", index:0}); yamlText===before; model.steps.some(K1)===true
it("본 스텝끼리 옮기면 setup 키가 안 생긴다", …)
//   MAIN_ONLY: reparentStep(B2, {parentId:K1, band:"do", index:0}) → loop do ids [B2,C1,C2] 그리고 yamlText에 "setup" 없음
it("하나뿐인 본 스텝을 준비로 보냈다가 되돌린다", …)
//   본 [B1]만: reparentStep(B1, {…"setup", index:0}) → model.steps toEqual [], setup [B1], yamlError===null
//   이어서 reparentStep(B1, {parentId:null, band:"top", index:0}) → steps ids [B1], model.setup===undefined
it("addSetupStep: 키를 만들고 끝에 붙인다", …)
//   MAIN_ONLY: const id = addSetupStep("Setup 1") → model.setup.steps.map(id) toEqual [id], setup이 steps 앞
//   SETUP_ONE: addSetupStep("Setup 2") → setup ids [S1, 새 id]; 새 스텝 request toMatchObject {method:"GET", url:"/"}(`headers` 기본값 `{}`가 붙으므로 toEqual 아님)
it("addSetupStep: YAML 오류 상태면 null", …)
//   setPendingYamlText("version: [") + commitPendingYaml() → addSetupStep("x")===null, yamlText 불변
```

- [ ] **Step 2:** `pnpm test setupReparent` → FAIL.
- [ ] **Step 3:** 구현(위 규칙). store 인터페이스 선언(`addStep` 선언 옆)과 파일 끝의 `getInitialState`용 액션 객체(`reparentStep: s.reparentStep`이 있는 객체 — 빠뜨리면 `tsc -b`가 실패한다)에 `addSetupStep`을 더한다.
- [ ] **Step 4:** `pnpm test setupReparent setupEdit reparent yamlDoc store` → PASS.
- [ ] **Step 5: 되돌려 확인** — ① `reparentStep`의 `ensureSetupSeq` 가지를 빼고 일반 경로로 → 「setup 키가 steps 키 앞에」 또는 「flow 표기를 block으로」 RED ② `bandSeqPath`의 준비 판정을 첫 줄 뒤로 → 「위치를 지정해 끼운다」 RED(경로가 `["steps"]`가 되어 본 스텝 안에서 움직인다) ③ 옮길 때 노드를 `doc.createNode(node.toJSON())`으로 새로 만들어 넣음 → 「옮긴 스텝 안의 주석이 따라간다」 RED. 각각 원복 후 GREEN.
- [ ] **Step 6:** UI 게이트 전체 + 커밋 `feat(ui): 준비 구획으로 위치 지정 옮기기 · addSetupStep`.

---

### Task 4: Inspector — 준비 스텝의 ↑↓

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`(`MoveButtons`, `HttpStepInspector`의 `{!inSetup && <MoveButtons …/>}`)
- Test: `ui/src/components/scenario/__tests__/Inspector.setup.test.tsx`(기존 파일)

**목업:** 장면 3.

`MoveButtons`의 형제 = 그 스텝이 준비 스텝이면 `setupSteps(model)`, 아니면 지금처럼 `findStepSiblings(model.steps, stepId)`. `!inSetup` 조건을 없앤다. 버튼의 동작은 기존 `moveStep(stepId, toIndex)` 그대로.

- [ ] **Step 1: 테스트를 고친다**(기존 파일):
  - 「준비 스텝에는 ↑↓가 없고 안내 줄과 「본 스텝으로 옮기기」가 있다」 → 이름을 「준비 스텝에도 ↑↓가 있고 …」로, 두 `queryByTitle(...).not.toBeInTheDocument()`를 `getByTitle(...)` 존재 단언으로.
  - 「「본 스텝으로 옮기기」를 누르면…」의 끝 두 줄(`getByTitle(ko.common.moveUp/moveDown)`)을 지운다(옮기기 전에도 있어 이빨이 없다).
  - 새 테스트(준비 3개 `S1,S2,S3` + 본 1개 픽스처):

```ts
it("준비 스텝의 ↓는 준비 구획 안에서 한 칸 내린다", …)
//   select(S1) → ↓ 클릭 → model.setup.steps.map(id) toEqual [S2,S1,S3]; model.steps 불변
it("맨 위 준비 스텝은 ↑가, 맨 아래는 ↓가 꺼져 있다", …)
//   select(S1): ↑ disabled, ↓ enabled / select(S3): ↓ disabled, ↑ enabled
```

- [ ] **Step 2:** `pnpm test Inspector.setup` → 새·고친 테스트 FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm test Inspector` → PASS.
- [ ] **Step 5: 되돌려 확인** — `MoveButtons`의 형제를 `findStepSiblings(steps, …)`로만 되돌림(준비 스텝의 형제가 본 스텝 목록이 되고 index가 −1) → 「맨 위 준비 스텝은 ↑가 … 꺼져 있다」(↑가 켜짐)와 「↓는 … 한 칸 내린다」(순서 불변) RED. 원복.
- [ ] **Step 6:** UI 게이트 전체 + 커밋 `feat(ui): Inspector — 준비 스텝 ↑↓`.

---

### Task 5: 갤러리 「로그인 흐름」을 준비 스텝 형태로

**Files:**
- Modify: `ui/src/scenario/templates.ts`(`LOGIN_FLOW_YAML`)
- Test: `ui/src/scenario/__tests__/templates.test.ts`, `ui/src/pages/__tests__/ScenarioNewPage.gallery.test.tsx`

**목업:** 장면 4.

`LOGIN_FLOW_YAML`: 「로그인」 스텝(id `01HX0000000000000000000320`)을 `setup:\n  steps:` 아래로(`steps:` 키 앞), 「내 정보 조회」(…`321`)는 `steps:`에. 요청·검증·추출·id는 그대로. 주석: `setup:` 위에 한 줄 「준비 스텝: VU마다 한 번만 실행합니다 — 로그인으로 토큰을 받아 둡니다.」, 기존 「값 추출: …」·「`${BASE_URL}`은 … 환경 …」 주석은 남긴다(「값 추출」·「환경」 낱말 유지), 「1단계:」·「2단계:」 주석은 「본 스텝: 반복 실행합니다 — 헤더에 {{token}}을 넣습니다.」 꼴로 고친다. `ko.templates.loginName`·`loginDesc`는 손대지 않는다. `\${BASE_URL}` 이스케이프 유지.

- [ ] **Step 1: 테스트를 고치고 더한다** — `templates.test.ts`:

```ts
it("로그인 흐름: 로그인은 준비 스텝, 내 정보 조회는 본 스텝", …)
//   parseScenarioDoc(login.yaml).model: setup.steps.map(name) toEqual ["로그인"]; steps.map(name) toEqual ["내 정보 조회"]
//   setup.steps[0].extract[0].var==="token"; steps[0].request.headers.Authorization toContain "{{token}}"
it("로그인 흐름: setup 키가 steps 키보다 앞", …)   // yaml.indexOf("\nsetup:") < yaml.indexOf("\nsteps:")
```

  기존 「로그인 템플릿이 extract → {{token}}을 보인다」류 테스트가 `model.steps[0]`을 로그인으로 가정하면 위 구조에 맞게 고친다. id 유일성 테스트가 `model.steps`만 훑으면 `allSteps(model)`로. `ScenarioNewPage.gallery.test.tsx`에: 「로그인 흐름」을 고르면 `getByRole("group", { name: /준비 스텝/ })` 안에 `option` 「스텝: 로그인」이 있고, 상자 밖에 「스텝: 내 정보 조회」가 있다.
- [ ] **Step 2:** `pnpm test templates ScenarioNewPage.gallery` → FAIL.
- [ ] **Step 3:** `LOGIN_FLOW_YAML`을 고친다.
- [ ] **Step 4:** `pnpm test templates ScenarioNewPage InsertTemplateModal TemplatesPage` → PASS(뒤 둘은 「로그인 흐름」 글자를 참조한다 — 깨지면 원인을 보고 그 테스트가 템플릿 모양에 기대는지 확인).
- [ ] **Step 5:** UI 게이트 전체 + 커밋 `feat(ui): 갤러리 「로그인 흐름」 — 로그인을 준비 스텝으로`.

---

### Task 6: 아웃라인 — 준비 행을 본 스텝 행으로, 추가 버튼, 준비 ↔ 본 끌기

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/FlowOutline.setup.test.tsx`(기존 파일)

**목업:** 장면 2(세 그림 모두)와 장면 1 「다」의 아래 버튼.

**Interfaces — Consumes:** Task 2의 `SETUP_BAND`·`bandKey`·`dropId`·`parseDropId`·선택 인자 `setup`을 받는 함수들·`resolveDrop(…, setup)`. Task 3의 store `addSetupStep`·`reparentStep`.

할 일:
1. **`SetupRow`를 없애고** 준비 행을 `OutlineRow`(`band={SETUP_BAND}`, `depth={0}`, `index`, `drag`, `view`)로 그린다. 준비 상자 안에 그 행들을 감싸는 `SortableContext`(items = 준비 id).
2. `OutlineRow`는 준비 밴드의 행이면 `view`와 무관하게 `data-step-id`를 단다(A2 동작 유지 — 기본 마운트의 「스텝으로 가기」가 기댄다).
3. `FlowOutline` 안에서 본 스텝만 보던 자리를 모두 준비도 보게 한다(`const all = useMemo(() => [...setup, ...steps], …)`):
   - `activeStep = findStepById(all, activeId)` — 못 찾으면 준비 스텝을 끌 때 미리보기가 안 뜬다.
   - 충돌 판정 안의 컨테이너 여부 찾기 → `all`.
   - `keyboardCandidateIds(steps, dragId, allIds, setup)` 두 곳.
   - `handleDragStart`: `legalTargetBands(steps, id, setup)`·`bandIndex(steps, setup)`.
   - `handleDragEnd`: `resolveDrop(steps, dragId, overId, half, setup)`.
   - `overBandKey`: 놓을 자리 id는 `parseDropId` → `bandKey`, 행 id는 `findParentBand(steps, id, setup)`.
   - `collisionDetection`의 의존 목록에 `setup`.
   - `EmptyBandDrop`은 `{ id: string }`을 받게 바꾸고 호출부(한 곳)가 `dropId({ parentId, band })`를 넘긴다.
4. **추가 버튼**: 준비가 있으면 상자 안 맨 아래에 `ko.editor.addSetupStep`(목업 `.box-add` → `mt-1.5 rounded-md border border-dashed border-accent-300 px-2.5 py-1 text-xs text-accent-800`). 준비가 없으면 아래 버튼 줄 끝에 같은 글의 버튼(목업 `.setup-add` → 기존 보조 버튼 클래스에서 테두리·글자색만 `border-accent-200 text-accent-800`). 둘 다 `onClick`: `select(addSetupStep(\`Setup ${setup.length + 1}\`))`. 준비가 있을 때 아래 줄 버튼은 내지 않는다.
5. **끄는 동안의 상자 표시**: `drag.activeId !== null`일 때 — 준비 밴드가 가리킨 밴드이고 출발 밴드가 아니면 상자에 `ring-2 ring-accent-300`(목업 `.target`); 합법 집합에 `"setup"`이 없으면 `opacity-[0.55]`(목업 `.refuse`). 출발 밴드가 준비면 합법 집합에 `"setup"`이 늘 있으니 흐려지지 않는다.
6. `ko.ts`에 새 키 둘(Global Constraints의 글자 그대로).

이 task에서 **빈 준비 구획의 놓을 자리(맨 위 영역)와 `"band:top"` 놓을 자리는 만들지 않는다**(Task 7). 준비가 비어 있으면 끌어서 넣을 길이 아직 없다 — 그것이 맞다.

- [ ] **Step 1: 테스트를 고치고 더한다**(`FlowOutline.setup.test.tsx`):
  - 「준비 행에는 끌기 손잡이가 없다」 → 「준비 행에도 끌기 손잡이가 있다」: `within(setupRow).getByRole("button", { name: ko.editor.dragHandleAria("준비 요청") })`.
  - 「끌기 계산은 준비 스텝 id를 모른다」 → 「끌기 계산이 준비 스텝을 안다」: `resolveDrop(model.steps, B1, S1, "below", setupSteps(model))` `toEqual({ kind: "reparent", stepId: B1, target: { parentId: null, band: "setup", index: 1 } })`.
  - **그대로 두고 통과해야 하는 것**: 「준비 행을 누르면 선택된다」, 「넓게 보기에서 준비 행을 누르면 onActivateStep이 불린다」, 「준비 행은 data-step-id를 항상 단다」, 「본 스텝이 없고 준비 스텝만 있어도 그려진다」.
  - 새 테스트:

```ts
it("준비가 있으면 상자 안에 추가 버튼이 있고 아래 줄에는 없다", …)
//   const box = getByRole("group", { name: /준비 스텝/ }); within(box).getByRole("button", { name: "+ 준비 스텝" })
//   getAllByRole("button", { name: "+ 준비 스텝" }) toHaveLength(1)
it("상자 안 추가 버튼: 준비 구획 끝에 새 스텝이 생기고 선택된다", …)
//   클릭 → model.setup.steps.length===2, 마지막 id === selectedStepId, 마지막 name==="Setup 2"
it("준비가 없으면 아래 버튼 줄에 추가 버튼이 있다", …)
//   준비 없는 픽스처: queryByRole("group", { name: /준비 스텝/ }) 없음; 버튼 1개; 클릭 → 상자가 생기고 setup.steps.length===1, name "Setup 1"
it("YAML 오류 상태에서 추가 버튼을 눌러도 준비 스텝이 안 생긴다", …)
it("준비 행의 손잡이를 움직이지 않고 누르면 그 행이 선택되고 순서는 안 바뀐다", …)
//   user.click(준비 행의 손잡이) — 기존 FlowOutline.test.tsx의 손잡이 누르기와 같은 방식(클릭이 행으로 올라가 select된다)
//   selectedStepId===S1; model.setup.steps.map(id) 불변; yamlText 불변
```

- [ ] **Step 2:** `pnpm test FlowOutline.setup` → FAIL.
- [ ] **Step 3:** 구현(위 1–6).
- [ ] **Step 4:** `pnpm test FlowOutline EditorShell` → PASS(기존 `FlowOutline.test.tsx`는 무수정 통과).
- [ ] **Step 5: 되돌려 확인** — ① 준비 행의 `data-step-id`를 `view` 조건으로 되돌림 → 「준비 행은 data-step-id를 항상 단다」 RED ② 아래 줄 버튼의 「준비가 없을 때만」 조건을 뺌 → 「…아래 줄에는 없다」 RED. 원복.
- [ ] **Step 6: 브라우저로 한 번 본다**(구현자가 아니라 orchestrator — 이 task의 리뷰 전에): `pnpm dev`의 `/scenarios/new`(빈 템플릿)에서 화면 버튼으로 시나리오를 만든다(`+ HTTP 스텝` ×3, `+ 반복`, `+ 준비 스텝` ×2 — Monaco에 YAML을 넣지 않는다). 준비 2개 + 본 3개(loop 하나 포함)로 ① 준비 행을 끌어 순서 바꿈 ② 본 http → 준비 둘째 자리 ③ 준비 → loop 안 ④ loop를 집으면 상자가 흐려짐 — 각각 끄는 미리보기가 뜨고, 놓은 뒤 순서가 맞고, 목업 장면 2와 상자 표시가 같은지(스크린샷 대조). 어긋나면 이 task 안에서 고친다.
- [ ] **Step 7:** UI 게이트 전체 + 커밋 `feat(ui): 아웃라인 — 준비 행 끌기·추가 버튼·구획 사이 옮기기`.

---

### Task 7: 빈 구획의 놓을 자리 — 맨 위 영역에서 열리는 준비 자리 · 본 스텝 0개의 자리

**선행 조건:** 「Task 1 결과」가 채워져 있다.

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`, `ui/src/scenario/dropRules.ts`(그릴지 말지 판정 함수 둘)
- Test: `ui/src/scenario/__tests__/setupBand.test.ts`(Task 2가 만든 파일에 이어 쓴다), `ui/src/components/scenario/__tests__/FlowOutline.setupZone.test.tsx`(새 파일)

**목업:** 장면 1 「다」의 `.dropzone` / `.dropzone.over`(모양만 — 열리는 시점은 spec D11).

**Interfaces — Consumes:** Task 2의 `setupZoneOpen`·`SETUP_DROP_ID`·`TOP_DROP_ID`·`dropId`, Task 6이 바꾼 `EmptyBandDrop({ id })`.

할 일(spec D11·D11-2 — 구현 전에 그 두 절을 읽는다):
1. **준비 놓을 자리** — 조건이 모두 참일 때만 목록 내용의 맨 위에 그린다: 준비가 비어 있음 · 끄는 중 · 합법 집합에 `"setup"` · 포인터로 집었음(`activatorEvent`가 키보드 이벤트가 아님) · `setupZoneOpen(pointerY, grabY)`.
   - `grabY`: `handleDragStart`에서 `누른 화면 Y − 「내용 맨 위」 요소의 화면 top`(「내용 맨 위」 요소와 재는 법은 Task 1 결과). `pointerY = grabY + event.delta.y`를 `handleDragMove`에서 계산한다. 충돌 판정이 받는 `pointerCoordinates`를 이 판정에 쓰지 않는다.
   - 열림 여부는 state(그리기)와 ref(충돌 판정이 읽음) 둘 다에 둔다. state는 값이 바뀔 때만 set.
   - 모양: `useDroppable({ id: SETUP_DROP_ID })`, 글 `ko.editor.setupDropHint`, 클래스 `mb-2.5 rounded-lg border-[1.5px] border-dashed border-accent-500 bg-accent-100 p-2.5 text-center text-xs font-medium text-accent-800 ring-2 ring-accent-200`(열려 있으면 곧 포인터가 그 위이므로 목업의 `.over` 모양으로 그린다). 「본 스텝」 머리 줄은 내지 않는다.
   - **충돌 판정**: 놓을 자리가 열려 있으면 다른 계산 없이 `[{ id: SETUP_DROP_ID }]`를 돌려준다(`nearestByHeader`의 거리 비교에 넣지 않는다).
   - 끌기가 끝나거나 취소되면 state·ref를 닫는다.
2. **`overflow-anchor: none`** — Task 1 결과가 정한 요소(들)에 건다.
3. **본 스텝 0개의 놓을 자리** — `steps.length === 0`이고 끄는 스텝이 준비 스텝이면(끌기 시작부터) 본 스텝 자리에 `<EmptyBandDrop id={TOP_DROP_ID} />`. `filterDropCandidates`가 `"top"` 합법 여부로 통과시킨다(Task 2).

- [ ] **Step 1: 실패하는 테스트** — jsdom은 끌기를 못 한다. 그릴지 말지를 정하는 순수 함수 둘을 `dropRules.ts`에 두고 테스트한다(컴포넌트 파일에 두면 `react-refresh/only-export-components` 경고로 lint가 실패한다):

```ts
// dropRules.ts
export function showSetupZone(a: {
  setupCount: number; dragging: boolean; legal: ReadonlySet<string> | null;
  keyboard: boolean; pointerY: number; grabY: number;
}): boolean;
export function showTopZone(a: { mainCount: number; draggingSetupStep: boolean }): boolean;
```

  테스트(`ui/src/scenario/__tests__/setupBand.test.ts`에 이어 쓴다 — 순수 함수라서):

```ts
it("showSetupZone: 다섯 조건이 모두 참일 때만", …)
//   기준 {setupCount:0, dragging:true, legal:new Set(["top","setup"]), keyboard:false, pointerY:10, grabY:100} → true
//   각 조건을 하나씩 깨면 false: setupCount:1 / dragging:false / legal:new Set(["top"]) / legal:null / keyboard:true / pointerY:30 / grabY:12
it("showSetupZone: 첫 행을 집었다 제자리(pointerY===grabY)면 닫힘", …)   // {…, pointerY:23, grabY:23} → false
it("showTopZone", …)   // {mainCount:0, draggingSetupStep:true}→true, {1,true}→false, {0,false}→false
```

  그리고 `FlowOutline.setupZone.test.tsx` — **연기 확인용(회귀 가드가 아니다)**: jsdom은 치수가 모두 0이고 끌기 이동이 없어 놓을 자리 동작을 밟지 못한다. 이 파일은 구현 전에도 통과한다. Review Focus 1의 가드는 위 순수 함수 테스트와 라이브 US5 ⓐⓑⓒ다.

```ts
it("준비 없는 시나리오: 끌지 않는 동안 놓을 자리가 없다", …)   // queryByText(ko.editor.setupDropHint) 없음
it("준비 없는 시나리오: 첫 본 행의 손잡이를 누르기만 하면 아무것도 안 바뀐다", …)
//   user.click(첫 본 행의 손잡이) → yamlText 불변, model.setup===undefined, 놓을 자리 글 없음
```
- [ ] **Step 2:** `pnpm test setupBand` → 새 순수 함수 테스트 FAIL(없는 export). `FlowOutline.setupZone`은 통과한다(위 설명).
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm test FlowOutline setupBand` → PASS.
- [ ] **Step 5: 브라우저로 확인**(orchestrator, 이 task의 리뷰 전에): Task 1의 Step 3 항목 3–6을 실제 구현으로 다시 — 세 마운트에서. 그리고 본 스텝 1개 + 준비 0개 시나리오에서 그 스텝을 준비로 끈 뒤 준비 스텝을 「여기로 드롭」에 놓아 되돌린다. 어긋나면 이 task 안에서 고친다.
- [ ] **Step 6:** UI 게이트 전체 + 커밋 `feat(ui): 아웃라인 — 맨 위 영역에서 열리는 준비 놓을 자리 · 빈 본 스텝 놓을 자리`.

---

## 구현 뒤 (plan task가 아니다 — 슬라이스 파이프라인)

- 최종 리뷰 `handicap-reviewer`. 초점: 본 스텝끼리의 끌기가 달라졌는가(기존 세 테스트 파일 무수정 확인 + `FlowOutline.tsx`의 충돌 판정 diff), `SetupRow`가 하던 일의 누락, 밴드 키 계약(`bandKey`·`parseDropId`·`bandSeqPath`·`resolveDrop`)의 일치.
- 라이브 검증: spec §8의 US 표와 극단값 표 전부(`/live-verify`) — 저장·test-run이 들어가므로 컨트롤러가 필요하다. 「스텝 넓게 보기」·「변수 넓게」 포함.
- `finish-slice` §0 보안 grep.
- 기록: build-log·roadmap(§B 새 번호 — B2, 키보드 구획 사이 옮기기, 스텝 템플릿의 준비 삽입, 준비 구획 컨테이너[spec §6], 내가 정한 것[이름 `Setup N`·24px/8px·`"band:top"` 자리])·현황판·`ui/src/components/scenario/CLAUDE.md`의 밴드 키 계약 불릿(「4곳」 → 지금 목록).
