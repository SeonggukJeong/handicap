# 에디터 칩 스트립 높이 캡 (editor-wide-view-overflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [스텝 넓게 보기]에서 긴 시나리오의 "테스트 흐름" 칩 스트립이 세로 아웃라인을 가리는 버그를 칩 wrap 높이 캡(96px+내부 스크롤)으로 수정하고, TestRunSection에만 "전체 펼치기/접기" 토글을 추가한다.

**Architecture:** `TestFlowChips` 컴포넌트 내부 칩 wrap div에 기본 캡(`max-h-24 overflow-y-auto`) — 소비처 2곳(EditorShell wide·TestRunSection) 공통. additive optional `expandable` prop(TestRunSection만 전달)이 실측 overflow 게이트 토글을 켠다. EditorShell은 0-diff(하드 캡 — 펼치면 가림 버그 복귀 경로라 의도적 미제공). 모델/store/와이어/서버 0-diff, 순수 표현 계층.

**Tech Stack:** React 18 + TS + Tailwind, vitest + RTL(jsdom), ResizeObserver.

**Spec:** `docs/superpowers/specs/2026-07-17-editor-wide-view-overflow-design.md` (US 블록 = spec 앞머리 `사용자 스토리 (US)` 헤딩 — orchestrator가 brief마다 첨부)

## Global Constraints

