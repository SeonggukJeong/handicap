# 에디터 UX 폴리시 (변수 패널·뷰포트·rename 실시간) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터의 4가지 UX 마찰 해소 — 변수 사용처 nav 팝오버(#3)·에디터 뷰포트 높이/열별 스크롤(#4)·변수 rename의 열린 스텝 실시간 반영(#5)·변수 검색(#6).

**Architecture:** 전부 `ui/src` UI-only. store에 `renameEpoch` 카운터(성공 rename 시만 ++)를 더해 Inspector draft 3종을 재시드; VariablesPanel에 portal-fixed 사용처 팝오버 + 검색 필터 + 헤더/추가행 pin·리스트 스크롤; EditorShell 그리드를 `grid-rows-[minmax(0,1fr)]`+`max-h`로 뷰포트 제한하고 열별 `overflow-auto`.

**Tech Stack:** React 18 + TypeScript(strict) + Tailwind + Zustand + Vitest/RTL. Spec: `docs/superpowers/specs/2026-07-04-editor-varpanel-viewport-polish-design.md`.

## Global Constraints

- **UI-only·wire 0-diff (R10)**: `crates`/proto/migration/`model.ts`(Zod)/YAML 직렬화 형식/store rename **시그니처**·반환타입 무변경. `git diff --name-only`가 `ui/**`·`docs/**`만. 신규는 전부 additive. **새 ADR 없음**.
- **문구는 `ko.ts` 경유 (R9, ADR-0035)**: 신규 사용자 노출 문구(검색 placeholder·무매치·팝오버 aria) 전부 `ko.editor.*`. 인라인 한글/영어 0.
- **TDD test-first (tdd-guard)**: `ui/src/**` non-test 편집 전에 pending(수정/미추적) 테스트 파일이 있어야 한다 → 각 Task는 **테스트 파일을 먼저** 편집(import 미해결 RED 무방).
- **커밋 게이트**: pre-commit UI 게이트가 `pnpm lint && pnpm test && pnpm build`를 돈다. 각 Task는 그걸 통과한 **독립 green 커밋**. `pnpm test`가 suite-wide 격리 flake로 간헐 red면(ui/CLAUDE.md) 실패 파일 격리 실행(`pnpm test <file>`)해 green이면 flake로 판정하고 재커밋 — 이 슬라이스 변경과 무관.
- **#4 correctness는 라이브가 권위**: jsdom은 레이아웃이 없어 높이/스크롤을 관측 못 한다([[implementation-rigor-over-spec]]). Task 4 RTL은 **클래스 계약**까지만; 실제 캡/스크롤/미클립은 슬라이스 라이브 검증 단계에서 `getBoundingClientRect`/`scrollHeight` 실측.
- **커밋 메시지**: `git commit`은 `run_in_background:false` 단일 호출(폴링 금지). 리포트는 `.superpowers/sdd/`에, worktree 루트에 쓰지 말 것·`git add` 금지.

---

## Task 1: #5 rename 실시간 반영 (store `renameEpoch` + Inspector 재시드)

**충족 R:** R5, R6. **위험도:** 낮음(store 필드 + dep 배열).

**Files:**
- Modify: `ui/src/scenario/store.ts` (state 타입 `:32-39`, `INITIAL` `:100-111`, `renameVariable` 성공 `set` `:174-179`, `renameParallelVar` 성공 `set` `:201-206`)
- Modify: `ui/src/components/scenario/Inspector.tsx` — **하위 컴포넌트 4곳 각각**(최상위 Inspector 본체 아님): `HeadersEditor`(`:423`, KVG `:438`)·`FormBodyField`(`:563`, KVG `:579`)·`JsonBodyField`(`:490`, reseed `:497-503`)·`ExtractEditor`(`:696`, reseed `:703-706`)
- Test: `ui/src/scenario/__tests__/store.renameVariable.test.ts`, `ui/src/scenario/__tests__/store.renameParallelVar.test.ts`, `ui/src/components/scenario/__tests__/Inspector.test.tsx`

