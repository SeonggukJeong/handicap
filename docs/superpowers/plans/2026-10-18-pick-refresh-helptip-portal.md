# 선택 배열 팝업 refresh 체크박스 + HelpTip portal Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선택 배열 팝업에서 "요청마다 새로 뽑기"를 draft로 편집하고, HelpTip popover가 좁은 스크롤 열·모달 안에서 잘리거나 ESC로 모달을 닫지 않게 한다.

**Architecture:** `HelpTip`을 `usePopover`에서 떼어 portal(`[role=dialog][aria-modal=true]` 또는 body) + `position: fixed` 자체 로직으로 바꾸고, 위치 산출은 순수 모듈 `helpTipPos.ts`로 분리한다. 그 위에서 `PickArrayDialog`에 `refreshDraft` 로컬 state + 체크박스·HelpTip 한 줄을 추가한다(적용 시에만 커밋). 순서는 B(HelpTip) → A(팝업) — A가 모달 안에 HelpTip을 새로 넣으므로 B의 ESC 레이어링이 먼저여야 한다.

**Tech Stack:** React 18 + TS + Tailwind, vitest + RTL + user-event v14, `react-dom` `createPortal`.

**Spec:** `docs/superpowers/specs/2026-10-18-pick-refresh-helptip-portal-design.md`

## Global Constraints

- 모든 사용자 노출 문구는 `ko.ts` 경유(ADR-0035) — **이 슬라이스는 새 카피 0**: 팝업 체크박스·HelpTip은 기존 `ko.editor.genRefreshLabel`·`ko.editor.genRefreshHelpLabel`·`ko.glossary.genRefreshIntro`·`ko.glossary.genRefreshPriority`를 재사용.
- `HelpTip` 공개 props(`label`, `children`) 무변경 → 소비처 18파일(`grep -rl "import { HelpTip }" ui/src | grep -v __tests__`) 코드 0-diff.
- `VerdictBadge`·`usePopover` 동작 무변경(usePopover는 주석만 수정).
- refresh 와이어: 체크 = `refresh: "request"`, 해제 = 키 **부재**, 미조작 = `initial.refresh` 그대로(`"iteration"` 포함 — `RefreshModel = z.enum(["iteration","request"])`, `ui/src/scenario/genVars.ts:19`).
- UI 게이트: `cd ui && pnpm lint; echo exit=$?` → `pnpm test; echo exit=$?` → `pnpm build; echo exit=$?` — **파이프(`| tail`) 금지**(종료코드 마스킹). 커밋은 pre-commit UI 게이트가 다시 돈다.
- `tdd-guard`: 각 task에서 **테스트 파일 편집을 먼저** 해야 `ui/src` production 편집이 허용된다.
- 커밋 메시지는 `-F <파일>`(heredoc 안 `git` 금지 — 워크트리 격리 가드), 끝에 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. 화면 **아래쪽 끝 근처**의 HelpTip(리포트 표 마지막 행 등)을 열면 popover가 위로 뒤집혀 전부 보여야 한다 — Task 1 `computeTipPos` "아래 부족→위" 테스트.
2. popover를 연 채 **페이지/열을 스크롤**하면 엉뚱한 곳에 떠 있지 말고 닫혀야 하고, popover **자체를 스크롤**하면 유지돼야 한다 — Task 1 scroll 테스트(window·내부 note 두 경우).
3. HelpTip을 **클릭 핸들러가 있는 조상** 안에 둔 경우 popover 본문 클릭이 조상 동작(행 펼침 등)을 일으키면 안 된다 — Task 1 "React 트리 격리" 테스트.
4. **모달 안**에서 popover를 연 채 ESC → popover만 닫히고 모달(=팝업 draft)은 유지 — Task 1(Modal+HelpTip) + Task 2(PickArrayDialog 실물) 테스트.
5. 손으로 `refresh: iteration`을 적은 선택 배열을 팝업에서 체크박스를 **건드리지 않고** 적용하면 `iteration`이 보존돼야 한다 — Task 2 ⑤ 테스트.

---

### Task 1: HelpTip을 portal + fixed로 (ESC 레이어링·클립 해소) + 관련 문서 정정

