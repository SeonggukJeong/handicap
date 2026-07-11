# 저장 안 됨 이탈 가드 Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> spec·plan 모두 spec-plan-reviewer clean APPROVE (spec: 1차 APPROVE-WITH-FIXES→반영→APPROVE / plan: 1차 APPROVE-WITH-FIXES(F1)→반영→APPROVE, 2026-07-12).

**Goal:** 에디터 2페이지(`ScenarioNewPage`, `ScenarioEditPage`)에서 dirty 상태의 라우터 이동·탭 닫기를 확인 다이얼로그로 가드해 편집 데이터 무경고 유실을 없앤다.

**Architecture:** react-router `useBlocker`(data router — 이 앱은 `createBrowserRouter`) + `beforeunload`를 공유 훅 `useUnsavedGuard(dirty)`로 묶고, 공유 다이얼로그 `UnsavedChangesDialog`(onSave 유무로 3버튼/2버튼)를 두 페이지가 렌더한다. 의도된 프로그램적 이동(생성 성공·복제)은 one-shot `bypassNext()`로 통과. **spec: `docs/superpowers/specs/2026-07-12-unsaved-changes-guard-design.md` (R1–R14가 normative — 각 task 머리의 "충족 R" 참조).**

**Tech Stack:** React 18 + react-router-dom ^6.27(설치본 6.30.3) `useBlocker`/`createMemoryRouter` + 기존 `Modal`/`Button` + vitest/RTL.

## Global Constraints

- **subagent는 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard`** — 메인 체크아웃 금지.
- **UI-only**: `crates/`·proto·migration·`deploy/`·`ui/src/api/` 절대 무변경 (spec R11).
- **tdd-guard**: 각 task는 **테스트 파일 편집을 가장 먼저**(pending test 없이 `ui/src` non-test 편집은 훅이 차단).
- **사용자 노출 문구(aria 포함) 전부 `ko.ts` 경유** (ADR-0035, spec R9) — 컴포넌트에 한글 리터럴 금지.
- **커밋 전 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` (pre-commit 훅도 동일 게이트를 돌린다). 단일 파일 반복은 `pnpm test <이름>` (`--` 붙이면 전체 스위트가 도니 금지).
- **커밋은 FOREGROUND 단일 호출**(`run_in_background` 금지), `git commit … | tail` 파이프 금지.
- react-router 6.30의 `createMemoryRouter`는 v7 future-flag `console.warn`을 찍는다 — **테스트 실패 아님, 억제하려고 케이스 변경 금지** (spec §4.6).
- full-suite 간헐 flake(비결정 파일 1개 red)는 격리 실행(`pnpm test <파일>`) green이면 flake 확정 → 재시도 (ui/CLAUDE.md).

---

### Task 1: 테스트 하니스 이주 — `MemoryRouter` → `createMemoryRouter` (9파일, 프로덕션 0-diff)

**충족 R: R12.** `useBlocker`는 data router 밖에서 throw하므로 에디터 2페이지를 렌더하는 기존 테스트 하니스를 먼저 이주한다. 케이스 로직·단언은 **한 글자도 바꾸지 않는다** — render 헬퍼(및 라우터 import)만 교체.

**Files (Modify — 이 9개만, 다른 테스트 파일 금지):**
- `ui/src/pages/__tests__/ScenarioEditPage.dirty.test.tsx`
- `ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx`
- `ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx`
- `ui/src/pages/__tests__/ScenarioEditPage.chrome.test.tsx`
- `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx`
- `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`
- `ui/src/pages/__tests__/ScenarioNewPage.gallery.test.tsx`
- `ui/src/pages/__tests__/ScenarioNewPage.import.test.tsx`
- `ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx`

**Interfaces:**
- Consumes: 없음 (독립 선행 task)
- Produces: data-router 하니스 — Task 4·5의 신규 guard 테스트가 같은 패턴을 복사한다.

- [ ] **Step 1: 변환 패턴 확인 — 예시(ScenarioEditPage.dirty.test.tsx)**

import 교체:
```tsx
// 삭제:
import { MemoryRouter, Route, Routes } from "react-router-dom";
// 추가:
import { createMemoryRouter, RouterProvider } from "react-router-dom";
```

`renderPage` 내부의 라우터 부분만 교체 (fetchMock/QueryClient/StrictMode 래핑 그대로):
```tsx
function renderPage(id = "S1") {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/scenarios/:id", element: <ScenarioEditPage /> }],
    { initialEntries: [`/scenarios/${id}`] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
```

- [ ] **Step 2: 9파일 전부에 같은 변환 적용 — 파일별 라우트 배열은 기존 `<Route>`를 1:1로 옮긴다**

