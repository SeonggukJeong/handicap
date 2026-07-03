# 에디터 편집 게이트 + 비율 floor 버그 2건 수정 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pre-existing 버그 2건 수정 — (A) 깨진 YAML 버퍼(`yamlError`) 상태에서 아웃라인/인스펙터 구조적 편집을 store 레벨에서 차단하고 주요 어포던스를 시각 비활성화, (B) 리포트 비율 `.toFixed(1)`이 nonzero<0.05%를 "0.0%"로 오표기하는 것을 공유 `floorPct`로 "<0.1%" floor.

**Architecture:** UI-only. A = Zustand store `dispatch`/`reparentStep`/`removeStep` 진입 가드 + id-반환 add 액션 9종 `null` 반환(형제 `addStepExtract` 가드 일반화) + 연필/드래그/배너 시각 표식. B = `report/format.ts`에 순수 `floorPct`/`formatErrPct` 추가 후 5개 표시 지점 배선. 백엔드/proto/migration/Zod 스키마 0-diff.

**Tech Stack:** TypeScript + React + Zustand + Vitest/RTL. 게이트 = `pnpm lint && pnpm test && pnpm build`(pre-commit UI 게이트가 ui/ 커밋마다 자동 실행).

## Global Constraints

- **spec 단일 소스**: `docs/superpowers/specs/2026-07-04-editor-gate-errpct-fixes-design.md`(R1~R8). 각 task의 요구사항은 그 R-id를 참조.
- **0-diff(R7)**: 엔진/controller/proto/migration/worker·`ui/src/api/schemas.ts`·`ui/src/scenario/model.ts`·`yamlDoc.ts`·`reorder.ts`·`dropRules`·`components/report/verdictFormat.ts`·`components/report/ConnectionCostCard.tsx`는 **건드리지 않는다**.
- **`pnpm build`(`tsc -b`)가 최종 게이트** — `pnpm test`(esbuild)는 TS strict를 놓친다. **`pnpm lint`는 `--max-warnings=0`**(경고=실패).
- **`select(id: string | null)`**(store.ts:75)이 이미 null 허용 → id-반환 add가 `null`을 돌려줘도 호출부 무변경.
- **테스트 파일 먼저(tdd-guard)**: 각 task는 `__tests__/*` 편집(pending RED)을 src 편집보다 **먼저**. 테스트 경로 파일은 tdd-guard가 항상 허용.
- **단일 파일 테스트**: `pnpm test <name>`(‼ `--` 붙이면 전체 스위트). 머지 전 인자 없는 `pnpm test`(전체) 1회.
- **문구는 `ko.ts` 경유**(ADR-0035). aria-label 포함.
- **byte-identical 정상 경로(R8)**: 모든 가드는 `yamlError===null`이면 falls-through, native `disabled={false}`는 React가 속성 omit.

---

### Task 1: store 편집 게이트 가드 (R1, R8)

**Files:**
- Create: `ui/src/scenario/__tests__/store.editGate.test.ts`
- Modify: `ui/src/scenario/store.ts` (인터페이스 add 반환타입 ~39-54, `reparentStep` ~230, `removeStep` ~224, `dispatch` ~316, 9개 add 액션 본문)

**Interfaces:**
- Produces: 9개 id-반환 add 액션(`addStep`/`addLoopStep`/`addStepInLoop`/`addIfStep`/`addStepInBranch`/`addLoopInBranch`/`addIfInLoop`/`addParallelStep`/`addStepInParallelBranch`)의 반환 타입이 `string` → **`string | null`**(locked 시 null). 소비처(FlowOutline/Inspector)는 `select(string|null)`로 무변경.

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/scenario/__tests__/store.editGate.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: 01J0000000000000000000000A
    name: login
    type: http
    request:
      method: POST
      url: https://x/login