**Files:**
- Create: `ui/src/components/helpTipPos.ts`
- Create: `ui/src/components/__tests__/helpTipPos.test.ts`
- Modify: `ui/src/components/HelpTip.tsx` (전면 교체)
- Modify: `ui/src/components/__tests__/HelpTip.test.tsx` (`left-0`/`right-0` 2케이스 교체 + 신규 케이스)
- Modify (주석/문서만): `ui/src/components/usePopover.ts:3-8`(JSDoc — 1행 import는 유지), `ui/src/components/scenario/ExtractConfirmRow.tsx:21-24`, `ui/CLAUDE.md`(`<HelpTip>` U1a 항목), `ui/src/components/scenario/CLAUDE.md`(`:12` 변수 aside 문장, `:84` ExtractConfirmRow 괄호)

**Interfaces:**
- Produces: `export const TIP_WIDTH_PX = 224;` · `export function computeTipPos(anchor: { top: number; bottom: number; left: number; right: number }, popH: number, vp: { width: number; height: number }): { top: number; left: number }` (`ui/src/components/helpTipPos.ts`). `HelpTip`은 시그니처 불변 `({ label, children }: { label: string; children: ReactNode })`. 열림 시 popover = `role="note"` 요소가 `[role="dialog"][aria-modal="true"]` 조상 안이면 그 다이얼로그 노드의 자식, 아니면 `document.body`의 자식. Task 2가 이 동작(모달 안 ESC는 tip만 닫음)에 기댄다.

- [ ] **Step 1: `computeTipPos` 실패 테스트 작성**

`ui/src/components/__tests__/helpTipPos.test.ts` 생성:

```ts
import { describe, expect, it } from "vitest";
import { computeTipPos, TIP_WIDTH_PX } from "../helpTipPos";

const VP = { width: 1280, height: 900 };
const rect = (left: number, top: number, w = 16, h = 16) => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

describe("computeTipPos", () => {
  it("기본: 앵커 아래 4px, 앵커 좌단 정렬", () => {
    expect(computeTipPos(rect(100, 100), 120, VP)).toEqual({ top: 120, left: 100 });
  });

  it("우단을 넘치면 앵커 우단 정렬(edge-flip)", () => {
    // left 1200 + 224 > 1280 - 8 → left = right(1216) - 224
    expect(computeTipPos(rect(1200, 100), 120, VP).left).toBe(1216 - TIP_WIDTH_PX);
  });

  it("좌측은 8px 여백으로 clamp", () => {
    expect(computeTipPos(rect(2, 100), 120, VP).left).toBe(8);
  });

  it("아래 공간이 부족하고 위 공간이 있으면 위로 뒤집힌다", () => {
    // below = 816+4 = 820, 820+200 > 892 → above = 800-4-200 = 596
    expect(computeTipPos(rect(100, 800), 200, VP).top).toBe(596);
  });

  it("위아래 모두 부족하면 뷰포트 하단 8px에 맞춘다", () => {
    const vp = { width: 1280, height: 300 };
    // below 120+250 > 292, above 100-4-250 < 8 → 300-250-8 = 42
    expect(computeTipPos(rect(100, 100), 250, vp).top).toBe(42);
  });

  it("top은 최소 8", () => {
    const vp = { width: 1280, height: 200 };
    expect(computeTipPos(rect(100, 100), 400, vp).top).toBe(8);
  });
});
```

- [ ] **Step 2: HelpTip 테스트 갱신(실패 상태로)**