- **UI-only**: `ui/src` 3파일(`TestFlowChips.tsx`·`TestRunSection.tsx`·`ko.ts`)+테스트만. `crates/**`·proto·마이그레이션·`EditorShell.tsx`(src) 0-diff.
- **게이트**: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?` — **파이프(`| tail` 등) 금지**(종료코드 마스킹), 셋 다 0이어야 커밋.
- **tdd-guard**: src 편집 전에 테스트 파일 편집 먼저(pending test diff 필요).
- **신규 사용자 노출 문구는 전부 `ko.editor.*` 카탈로그 경유**(ADR-0035) — RTL 셀렉터도 같은 키로 lockstep.
- **클래스 토큰 단언은 `className.split(/\s+/)` 정확-토큰** — raw substring `toContain`은 `max-h-24` ⊃ `h-24`류 false-green.
- **ES2023+ 배열 메서드 금지**(tsconfig lib ES2022 — `pnpm build`만 잡음).
- **jsdom overflow getter mock은 `Element.prototype` 대상**(`vi.spyOn(Element.prototype, "scrollHeight", "get")`) — `HTMLElement.prototype`엔 own property가 없어 spyOn이 'property does not exist'로 throw (2026-07-17 node 실측).
- 커밋은 워크트리 루트에서. 리포트 파일은 `.superpowers/sdd/`에만 — worktree 루트에 `.md` 쓰기·`git add` 금지.

---

### Task 1: TestFlowChips 칩 wrap 캡 + `expandable` 토글 + ko 키

**Files:**
- Test: `ui/src/components/scenario/__tests__/TestFlowChips.test.tsx` (기존 파일 확장)
- Modify: `ui/src/components/scenario/TestFlowChips.tsx`
- Modify: `ui/src/i18n/ko.ts` (editor 섹션에 2키)

**Interfaces:**
- Consumes: 없음 (기존 `TestFlowChips` props: `steps`/`trace`/`selectedStepId`/`onSelect`).
- Produces (Task 2가 의존):
  - `TestFlowChips` props에 `expandable?: boolean` 추가(기본 미전달=false — 미전달 소비처는 토글 절대 미렌더, 캡은 공통 기본).
  - 칩 wrap div: `data-testid="chip-strip-wrap"`, 기본 클래스에 `max-h-24 overflow-y-auto` 포함, 펼침 시 두 토큰 제거.
  - `ko.editor.chipStripExpand === "전체 펼치기"` / `ko.editor.chipStripCollapse === "접기"`.
  - 토글 버튼: `aria-expanded` + `aria-controls`(wrap div `useId()` id와 일치), 라벨 "테스트 흐름" 옆.

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/components/scenario/__tests__/TestFlowChips.test.tsx` — ① import 줄 수정: vitest import에 `afterEach` 추가, RTL import에 `act` 추가:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
```

② 파일 끝에 새 describe 블록 추가:

```tsx
describe("TestFlowChips — 칩 스트립 높이 캡 + 펼치기 토글 (editor-wide-view-overflow R1/R2)", () => {
  // jsdom은 scrollHeight/clientHeight가 항상 0 — Element.prototype getter를 render *전*에 mock.
  // (HTMLElement.prototype엔 own property가 없어 vi.spyOn이 throw — spec 리스크 노트.)
  const mockOverflow = (scrollH: number, clientH: number) => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(scrollH);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(clientH);
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("T1: 칩 wrap div에 캡 토큰 — split 정확-토큰 단언", () => {
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    const tokens = screen.getByTestId("chip-strip-wrap").className.split(/\s+/);
    expect(tokens).toContain("max-h-24");
    expect(tokens).toContain("overflow-y-auto");
  });

  it("T2: expandable 미전달 → overflow여도 토글 부재", () => {
    mockOverflow(300, 96);
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
  });

  it("T3: expandable + overflow → 토글 렌더, aria-expanded/aria-controls 배선", () => {
    mockOverflow(300, 96);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    const toggle = screen.getByRole("button", { name: "전체 펼치기" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("chip-strip-wrap").id);
  });

  it("T4: 토글 클릭 → 캡 토큰 제거 + '접기', 재클릭 → 캡 복귀", async () => {
    const user = userEvent.setup();
    mockOverflow(300, 96);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    await user.click(screen.getByRole("button", { name: "전체 펼치기" }));
    const expandedTokens = screen.getByTestId("chip-strip-wrap").className.split(/\s+/);
    expect(expandedTokens).not.toContain("max-h-24");
    expect(expandedTokens).not.toContain("overflow-y-auto");
    const collapse = screen.getByRole("button", { name: "접기" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(screen.getByTestId("chip-strip-wrap").className.split(/\s+/)).toContain("max-h-24");
  });

  it("T5: expandable + overflow 없음(jsdom 기본 0) → 토글 부재(죽은 컨트롤 미노출)", () => {
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
  });

  it("T6: RO 재측정 경로 — wrap 등록 + 콜백 발화로 토글 등장", () => {
    let roCallback: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    const wrap = screen.getByTestId("chip-strip-wrap");
    expect(observed).toContain(wrap);
    // mount 측정(0>0=false) → 토글 부재
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
    // overflow로 전이 — element 인스턴스 getter 주입 후 RO 콜백 수동 발화
    Object.defineProperty(wrap, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(wrap, "clientHeight", { configurable: true, value: 96 });
    act(() => {
      roCallback?.([], {} as ResizeObserver);
    });
    expect(screen.getByRole("button", { name: "전체 펼치기" })).toBeInTheDocument();
  });

  it("T2b: expandable 미전달이면 RO 관측 자체가 없음 (spec R2.3 게이트)", () => {
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(observed).toHaveLength(0);
  });
});
```

주의: T6의 RO 콜백 발화는 setState를 부르므로 **`act()` 래핑 필수**(raw dispatch류 act-공백 — `ui/CLAUDE.md` rundialog-size-chip-multiplier 함정. `AutoGrowTextarea.test`는 콜백이 style만 만져 act 불요였다 — 여기는 다름).

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm test TestFlowChips; echo exit=$?`
Expected: FAIL — T1이 `getByTestId("chip-strip-wrap")` not found(testid 미존재), T3/T4/T6이 토글 미존재로 red. 기존 케이스는 전부 green 유지.

- [ ] **Step 3: 구현**

③ `ui/src/i18n/ko.ts` — `testFlowTitle`/`chipAria*` 키가 있는 "테스트 흐름 칩 스트립 (B13 슬라이스 2)" 그룹의 `chipAriaNotRun` 줄 바로 아래에 추가:

```ts
    chipStripExpand: "전체 펼치기",
    chipStripCollapse: "접기",
```

④ `ui/src/components/scenario/TestFlowChips.tsx` — import 줄 교체:

```tsx
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
```

⑤ 같은 파일 — `export function TestFlowChips(...)` 본문 교체 (칩 렌더 `steps.map(...)` 내용은 **바이트 그대로 유지**, 바깥 골격만 변경):

```tsx
/** 시나리오 흐름을 가로 flex-wrap 그룹 칩으로 미러하는 상시 스트립(spec R1/R2).
 *  run 전 = 플레인 미러, run 후 = deriveChipResults로 스텝별 ✓/✗/○(spec R4/R5).
 *  칩 클릭 = onSelect(stepId) — 부모가 store select로 배선(spec R6).
 *  칩 wrap은 기본 max-h-24 캡+내부 스크롤 — 긴 시나리오가 wide 아웃라인/결과 패널을
 *  잠식하지 않게(editor-wide-view-overflow R1). expandable(TestRunSection만)이면
 *  overflow 실측 시 "전체 펼치기/접기" 토글(R2). */
const WRAP_BASE = "flex flex-wrap items-center gap-1.5";

export function TestFlowChips({
  steps,
  trace,
  selectedStepId,
  onSelect,
  expandable = false,
}: {
  steps: ReadonlyArray<Step>;
  trace: ScenarioTrace | null;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
  /** true(TestRunSection)면 overflow 시 펼치기 토글 — EditorShell(wide)은 미전달=하드 캡(펼치면 가림 복귀). */
  expandable?: boolean;
}) {
  const results = useMemo(() => (trace ? deriveChipResults(trace) : null), [trace]);
  // 훅은 전부 steps-empty early return 앞에 (rules-of-hooks).
  const wrapId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // overflow 불리언의 모든 전이는 캡 경계(96px)를 지나며 wrap 박스 높이가 변하므로
  // 재측정은 RO 전담으로 충분(캡에 눌린 96px→96px 내부 증감은 상태도 불변이라 무발화 무해).
  // deps에 steps/trace를 넣으면 effect 본문 미참조로 exhaustive-deps 경고(--max-warnings=0).
  // 알려진 한계(수용, spec §7): steps 0→>0로 wrap이 재마운트되면 새 div를 재관측하지
  // 않아 overflowing이 stale할 수 있음(토글 가시성만 영향·리마운트로 회복).
  useLayoutEffect(() => {
    if (!expandable) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expandable]);

  if (steps.length === 0) return null;
  return (
    <div role="group" aria-label={ko.editor.testFlowTitle} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">{ko.editor.testFlowTitle}</span>
        {expandable && (overflowing || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={wrapId}
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            {expanded ? ko.editor.chipStripCollapse : ko.editor.chipStripExpand}
          </button>
        )}
      </div>
      <div
        id={wrapId}
        ref={wrapRef}
        data-testid="chip-strip-wrap"
        className={expanded ? WRAP_BASE : `${WRAP_BASE} max-h-24 overflow-y-auto`}
      >
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 && (
              <span aria-hidden="true" className="text-slate-300">
                →
              </span>
            )}
            <ChipNode
              step={s}
              results={results}
              selectedStepId={selectedStepId}
              onSelect={onSelect}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
```

구현 노트:
- 기존 라벨 `<span>`은 그대로 두고 flex row `<div>`로 감싼다(토글이 형제) — group의 accessible name은 `aria-label` 속성이라 오염 없음.
- `WRAP_BASE` 상수는 컴포넌트 밖 파일 스코프(비-컴포넌트 export 아님 — react-refresh 경고 없음, export 안 함).
- 조기 반환(`steps.length === 0`) 시 wrap div가 없으므로 측정 effect의 `if (!el) return` 가드가 필수.

- [ ] **Step 4: 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm test TestFlowChips; echo exit=$?`
Expected: exit=0 — 신규 7케이스 + 기존 케이스 전부 green.

teeth-check(커밋 전 1회): T3에서 `mockOverflow(300, 96)` 줄을 잠시 주석 → `pnpm test TestFlowChips`에서 T3 FAIL 확인(mock이 없으면 토글이 안 뜬다 = 테스트에 이빨) → 원복.

- [ ] **Step 5: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?`
Expected: 셋 다 0.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow
git add ui/src/components/scenario/TestFlowChips.tsx ui/src/components/scenario/__tests__/TestFlowChips.test.tsx ui/src/i18n/ko.ts
git commit -m "fix(editor): TestFlowChips 칩 wrap 높이 캡(max-h-24+내부 스크롤) + expandable 토글 (R1/R2)"
```

(FOREGROUND 단일 호출, timeout 600000ms — UI 게이트가 pre-commit에서 다시 돈다.)

---

### Task 2: 소비처 배선 — TestRunSection `expandable` + EditorShell 미배선 락인

**Files:**
- Test: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx` (기존 파일 확장)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (기존 파일 확장)
- Modify: `ui/src/components/scenario/TestRunSection.tsx` (1속성)

**Interfaces:**
- Consumes (Task 1 산출): `TestFlowChips`의 `expandable?: boolean` prop, `ko.editor.chipStripExpand`("전체 펼치기"), `data-testid="chip-strip-wrap"`, overflow mock은 `Element.prototype` getter.
- Produces: TestRunSection의 칩 스트립만 펼치기 가능(US1), EditorShell wide 스트립은 하드 캡(B1) — 락인 테스트 2건.

- [ ] **Step 1: 실패하는 테스트 작성 (TestRunSection)**

`ui/src/components/scenario/__tests__/TestRunSection.test.tsx` — ① RTL import에 `within` 추가(`import { act, render, screen, within } from "@testing-library/react";`), ② 파일 끝에 새 describe 블록 추가.

**주의 — fixture는 반드시 `CHIP_YAML`**(파일 최상위 line ~130에 이미 정의): `VALID_YAML`은 `id: a`(비-ULID)·`name` 부재로 `parseScenarioDoc`가 실패해 `traceSteps=[]` → `TestFlowChips`가 null 반환 → 칩 스트립 자체가 안 떠서 테스트가 영구 red(기존 스트립 describe도 같은 이유로 CHIP_YAML 사용 — line 129 주석).

```tsx
describe("TestRunSection 칩 스트립 캡+펼치기 토글 (editor-wide-view-overflow US1)", () => {
  // Element.prototype getter spy는 단언 throw에도 반드시 원복돼야 한다(누수 시 후속
  // 케이스 오염) — in-body restore가 아니라 afterEach로. 파일 기존 afterEach의
  // clearAllMocks는 spy 원복을 안 한다.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("칩 스트립 overflow 시 펼치기 토글 노출 — expandable 배선", () => {
    // jsdom getter mock은 render 전에, Element.prototype 대상 (spec 리스크 노트)
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(300);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(96);
    render(<TestRunSection yamlText={CHIP_YAML} />);
    const strip = screen.getByRole("group", { name: "테스트 흐름" });
    expect(within(strip).getByRole("button", { name: "전체 펼치기" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm test TestRunSection.test; echo exit=$?`
Expected: 신규 케이스만 FAIL(토글 미존재 — expandable 미전달), 기존 케이스 green.

- [ ] **Step 3: 구현 (TestRunSection 1속성)**

`ui/src/components/scenario/TestRunSection.tsx`의 `<TestFlowChips ...>` 호출에 `expandable` 추가:

```tsx
        <TestFlowChips
          steps={traceSteps}
          trace={chipTrace}
          selectedStepId={selectedStepId ?? null}
          onSelect={(id) => useScenarioEditor.getState().select(id)}
          expandable
        />
```

- [ ] **Step 4: 통과 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm test TestRunSection.test; echo exit=$?`
Expected: exit=0.

- [ ] **Step 5: EditorShell 미배선 락인 테스트 추가 (green 가드 — 이 단계는 RED 없음)**

`ui/src/components/scenario/__tests__/EditorShell.test.tsx` — ① vitest import에 **`afterEach` 추가**(현재 `beforeEach, describe, expect, it, vi`만 — `vi`는 이미 있음), ② 기존 `describe("스텝 넓게 보기 토글 (R5/R10)")` 블록 *안에* 중첩 describe로 추가(`WIDE_YAML` 상수가 그 스코프에 정의돼 있음):

```tsx
    describe("wide 칩 스트립 하드 캡 (editor-wide-view-overflow R3)", () => {
      // spy 누수 방지 — 단언 throw에도 Element.prototype getter 원복 (in-body restore 금지)
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("펼치기 토글 부재 — expandable 미배선 락인 (overflow여도)", async () => {
        // 실제 가치 = 향후 우발적 expandable 전달 가드. 레이아웃 검증은 라이브 rect가 권위(spec R3.2).
        vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(300);
        vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(96);
        const user = userEvent.setup();
        render(<EditorShell initialYaml={WIDE_YAML} />);
        await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
        expect(screen.getByRole("group", { name: ko.editor.testFlowTitle })).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: ko.editor.chipStripExpand }),
        ).not.toBeInTheDocument();
      });
    });
```

- [ ] **Step 6: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow/ui && pnpm lint; echo lint=$?` → `pnpm test; echo test=$?` → `pnpm build; echo build=$?`
Expected: 셋 다 0. (targeted green ≠ full green — 전체 1회 필수.)

- [ ] **Step 7: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-wide-view-overflow
git add ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/__tests__/TestRunSection.test.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "fix(editor): TestRunSection 칩 스트립 expandable 배선 + EditorShell 하드 캡 락인 (US1/R3)"
```

---

## 라이브 검증 (orchestrator 직접 — subagent task 아님)

spec §라이브 검증 표대로. 클라이언트-only(백엔드 불요 — 레이아웃·토글 검증), `implementation-rigor-over-spec`에 따라 rect 실측이 권위.

1. 준비: `lsof -i :5173`으로 포트 선점 확인 후 워크트리 `ui/`에서 `pnpm dev`(background). Playwright는 **`localhost`**(vite IPv6 바인드 — `127.0.0.1` 거부).
2. **B1**: `http://localhost:5173/scenarios/new` → "로그인 흐름" 템플릿 → `browser_run_code_unsafe` 루프로 `+ HTTP 스텝` 클릭 ×102(105스텝) → [스텝 넓게 보기] 클릭 → 측정(**wide section 스코프** — `section[aria-label="스텝 흐름 (넓게 보기)"]` 안에서 `[data-testid="chip-strip-wrap"]`을 집는다; testid는 페이지 전역 유일이 아님 — TestRunSection에도 존재):
   - 칩 wrap `getBoundingClientRect().height ≤ 96`
   - 아웃라인 wrapper(섹션 nextElementSibling) `height > 200`
   - 스트립 `bottom ≤` 컨테이너(`section.parentElement`) `bottom`
   - 칩 wrap `scrollHeight > clientHeight` + `scrollTo(0, scrollHeight)` 후 마지막 칩 `getBoundingClientRect()`가 wrap rect 안
3. **US1**: 같은 페이지 하단 '테스트' 섹션(스코프: `section[aria-label]` test-run controls 안 `role="group"` "테스트 흐름") — 기본 칩 wrap `height ≤ 96` + "전체 펼치기" 버튼 존재 → 클릭 후 `height > 96` + 버튼 문구 "접기" → 재클릭 복귀.
4. **US1'**: 새 탭 `/scenarios/new` → "로그인 흐름"(3스텝)만 → 하단 섹션에 토글 **부재** + 캡 미발동(wrap height < 96 자연 높이).
5. 콘솔 에러 0(`browser_console_messages`, `all:false` — cross-session 버퍼 함정).
6. 정리: vite dev kill(`lsof -ti :5173 | xargs kill`), `.playwright-mcp/` 산출물 삭제(머지 전).

## Deferred (spec §7 — 이 plan에 없음이 의도)

- 선택 칩 자동 scrollIntoView · 펼침 상태 영속화 · wide 모드 펼치기.