`;
const ID = "01J0000000000000000000000A";

// 깨진 YAML 버퍼(yamlError) 상태 진입: 유효 모델 적재 → 선택 → unparseable 버퍼 커밋 실패.
function enterYamlErrorState() {
  const s = useScenarioEditor.getState();
  s.loadFromString(YAML);
  s.select(ID);
  s.setPendingYamlText("version: 1\nsteps: [oops"); // unparseable
  s.commitPendingYaml(); // parse 실패 → yamlError 설정, model=last-good, pending 잔존
}

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("edit gate while yamlError is set (R1)", () => {
  it("dispatch-기반 편집은 no-op (model/doc/yamlText/yamlError/pendingYamlText/selectedStepId 불변)", () => {
    enterYamlErrorState();
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull(); // 전제
    const before = {
      model: s.model, doc: s.doc, yamlText: s.yamlText,
      yamlError: s.yamlError, pendingYamlText: s.pendingYamlText, selectedStepId: s.selectedStepId,
    };
    s.setName("renamed");
    s.setStepField(ID, ["request", "url"], "https://y/login");
    s.moveStep(ID, 0);
    s.removeStep(ID);
    const after = useScenarioEditor.getState();
    expect(after.model).toBe(before.model); // 참조 동일 = 무변이 증명
    expect(after.doc).toBe(before.doc);
    expect(after.yamlText).toBe(before.yamlText);
    expect(after.yamlError).toBe(before.yamlError);
    expect(after.pendingYamlText).toBe(before.pendingYamlText);
    expect(after.selectedStepId).toBe(before.selectedStepId); // removeStep가 선택을 비우지 않음
  });

  it("reparentStep도 no-op", () => {
    enterYamlErrorState();
    const before = useScenarioEditor.getState().model;
    useScenarioEditor.getState().reparentStep(ID, { parentId: null, band: "top", index: 0 });
    expect(useScenarioEditor.getState().model).toBe(before);
  });

  it("id-반환 add 액션은 null 반환 (phantom-select 방지)", () => {
    enterYamlErrorState();
    const s = useScenarioEditor.getState();
    expect(s.addStep("x")).toBeNull();
    expect(s.addLoopStep("x")).toBeNull();
    expect(s.addIfStep("x")).toBeNull();
    expect(s.addParallelStep("x")).toBeNull();
    expect(s.addStepInLoop("nope", "x")).toBeNull();
    expect(s.addIfInLoop("nope", "x")).toBeNull();
    expect(s.addStepInParallelBranch("nope", 0, "x")).toBeNull();
    expect(useScenarioEditor.getState().model).toBe(s.model); // 여전히 무변이
  });

  it("yamlError=null 정상 상태면 편집은 그대로 적용 (R8 회귀 제어)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().setName("renamed");
    expect(useScenarioEditor.getState().model!.name).toBe("renamed");
    expect(useScenarioEditor.getState().addStep("Step 2")).not.toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test store.editGate`
Expected: FAIL — locked 상태 편집이 상태를 바꿔 `toBe` 단언 실패 + `addStep` 등이 non-null 반환.

- [ ] **Step 3: store.ts 인터페이스 반환타입 확장** — 9개 add 선언(store.ts ~39-53)의 `: string`을 `: string | null`로.

```ts
  addStep(name: string): string | null; // returns new id (null when yamlError)
  addLoopStep(name: string): string | null;
  addStepInLoop(loopId: string, name: string): string | null;
  // (addIfStep / addStepInBranch / addLoopInBranch / addIfInLoop /
  //  addParallelStep / addStepInParallelBranch 도 동일하게 `: string | null`)
```
`insertTemplateSteps(...): string`은 **그대로**(tplReady 게이트로 locked 시 도달불가, spec §4.1).

- [ ] **Step 4: 가드 4곳 추가** — store.ts

`dispatch`(~316, `if (!doc) return;` 바로 뒤·`applyEdit` 이전):
```ts
function dispatch(set, get, edit) {
  const doc = get().doc;
  if (!doc) return;
  if (get().yamlError !== null) return; // 편집 게이트(R1): 깨진 YAML 버퍼 동안 무변이
  applyEdit(doc, edit);
  // ... 이하 기존
}
```
`reparentStep`(~230, `if (!doc) return;` 뒤):
```ts
  reparentStep(stepId, target) {
    const doc = get().doc;
    if (!doc) return;
    if (get().yamlError !== null) return; // 편집 게이트(R1)
    const clone = doc.clone();
    // ... 이하 기존
```
`removeStep`(~224, selection clear **이전** 최상단):
```ts
  removeStep(stepId) {
    if (get().yamlError !== null) return; // 편집 게이트(R1) — selection clear 이전
    if (get().selectedStepId === stepId) set({ selectedStepId: null });
    dispatch(set, get, { type: "removeStep", stepId });
  },
```
9개 add 액션 본문 최상단(id 생성 이전)에 `if (get().yamlError !== null) return null;`. 예:
```ts
  addStep(name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    dispatch(set, get, { type: "addStep", id, name });
    return id;
  },
```
(나머지 8개도 동일 첫 줄 추가. `addBranch`/`addElif`/`removeBranch`/`removeElif` 등 non-id·dispatch-only는 dispatch 가드로 이미 no-op — 추가 변경 없음.)