`ui/src/components/__tests__/HelpTip.test.tsx`에서 마지막 두 케이스(`"기본은 left-0 정렬이다"`, `"뷰포트 우단을 넘치면 right-0로 뒤집힌다"`)를 **삭제**하고, import를 다음으로 바꾼 뒤 `describe` 블록 끝(마지막 `});` 직전)에 아래 케이스들을 추가한다:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { HelpTip } from "../HelpTip";
import { Modal } from "../Modal";
import { TIP_WIDTH_PX } from "../helpTipPos";
```

```tsx
  it("popover는 portal로 body에 붙는다 — 루트 span의 자손이 아니다", async () => {
    const user = userEvent.setup();
    const { container } = render(<HelpTip label="설명">내용</HelpTip>);
    const root = container.querySelector("span")!;
    await user.click(screen.getByRole("button", { name: "설명" }));
    const note = screen.getByRole("note");
    expect(root.contains(note)).toBe(false);
    expect(note.parentElement).toBe(document.body);
  });

  it("fixed 위치·폭·높이 상한 — 앵커 rect 기준", async () => {
    const user = userEvent.setup();
    const { container } = render(<HelpTip label="설명">내용</HelpTip>);
    const root = container.querySelector("span")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 116,
      top: 50,
      bottom: 66,
      width: 16,
      height: 16,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    await user.click(screen.getByRole("button", { name: "설명" }));
    const note = screen.getByRole("note");
    expect(note.style.position).toBe("fixed");
    expect(note.style.top).toBe("70px");
    expect(note.style.left).toBe("100px");
    expect(note.style.width).toBe(`${TIP_WIDTH_PX}px`);
    expect(note.style.overflowY).toBe("auto");
  });

  it("모달 안이면 popover가 그 다이얼로그 안에 붙는다(aria-modal 범위 유지)", async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={vi.fn()} title="모달">
        <HelpTip label="설명">내용</HelpTip>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note").parentElement).toBe(screen.getByRole("dialog"));
  });

  it("aria-modal 없는 평범한 role=dialog 안이면 body로 간다", async () => {
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="비모달">
        <HelpTip label="설명">내용</HelpTip>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note").parentElement).toBe(document.body);
  });

  it("모달 안에서 popover가 열려 있으면 ESC는 popover만 닫는다 — 모달 유지", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="모달">
        <HelpTip label="설명">내용</HelpTip>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("popover 안 pointerdown은 닫지 않는다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    await user.click(screen.getByRole("button", { name: "설명" }));
    fireEvent.pointerDown(screen.getByRole("note"));
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("바깥 스크롤·리사이즈는 닫고, popover 자체 스크롤은 유지한다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    await user.click(btn);
    fireEvent.scroll(screen.getByRole("note"));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(btn);
    fireEvent.scroll(document);
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(btn);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("열림 동안만 버튼 aria-describedby가 popover id를 가리킨다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    expect(btn).not.toHaveAttribute("aria-describedby");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-describedby", screen.getByRole("note").id);
    await user.click(btn);
    expect(btn).not.toHaveAttribute("aria-describedby");
  });

  it("popover 본문 클릭은 React 트리 조상의 onClick으로 버블하지 않는다", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <HelpTip label="설명">내용</HelpTip>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    onRowClick.mockClear(); // 버튼 클릭 자체의 버블은 기존 동작
    await user.click(screen.getByRole("note"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip/ui && pnpm test helpTipPos HelpTip; echo exit=$?`
Expected: FAIL — `helpTipPos` 모듈 없음(import 실패), HelpTip 신규 케이스 실패. `exit=1`.

- [ ] **Step 4: `helpTipPos.ts` 구현**

`ui/src/components/helpTipPos.ts` 생성:

```ts
/** HelpTip popover 폭(px) — 기존 `w-56`과 같은 값. */
export const TIP_WIDTH_PX = 224;
const MARGIN = 8;
const GAP = 4;

/** HelpTip popover의 fixed 좌표(spec §3.1). 기본은 앵커 아래·좌단 정렬, 우단을 넘치면
 *  앵커 우단 정렬(기존 right-0 edge-flip과 같은 의미), 좌우는 8px 여백 clamp. 아래 공간이
 *  부족하면 위로, 둘 다 부족하면 뷰포트 하단에 맞춘다(top 최소 8). VarUsagePopover
 *  `computePos`와 같은 이디엄 — 순수 함수라 레이아웃 없는 jsdom에서도 단위 테스트한다. */
export function computeTipPos(
  anchor: { top: number; bottom: number; left: number; right: number },
  popH: number,
  vp: { width: number; height: number },
): { top: number; left: number } {
  let left =
    anchor.left + TIP_WIDTH_PX > vp.width - MARGIN ? anchor.right - TIP_WIDTH_PX : anchor.left;
  left = Math.max(MARGIN, Math.min(left, vp.width - TIP_WIDTH_PX - MARGIN));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - popH;
  let top: number;
  if (below + popH <= vp.height - MARGIN) top = below;
  else if (above >= MARGIN) top = above;
  else top = vp.height - popH - MARGIN;
  return { top: Math.max(MARGIN, top), left };
}
```

- [ ] **Step 5: `HelpTip.tsx` 전면 교체**

```tsx
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { computeTipPos, TIP_WIDTH_PX } from "./helpTipPos";

const stop = (e: SyntheticEvent) => e.stopPropagation();
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

/**
 * 도움말(?) 버튼 클릭 토글 popover (spec 2026-06-11 UX §2.2, ADR-0035).
 * hover 전용 금지 — 터치·키보드 접근성. 용어 설명 본문은 ko.ts glossary를 children으로
 * 넘겨 단일 소스를 유지한다. children은 인라인 콘텐츠만(popover가 <span>).
 *
 * popover는 portal + position:fixed(spec 2026-10-18 §3) — 좁은 `overflow-auto` 열(변수 목록
 * 등)에 잘리지 않는다. 컨테이너는 가장 가까운 `[role=dialog][aria-modal=true]`(모달 안이면
 * aria-modal 범위 안에 남아 SR이 읽는다) 또는 body. 전제: 그 컨테이너엔 transform/filter/
 * contain이 없다(있으면 fixed가 그 박스 기준이 된다 — Modal.tsx 패널은 해당 없음).
 * 닫힘: 버튼 재클릭 · 바깥 pointerdown · ESC(window capture라 Modal의 document capture보다
 * 먼저 — 모달 안에서도 tip만 닫는다) · 바깥 스크롤 · 리사이즈.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  // null = 닫힘. 열 때 1회 계산해 둔다(렌더 중 ref 읽기 금지).
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = container !== null;

  // 실측 높이로 위/아래 뒤집기 재계산(페인트 전).
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const h = panelRef.current?.getBoundingClientRect().height ?? 0;
    setPos(computeTipPos(rootRef.current.getBoundingClientRect(), h, viewport()));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setContainer(null);
    const inPanel = (t: EventTarget | null) =>
      t instanceof Node && panelRef.current !== null && panelRef.current.contains(t);
    const inRoot = (t: EventTarget | null) =>
      t instanceof Node && rootRef.current !== null && rootRef.current.contains(t);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    }
    function onPointerDown(e: PointerEvent) {
      if (!inPanel(e.target) && !inRoot(e.target)) close();
    }
    function onScroll(e: Event) {
      if (!inPanel(e.target)) close();
    }
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setContainer(null);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    setPos(computeTipPos(root.getBoundingClientRect(), 0, viewport()));
    setContainer(
      root.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? document.body,
    );
  };

  return (
    <span ref={rootRef} className="inline-block">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        onClick={toggle}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100"
      >
        ?
      </button>
      {container &&
        createPortal(
          <span
            ref={panelRef}
            id={id}
            role="note"
            onClick={stop}
            onMouseDown={stop}
            onPointerDown={stop}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: TIP_WIDTH_PX,
              maxHeight: "calc(100vh - 16px)",
              overflowY: "auto",
              zIndex: 60,
            }}
            className="block whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg"
          >
            {children}
          </span>,
          container,
        )}
    </span>
  );
}
```

- [ ] **Step 6: 통과 확인 + 이빨 실증 4종**

Run: `pnpm test helpTipPos HelpTip; echo exit=$?` → Expected: PASS, `exit=0`.

각각 고의 회귀 → 해당 테스트 RED 확인 → 원복 → GREEN (결과를 리포트에 적을 것):
1. `onPointerDown`의 `!inPanel(e.target) &&` 제거 → "popover 안 pointerdown은 닫지 않는다" RED.
2. `window.addEventListener("keydown", onKeyDown, true)`를 `document.addEventListener("keydown", onKeyDown)`(bubble)로(cleanup도 맞춰) → "모달 안에서 … ESC는 popover만 닫는다" RED.
3. `setContainer(root.closest(...) ?? document.body)`를 `setContainer(document.body)`로 → "모달 안이면 … 다이얼로그 안에 붙는다" RED.
4. popover의 `onClick={stop}` 제거 → "React 트리 조상의 onClick으로 버블하지 않는다" RED.

- [ ] **Step 7: 거짓이 된 주석·문서 정정**

`ui/src/components/usePopover.ts` 상단 JSDoc(**3-8행** — 1행 `import`는 그대로 둔다)의 소비처·U1a 문장을 다음으로 교체(코드 무변경):

```ts
/** 클릭 토글 popover 공통 로직 — ESC/외부 pointerdown 닫힘 + 뷰포트 우단 edge-flip.
 *  소비처: VerdictBadge(FAIL 사유). HelpTip은 2026-10-18부터 portal+fixed 자체 로직
 *  (HelpTip.tsx — 좁은 overflow 열 클립·Modal ESC 레이어링 해소)이라 이 훅을 쓰지 않는다.
 *
 *  주의(U1a 기록): Modal.tsx의 capture-phase keydown이 stopPropagation()하므로
 *  Modal 내부에서는 이 훅의 ESC 닫힘이 동작하지 않는다 — 현 소비처 VerdictBadge는 Modal 밖.
 *  Modal 안에서 쓰려면 HelpTip처럼 window capture로 ESC를 먼저 받을 것. */
```

`ui/src/components/scenario/ExtractConfirmRow.tsx:21-24` JSDoc 교체(코드 무변경):

```ts
/** Inline confirm row for creating an extract. PLAIN inline JSX — NO <Modal>: this row
 *  renders INSIDE the BodyViewer <Modal>, so a nested modal's ESC would close the outer
 *  one (R11). (<HelpTip> is safe here since 2026-10-18 — its window-capture ESC closes
 *  only the tip — but the row needs none.) */
```

`ui/CLAUDE.md`의 `- **`<HelpTip>`(용어 도움말 popover, U1a)은 Modal 안에서 ESC 레이어링이 안 된다** (U1a): …` 항목에서 **첫 문장부터 "`POPOVER_WIDTH_PX` 상수가 `w-56`과 lockstep)." 까지**를 다음으로 교체(뒤의 "용어 설명 본문은 항상 …" 이하 문장은 유지):

```markdown
- **`<HelpTip>`(용어 도움말 popover)은 portal + `position: fixed`** (U1a → pick-random-tooltip 2026-10-18): popover를 가장 가까운 `[role=dialog][aria-modal=true]`(모달 안이면 aria-modal 범위 유지) 또는 body에 portal로 그리고 좌표는 순수 `helpTipPos.ts::computeTipPos`(앵커 아래·우단 넘치면 우단 정렬·아래 부족하면 위·폭 224=`TIP_WIDTH_PX`)가 낸다 — 좁은 `overflow-auto` 열(변수 목록 `<ul>`)에서 popover 71%가 잘리던 클립 해소. ESC는 **window capture**라 Modal의 document capture보다 먼저 받아 **모달 안에서도 tip만 닫는다**(옛 U1a 함정 해소). 바깥 스크롤·리사이즈는 닫힘(fixed는 열 때 좌표), popover 본문 클릭은 `stopPropagation`으로 React 트리 조상 핸들러에 안 닿는다. 열림 동안 버튼 `aria-describedby`=popover id(portal로 DOM 인접성을 잃은 SR 보완). 함정: popover가 루트 span 밖이라 `container.querySelector`로는 못 찾는다 — 테스트는 `screen.getByRole("note")`. 컨테이너에 transform/filter가 생기면 fixed 기준이 바뀌니 주의.
```

`ui/src/components/scenario/CLAUDE.md`:
- `:12`의 `**변수 aside는 `overflow-visible`**(내부 `<ul>`만 스크롤)로 224px HelpTip이 좁은 열 밖으로 미클립.` 문장을 `**변수 aside는 `overflow-visible`**(내부 `<ul>`만 스크롤)이지만 HelpTip은 그 `<ul>` 안에 있어 absolute 시절엔 잘렸다(2026-10-18 실측 71% 클립) — 현재 HelpTip은 portal+fixed라 무관.`으로 교체.
- `:84`의 `(중첩 Modal/HelpTip 금지 — ESC 함정)`을 `(중첩 Modal 금지 — ESC 함정. HelpTip은 2026-10-18부터 window-capture ESC라 안전)`으로 교체.

- [ ] **Step 8: 전체 UI 게이트**

Run (각각 파이프 없이):
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip/ui
pnpm lint; echo exit=$?
pnpm test; echo exit=$?
pnpm build; echo exit=$?
```
Expected: 셋 다 `exit=0`. 다른 파일의 HelpTip 테스트(`RunDialog`·`Summary`·`VariablesPanel` 등 `screen.getByRole("note")`)도 그대로 green이어야 한다 — 하나라도 red면 원인을 리포트(portal 이동으로 `within(...)`/`container` 스코프 쿼리가 깨진 경우일 것).

- [ ] **Step 9: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip
git add ui/src/components/helpTipPos.ts ui/src/components/__tests__/helpTipPos.test.ts ui/src/components/HelpTip.tsx ui/src/components/__tests__/HelpTip.test.tsx ui/src/components/usePopover.ts ui/src/components/scenario/ExtractConfirmRow.tsx ui/CLAUDE.md ui/src/components/scenario/CLAUDE.md
git diff --cached --name-only
git commit -F <메시지 파일>
git log -1 --oneline
```
메시지: `feat(ui): HelpTip popover를 portal+fixed로 — 좁은 열 클립·모달 ESC 레이어링 해소` + 본문 1–2줄 + Co-Authored-By.

---

### Task 2: 선택 배열 팝업 "요청마다 새로 뽑기" 체크박스 (draft)

**Files:**
- Modify: `ui/src/components/scenario/PickArrayDialog.tsx` (import, state, spec 조립 `:174-191`, 미리보기 제목 `:444-448`, 미리보기 섹션 `:442` 직전에 체크박스 줄)
- Modify: `ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx` (describe 끝에 케이스 추가)
- Modify: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (`describe("VariablesPanel — 요청마다 새로 뽑기")` 끝에 케이스 추가)
- Modify (문서): `docs/superpowers/specs/2026-10-17-genvar-per-request-design.md:120` 뒤 포인터 1줄

**Interfaces:**
- Consumes: Task 1의 `HelpTip`(모달 안 ESC는 tip만 닫음). `PickArraySpec`(`ui/src/scenario/genVars.ts:125`, `refresh?: "iteration" | "request"`).
- Produces: `PickArrayDialog` props 무변경. `onApply(spec)`의 `spec.refresh` = draft 값(미조작이면 `initial.refresh`).

- [ ] **Step 1: 팝업 단위 실패 테스트 작성**

`ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx`의 `describe("PickArrayDialog", …)` 끝(파일 마지막 `});` 직전)에 추가:

```tsx
  // ── 팝업 refresh 체크박스 (pick-random-tooltip, US1·US2) ──
  const refreshBox = (dialog: HTMLElement) =>
    within(dialog).getByRole("checkbox", { name: ko.editor.genRefreshLabel });

  it("① 체크 → 적용하면 refresh: request가 실린다", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    expect(refreshBox(dialog)).not.toBeChecked();
    await user.click(refreshBox(dialog));
    await user.click(apply);
    expect(onApply.mock.calls[0][0]).toStrictEqual({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "request",
    });
  });

  it("② 초기 request를 해제 → 적용하면 refresh 키가 없다", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "request",
    });
    expect(refreshBox(dialog)).toBeChecked();
    await user.click(refreshBox(dialog));
    await user.click(apply);
    expect(onApply.mock.calls[0][0]).not.toHaveProperty("refresh");
  });

  it("③ 체크 후 취소하면 적용되지 않는다", async () => {
    const user = userEvent.setup();
    const { onApply, onCancel, dialog } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    await user.click(refreshBox(dialog));
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("④ 체크 즉시 미리보기 제목이 요청마다로 바뀌고, 해제하면 돌아온다", async () => {
    const user = userEvent.setup();
    const { dialog } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    expect(within(dialog).getByText(ko.editor.pickPreviewTitle)).toBeInTheDocument();
    await user.click(refreshBox(dialog));
    expect(within(dialog).getByText(ko.editor.pickPreviewTitleRequest)).toBeInTheDocument();
    expect(within(dialog).queryByText(ko.editor.pickPreviewTitle)).toBeNull();
    await user.click(refreshBox(dialog));
    expect(within(dialog).getByText(ko.editor.pickPreviewTitle)).toBeInTheDocument();
  });

  it("⑤ 손으로 쓴 refresh: iteration은 체크박스를 안 건드리면 보존된다", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "iteration",
    });
    expect(refreshBox(dialog)).not.toBeChecked();
    await user.click(apply);
    expect(onApply.mock.calls[0][0]).toStrictEqual({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "iteration",
    });
  });

  it("팝업의 도움말을 열고 ESC를 누르면 도움말만 닫히고 팝업은 남는다", async () => {
    const user = userEvent.setup();
    const { onCancel, dialog } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    await user.click(
      within(dialog).getByRole("button", { name: ko.editor.genRefreshHelpLabel }),
    );
    expect(within(dialog).getByRole("note")).toHaveTextContent(ko.glossary.genRefreshIntro);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
```

- [ ] **Step 2: 패널 통합 실패 테스트 작성**

`ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`의 `describe("VariablesPanel — 요청마다 새로 뽑기", …)` 끝(그 describe의 `});` 직전, 기존 `"refresh: request 선택 배열을 팝업으로 편집해도 refresh가 남는다"` 케이스 뒤)에 추가:

```tsx
  it("팝업에서 요청마다 새로 뽑기를 켜고 적용하면 YAML·배지에 반영된다 (US1)", async () => {
    const user = userEvent.setup();
    useScenarioEditor
      .getState()
      .setVariableGen("flags", { gen: "pick_array", length: 5, min: 1, max: 2 });
    render(<VariablesPanel />);
    expect(screen.queryByText(ko.editor.genRefreshBadge)).toBeNull();
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") }));
    const dialog = screen.getByRole("dialog");
    // 패널 <label>도 같은 텍스트를 감싸므로 반드시 dialog 스코프 + role 쿼리(spec §4)
    await user.click(within(dialog).getByRole("checkbox", { name: ko.editor.genRefreshLabel }));
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickApply }));
    expect(useScenarioEditor.getState().model!.variables.flags).toEqual({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "request",
    });
    expect(useScenarioEditor.getState().yamlText).toContain("refresh: request");
    expect(screen.getByText(ko.editor.genRefreshBadge)).toBeInTheDocument();
  });

  it("팝업에서 체크박스를 바꿨다가 취소하면 YAML이 그대로다 (US2)", async () => {
    const user = userEvent.setup();
    useScenarioEditor
      .getState()
      .setVariableGen("flags", { gen: "pick_array", length: 5, min: 1, max: 2 });
    render(<VariablesPanel />);
    const before = useScenarioEditor.getState().yamlText;
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: ko.editor.genRefreshLabel }));
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScenarioEditor.getState().yamlText).toBe(before);
    expect(screen.queryByText(ko.editor.genRefreshBadge)).toBeNull();
  });