각 파일의 기존 라우트 → `createMemoryRouter` 첫 인자 (element JSX는 기존 그대로):

| 파일 | routes 배열 (기존 `<Route>` 1:1) | initialEntries (기존 그대로) |
|---|---|---|
| ScenarioEditPage.dirty | `[{ path: "/scenarios/:id", element: <ScenarioEditPage /> }]` | `` [`/scenarios/${id}`] `` |
| ScenarioEditPage.name | 위와 동일 | `["/scenarios/S1"]` |
| ScenarioEditPage.save | 위와 동일 | `["/scenarios/S1"]` |
| ScenarioEditPage.chrome | 위와 동일 | `["/scenarios/S1"]` |
| ScenarioEditPage.clone | `[{ path: "/scenarios/:id", element: <ScenarioEditPage /> }, { path: "/scenarios/S2", element: <h1>demo (copy)</h1> }]` | `["/scenarios/S1"]` |
| ScenarioEditPage.testrun | `[{ path: "/scenarios/:id/edit", element: <ScenarioEditPage /> }]` | `["/scenarios/S1/edit"]` |
| ScenarioNewPage.gallery | `[{ path: "/scenarios/new", element: <ScenarioNewPage /> }, { path: "/", element: <div>HOME</div> }, { path: "/scenarios/:id", element: <div>SAVED</div> }]` | `["/scenarios/new"]` |
| ScenarioNewPage.import | `[{ path: "/scenarios/new", element: <ScenarioNewPage /> }]` | `[{ pathname: "/scenarios/new", state }]` (location state 형태 그대로 — `createMemoryRouter`도 지원) |
| ScenarioNewPage.testrun | `[{ path: "/scenarios/new", element: <ScenarioNewPage /> }, { path: "/", element: <div>HOME</div> }]` | `["/scenarios/new"]` |

StrictMode 래핑 유무는 **파일별 기존 그대로**(있으면 유지, 없으면 추가하지 않는다 — 이 task는 하니스 교체만). `QueryClientProvider`가 `RouterProvider`를 감싸는 순서 유지.

- [ ] **Step 3: 전체 스위트 green 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm test`
Expected: 전부 PASS (future-flag console.warn 노이즈는 무시). 실패 시 해당 파일 격리 실행으로 flake/실수 구분.

- [ ] **Step 4: lint/build 게이트**

Run: `pnpm lint && pnpm build`
Expected: 경고 0·타입 에러 0.

- [ ] **Step 5: Commit (foreground 단일 호출)**

```bash
git add ui/src/pages/__tests__
git commit -m "test(ui): 에디터 페이지 테스트 하니스 MemoryRouter→createMemoryRouter 이주 (useBlocker 전제, R12)"
```

---

### Task 2: ko 키 + `UnsavedChangesDialog` 컴포넌트

**충족 R: R2·R3(표면), R9, R13, R14.** onSave 유무로 3버튼/2버튼을 렌더하는 공유 다이얼로그. **saving 중엔 모든 dismiss 경로(버튼·ESC/backdrop/✕) 봉쇄** (spec §3-8).

**Files:**
- Test(먼저): `ui/src/components/__tests__/UnsavedChangesDialog.test.tsx` (Create)
- Modify: `ui/src/i18n/ko.ts` (editor 섹션, `discardConfirm` 아래)
- Create: `ui/src/components/UnsavedChangesDialog.tsx`

**Interfaces:**
- Consumes: 기존 `Modal`(`open/onClose/title/children`), `Button`(`variant`), `ko.editor.*`.
- Produces: `UnsavedChangesDialog` props — `{ open: boolean; body: string; saving?: boolean; onStay: () => void; onDiscard: () => void; onSave?: () => void }`. Task 4·5가 이 시그니처로 마운트.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/__tests__/UnsavedChangesDialog.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { UnsavedChangesDialog } from "../UnsavedChangesDialog";

describe("UnsavedChangesDialog", () => {
  it("onSave 있으면 3버튼([취소][저장 안 하고 이동][저장 후 이동]) + 본문 (R2)", () => {
    render(
      <UnsavedChangesDialog
        open
        body={ko.editor.unsavedBodyEdit}
        onStay={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
    expect(screen.getByText(ko.editor.unsavedBodyEdit)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveSave })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.stayEditing })).not.toBeInTheDocument();
  });

  it("onSave 없으면 2버튼([계속 편집][버리고 이동]) (R3)", () => {
    render(
      <UnsavedChangesDialog
        open
        body={ko.editor.discardConfirm}
        onStay={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: ko.editor.stayEditing })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.discardAndLeave })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveSave })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveCancel })).not.toBeInTheDocument();
  });

  it("open=false면 아무것도 렌더하지 않는다", () => {
    render(
      <UnsavedChangesDialog open={false} body="x" onStay={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("각 버튼이 해당 콜백을 1회 호출한다", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <UnsavedChangesDialog open body="b" onStay={onStay} onDiscard={onDiscard} onSave={onSave} />,
    );
    await user.click(screen.getByRole("button", { name: ko.editor.leaveCancel }));
    await user.click(screen.getByRole("button", { name: ko.editor.leaveDiscard }));
    await user.click(screen.getByRole("button", { name: ko.editor.leaveSave }));
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("non-saving에서 ESC는 onStay를 부른다 (R14 — non-saving 상태 명시)", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    render(
      <UnsavedChangesDialog open body="b" onStay={onStay} onDiscard={vi.fn()} onSave={vi.fn()} />,
    );
    await user.keyboard("{Escape}");
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it("saving 중엔 버튼 3개 disabled + ESC no-op (R13)", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    render(
      <UnsavedChangesDialog
        open
        body="b"
        saving
        onStay={onStay}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeDisabled();
    // 저장 버튼은 saving 중 라벨이 "저장 중…"으로 바뀐다
    expect(screen.getByRole("button", { name: ko.common.saving })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onStay).not.toHaveBeenCalled();
    // 다이얼로그가 여전히 열려 있다
    expect(screen.getByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test UnsavedChangesDialog`