- [ ] **Step 5: 통과 확인**

Run: `cd ui && pnpm test store.editGate`
Expected: PASS (4 tests).

- [ ] **Step 6: teeth-check** — `dispatch`의 가드 줄을 잠시 주석 처리 → `pnpm test store.editGate` → 첫 테스트 FAIL 확인 → 복원(가드가 실제로 이빨이 있음을 실증). 기존 store 회귀 확인: `cd ui && pnpm test store` (store.test.ts·store.addStepExtract.test.ts green).

- [ ] **Step 7: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.editGate.test.ts
git commit -m "fix(ui): 깨진 YAML(yamlError) 동안 구조적 편집 차단 — store 게이트 (R1)

dispatch/reparentStep/removeStep 진입 가드 + id-반환 add 9종 null 반환
(형제 addStepExtract 가드 일반화). 정상 상태 byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 2: 비율 floor 헬퍼 + 5 표시 지점 (R5, R6)

**Files:**
- Modify: `ui/src/components/report/format.ts` (헬퍼 추가)
- Modify: `ui/src/components/report/ReportHeadline.tsx:17`, `WorkerBreakdownTable.tsx:42`, `InsightPanel.tsx:17`, `Summary.tsx:26,31`, `ui/src/components/compare/InsightCompareMatrix.tsx:28`
- Modify(test): `ui/src/components/report/__tests__/format.test.ts` + 5 컴포넌트 테스트 파일(케이스 추가)
- **미변경**: `ConnectionCostCard.tsx`(reusePct=`style.width` 입력·제외, spec §3.3/§7)

**Interfaces:**
- Produces: `floorPct(pct: number): string`(0–100), `formatErrPct(errors: number, count: number): string` — from `components/report/format.ts`.

- [ ] **Step 1: 헬퍼 실패 테스트** — `ui/src/components/report/__tests__/format.test.ts`에 append

```ts
import { floorPct, formatErrPct } from "../format"; // 기존 import에 병합

describe("floorPct (R5)", () => {
  it("진짜 0은 0.0%", () => expect(floorPct(0)).toBe("0.0%"));
  it("nonzero<0.05는 <0.1%로 floor", () => expect(floorPct(0.03)).toBe("<0.1%"));
  it("표시 최소값 0.1%는 그대로", () => expect(floorPct(0.1)).toBe("0.1%"));
  it("정상값 불변", () => expect(floorPct(50)).toBe("50.0%"));
});
describe("formatErrPct (R5)", () => {
  it("count 0이면 —", () => expect(formatErrPct(0, 0)).toBe("—"));
  it("1/3000은 <0.1%", () => expect(formatErrPct(1, 3000)).toBe("<0.1%"));
  it("에러 0은 0.0%", () => expect(formatErrPct(0, 100)).toBe("0.0%"));
});
```

- [ ] **Step 2: 5 컴포넌트 테스트에 tiny-nonzero 케이스 추가** — 각 파일이 *이미 쓰는 렌더 fixture를 복사*해 값만 바꾸고 "<0.1%" 단언:
  - `report/__tests__/ReportHeadline.test.tsx`: 기존 render를 `summary`에 `count: 3000, errors: 1`로 → `expect(screen.getByText(/<0\.1%/)).toBeInTheDocument()` (헤드라인 문장에 포함).
  - `report/__tests__/WorkerBreakdownTable.test.tsx`: 워커 행 fixture에 `count: 3000, errors: 1` → 그 행에 `<0.1%`.
  - `report/__tests__/InsightPanel.test.tsx`: 인사이트 하나의 `pct`를 `0.0003`(=0.03%)로 → `<0.1%`.
  - `compare/__tests__/InsightCompareMatrix.test.tsx`: 비교 인사이트의 `pct`를 `0.0003`으로 → 대표값 셀에 `<0.1%`.
  - `report/__tests__/Summary.test.tsx`: `targetRps` 설정 + `dropped: 1`·`summary.count: 3000` → 드롭 카드 텍스트에 `<0.1%`(예: `getByText(/1 \(<0\.1%\)/)` 또는 `/<0\.1%/`).