```

- [ ] **Step 3: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip/ui && pnpm test PickArrayDialog VariablesPanel; echo exit=$?`
Expected: 신규 8케이스 FAIL(체크박스·도움말 버튼 not found), 기존 케이스 PASS. `exit=1`.

- [ ] **Step 4: 구현**

`PickArrayDialog.tsx`:

(a) import 추가(`import { Input } from "../ui/Input";` 아래):
```tsx
import { HelpTip } from "../HelpTip";
```

(b) `const anchorRef = useRef<number | null>(null);` 바로 위에 state 추가:
```tsx
  // "요청마다 새로 뽑기" draft — 원값 보존(손으로 쓴 `iteration` 포함), 토글은 패널 체크박스와
  // 같은 규칙(체크=request, 해제=키 없음). 적용 시에만 커밋(spec 2026-10-18 §2).
  const [refreshDraft, setRefreshDraft] = useState<PickArraySpec["refresh"]>(initial.refresh);
```

(c) spec 조립(`:189-190`) 두 줄을 교체:
```tsx
          // refresh는 팝업 draft(미조작이면 initial 그대로, 없으면 키 없음 — spec 2026-10-18 §2).
          ...(refreshDraft !== undefined ? { refresh: refreshDraft } : {}),
```

(d) 미리보기 제목의 `initial.refresh === "request"`를 `refreshDraft === "request"`로.