Expected: FAIL — `ko.editor.unsavedTitle` 미존재(타입은 vitest가 안 잡아도 import 런타임 undefined) 또는 `Cannot find module '../UnsavedChangesDialog'`.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`의 `discardConfirm` 줄 바로 아래에:

```ts
    // ── 저장 안 됨 이탈 가드 (unsaved-changes-guard) ──
    unsavedTitle: "저장되지 않은 변경",
    unsavedBodyEdit: "저장되지 않은 변경이 있습니다. 이동하기 전에 저장할까요?",
    leaveCancel: "취소",
    leaveDiscard: "저장 안 하고 이동",
    leaveSave: "저장 후 이동",
    stayEditing: "계속 편집",
    discardAndLeave: "버리고 이동",
```
(신규 페이지 본문은 기존 `discardConfirm` 재사용 — 새 본문 키를 만들지 말 것, spec §4.1.)

- [ ] **Step 4: 컴포넌트 구현** — `ui/src/components/UnsavedChangesDialog.tsx`

```tsx
import { ko } from "../i18n/ko";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * 저장 안 됨 이탈 확인 다이얼로그 (spec 2026-07-12-unsaved-changes-guard §4.3).
 * onSave 있으면 3버튼(편집 페이지), 없으면 2버튼(신규 페이지).
 * saving 중엔 모든 dismiss 경로(버튼·ESC/backdrop/✕)가 봉쇄된다 — in-flight
 * 저장 뒤 stale blocker.proceed()/reset() 레이스를 소스에서 제거(spec §3-8).
 */