**Interfaces:**
- Produces: `ScenarioEditorState.renameEpoch: number` (초기 0, 성공 rename마다 +1). Inspector·다른 컨슈머가 `useScenarioEditor((s) => s.renameEpoch)`로 구독.
- Consumes: 기존 `renameVariable`/`renameParallelVar`(시그니처 불변), `findStepById`, `KeyValueGrid resetKey`.

- [ ] **Step 1: store epoch 실패 테스트 추가** — `store.renameVariable.test.ts`와 `store.renameParallelVar.test.ts`에 각각:

```ts
it("increments renameEpoch on a successful rename, not on a no-op/failure", () => {
  const s = useScenarioEditor.getState();
  s.loadFromString(FIXTURE_YAML); // 기존 파일의 fixture 재사용(변수 1개 이상 선언·참조)
  const before = useScenarioEditor.getState().renameEpoch;
  const ok = useScenarioEditor.getState().renameVariable(OLD, NEW); // parallel 파일은 renameParallelVar(BRANCH, OLD, NEW)
  expect(ok).toBeNull();
  expect(useScenarioEditor.getState().renameEpoch).toBe(before + 1);
  // 실패는 미증가
  const err = useScenarioEditor.getState().renameVariable(NEW, NEW); // self → 미증가
  expect(err).not.toBeNull();
  expect(useScenarioEditor.getState().renameEpoch).toBe(before + 1);
});
```
(`OLD`/`NEW`/`BRANCH`/`FIXTURE_YAML`은 각 파일의 기존 fixture·유효 이름을 재사용. `getInitialState`로 초기 0 확인은 파일 상단 reset 패턴 그대로.)

- [ ] **Step 2: 테스트 실행 → FAIL 확인** — Run: `cd ui && pnpm test store.renameVariable store.renameParallelVar`. Expected: FAIL(`renameEpoch` 프로퍼티 없음/undefined).

- [ ] **Step 3: store에 `renameEpoch` 추가** —
  - `store.ts:32-39` state 타입에 `pendingYamlText` 옆으로 `renameEpoch: number;` 추가.
  - `INITIAL` Pick 유니언(`store.ts:100-107`)에 `| "renameEpoch"` 추가, 객체(`:108-111`)에 `renameEpoch: 0,` 추가.
  - `renameVariable` 성공 `set`(`:174-179`)과 `renameParallelVar` 성공 `set`(`:201-206`)에 `renameEpoch: get().renameEpoch + 1,` 한 줄씩 추가(실패/no-op `return` 분기는 무변경). `getInitialState`(`:480`)는 `{...INITIAL, ...actions}`라 자동 전파 — 무수정.

- [ ] **Step 4: store 테스트 GREEN 확인** — Run: `cd ui && pnpm test store.renameVariable store.renameParallelVar`. Expected: PASS.

- [ ] **Step 5: Inspector 재시드 teeth-check 테스트 추가** — `Inspector.test.tsx`에 (기존 파일의 render/셋업 헬퍼 재사용 — store를 `loadFromString`+`select`로 세팅해 Inspector 마운트):

```ts
it("re-seeds header/JSON-body/extract drafts live when a used variable is renamed", async () => {
  // 헤더 값·JSON 바디·extract var 가 모두 {{tok}}를 쓰는 http 스텝 1개 YAML 로드 후 그 스텝 select
  useScenarioEditor.getState().loadFromString(YAML_WITH_TOK); // 헤더 value "{{tok}}", body.json {"k":"{{tok}}"}, extract var "tok"
  useScenarioEditor.getState().select(STEP_ID);
  render(<Inspector />);
  // 섹션 접힘이면 펼침(editor-space-qol 함정): 헤더/바디/추출 섹션 토글 클릭
  // 헤더 값 입력이 {{tok}} 표시 확인
  expect((screen.getByLabelText(/header value 0/i) as HTMLInputElement).value).toContain("{{tok}}");
  // rename
  act(() => { useScenarioEditor.getState().renameVariable("tok", "renamed"); });
  // 재선택 없이 세 표면이 {{renamed}}로 갱신
  expect((screen.getByLabelText(/header value 0/i) as HTMLInputElement).value).toContain("{{renamed}}");
  // JSON 바디 textarea·extract var 입력도 {{renamed}} / renamed 확인(해당 섹션 펼친 뒤)
});
```
(정확한 aria-label/셀렉터는 기존 `Inspector.test.tsx`의 헤더/바디/추출 케이스에서 복사. 섹션 접힘 토글은 `getByRole("button",{name:섹션제목})` 먼저 — editor-space-qol 함정.)