(e) 미리보기 `<section className="flex flex-col gap-1.5">`(제목이 `pickPreviewTitle*`인 섹션) **바로 앞**에 삽입:
```tsx
        <div className="flex items-center gap-1 text-xs text-slate-600">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={refreshDraft === "request"}
              onChange={(e) => setRefreshDraft(e.target.checked ? "request" : undefined)}
            />
            <span>{ko.editor.genRefreshLabel}</span>
          </label>
          {/* HelpTip은 label 밖 형제 — 체크박스 accname 오염 방지(U3). 모달 안 ESC는 tip만 닫는다. */}
          <HelpTip label={ko.editor.genRefreshHelpLabel}>
            <span className="block">{ko.glossary.genRefreshIntro}</span>
            <span className="mt-1 block">{ko.glossary.genRefreshPriority}</span>
          </HelpTip>
        </div>
```

`docs/superpowers/specs/2026-10-17-genvar-per-request-design.md:120`(`- 팝업은 refresh를 편집하지 않는다. …`) 바로 아래에 한 줄 추가:
```markdown
  - **대체됨(2026-10-18)**: 팝업도 "요청마다 새로 뽑기" 체크박스를 draft로 편집한다 — `docs/superpowers/specs/2026-10-18-pick-refresh-helptip-portal-design.md` §2.
```