export function UnsavedChangesDialog({
  open,
  body,
  saving = false,
  onStay,
  onDiscard,
  onSave,
}: {
  open: boolean;
  body: string;
  saving?: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSave?: () => void;
}) {
  const dismiss = () => {
    if (!saving) onStay();
  };
  return (
    <Modal open={open} onClose={dismiss} title={ko.editor.unsavedTitle}>
      <div className="flex flex-col gap-4">
        <p>{body}</p>
        <div className="flex justify-end gap-2">
          {onSave ? (
            <>
              <Button variant="secondary" onClick={onStay} disabled={saving}>
                {ko.editor.leaveCancel}
              </Button>
              <Button variant="secondary" onClick={onDiscard} disabled={saving}>
                {ko.editor.leaveDiscard}
              </Button>
              <Button onClick={onSave} disabled={saving}>
                {saving ? ko.common.saving : ko.editor.leaveSave}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onStay}>{ko.editor.stayEditing}</Button>
              <Button variant="secondary" onClick={onDiscard}>
                {ko.editor.discardAndLeave}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
```
(2버튼 순서 [계속 편집][버리고 이동]·계속 편집=primary는 사용자 승인 목업 그대로. `Modal.onClose`가 ESC/backdrop/✕ 전부를 나르므로 `dismiss` 게이트 하나로 R13 봉쇄가 완성된다.)

- [ ] **Step 5: 통과 확인**

Run: `pnpm test UnsavedChangesDialog`
Expected: 6 tests PASS.

- [ ] **Step 6: 게이트 + Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/i18n/ko.ts ui/src/components/UnsavedChangesDialog.tsx ui/src/components/__tests__/UnsavedChangesDialog.test.tsx
git commit -m "feat(ui): UnsavedChangesDialog 공유 다이얼로그 + ko 이탈 가드 키 (R2/R3 표면·R9·R13·R14)"
```

---

### Task 3: `useUnsavedGuard` 훅

**충족 R: R1(메커니즘), R4, R5, R7.** `useBlocker` + `beforeunload` + one-shot bypass. **bypass 소비는 dirty 검사보다 무조건 먼저** (spec §3-5/§4.2 normative).

**Files:**
- Test(먼저): `ui/src/hooks/__tests__/useUnsavedGuard.test.tsx` (Create)
- Create: `ui/src/hooks/useUnsavedGuard.ts`

**Interfaces:**
- Consumes: `react-router-dom`의 `useBlocker` (data router 필수).
- Produces: `useUnsavedGuard(dirty: boolean)` → `{ blocker, bypassNext: () => void }` (blocker는 `useBlocker` 반환 그대로 — `blocker.state === "blocked"`, `blocker.proceed?.()`, `blocker.reset?.()`). Task 4·5가 이 시그니처로 호출.

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/hooks/__tests__/useUnsavedGuard.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, RouterProvider, useParams } from "react-router-dom";
import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { useUnsavedGuard } from "../useUnsavedGuard";

/** param-only 이동(/p/1→/p/2)에서 컴포넌트가 마운트 유지되는 실제 조건을 재현하는 하니스.
 *  (편집 페이지 복제 /scenarios/A→/scenarios/B와 동형 — spec §3-5) */
function GuardedPage({ initialDirty }: { initialDirty: boolean }) {
  const { id } = useParams<{ id: string }>();
  const [dirty, setDirty] = useState(initialDirty);
  const { blocker, bypassNext } = useUnsavedGuard(dirty);
  return (
    <div>
      <span data-testid="param">{id}</span>
      <span data-testid="blocker-state">{blocker.state}</span>
      <button onClick={() => setDirty(true)}>make-dirty</button>
      <button onClick={() => setDirty(false)}>make-clean</button>
      <button onClick={() => bypassNext()}>arm-bypass</button>
      <button onClick={() => blocker.proceed?.()}>proceed</button>
      <button onClick={() => blocker.reset?.()}>reset</button>
      <Link to="/p/2">to-p2</Link>
      <Link to="/p/3">to-p3</Link>
      <Link to="/away">away</Link>
    </div>
  );
}

function renderGuarded(initialDirty: boolean) {
  const router = createMemoryRouter(
    [
      { path: "/p/:id", element: <GuardedPage initialDirty={initialDirty} /> },
      { path: "/away", element: <div>AWAY</div> },
    ],
    { initialEntries: ["/p/1"] },
  );
  // 프로덕션(main.tsx)이 StrictMode — useBlocker의 이중 마운트 거동까지 테스트에서 재현
  render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}

describe("useUnsavedGuard", () => {
  it("dirty면 이동을 차단하고 blocked 상태가 된다 (R1)", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(screen.getByTestId("param")).toHaveTextContent("1"); // 잔류
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("blocked");
  });

  it("blocked에서 proceed()하면 이동한다", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    await user.click(screen.getByRole("button", { name: "proceed" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("blocked에서 reset()하면 잔류하고 unblocked로 돌아온다", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    await user.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByTestId("param")).toHaveTextContent("1");
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("unblocked");
  });

  it("clean이면 즉시 이동한다 (R4)", async () => {
    const user = userEvent.setup();
    renderGuarded(false);
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("bypassNext() 후 첫 이동은 dirty여도 통과한다 (R5)", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("button", { name: "arm-bypass" }));
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("clean 이동도 armed 플래그를 소비한다 — 잔존 플래그가 나중 dirty 이동을 통과시키지 않는다 (spec §3-5 잔존 버그 회귀)", async () => {
    const user = userEvent.setup();
    renderGuarded(false); // clean
    await user.click(screen.getByRole("button", { name: "arm-bypass" }));
    await user.click(screen.getByRole("link", { name: "to-p2" })); // clean 통과 + 플래그 소비, 컴포넌트는 마운트 유지
    expect(screen.getByTestId("param")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    await user.click(screen.getByRole("link", { name: "to-p3" }));
    expect(screen.getByTestId("param")).toHaveTextContent("2"); // 차단 = 잔류
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("blocked");
  });

  it("dirty일 때만 beforeunload를 preventDefault한다 (R7)", async () => {
    const user = userEvent.setup();
    renderGuarded(false);
    // jsdom: cancelable 없으면 preventDefault가 no-op이라 반드시 cancelable: true (spec §6)
    const cleanEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvt);
    expect(cleanEvt.defaultPrevented).toBe(false);

    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    const dirtyEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvt);
    expect(dirtyEvt.defaultPrevented).toBe(true);

    // dirty→clean 복귀 시 리스너 해제 (R7 "clean/unmount 시 해제" 자구)
    await user.click(screen.getByRole("button", { name: "make-clean" }));
    const backCleanEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(backCleanEvt);
    expect(backCleanEvt.defaultPrevented).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test useUnsavedGuard`
Expected: FAIL — `Cannot find module '../useUnsavedGuard'`.

- [ ] **Step 3: 훅 구현** — `ui/src/hooks/useUnsavedGuard.ts`

```ts
import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * 저장 안 됨 이탈 가드 (spec 2026-07-12-unsaved-changes-guard §4.2).
 * dirty일 때 pathname이 바뀌는 라우터 이동을 차단(useBlocker)하고, dirty일 때만
 * beforeunload 브라우저 확인창을 켠다. bypassNext()는 의도된 프로그램적 이동
 * (생성 성공·복제 확정) 1회를 통과시키는 one-shot 플래그.
 *
 * 주의 1 — react-router는 라우터당 blocker 1개만 지원한다: 이 훅은 상호배타로
 * 마운트되는 leaf 라우트(에디터 페이지)에서만 호출할 것(동시 마운트 금지).
 * 주의 2 — bypass 소비는 dirty 검사보다 반드시 먼저(무조건): dirty 검사 뒤에
 * 두면 clean 이동에서 short-circuit로 플래그가 잔존해, param-only 이동으로
 * 살아남은 컴포넌트의 나중 dirty 이동을 조용히 통과시킨다(spec §3-5).
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypassRef = useRef(false);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypassRef.current) {
      bypassRef.current = false; // one-shot 무조건 소비 — 순서 normative
      return false;
    }
    return dirtyRef.current && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 레거시 브라우저 경로 (Chrome <119 등) — 모던은 preventDefault만으로 충분
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const bypassNext = () => {
    bypassRef.current = true;
  };

  return { blocker, bypassNext };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm test useUnsavedGuard`
Expected: 7 tests PASS.

- [ ] **Step 5: 게이트 + Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/hooks/useUnsavedGuard.ts ui/src/hooks/__tests__/useUnsavedGuard.test.tsx
git commit -m "feat(ui): useUnsavedGuard 훅 — useBlocker+beforeunload+one-shot bypass (R1/R4/R5/R7)"
```

---

### Task 4: `ScenarioNewPage` 배선 — 취소 confirm 일원화 + 생성 bypass + 2버튼 다이얼로그

**충족 R: R1, R3, R5, R8, R10.**

**Files:**
- Test(먼저): `ui/src/pages/__tests__/ScenarioNewPage.guard.test.tsx` (Create)
- Modify: `ui/src/pages/ScenarioNewPage.tsx`

**Interfaces:**
- Consumes: Task 2 `UnsavedChangesDialog`, Task 3 `useUnsavedGuard`.
- Produces: 없음 (leaf).

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/pages/__tests__/ScenarioNewPage.guard.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioNewPage } from "../ScenarioNewPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CREATED = {
  id: "01HX00000000000000000000ZZ",
  name: "n",
  yaml: "version: 1\nname: n\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/scenarios") && init?.method === "POST") return jsonResponse(CREATED, 201);
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/scenarios/new", element: <ScenarioNewPage /> },
      { path: "/", element: <div>HOME</div> },
      { path: "/scenarios/:id", element: <div>SAVED</div> },
    ],
    { initialEntries: ["/scenarios/new"] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

/** 템플릿 선택 → 에디터 mount 대기 → store 편집으로 dirty 만들기 (dirty 테스트 이디엄) */
async function enterEditorAndMakeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
  await screen.findByRole("button", { name: ko.editor.create }); // 에디터 mount 대기
  await act(async () => {}); // EditorShell 마운트 이펙트 flush (dirty 테스트 이디엄)
  act(() => {
    useScenarioEditor.getState().addStep("새 스텝");
  });
}

describe("ScenarioNewPage 이탈 가드", () => {
  it("dirty에서 취소 클릭 → window.confirm 없이 2버튼 다이얼로그, 잔류 (R1·R3·R8)", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: ko.editor.unsavedTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(ko.editor.discardConfirm)).toBeInTheDocument(); // 신규용 본문
    expect(screen.getByRole("button", { name: ko.editor.stayEditing })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveSave })).not.toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("계속 편집 → 다이얼로그 닫히고 잔류", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    await user.click(
      await screen.findByRole("button", { name: ko.editor.stayEditing }),
    );
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument(); // 에디터 유지
  });

  it("버리고 이동 → HOME으로 이동", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    await user.click(
      await screen.findByRole("button", { name: ko.editor.discardAndLeave }),
    );
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("clean이면 취소가 다이얼로그 없이 즉시 이동한다 (R4)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
    await screen.findByRole("button", { name: ko.editor.create });
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("갤러리 단계에선 가드가 비활성 — 취소 즉시 이동 (R10)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: ko.editor.cancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("dirty여도 만들기 성공 이동은 무프롬프트다 (R5 bypass)", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.create }));
    expect(await screen.findByText("SAVED")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test ScenarioNewPage.guard`
Expected: FAIL — dirty 취소가 window.confirm 경로(구현 전)라 다이얼로그 미노출 / bypass 미구현.

- [ ] **Step 3: 페이지 배선** — `ui/src/pages/ScenarioNewPage.tsx`

import 추가:
```tsx
import { UnsavedChangesDialog } from "../components/UnsavedChangesDialog";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
```

`const dirty = yamlText !== originalYaml;` 바로 아래에 훅 호출 추가(갤러리 단계 early-return보다 앞 — 기존 위치가 이미 앞이다):
```tsx
  const dirty = yamlText !== originalYaml;
  const { blocker, bypassNext } = useUnsavedGuard(dirty);
```

`cancel`에서 window.confirm 제거 (R8):
```tsx
  const cancel = () => navigate("/");
```

생성 성공 시 bypass (R5):
```tsx
          <Button
            onClick={() =>
              mutation.mutate(yamlText, {
                onSuccess: (created) => {
                  bypassNext();
                  navigate(`/scenarios/${created.id}`);
                },
              })
            }
```

에디터 단계 return JSX 하단(`{insertTplOpen && …}` 다음 줄)에 다이얼로그 추가:
```tsx
      <UnsavedChangesDialog
        open={blocker.state === "blocked"}
        body={ko.editor.discardConfirm}
        onStay={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
      />
```
(갤러리 단계 return엔 추가하지 않는다 — dirty=false라 blocked 불가능, R10.)

- [ ] **Step 4: 통과 확인 + 기존 신규 페이지 테스트 회귀**

Run: `pnpm test ScenarioNewPage`
Expected: guard 6 + 기존 gallery/import/testrun/STARTER 전부 PASS (기존 confirm-spy 단언은 "이제 confirm을 아예 안 부름"이므로 그대로 성립).

- [ ] **Step 5: 게이트 + Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioNewPage.tsx ui/src/pages/__tests__/ScenarioNewPage.guard.test.tsx
git commit -m "feat(ui): ScenarioNewPage 이탈 가드 — 취소 confirm 일원화·생성 bypass·2버튼 다이얼로그 (R1/R3/R5/R8/R10)"
```

---

### Task 5: `ScenarioEditPage` 배선 — dirty 호이스팅 + 3버튼 다이얼로그 + saveThenLeave + 복제 bypass

**충족 R: R1, R2, R5, R6, R13.**

**Files:**
- Test(먼저): `ui/src/pages/__tests__/ScenarioEditPage.guard.test.tsx` (Create)
- Modify: `ui/src/pages/ScenarioEditPage.tsx`

**Interfaces:**
- Consumes: Task 2 `UnsavedChangesDialog`, Task 3 `useUnsavedGuard`.
- Produces: 없음 (leaf).

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/pages/__tests__/ScenarioEditPage.guard.test.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const fetchMock = vi.fn();
let putShouldFail = false;
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  putShouldFail = false;
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = { id: "S1", name: "demo", yaml: DEMO_YAML, version: 1, created_at: 0, updated_at: 0 };
const CLONED = { ...DEMO, id: "S2", name: "demo (copy)" };

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    if (putShouldFail) return jsonResponse({ error: "save boom" }, 500);
    const sent = JSON.parse(String(init?.body)) as { yaml: string };
    return jsonResponse({ ...DEMO, yaml: sent.yaml, version: 2 });
  }
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(CLONED, 201);
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [DEMO] });
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/scenarios/:id", element: <ScenarioEditPage /> },
      { path: "/scenarios/:id/runs", element: <div>RUNS</div> },
      // 복제 목적지 stub — 정적 세그먼트가 ":id"보다 우선 매치(기존 clone 테스트와 동일 기법).
      // 실 페이지로 두면 GET /api/scenarios/S2 목까지 필요해져 stub이 간결.
      { path: "/scenarios/S2", element: <h1>demo (copy)</h1> },
    ],
    { initialEntries: ["/scenarios/S1"] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

async function loadAndMakeDirty(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await screen.findByRole("heading", { name: "demo" });
  await act(async () => {}); // EditorShell 마운트 이펙트 flush (dirty 테스트 이디엄)
  act(() => {
    useScenarioEditor.getState().addStep("새 스텝");
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled(),
  );
  return user;
}

describe("ScenarioEditPage 이탈 가드", () => {
  it("dirty에서 실행 목록 링크 클릭 → 3버튼 다이얼로그, 잔류 (R1·R2)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    expect(
      await screen.findByRole("dialog", { name: ko.editor.unsavedTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(ko.editor.unsavedBodyEdit)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveSave })).toBeInTheDocument();
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
  });

  it("취소 → 잔류, 다이얼로그 닫힘", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveCancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
  });

  it("저장 안 하고 이동 → PUT 없이 이동", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveDiscard }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PUT");
    expect(putCall).toBeUndefined();
  });

  it("저장 후 이동 → PUT 성공 후 이동 (R2)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveSave }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PUT");
    expect(putCall).toBeTruthy();
  });

  it("저장 실패 → 잔류·다이얼로그 닫힘·에러 Callout 노출 (R6)", async () => {
    putShouldFail = true;
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveSave }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: ko.editor.unsavedTitle }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
    expect(await screen.findByText(/save boom/)).toBeInTheDocument();
  });

  it("dirty에서 복제(저장 없이) → 가드 이중 프롬프트 없이 이동 (R5 bypass)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.duplicateBtn }));
    // 복제 자체 확인 다이얼로그(기존)에서 "저장 없이 복제"
    await user.click(await screen.findByRole("button", { name: "저장 없이 복제" }));
    // 가드 다이얼로그 개입 없이 S2 stub에 도착(이 하니스는 정적 stub 라우트라 페이지가
    // 언마운트된다 — param-only 생존·seededId 리시드·잔존 플래그 회귀는 훅 테스트
    // (useUnsavedGuard.test "clean 이동도 armed 플래그를 소비")가 커버, 중복 아님).
    await screen.findByRole("heading", { name: "demo (copy)" });
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
  });

  it("clean이면 실행 목록 이동이 무프롬프트다 (R4)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm test ScenarioEditPage.guard`
Expected: FAIL — 다이얼로그 미구현이라 dirty 이동이 그대로 RUNS 전환.

- [ ] **Step 3: 페이지 배선** — `ui/src/pages/ScenarioEditPage.tsx`

import 추가:
```tsx
import { UnsavedChangesDialog } from "../components/UnsavedChangesDialog";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
```

**호이스팅(spec §4.4 주의)**: 기존 line ~69의 `const dirty = originalYaml !== yamlText;`를 **삭제**하고, early-return(`if (isLoading) …` 3연속) *위*(`nameEscapedRef` 선언 다음 줄)로 이동 + 훅 호출:
```tsx
  const dirty = originalYaml !== yamlText;
  const { blocker, bypassNext } = useUnsavedGuard(dirty);

  if (isLoading) return <p className="text-slate-500">{ko.common.loading}</p>;
```

`cloneAndGo`의 navigate 직전에 bypass (R5):
```tsx
      const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
      setCloneDialog(null);
      bypassNext();
      navigate(`/scenarios/${created.id}`);
```

`saveThenClone` 아래에 `saveThenLeave` 추가 (R2·R6):
```tsx
  const saveThenLeave = async () => {
    if (loadedVersion === null) return;
    try {
      const next = await update.mutateAsync({ yaml: yamlText, version: loadedVersion });
      setLoadedVersion(next.version);
      setOriginalYaml(next.yaml);
      blocker.proceed?.();
    } catch {
      // update.error가 페이지-레벨 Callout을 구동한다 — 모달을 닫아야 backdrop에
      // 가리지 않는다(R6, scenario-clone-error-fixes 패턴).
      blocker.reset?.();
    }
  };
```

return JSX 하단(마지막 `</Modal>` 다음, 최상위 `</div>` 앞)에 다이얼로그 추가:
```tsx
      <UnsavedChangesDialog
        open={blocker.state === "blocked"}
        body={ko.editor.unsavedBodyEdit}
        saving={update.isPending}
        onStay={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
        onSave={() => void saveThenLeave()}
      />
```

- [ ] **Step 4: 통과 확인 + 기존 편집 페이지 테스트 회귀**

Run: `pnpm test ScenarioEditPage`
Expected: guard 7 + 기존 dirty/name/save/clone/chrome/testrun 전부 PASS.

- [ ] **Step 5: 게이트 + Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/__tests__/ScenarioEditPage.guard.test.tsx
git commit -m "feat(ui): ScenarioEditPage 이탈 가드 — dirty 호이스팅·3버튼 saveThenLeave·복제 bypass (R1/R2/R5/R6/R13)"
```

---

### Task 6: 전체 게이트 + 범위/문구 스윕 (R8·R9·R11 acceptance)

**충족 R: R8, R9, R11 (검증 전용 — 코드 변경은 발견 시에만).**

**Files:** 없음 (검증 task — 스윕에서 위반 발견 시 해당 파일 수정).

**Interfaces:**
- Consumes: Task 1–5 전체.
- Produces: green 브랜치 (최종 리뷰·라이브 검증 입력).

- [ ] **Step 1: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 green (간헐 flake는 격리 실행으로 확정 후 재시도).

- [ ] **Step 2: R8 스윕 — 신규 페이지 confirm 제거 확인**

Run: `grep -c "window.confirm" src/pages/ScenarioNewPage.tsx || true`
Expected: `0`.

- [ ] **Step 3: R9 스윕 — 신규 파일 한글 리터럴 0**

Run: `grep -nE '"[^"]*[가-힣]' src/components/UnsavedChangesDialog.tsx src/hooks/useUnsavedGuard.ts || echo CLEAN`
Expected: `CLEAN` (매치 0 — 주석 내 한글은 무방하나 이 패턴은 문자열 리터럴만 본다; 매치가 나오면 ko.ts로 이주).

- [ ] **Step 4: R11 스윕 — UI-only diff 범위**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard && git diff --stat master...HEAD -- crates deploy desktop ui/src/api`
Expected: 출력 없음 (0-diff).

- [ ] **Step 5: 위반 발견 시에만 수정 커밋, 아니면 커밋 없음**

Expected: 보통 no-op — 이 task는 커밋이 없어도 된다(검증 로그를 report로 남긴다).

---

### Task 7: 라이브 검증 (orchestrator 직접 수행 — subagent 위임 금지)

**충족 R: R1·R7 라이브 acceptance (spec §6 ①–⑥).** jsdom 신뢰 천장이 낮은 모달/라우팅/beforeunload를 실브라우저로 실측. **orchestrator가 Playwright MCP로 직접 수행** (fake-completed subagent 방지 + `docs/dev/live-verify-playwright.md`의 운전 함정 적용).

- [ ] **Step 1: 스택 기동 (포트 선점 확인 먼저)**

```bash
lsof -i :5173 -i :8080   # stray 프로세스 있으면 cwd 확인 후 kill (다른 워크트리 함정)
cd /Users/sgj/develop/handicap/.claude/worktrees/unsaved-changes-guard
cargo build -p handicap-controller --bin controller
./target/debug/controller --db /tmp/unsaved-guard-live.db &   # --ui-dir 생략 (vite dev가 프록시)
cd ui && pnpm dev &   # 5173
```

- [ ] **Step 2: 시나리오 준비** — UI(새 시나리오 → 템플릿 → 만들기)로 1개 생성.

- [ ] **Step 3: spec §6 ①–⑥ 실측**

(navigate는 `http://localhost:5173` — vite dev는 `[::1]`만 바인드라 `127.0.0.1`은 ERR_CONNECTION_REFUSED, `docs/dev/live-verify-playwright.md`.)

① 편집 페이지에서 스텝 추가(dirty) → 헤더 "데이터셋" 링크 클릭 → 모달 노출을 **스크린샷 + `getBoundingClientRect` 높이>0**으로 실측, URL 미변경 확인.
② [저장 후 이동] → PUT 반영(재진입 시 v2) + 데이터셋 페이지 도착.
③ 다시 dirty → [저장 안 하고 이동]·[취소] 각 1회.
④ dirty → 브라우저 뒤로가기 → 모달.
⑤ dirty → `page.on("dialog", d => d.accept())` **선등록 후** reload → beforeunload dialog 발생 확인 (미등록 시 hang 함정, spec §6).
⑥ 신규 페이지 dirty → 취소 → 2버튼 모달.
(참고: saving 중 뒤로가기를 눌렀다 저장이 완료되면 proceed 목적지가 마지막 blocked 목적지가 된다 — benign, 버그로 오인 금지. spec 리뷰 Nit-2.)

- [ ] **Step 4: 스택 정리** — controller·vite kill, `/tmp/unsaved-guard-live.db` 삭제, `.playwright-mcp` 산출물 정리(머지 전).

---

## 실행 순서·의존성 요약

Task 1(하니스) → Task 2(다이얼로그)·Task 3(훅)은 상호 독립(순차 권장) → Task 4·5(배선, 2·3에 의존) → Task 6(게이트) → Task 7(라이브, orchestrator). 이후 파이프라인 4–6단계: `handicap-reviewer` 최종 리뷰(보안 게이트는 path-gate 예상 N/A — 요청실행/템플릿/env/업로드/trace 미접촉) → `/finish-slice`.