- [ ] **Step 6: 테스트 실행 → FAIL(teeth) 확인** — Run: `cd ui && pnpm test Inspector`. Expected: rename 후에도 `{{tok}}`로 stale → FAIL(재시드 아직 `[step.id]`).

- [ ] **Step 7: 재시드 dep에 `renameEpoch` 추가 (네 하위 컴포넌트 각각 — F1)** — reseed/`resetKey`를 쓰는 4곳은 전부 **별개 하위 컴포넌트**다: `HeadersEditor`(`:423`, KVG `:438`)·`FormBodyField`(`:563`, KVG `:579`)·`JsonBodyField`(`:490`, reseed `:497-503`)·`ExtractEditor`(`:696`, reseed `:703-706`). 최상위 `Inspector` 본체(`:54-91`)는 이들을 렌더하지 않으므로 **top-level 셀렉터를 두면 unused(lint fail)이고 `resetKey`는 out-of-scope(tsc `TS2304`)**. → **각 하위 컴포넌트 함수 안에** `const renameEpoch = useScenarioEditor((s) => s.renameEpoch);` 추가(넷 다 이미 `useScenarioEditor` 호출 — `:424`/`:564`/`:491`/`:697` — import·패턴 존재). 그런 뒤:
  - `JsonBodyField` reseed: dep `[step.id]` → `[step.id, renameEpoch]`(eslint-disable 유지·`body` 미포함 의도).
  - `ExtractEditor` reseed: dep `[step.id]` → `[step.id, renameEpoch]`.
  - `HeadersEditor`(`:438`)·`FormBodyField`(`:579`): `resetKey={step.id}` → `resetKey={`${step.id}:${renameEpoch}`}`(KVG는 resetKey 변화 시 entries 재시드 — 무변경).

- [ ] **Step 8: Inspector 테스트 GREEN 확인** — Run: `cd ui && pnpm test Inspector`. Expected: PASS(세 표면 `{{renamed}}`).