- [ ] **Step 5: 통과 확인 + 이빨 실증 3종**

Run: `pnpm test PickArrayDialog VariablesPanel; echo exit=$?` → Expected: PASS, `exit=0`.

고의 회귀 → RED → 원복 → GREEN (리포트에 기록):
1. spec 조립을 `...(initial.refresh !== undefined ? { refresh: initial.refresh } : {})`로 되돌림 → ①·②·VariablesPanel US1 RED.
2. state를 `useState<boolean>(initial.refresh === "request")` + 조립 `...(draft ? { refresh: "request" } : {})`(boolean draft)로 → ⑤ RED.
3. 제목 조건을 `initial.refresh === "request"`로 되돌림 → ④ RED.

- [ ] **Step 6: 전체 UI 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip/ui
pnpm lint; echo exit=$?
pnpm test; echo exit=$?
pnpm build; echo exit=$?
```
Expected: 셋 다 `exit=0`.

- [ ] **Step 7: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-random-tooltip
git add ui/src/components/scenario/PickArrayDialog.tsx ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx docs/superpowers/specs/2026-10-17-genvar-per-request-design.md
git diff --cached --name-only
git commit -F <메시지 파일>
git log -1 --oneline
```
메시지: `feat(ui): 선택 배열 팝업에서 요청마다 새로 뽑기 편집 — 적용 시 커밋·원값 보존` + Co-Authored-By.