> 각 케이스는 **기존 fixture를 그대로 복사**하고 위 필드만 바꾼다(fixture 모양은 파일에서 확인). RED가 목적이라 import 미해결/floorPct 부재로 실패해도 무방.

- [ ] **Step 3: 실패 확인**

Run: `cd ui && pnpm test format ReportHeadline WorkerBreakdownTable InsightPanel InsightCompareMatrix Summary`
Expected: FAIL(floorPct 미export + 각 지점 아직 "0.0%").

- [ ] **Step 4: 헬퍼 구현** — `ui/src/components/report/format.ts`에 append

```ts
/** 백분율(0–100)을 표시 문자열로. nonzero인데 표시 최소값(0.1%) 미만이면 "<0.1%"로 floor
 *  — 에러/드롭이 실재하는데 "0.0%"로 보이는 오해 방지(R5). 진짜 0은 "0.0%". */
export function floorPct(pct: number): string {
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** 에러율(errors/count) 표시 — count 0이면 "—". */
export function formatErrPct(errors: number, count: number): string {
  return count === 0 ? "—" : floorPct((errors / count) * 100);
}
```

- [ ] **Step 5: 5 지점 배선** — 각 파일 상단 import에 `floorPct`(에러율 2곳은 `formatErrPct`) 추가 후:
  - `report/ReportHeadline.tsx:17`: `errPct: summary.count === 0 ? "0%" : floorPct((summary.errors / summary.count) * 100),`(count===0 dead 분기는 기존 "0%" 유지).
  - `report/WorkerBreakdownTable.tsx:42`: `{formatErrPct(w.errors, w.count)}` (기존 `w.count === 0 ? "—" : ...` 삼항 통째 대체 — formatErrPct가 count===0을 "—"로 처리).
  - `report/InsightPanel.tsx:17` `pctStr`: `return v === undefined ? "" : floorPct(v * 100);`.
  - `compare/InsightCompareMatrix.tsx:28`: `if (i.pct != null) return floorPct(i.pct * 100);` (import는 `../report/format`).
  - `report/Summary.tsx:26,31`: `const dropPct = floorPct(dropRate * 100);` + 템플릿 `value: `${droppedCount.toLocaleString()} (${dropPct})`,`(‼ 기존 리터럴 `%` 제거 — floorPct가 이미 `%` 포함, 이중 `%` 금지).

> **이중 `%` 확인**: `floorPct` 반환은 `"50.0%"`/`"<0.1%"`로 이미 `%` 포함. `Summary`만 호출부가 리터럴 `%`를 붙였으니 제거. `InsightPanel.pctStr`·`InsightCompareMatrix.repNumber`는 `%`가 반환 *안쪽*이라 소비처에 리터럴 `%` 없음=clean swap.

- [ ] **Step 6: 통과 확인**

Run: `cd ui && pnpm test format ReportHeadline WorkerBreakdownTable InsightPanel InsightCompareMatrix Summary`
Expected: PASS(신규 + 기존 케이스 전부).

- [ ] **Step 7: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes
git add ui/src/components/report/format.ts ui/src/components/report/ReportHeadline.tsx ui/src/components/report/WorkerBreakdownTable.tsx ui/src/components/report/InsightPanel.tsx ui/src/components/report/Summary.tsx ui/src/components/compare/InsightCompareMatrix.tsx ui/src/components/report/__tests__/format.test.ts ui/src/components/report/__tests__/ReportHeadline.test.tsx ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx ui/src/components/report/__tests__/Summary.test.tsx ui/src/components/compare/__tests__/InsightCompareMatrix.test.tsx
git commit -m "fix(ui): 에러율/비율 nonzero<0.05%를 '<0.1%'로 floor — 공유 floorPct (R5,R6)