- [ ] **Step 9: 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`(전체). Expected: PASS. 그다음:

```bash
git add ui/src/scenario/store.ts ui/src/components/scenario/Inspector.tsx \
  ui/src/scenario/__tests__/store.renameVariable.test.ts \
  ui/src/scenario/__tests__/store.renameParallelVar.test.ts \
  ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(editor): renameEpoch — rename이 열린 스텝 draft 3종 실시간 재시드 (#5, R5·R6)"
```

---

## Task 2: #6 변수 검색 (VariablesPanel 필터)

**충족 R:** R7, R8, R9(검색 문구). **위험도:** 낮음(표시 전용 필터).

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (헤더 `:184-188`, `rows` 렌더 `:189-323`, add-var `:325-347`)
- Modify: `ui/src/i18n/ko.ts` (`editor.*` 카탈로그)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`

**Interfaces:**
- Produces: 로컬 `query` state + `matchesRow(row, q)` 필터. 팝오버(Task 3)·add(무영향).
- Consumes: 기존 `rows` useMemo(무변경), `ko.editor.varSearchPlaceholder`/`varSearchEmpty`(신규).

- [ ] **Step 1: 검색 실패 테스트 추가** — `VariablesPanel.test.tsx`:

```ts
it("filters rows by case-insensitive substring over name, value, and branch display", async () => {
  const user = userEvent.setup();
  // 변수 auth(value "Bearer X")·token(참조) 있는 시나리오 로드 후 render
  render(<VariablesPanel />);
  const search = screen.getByPlaceholderText("변수 검색");
  await user.type(search, "AUT"); // 대소문자 무시 → auth 매치, token 미매치
  expect(screen.getByText("auth")).toBeInTheDocument();
  expect(screen.queryByText("token")).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "bearer"); // 값 매치
  expect(screen.getByText("auth")).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "zzz"); // 무매치
  expect(screen.getByText("일치하는 변수 없음")).toBeInTheDocument();
});

it("clears the search query when a variable is added", async () => {
  const user = userEvent.setup();
  render(<VariablesPanel />);
  await user.type(screen.getByPlaceholderText("변수 검색"), "zzz");
  await user.type(screen.getByPlaceholderText("new_var"), "brandnew");
  await user.click(screen.getByRole("button", { name: "추가" })); // ko.editor.variablesAdd
  expect((screen.getByPlaceholderText("변수 검색") as HTMLInputElement).value).toBe("");
  expect(screen.getByText("brandnew")).toBeInTheDocument();
});
```
(fixture·render 셋업은 기존 `VariablesPanel.test.tsx` 패턴 재사용. `추가` 라벨은 기존 `ko.editor.variablesAdd`.)

- [ ] **Step 2: 테스트 실행 → FAIL** — Run: `cd ui && pnpm test VariablesPanel`. Expected: FAIL(검색 입력 없음).

- [ ] **Step 3: ko 키 추가** — `ko.ts`의 `editor` 카탈로그에:
```ts
varSearchPlaceholder: "변수 검색",
varSearchEmpty: "일치하는 변수 없음",
```

- [ ] **Step 4: VariablesPanel 검색 구현** —
  - 컴포넌트에 `const [query, setQuery] = useState("");` 추가.
  - 헤더(`:185-188` `<div className="flex items-center">` 블록) 아래에 검색 입력 추가:
```tsx
<Input
  className="mt-1"
  placeholder={ko.editor.varSearchPlaceholder}
  value={query}
  onChange={(e) => setQuery(e.target.value)}
/>
```
  - `rows` 렌더 직전 필터 도출:
```tsx
const q = query.trim().toLowerCase();
const matchesRow = (r: VarRow): boolean => {
  if (q === "") return true;
  if (r.kind === "declared") return r.name.toLowerCase().includes(q) || r.value.toLowerCase().includes(q);
  if (r.kind === "parallel-extract")
    return r.display.toLowerCase().includes(q) || r.varName.toLowerCase().includes(q) || r.branchName.toLowerCase().includes(q);
  return r.name.toLowerCase().includes(q); // flat-extract, undefined
};
const visibleRows = rows.filter(matchesRow);
```
  - `<ul>` 내부 `rows.map(...)` → `visibleRows.map(...)`. 빈 상태 분기(`:320-322`)를 둘로:
```tsx
{rows.length === 0 && (
  <li className="text-xs text-slate-400 italic">{ko.editor.variablesEmpty}</li>
)}
{rows.length > 0 && visibleRows.length === 0 && (
  <li className="text-xs text-slate-400 italic">{ko.editor.varSearchEmpty}</li>
)}
```
  - add-var 핸들러(`:336-341`)의 `setVariable(k, "")` 뒤 `setNewKey("")` 옆에 `setQuery("");` 추가.

- [ ] **Step 5: 테스트 GREEN** — Run: `cd ui && pnpm test VariablesPanel`. Expected: PASS.

- [ ] **Step 6: 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`. Expected: PASS.
```bash
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/i18n/ko.ts \
  ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(editor): 변수 검색 필터 — 이름·값·분기표기 부분일치 (#6, R7·R8)"
```

---

## Task 3: #3 사용처 nav 팝오버 (`VarUsagePopover`, 순환 제거)

**충족 R:** R1, R2, R9(팝오버 문구). **위험도:** 중(신규 portal 컴포넌트 + 순환 테스트 재작성).

**Files:**
- Create: `ui/src/components/scenario/VarUsagePopover.tsx`
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (`cycleRef`/`nav` 제거 `:47-48,122-142`, `usageCell` `:130-142`, 팝오버 렌더 + `selectedStepId` 셀렉터)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`, `ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx`(신규)

**Interfaces:**
- Produces: `VarUsagePopover({ anchor: HTMLElement, refIds: string[], steps: Step[], selectedStepId: string | null, onJump: (id: string) => void, onClose: () => void })` — portal-fixed 목록, 항목 클릭 → `onJump`(팝오버 유지), 바깥 pointerdown/ESC/scroll → `onClose`.
- Consumes: `findStepById`(model.ts), `METHOD_BADGE`(methodBadge.ts), `summarizeCondition`(model.ts), `createPortal`(react-dom).

- [ ] **Step 1: `VarUsagePopover` 실패 테스트 추가** — `VarUsagePopover.test.tsx`:

```tsx
it("renders referencing steps in a body portal and jumps without closing", async () => {
  const user = userEvent.setup();
  const steps = [ /* http 스텝 s1(name '로그인', method GET), s2(name '주문') */ ];
  const onJump = vi.fn(); const onClose = vi.fn();
  const anchor = document.createElement("button"); document.body.appendChild(anchor);
  render(<VarUsagePopover anchor={anchor} refIds={["s1","s2"]} steps={steps} selectedStepId="s2" onJump={onJump} onClose={onClose} />);
  const menu = screen.getByRole("menu");
  expect(menu.parentElement).toBe(document.body); // portal
  expect(within(menu).getByText("로그인")).toBeInTheDocument();
  await user.click(within(menu).getByText("로그인"));
  expect(onJump).toHaveBeenCalledWith("s1");
  expect(onClose).not.toHaveBeenCalled(); // 항목 클릭은 안 닫음
  // active: selectedStepId 항목
  expect(within(menu).getByText("주문").closest("[role=menuitem]")).toHaveAttribute("aria-current", "true");
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: FAIL 확인** — Run: `cd ui && pnpm test VarUsagePopover`. Expected: FAIL(모듈 없음).

- [ ] **Step 3: ko 키 추가** — `ko.ts` `editor`:
```ts
varUsageListAria: "사용 스텝 목록",
```

- [ ] **Step 4: `VarUsagePopover.tsx` 작성** —
```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findStepById, summarizeCondition, type Step } from "../../scenario/model";
import { METHOD_BADGE } from "./methodBadge";
import { ko } from "../../i18n/ko";

const POPOVER_WIDTH = 240;
const POPOVER_MAX_H = 256; // max-h-64 와 lockstep

function computePos(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const left = r.left + POPOVER_WIDTH > window.innerWidth ? Math.max(8, r.right - POPOVER_WIDTH) : r.left;
  const below = r.bottom + 4;
  // 하단 넘치고 위에 공간 있으면 앵커 위로 flip (R2 하단 edge-flip, F3)
  const top = below + POPOVER_MAX_H > window.innerHeight && r.top > POPOVER_MAX_H ? r.top - 4 - POPOVER_MAX_H : below;
  return { top, left };
}

export function VarUsagePopover({
  anchor, refIds, steps, selectedStepId, onJump, onClose,
}: {
  anchor: HTMLElement;
  refIds: string[];
  steps: Step[];
  selectedStepId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => computePos(anchor));
  useLayoutEffect(() => setPos(computePos(anchor)), [anchor]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) onClose(); }; // 팝오버 내부 스크롤은 무시(F2)
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ko.editor.varUsageListAria}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      className="z-50 max-h-64 overflow-auto rounded-md border border-slate-200 bg-white p-1 text-xs shadow-lg"
    >
      {refIds.map((id) => {
        const s = findStepById(steps, id);
        const active = id === selectedStepId;
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            aria-current={active ? "true" : undefined}
            onClick={() => onJump(id)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-slate-100 ${active ? "bg-accent-50 text-accent-700" : "text-slate-700"}`}
          >
            {s?.type === "http" && (
              <span className={`shrink-0 rounded px-1 font-mono text-[10px] ${METHOD_BADGE[s.request.method] ?? "bg-slate-100 text-slate-600"}`}>
                {s.request.method}
              </span>
            )}
            {s?.type === "if" && (
              <span className="shrink-0 rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500">IF</span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {s ? (s.type === "if" ? summarizeCondition(s.cond) : s.name) : id}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
```
(`Step`의 `.type` 판별로 narrowing — `s.type === "http"`면 `s.request.method`, `s.type === "if"`면 `s.cond`+`IF` 배지(R1 타입 라벨). `pnpm build` `tsc -b`가 union narrowing 확인. `buildVarRefIndex`가 http·if 스텝 id만 기록(`scanVars.ts:107-132`)하므로 refIds는 http|if뿐 — loop/parallel 행의 `else → s.name`은 도달 불가 방어 폴백[R1의 loop·parallel 타입라벨 moot], F5.)

> **R9 판정(sweep 시 명시)**: `IF` 배지는 인라인 리터럴이지만 **DSL 타입 토큰**(에디터 `ChildStepButton`이 이미 `loop`/`parallel`/`if`를 인라인 렌더하는 선례·메서드 배지 `GET`/`POST`와 동류)이라 `ko` 번역 대상 아님 — R9 하드코딩 sweep에서 이 예외를 의식적으로 통과시킨다(번역 필요한 새 라벨 아님).

- [ ] **Step 5: `VarUsagePopover` GREEN** — Run: `cd ui && pnpm test VarUsagePopover`. Expected: PASS.

- [ ] **Step 6: VariablesPanel 순환 테스트 → 팝오버로 재작성(실패)** — `VariablesPanel.test.tsx`의 기존 순환-nav 테스트(사용 카운트 클릭이 refIds를 순환한다는 단언)를 팝오버 단언으로 교체:
```ts
it("opens a usage popover on click and jumps to a step without cycling", async () => {
  const user = userEvent.setup();
  render(<VariablesPanel onJumpToStep={onJump} />); // onJump = vi.fn()
  await user.click(screen.getByRole("button", { name: /사용/ })); // ko.editor.variableUsage(n) 트리거
  const menu = await screen.findByRole("menu", { name: "사용 스텝 목록" });
  await user.click(within(menu).getAllByRole("menuitem")[0]);
  expect(onJump).toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeInTheDocument(); // 안 닫힘
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
```

- [ ] **Step 7: FAIL 확인** — Run: `cd ui && pnpm test VariablesPanel`. Expected: FAIL(아직 순환 버튼).

- [ ] **Step 8: VariablesPanel 팝오버 배선 + 순환 제거** —
  - `cycleRef`(`:47-48`)·`nav`(`:122-127`) 제거 + **`VariablesPanel.tsx:1` import에서 `useRef` 제거**(cycleRef가 유일 소비처였으므로 unused → `--max-warnings=0` lint fail 방지, F4).
  - `const selectedStepId = useScenarioEditor((s) => s.selectedStepId);` 셀렉터 추가.
  - 팝오버 상태: `const [usageNav, setUsageNav] = useState<{ key: string; anchor: HTMLElement; refIds: string[] } | null>(null);`
  - `usageCell`(`:130-142`) 재작성 — 버튼 클릭이 팝오버 토글:
```tsx
const usageCell = (cycleKey: string, ariaName: string, refIds: string[]) =>
  refIds.length === 0 ? (
    <span className="text-xs text-slate-400">{ko.editor.variableUnused}</span>
  ) : (
    <button
      type="button"
      aria-label={ko.editor.variableUsageNavAria(ariaName)}
      aria-expanded={usageNav?.key === cycleKey}
      onClick={(e) =>
        setUsageNav((prev) =>
          prev?.key === cycleKey ? null : { key: cycleKey, anchor: e.currentTarget, refIds },
        )
      }
      className="text-xs text-accent-600 hover:underline"
    >
      {ko.editor.variableUsage(refIds.length)}
    </button>
  );
```
  - `<section>` 안 맨 끝(add-var 위/아래 무관)에 팝오버 렌더:
```tsx
{usageNav && model && (
  <VarUsagePopover
    anchor={usageNav.anchor}
    refIds={usageNav.refIds}
    steps={model.steps}
    selectedStepId={selectedStepId}
    onJump={(id) => onJumpToStep?.(id)}
    onClose={() => setUsageNav(null)}
  />
)}
```
  - `VarUsagePopover` import 추가.

- [ ] **Step 9: VariablesPanel GREEN** — Run: `cd ui && pnpm test VariablesPanel`. Expected: PASS.

- [ ] **Step 10: 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`. Expected: PASS.
```bash
git add ui/src/components/scenario/VarUsagePopover.tsx ui/src/components/scenario/VariablesPanel.tsx \
  ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx \
  ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(editor): 변수 사용처 nav 팝오버(직접 점프) — 순환 대체 (#3, R1·R2)"
```

---

## Task 4: #4 뷰포트 높이 + 열별 스크롤 + 클립 회귀 방지

**충족 R:** R3, R4, R13. **위험도:** 중(CSS — 라이브가 권위).

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx` (grid `:99-105`, aside `:107-115`, 아웃라인/디테일 div `:132-137`)
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (`<section>`/헤더/`<ul>`/add-var 구조 pin — Task 2/3 후 라인 이동, `<section>` 루트·`<ul>`·add-var `<div>` 구조로 locate)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx`, `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`(R13 pin 클래스 계약, F6)

**Interfaces:**
- Consumes: 기존 `wideOpen`/`varsOpen` state, VariablesPanel(Task 2/3 후 구조).
- Produces: 비-wide 그리드 `max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)]`, 열별 `overflow-auto min-h-0`, aside `overflow-visible`+내부 `<ul>` 스크롤.

- [ ] **Step 1: EditorShell 클래스 계약 실패 테스트 추가** — `EditorShell.test.tsx`:
```ts
it("bounds the non-wide editor grid to the viewport with per-column scroll", () => {
  render(<EditorShell initialYaml={SOME_YAML} />);
  const grid = screen.getByTestId("editor-grid");
  expect(grid.className).toContain("grid-rows-[minmax(0,1fr)]");
  expect(grid.className).toContain("max-h-[calc(100vh-16rem)]");
  expect(grid.className).not.toContain("min-h-[680px]");
  // 아웃라인·디테일 열 컨테이너 overflow-auto min-h-0 (직계 자식 div)
  // 변수 aside 는 overflow-visible + 내부 ul overflow-auto
});
```
(정확한 열 컨테이너 셀렉터는 기존 `EditorShell.test.tsx`가 `editor-grid`를 어떻게 집는지 보고 맞춘다. jsdom 한도 — 클래스 계약만.)

그리고 `VariablesPanel.test.tsx`에 R13 pin 계약(F6):
```ts
it("scrolls the variable list while pinning header/add-var (R13)", () => {
  render(<VariablesPanel />);
  const list = screen.getByRole("list"); // <ul>
  expect(list.className).toContain("overflow-auto");
  expect(list.className).toContain("min-h-0");
});
```

- [ ] **Step 2: FAIL 확인** — Run: `cd ui && pnpm test EditorShell VariablesPanel`. Expected: FAIL.

- [ ] **Step 3: EditorShell 그리드/열 클래스 변경** —
  - 비-wide 그리드 className(`:104`)의 `min-h-[680px]` → `max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)]`:
```tsx
: `grid gap-4 max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
```
  - aside(`:108-112`) className: `wideOpen` 분기 + `flex flex-col overflow-visible min-h-0`:
```tsx
className={`flex min-h-0 flex-col overflow-visible rounded-md border border-slate-200 bg-white p-3 ${wideOpen ? "max-h-[calc(100vh-16rem)]" : ""}`}
```
  - 비-wide 아웃라인 div(`:132`): `... overflow-auto` 뒤에 `min-h-0` 추가.
  - 비-wide 디테일 div(`:135`): `... p-3` → `... p-3 overflow-auto min-h-0`.

- [ ] **Step 4: VariablesPanel 구조 pin(헤더/add-var 고정·리스트 스크롤)** —
  - `<section>`(`:184`) className `flex flex-col gap-3` → `flex min-h-0 flex-1 flex-col gap-3`.
  - 헤더 블록(h3 row + 검색 입력, Task 2에서 추가)을 `<div className="shrink-0 flex flex-col gap-1">`로 감싼다(제목 row + 검색).
  - `<ul>`(`:189`) className `flex flex-col gap-3` → `flex min-h-0 flex-1 flex-col gap-3 overflow-auto`.
  - add-var `<div>`(`:325`) className `flex gap-2` → `flex shrink-0 gap-2`.

- [ ] **Step 5: 테스트 GREEN** — Run: `cd ui && pnpm test EditorShell VariablesPanel`. Expected: PASS.

- [ ] **Step 6: 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build`. Expected: PASS.
```bash
git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/VariablesPanel.tsx \
  ui/src/components/scenario/__tests__/EditorShell.test.tsx \
  ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(editor): 에디터 뷰포트 높이·열별 내부 스크롤·헤더/추가행 pin (#4, R3·R4·R13)"
```

> **⚠ #4는 커밋 후 슬라이스 라이브 검증에서 실측 필수**(jsdom 미관측): `editor-grid` 높이 ≤ `innerHeight−16rem`·아웃라인/변수 열 `scrollHeight>clientHeight`·열이 test-run 위로 안 넘침·VarCheatSheet HelpTip 미클립. `<chrome>`=16rem이 부족하면(banner 등) 값 조정 후 재커밋.

---

## Task 5: 연기 항목 roadmap 등재 (R12)

**충족 R:** R12. **위험도:** 없음(docs).

**Files:**
- Modify: `docs/roadmap.md` (§B — 에디터 구조 재설계 B13 계열)

- [ ] **Step 1: roadmap.md §B13에 연기 항목 한 줄 등재** — spec §7 항목을 `docs/roadmap.md`의 에디터(B13) 연기 섹션에 추가: 검색 고급(정규식/스코프 필터/값 하이라이트)·팝오버 화살표키 내비/포커스 트랩·#4 전체화면 셸(test-run 탭 분리)·기존 HelpTip/헤더메뉴 portal화(디테일 열 in-scroll 클립이 라이브서 문제 될 때만)·rename 외 구조편집 draft 재시드(`fieldRewriteEpoch` 일반화).

- [ ] **Step 2: 커밋** —
```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): editor-varpanel-viewport-polish 연기 항목 등재 (R12)"
```

---

## Self-Review (작성자 체크)

- **Spec coverage**: R1·R2→Task 3; R3·R4·R13→Task 4; R5·R6→Task 1; R7·R8→Task 2; R9→Task 2·3(문구)+최종 sweep; R10→Global Constraints+최종 diff grep; R11→각 Task 전체 `pnpm test`+최종; R12→Task 5. 전 R에 task 매핑됨.
- **Placeholder scan**: 코드 스텝은 실코드 포함. 테스트 스텝은 assertion-level 코드 + "기존 파일 셋업 재사용" 명시(fixture/셀렉터는 형제 테스트에서 복사 — repo 관행). #4 정확한 열 셀렉터·`<chrome>` 미세조정은 라이브로 위임(spec이 명시한 의도적 deferral).
- **Type consistency**: `renameEpoch: number` 일관(Task 1 정의→Inspector 소비). `VarUsagePopover` prop 시그니처가 Task 3 Interfaces↔코드 일치. `matchesRow`/`visibleRows` Task 2 내부 일관. `VarRow` 판별(`declared`/`parallel-extract`/`flat-extract`/`undefined`)은 기존 타입 재사용.
- **위험 순서**: Task 1·2(저위험)→3(팝오버)→4(레이아웃, 라이브-heavy)→5(docs). 리뷰어 §8 스코프 노트 반영.

## Execution Handoff

이 plan은 spec-plan-reviewer clean APPROVE + `REVIEW-GATE: APPROVED` 마커 후, **STOP-gate**에 따라 커밋→`/clear`→fresh `/start-slice`로 구현 진입(subagent-driven-development). 구현은 fresh 컨텍스트에서.

spec-plan-reviewer(Opus): spec 3R → clean APPROVE, plan 2R → clean APPROVE.

REVIEW-GATE: APPROVED