---

## 라이브 검증 체크리스트 (구현·최종 리뷰 후 `/live-verify`, US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US3 | 1280×900, 에디터 기본(좁은) 변수 패널, `random_int` 행 펼침 → "요청마다 새로 뽑기 도움말" 클릭 | `role=note` rect 폭 224·`right ≤ innerWidth`·popover 우단−4px `elementFromPoint`가 note 자신·변수 `<ul>` `scrollWidth`가 **popover 닫힌 상태에서 잰 기준값과 같다**(popover가 가로 오버플로를 더하지 않음 — 다른 원인의 오버플로를 실패로 세지 않게 기준 대조). 뷰포트 하단 근처 행에서도 열어 위로 뒤집힘 확인 |
| US1 | `pick_array` 변수 `선택 배열 편집` → 팝업 체크 → 미리보기 제목 즉시 "요청마다" → 적용 → 저장 | 행 배지 `요청마다`, 저장 후 `GET /api/scenarios/{id}`의 `yaml`에 `refresh: request` |
| US2 | 다시 팝업 → 체크 해제 → 취소 | 패널 체크박스·배지·저장 YAML 불변 |
| US4 | 팝업 HelpTip 열기 → popover 본문 클릭 → ESC / RunDialog(인라인) HelpTip 열기·바깥 클릭 / ThinkTimeBoard(모달) HelpTip 열기·ESC / 리포트 Summary HelpTip 열기 후 페이지 스크롤 | popover가 모달 위에 보임(`elementFromPoint`=note), 본문 클릭에 안 닫힘, ESC는 tip만 닫고 모달 유지(두 번째 ESC에 모달 닫힘), 바깥 클릭·스크롤에 닫힘, 콘솔 error 0 |