report/format.ts floorPct·formatErrPct + 5 표시 지점(에러율 2·인사이트 2·드롭율 1).
reusePct(=style.width 입력)는 제외. verdictFormat(.toFixed(2))·Summary 에러카드(raw count) 무관.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 3: 연필 rename 게이트 (R2)

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx:72`
- Modify(test): `ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx`

- [ ] **Step 1: 실패 테스트 추가** — `ScenarioEditPage.name.test.tsx`의 `describe` 안에 케이스 추가(기존 `renderPage`·`ko`·`act`·`useScenarioEditor` 재사용):

```ts
  it("YAML 오류(yamlError) 상태면 이름 편집 연필이 비활성 (R2)", async () => {
    renderPage();
    const pencil = await screen.findByRole("button", { name: ko.editor.renameAria });
    expect(pencil).toBeEnabled(); // 정상 상태 = 활성 (R8)
    act(() => useScenarioEditor.setState({ yamlError: "boom" }));
    expect(pencil).toBeDisabled();
    expect(pencil).toHaveAttribute("title", ko.editor.renameDisabledTitle);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioEditPage.name`
Expected: FAIL(yamlError 설정 후에도 연필이 활성).

- [ ] **Step 3: 게이트 조건 추가** — `ScenarioEditPage.tsx:72`

```ts
  const nameEditable = seeded && editorModel !== null && editorYamlError === null;
```
(`editorYamlError`는 line 37에서 이미 셀렉트됨. `disabled={!nameEditable}`·`title` 삼항은 기존 그대로 — `renameDisabledTitle`(ko.ts:594, "YAML 파싱 오류를 먼저 해결…")이 맞음, 신규 ko 키 불요.)

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScenarioEditPage.name`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes
git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx
git commit -m "fix(ui): 이름 편집 연필을 yamlError 상태에서 비활성 (R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 4: FlowOutline 드래그 비활성 (R3)

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx` (`OutlineRow` ~268-323)
- Modify(test): `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

- [ ] **Step 1: 실패 테스트 추가** — `FlowOutline.test.tsx`에 케이스 추가(기존 `NESTED_YAML`·`ko`·`render` 재사용):

```ts
  it("YAML 오류(yamlError) 상태면 드래그 핸들이 비활성 (R3)", () => {
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
    useScenarioEditor.setState({ yamlError: "boom" });
    render(<FlowOutline />);
    expect(screen.getByRole("button", { name: ko.editor.dragHandleAria("login") })).toBeDisabled();
  });

  it("정상 상태면 드래그 핸들이 활성 (R8)", () => {
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
    render(<FlowOutline />);
    expect(screen.getByRole("button", { name: ko.editor.dragHandleAria("login") })).toBeEnabled();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: FAIL(yamlError 상태에서도 핸들 활성).

- [ ] **Step 3: OutlineRow에 editLocked 구독 + 배선** — `FlowOutline.tsx`

`OutlineRow`가 이미 `useScenarioEditor` 훅을 쓰므로(selectedStepId/select, ~274-275) yamlError를 직접 구독(재귀 prop threading 불요):
```ts
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const editLocked = useScenarioEditor((s) => s.yamlError) !== null; // 편집 게이트(R3)
```
`useSortable`(~269)에 `disabled` 추가:
```ts
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
      data: { parentId: band.parentId, band: band.band, index },
      disabled: editLocked,
    });
```
드래그 핸들 `<button>`(~313-324)에 native `disabled`만 추가(‼ 기존 `ref={setActivatorNodeRef}`·`{...attributes}`·`{...listeners}`·`className` **전부 유지** — ref를 빠뜨리면 드래그 액티베이터 바인딩이 깨진다). false면 React가 속성 omit=byte-identical(R8):
```tsx
  const dragHandle = (
    <button
      type="button"
      disabled={editLocked}
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={ko.editor.dragHandleAria(step.name)}
      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
    >
      ⠿
    </button>
  );
```
(`OutlineRowPreview`는 드래그 중에만 렌더=locked 시 도달불가 → 무변경.)

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS(신규 + 기존 드래그/reorder 케이스).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "fix(ui): FlowOutline 드래그를 yamlError 상태에서 비활성 (R3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 5: ValidationBanner 편집 차단 안내 (R4)

**Files:**
- Modify: `ui/src/components/scenario/ValidationBanner.tsx`, `ui/src/i18n/ko.ts` (`editor` 네임스페이스)
- Modify(test): `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx`

- [ ] **Step 1: 실패 테스트 추가** — `ValidationBanner.test.tsx`(기존 `EMPTY_URL_YAML`·`ko`·`render` 재사용):

```ts
  it("yamlError 상태면 편집 차단 안내를 렌더한다 (R4)", () => {
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner />);
    expect(screen.getByText(ko.editor.editBlockedWhileInvalid)).toBeInTheDocument();
  });

  it("step 문제만 있고 yamlError가 없으면 편집 차단 안내는 없다 (R4)", () => {
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML); // 빈 URL=step 문제, yamlError=null
    render(<ValidationBanner />);
    expect(screen.queryByText(ko.editor.editBlockedWhileInvalid)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ValidationBanner`
Expected: FAIL(`ko.editor.editBlockedWhileInvalid` 미정의 → 타입/런타임 에러 또는 문구 부재).

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`의 `editor` 객체(‘renameDisabledTitle’ 인근)에:

```ts
    editBlockedWhileInvalid: "YAML 오류를 고칠 때까지 아웃라인·인스펙터 편집이 차단됩니다.",
```

- [ ] **Step 4: 배너 한 줄 추가** — `ValidationBanner.tsx`, 기존 `{hasGate && <p ...>{ko.editor.problemGateIntro}</p>}` 바로 뒤:

```tsx
      {yamlError !== null && (
        <p className="mt-1 text-xs font-medium">{ko.editor.editBlockedWhileInvalid}</p>
      )}
```
(Callout variant/`role="status"`/문제 목록 구조 무변경 — ADR-0043.)

- [ ] **Step 5: 통과 확인**

Run: `cd ui && pnpm test ValidationBanner`
Expected: PASS(신규 2 + 기존).

- [ ] **Step 6: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes
git add ui/src/components/scenario/ValidationBanner.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/ValidationBanner.test.tsx
git commit -m "fix(ui): yamlError 시 ValidationBanner에 편집 차단 안내 (R4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz"
```

---

### Task 6: 최종 게이트 + 라이브 검증 (R7, R8, 라이브)

**Files:** 없음(검증 전용).

- [ ] **Step 1: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고 · 전체 테스트 green · `tsc -b && vite build` 성공.

- [ ] **Step 2: R7 0-diff 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-gate-errpct-fixes && git diff --stat master..HEAD`
Expected: `ui/src`(+ docs)만. **엔진/controller/proto/migration/worker·`schemas.ts`·`scenario/model.ts`·`yamlDoc.ts`·`reorder.ts`·`dropRules*`·`verdictFormat.ts`·`ConnectionCostCard.tsx` 미포함** 확인.

- [ ] **Step 3: 라이브 Playwright (A — 순수 UI, 백엔드 불필요)**

`/scenarios/new`(클라-only, 템플릿 선택 후) 또는 저장 시나리오에서, YAML 모달에 단일 토큰 편집으로 파스를 깨 `yamlError`를 만든 뒤 아웃라인으로 복귀해 실측:
- 연필(`✎`) 버튼 `disabled`(getBounding/`toBeDisabled` 상당 — `el.disabled===true`).
- 드래그 핸들 held-drag 시 `getBoundingClientRect` top-델타 0(무이동).
- ValidationBanner에 편집 차단 문구 존재.
- 인스펙터 필드 편집(URL 등) 후 `useScenarioEditor.getState().model` 불변(no-op) 실측.
- 콘솔 에러 0.

> **DOM-존재만으로 PASS 금지**([[implementation-rigor-over-spec]] #5) — `disabled`/드래그 델타/model 참조를 실측. 상세 운전법은 `/live-verify` 시 `docs/dev/live-verify-playwright.md`. **B는 결정적 단위/컴포넌트 테스트(Task 2)로 종결** — tiny 비율 라이브 재현 불요.

- [ ] **Step 4: 최종 확인** — 모든 R(R1~R8) acceptance가 닫혔는지 spec §6 표와 대조. (커밋 없음 — 검증 task.)

---

## Self-Review (작성자 체크)

- **Spec coverage**: R1→Task1, R2→Task3, R3→Task4, R4→Task5, R5/R6→Task2, R7→Task6 Step2, R8→각 Task의 정상-상태 케이스 + Task6 전체 게이트. 전 R에 대응 task 존재.
- **Placeholder scan**: 모든 코드 스텝에 실제 코드/명령. 컴포넌트 테스트 5건만 "기존 fixture 복사 + 지정 값"(구체 값·단언 명시, vague 아님).
- **Type consistency**: 9개 add 반환타입 `string | null`(Task1 Step3 인터페이스)과 소비처 `select(string|null)`(Global Constraints) 일치. `floorPct`/`formatErrPct` 시그니처(Task2 Interfaces)가 5 소비처와 일치.

<!-- spec-plan-reviewer clean APPROVE (2026-07-04): spec 3라운드 + plan 1라운드, minor polish 2건(드래그 핸들 ref 명시·인터페이스 범위) 반영 -->
<!-- REVIEW-GATE: APPROVED -->
