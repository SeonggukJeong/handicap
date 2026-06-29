# 에디터 드래그 메커니즘 수리 (slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터 아웃라인(`FlowOutline`)의 드래그를 `DragOverlay`로 재배선해 (#3) 컨테이너 위를 지날 때 드래그가 취소되는 현상과 (#4) 드래그 중 컨테이너 자식이 따라오지 않는 현상을 고친다 — 모델/wire/store byte-identical.

**Architecture:** 중첩 `SortableContext` 구조와 그룹내-전용 재정렬 의미론(`resolveDragEnd`)을 **유지**한 채, ① 한 행의 헤더 비주얼을 공유 프리젠테이션 조각(`RowContent`/`ContainerBands`)으로 추출하고 ② 비대화형 `OutlineRowPreview`(서브트리 재귀 렌더)를 만들어 `DragOverlay`에 띄우고(=#4) ③ `closestCenter` 충돌 + `MeasuringStrategy.Always` 측정 + 드래그 중 소스 서브트리 숨김 + `setActivatorNodeRef`로 드래그를 재배선한다(=#3 표적). re-parenting(경계 넘기)은 ADR-0044대로 슬라이스 3으로 계속 연기.

**Tech Stack:** React + TypeScript, `@dnd-kit/core@6.3.1`(`DragOverlay`/`closestCenter`/`MeasuringStrategy`/`DragStartEvent`), `@dnd-kit/sortable@10`(`useSortable` → `isDragging`/`setActivatorNodeRef`/`transition`), Zustand store, vitest + Testing Library(jsdom), Playwright-MCP(라이브 드래그 실측).

설계 출처: `docs/superpowers/specs/2026-06-29-editor-drag-fixes-design.md`.

## Global Constraints

- **UI-only.** controller/worker/engine/proto **0-diff**. 손대는 production 파일은 `ui/src/components/scenario/FlowOutline.tsx` 단 하나(+ 그 테스트).
- **모델/YAML wire/Zustand store byte-identical.** `resolveDragEnd`/`computeReorder`(`ui/src/scenario/reorder.ts`)·`moveStep`(store)·`model.ts`·`ko.ts` **무변경**. `activeId`는 컴포넌트 로컬 `useState`(store 아님).
- **re-parenting 없음.** 그룹내 재정렬만, 경계=no-op(현 `resolveDragEnd` 그대로).
- **신규 사용자노출 문구 없음**(ADR-0035) — 오버레이는 `aria-hidden` 장식. `ko.ts` 추가 금지.
- **프리뷰는 store 미접촉 + 선택 accent 미표시** — 항상 중립 `border-slate-200`.
- **소스 숨김은 컨테이너의 *외곽 wrapper*에** — 헤더 div에만 걸면 형제 자식 밴드가 이중 표시(spec F1).
- **게이트(매 task 머지 전):** `cd ui && pnpm lint && pnpm test && pnpm build` 전부 GREEN. lint는 `--max-warnings=0`. **단일 파일 빠른 반복은 `pnpm test FlowOutline`**(`--` 붙이면 전체 스위트 — ui/CLAUDE.md).
- **tdd-guard:** watched `ui/src/**`(non-test) 편집 전 *pending test-path 파일*이 있어야 함 → **각 task에서 테스트 파일을 먼저 편집**(test-path는 항상 허용).
- **드래그 메커니즘은 jsdom 단위 테스트 불가**(spec §6.2): pointer 드래그/취소/오버레이는 Playwright(Task 3)로만 검증. KeyboardSensor는 Playwright에서 미발화 → pointer 드래그만 유효.

---

## File Structure

- `ui/src/components/scenario/FlowOutline.tsx` (수정) — 유일 production 파일.
  - 신규 내부 컴포넌트: `RowContent`(헤더 내용 공유), `ContainerBands`(자식 밴드 스캐폴딩, `renderGroup` 주입), `OutlineRowPreview`(**export**, 비대화형 재귀 프리뷰).
  - 수정: `OutlineRow`(공유 조각 사용 + Task 2에서 드래그 훅), `FlowOutline`(DndContext 설정 + `DragOverlay` + `activeId`).
  - 유지: `METHOD_BADGE`, `EMPTY_STEPS`, `ContainerTag`.
- `ui/src/components/scenario/__tests__/FlowOutline.test.tsx` (수정) — `OutlineRowPreview` 단위 테스트 + 오버레이 배선 회귀 락.

---

## Task 1: 프리젠테이션 추출 + `OutlineRowPreview` (TDD)

한 행의 헤더 비주얼을 `RowContent`/`ContainerBands`로 추출하고, 이를 재사용하는 비대화형 `OutlineRowPreview`(export)를 만든다. `OutlineRow`는 같은 조각을 쓰도록 리팩터(거동 불변 — 기존 15 테스트가 가드). 오버레이 배선(DragOverlay/isDragging)은 Task 2.

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

**Interfaces:**
- Consumes: `isLoopStep`/`isIfStep`/`isParallelStep`/`summarizeCondition`/`type Step` (`../../scenario/model`, 이미 import됨), `ko.editor.*`, `METHOD_BADGE`/`ContainerTag`(같은 파일).
- Produces:
  - `function RowContent({ step }: { step: Step }): JSX.Element` — 한 행 헤더의 "드래그 핸들 이후" 내용(컨테이너 태그/메서드 배지·이름·repeat/조건/URL·⚠). fragment 반환.
  - `function ContainerBands({ step, depth, renderGroup }: { step: Step; depth: number; renderGroup: (children: Step[], childDepth: number) => React.ReactNode }): React.ReactNode` — 컨테이너 자식 밴드 스캐폴딩. leaf면 `null`.
  - `export function OutlineRowPreview({ step, depth }: { step: Step; depth: number }): JSX.Element` — 비대화형 재귀 프리뷰(`useSortable`/`SortableContext`/`onClick` 없음, `aria-hidden`, 선택 accent 미표시).

- [ ] **Step 1: 실패하는 테스트 작성** (테스트 파일 먼저 — tdd-guard)

`FlowOutline.test.tsx` import에 `OutlineRowPreview`를 추가하고(`import { FlowOutline, OutlineRowPreview } from "../FlowOutline";`), 파일 끝에 describe 블록 추가:

```tsx
describe("OutlineRowPreview (DragOverlay 프리뷰 — 비대화형 재귀)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  const stepById = (id: string) =>
    useScenarioEditor.getState().model!.steps.find((s) => s.id === id)!;

  it("컨테이너 프리뷰가 헤더 + 자식 서브트리를 재귀로 렌더한다 (#4)", () => {
    // 'gate'(if) → THEN → 'inner-loop'(loop) → 'ping'(http leaf)
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000010")} depth={0} />);
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    expect(screen.getByText("inner-loop")).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument(); // depth-2 자식까지
  });

  it("프리뷰 root 는 aria-hidden (SR 이중 구술 방지)", () => {
    const { container } = render(
      <OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />,
    );
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("프리뷰는 비대화형 — 진짜 button 이 없고 핸들은 정적 aria-hidden span 이다", () => {
    const { container } = render(
      <OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />,
    );
    // 프리뷰 root 가 aria-hidden 이라 getByRole 은 서브트리를 제외(teeth 없음) →
    // DOM 레벨로 단언해야 진짜 button 누출을 잡는다([[implementation-rigor-over-spec]]).
    expect(container.querySelector("button")).toBeNull();
    // 핸들 글리프(⠿)는 정적 span(aria-hidden) — leaf 프리뷰엔 정확히 이 1개
    const handle = container.querySelector('span[aria-hidden="true"]');
    expect(handle?.textContent).toContain("⠿");
  });

  it("선택된 스텝이어도 프리뷰는 accent 를 표시하지 않는다 (F3 — store 미접촉)", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000010"); // 'gate' 선택
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000010")} depth={0} />);
    const headerRow = screen.getByText("gate").parentElement!;
    expect(headerRow.className).not.toMatch(/border-accent-500|ring-accent/);
    expect(headerRow.className).toMatch(/border-slate-200/);
  });

  it("http leaf 프리뷰가 이름/URL/메서드 배지를 렌더한다", () => {
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />);
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("/login")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: FAIL — `OutlineRowPreview` is not exported / not a function (import 미해결 또는 렌더 throw).

- [ ] **Step 3: 최소 구현 — 공유 조각 추출 + `OutlineRowPreview`**

`FlowOutline.tsx`에서 현재 `OutlineRow`의 4분기 헤더 JSX를 `RowContent`로, 밴드 스캐폴딩을 `ContainerBands`로 추출하고, `OutlineRow`를 둘을 쓰도록 리팩터한 뒤 `OutlineRowPreview`를 추가한다. `ContainerTag` 정의 위(또는 `OutlineRow` 위)에 삽입:

```tsx
// 한 행 헤더의 "드래그 핸들 이후" 내용. 대화형 OutlineRow와 오버레이용
// OutlineRowPreview가 공유 — 시각 드리프트 방지(spec §3.3).
function RowContent({ step }: { step: Step }) {
  if (isLoopStep(step)) {
    return (
      <>
        <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="shrink-0 text-xs text-slate-500">× {step.repeat}</span>
      </>
    );
  }
  if (isIfStep(step)) {
    return (
      <>
        <ContainerTag glyph="⎇" label={ko.editor.containerIf} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="shrink-0 text-xs text-slate-500">{summarizeCondition(step.cond)}</span>
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        <ContainerTag glyph="⇉" label={ko.editor.containerParallel} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
      </>
    );
  }
  // http leaf
  const urlMissing = step.request.url.trim() === "";
  return (
    <>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}
      >
        {step.request.method}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="truncate text-xs text-slate-500" title={step.request.url}>
          {step.request.url}
        </span>
      </div>
      {urlMissing && (
        <span
          role="img"
          aria-label={ko.editor.urlMissingTitle}
          title={ko.editor.urlMissingTitle}
          className="shrink-0 text-amber-500"
        >
          ⚠
        </span>
      )}
    </>
  );
}

// 컨테이너 자식 밴드 스캐폴딩(들여쓰기·border-l-2·밴드 라벨). 자식 렌더 방식만
// renderGroup으로 주입 — 대화형(SortableContext+OutlineRow) vs 프리뷰(OutlineRowPreview).
function ContainerBands({
  step,
  depth,
  renderGroup,
}: {
  step: Step;
  depth: number;
  renderGroup: (children: Step[], childDepth: number) => React.ReactNode;
}) {
  if (isLoopStep(step)) {
    return (
      <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
        {renderGroup(step.do, depth + 1)}
      </div>
    );
  }
  if (isIfStep(step)) {
    const bands: Array<{ label: string; children: Step[] }> = [
      { label: "THEN", children: step.then },
      ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
      ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
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
            <div className="flex flex-col gap-1">{renderGroup(b.children, depth + 1)}</div>
          </div>
        ))}
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        {step.branches.map((b) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.name}
            </div>
            <div className="flex flex-col gap-1">{renderGroup(b.steps, depth + 1)}</div>
          </div>
        ))}
      </>
    );
  }
  return null;
}
```

> **타입 메모:** `step.do`/`then`/`else`/`branches[].steps`는 nested-variant 배열이지만 `Step[]`에 할당 가능하다 — 현 `OutlineRow`가 이미 그 원소를 `step={c}`(`step: Step`)로 넘기고 빌드가 통과한다. `renderGroup(children: Step[], …)`도 동일 근거로 OK.

이어서 `OutlineRow`를 공유 조각으로 리팩터(거동 불변 — 드래그 훅은 Task 2). 기존 `OutlineRow` 본문 전체를 아래로 교체:

```tsx
function OutlineRow({ step, depth }: { step: Step; depth: number }) {
  const { attributes, listeners, setNodeRef, transform } = useSortable({
    id: step.id,
  });
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const selected = step.id === selectedStepId;
  const accent = selected ? "border-accent-500 ring-1 ring-accent-500" : "border-slate-200";

  const rowStyle: React.CSSProperties = {
    marginLeft: `${depth * 16}px`,
    transform: CSS.Transform.toString(transform),
  };
  const rowClassBase = `flex gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`;
  const rowProps = {
    role: "option" as const,
    "aria-selected": selected,
    "aria-label": ko.editor.outlineRowAria(step.name),
    tabIndex: 0,
    "data-depth": String(depth),
    onClick: () => select(step.id),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(step.id);
      }
    },
    style: rowStyle,
  };
  const dragHandle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={ko.editor.dragHandleAria(step.name)}
      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
    >
      ⠿
    </button>
  );
  const headerRow = (
    <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center`}>
      {dragHandle}
      <RowContent step={step} />
    </div>
  );

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    return (
      <div>
        {headerRow}
        <ContainerBands
          step={step}
          depth={depth}
          renderGroup={(children, childDepth) => (
            <SortableContext
              items={children.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {children.map((c) => (
                <OutlineRow key={c.id} step={c} depth={childDepth} />
              ))}
            </SortableContext>
          )}
        />
      </div>
    );
  }
  // http leaf — 단일 행 div 자체가 최외곽
  return headerRow;
}
```

마지막으로 `OutlineRowPreview`를 추가(`OutlineRow` 아래, `ContainerTag` 근처):

```tsx
// DragOverlay 안에 띄우는 비대화형 재귀 프리뷰. useSortable/SortableContext/onClick
// 없음(이중 등록·중복 핸들 방지), store 미접촉, 선택 accent 미표시(F3), aria-hidden 장식.
export function OutlineRowPreview({ step, depth }: { step: Step; depth: number }) {
  const rowStyle: React.CSSProperties = { marginLeft: `${depth * 16}px` };
  // 항상 중립 border-slate-200 — 선택 여부와 무관(store 미접촉).
  const rowClass =
    "flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm shadow-lg";
  const staticHandle = (
    <span className="shrink-0 cursor-grab text-slate-400" aria-hidden="true">
      ⠿
    </span>
  );
  const headerRow = (
    <div style={rowStyle} className={rowClass}>
      {staticHandle}
      <RowContent step={step} />
    </div>
  );
  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    return (
      <div aria-hidden="true">
        {headerRow}
        <ContainerBands
          step={step}
          depth={depth}
          renderGroup={(children, childDepth) =>
            children.map((c) => <OutlineRowPreview key={c.id} step={c} depth={childDepth} />)
          }
        />
      </div>
    );
  }
  return <div aria-hidden="true">{headerRow}</div>;
}
```

- [ ] **Step 4: 테스트 통과 확인 (신규 + 기존 회귀)**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS — 신규 `OutlineRowPreview` 5케이스 + **기존 15케이스**(render full nesting 4[renders/indent/R5/R6]·selection 4·url-missing+add+empty 5·drag wiring 2) = **20** 모두 green. (개수 핀: 리팩터로 기존 테스트가 실수로 삭제되면 15→줄어듦으로 잡힌다.)

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test FlowOutline && pnpm build && cd ..
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "refactor(editor): RowContent/ContainerBands 공유 추출 + 비대화형 OutlineRowPreview (드래그 오버레이 토대)"
```

Expected: 커밋 성공. (UI-only라 pre-commit UI 게이트만 — cargo skip.)

---

## Task 2: `DragOverlay` 배선 + collision/measuring + 소스 숨김 (#3/#4 배선)

`FlowOutline`에 `DragOverlay`+`activeId`, **그룹-스코프 커스텀 충돌 감지**(over를 active의 형제 그룹으로만 좁힘 — 교차-컨텍스트 취소 직격), `MeasuringStrategy.Always`를 배선하고, `OutlineRow`에 드래그 중 소스 숨김(`isDragging`→외곽 wrapper)·소스 transform 제로화·`setActivatorNodeRef`를 추가한다. 드래그 메커니즘 자체는 jsdom 단위 불가 → 회귀 락 테스트 + Task 3(Playwright).

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

**Interfaces:**
- Consumes: `OutlineRowPreview`(Task 1), `findStepById(steps, id): Step | null`·`findStepSiblings(steps, id): ReadonlyArray<Step>`(`../../scenario/model`), `DragOverlay`/`closestCenter`/`MeasuringStrategy`/`type CollisionDetection`/`type DragStartEvent`(`@dnd-kit/core`), `useState`/`useCallback`(react).
- Produces: 외부 인터페이스 변화 없음(내부 배선만). `FlowOutline`의 export 시그니처 불변.

- [ ] **Step 1: 회귀 락 테스트 작성** (테스트 먼저 — tdd-guard)

> 드래그 *취소/오버레이/소스숨김* 같은 메커니즘은 jsdom에서 검증 불가(spec §6.2) — 이 테스트는 **오버레이 배선이 기존 거동을 깨지 않음**을 잠그는 회귀 락이고, 진짜 메커니즘 증명은 Task 3(Playwright)다. `FlowOutline.test.tsx` 끝에 추가:

```tsx
describe("FlowOutline 오버레이 배선 (메커니즘은 Task 3 Playwright)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("오버레이 배선 후에도 live(sortable) 행의 선택 accent·드래그 핸들 button 이 유지된다", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    render(<FlowOutline />);
    // live 행은 여전히 accent (overlay 추가가 선택 표시를 회귀시키지 않음)
    expect(screen.getByRole("option", { name: /login/ }).className).toMatch(
      /border-accent-500|ring-accent/,
    );
    // live 드래그 핸들은 여전히 진짜 button (프리뷰 핸들은 정적 span — 드래그 없으면 미렌더)
    expect(
      screen.getByRole("button", { name: /"login" 스텝 순서 이동/ }),
    ).toBeInTheDocument();
    // 컨테이너 자식 재정렬도 그대로 마운트(중첩 SortableContext 회귀 없음)
    expect(screen.getByText("ping")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 회귀 락 실행(현재 green)**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS(이미 green — 회귀 락이므로 RED 단계 없음. tdd-guard는 pending test-path 존재만 요구하므로 이 편집이 src 편집을 unblock). 드래그 메커니즘 RED→GREEN은 Task 3.

- [ ] **Step 3: `OutlineRow`에 드래그 훅 추가 (소스 숨김 + activator)**

`OutlineRow`의 `useSortable` 구조분해에 `setActivatorNodeRef`·`isDragging`를 추가하고, 핸들에 `ref={setActivatorNodeRef}`, **외곽 요소에 hide**(컨테이너=wrapper, leaf=행 div), 그리고 **드래그 중 소스 transform 제로화**(오버레이가 시각 담당 — spec §3.1)를 적용한다. Task 1의 `OutlineRow`에서 아래 5곳을 변경:

(a) 구조분해:
```tsx
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
    });
```

(b) `accent` 줄 아래에 hide 클래스 추가:
```tsx
  // 드래그 중 소스는 *숨김만*(opacity-0, DOM 제거 금지 — dnd-kit 측정 필요).
  // 외곽 요소에 적용: 컨테이너는 wrapper(헤더+밴드), leaf는 행 div 자체(spec F1).
  const hidden = isDragging ? "opacity-0" : "";
```

(b2) `rowStyle`의 `transform`을 드래그 중 제로화(spec §3.1 — 시각은 오버레이가 담당, 소스는 제자리 gap):
```tsx
  const rowStyle: React.CSSProperties = {
    marginLeft: `${depth * 16}px`,
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
  };
```

(c) 핸들에 `ref={setActivatorNodeRef}` (`{...attributes}` 앞):
```tsx
  const dragHandle = (
    <button
      type="button"
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

(d) `headerRow` const → 함수(leaf 행에 hide를 합치기 위해)로 바꾸고 두 return을 갱신:
```tsx
  const headerRow = (extra: string) => (
    <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center ${extra}`}>
      {dragHandle}
      <RowContent step={step} />
    </div>
  );

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    return (
      <div className={hidden}>
        {headerRow("")}
        <ContainerBands
          step={step}
          depth={depth}
          renderGroup={(children, childDepth) => (
            <SortableContext
              items={children.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {children.map((c) => (
                <OutlineRow key={c.id} step={c} depth={childDepth} />
              ))}
            </SortableContext>
          )}
        />
      </div>
    );
  }
  // http leaf — 단일 행 div 자체가 최외곽이라 hide를 직접 합친다
  return headerRow(hidden);
```

- [ ] **Step 4: `FlowOutline`에 DragOverlay + 설정 배선**

> **기존 import 유지(F3):** 아래는 `react`/`@dnd-kit/core`/`model` import만 *갱신*한다. 기존 `@dnd-kit/sortable`(`SortableContext`·`useSortable`·`verticalListSortingStrategy`·`sortableKeyboardCoordinates`)·`@dnd-kit/utilities`(`CSS`) import는 **그대로 유지**(literal-paste로 지우지 말 것 — 지우면 빌드 깨짐).

import 갱신:
```tsx
import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  MeasuringStrategy,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
```
`model` import에 `findStepById`·`findStepSiblings` 추가:
```tsx
import {
  isLoopStep,
  isIfStep,
  isParallelStep,
  summarizeCondition,
  findStepById,
  findStepSiblings,
  type Step,
} from "../../scenario/model";
```

`FlowOutline` 본문: `moveStep` 셀렉터 아래에 state·그룹-스코프 충돌·핸들러 추가:
```tsx
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeStep = activeId ? findStepById(steps, activeId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 그룹-스코프 충돌(spec §3.1): over 후보를 active의 형제 그룹으로만 좁혀
  // over가 중첩 컨테이너 자식이 되지 않게 → 교차-컨텍스트 취소·dead-zone 제거.
  // resolveDragEnd의 그룹내-전용 의미론과 정확히 일치(re-parenting 없음).
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const dragId = args.active.id as string;
      const siblingIds = new Set(findStepSiblings(steps, dragId).map((s) => s.id));
      const candidates = args.droppableContainers.filter((c) =>
        siblingIds.has(c.id as string),
      );
      return closestCenter({ ...args, droppableContainers: candidates });
    },
    [steps],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    const activeId = active.id as string;
    const overId = (over?.id ?? null) as string | null;
    const result = resolveDragEnd(steps, activeId, overId);
    if (result) {
      moveStep(result.stepId, result.toIndex);
    }
  };
  const handleDragCancel = () => setActiveId(null);
```

`<DndContext>` 여는 태그를 교체하고, 닫기 직전에 `<DragOverlay>`를 추가:
```tsx
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* ...기존 트리(div.flex.h-full ...)... 그대로... */}
      <DragOverlay>
        {activeStep ? <OutlineRowPreview step={activeStep} depth={0} /> : null}
      </DragOverlay>
    </DndContext>
```

> `<DragOverlay>`는 `<DndContext>`의 **직계 자식**으로 기존 트리 `<div>` *다음에* 둔다. 기존 트리 마크업(`<div className="flex h-full flex-col">…`)은 한 글자도 바꾸지 않는다 — plan의 `{/* …기존 트리… 그대로… */}`는 삭제 금지 keep-marker(빈 블록 아님).
>
> **재현 베이스라인(F4):** 이 fix(#3)는 명시적 *가설*이다. **Task 2 적용 *전*에** (= Task 1 머지 후, 순수 리팩터라 #3 여전히 재현) orchestrator가 Task 3의 "#3 재현(pre-fix)" 체크를 먼저 돌려 취소를 *관측*해 둔다 — 그래야 fix 후 "취소가 사라짐"과 §7 B-fallback 판단이 의미를 가진다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS — 회귀 락 1 + **기존 20케이스** = **21** 모두 green. (`MeasuringStrategy.Always`가 jsdom에서 act 경고/루프를 유발하면 워치포인트 — spec §8대로 `WhileDragging` + `frequency`로 후퇴 고려하되, 먼저 polyfill로 통과하는지 확인.)

- [ ] **Step 6: 전체 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "fix(editor): DragOverlay 서브트리 프리뷰 + 그룹-스코프 충돌/measuring + 소스 숨김·transform 제로화로 컨테이너 드래그 취소·하위 미추종 수리(#3/#4)"
```

> **전체 `pnpm test`(인자 없음) 1회 필수** — `FlowOutline` 외 파일 회귀 확인(targeted green ≠ full green, ui/CLAUDE.md). lint `--max-warnings=0`. UI-only라 cargo 게이트 skip.

---

## Task 3: 라이브 검증 (Playwright 포인터드래그) — orchestrator/`/live-verify`

> **코드 task 아님.** **orchestrator가 직접**(또는 `/live-verify`) 수행하는 파이프라인 step 5. 단 순서가 맞물린다 — **"#3-재현(pre-fix)"는 Task 2 *전*에**(Task 1 머지 후, 버그 잔존 상태) 수행하고, **나머지 acceptance(#3-a/b/c·#4-a/b)는 Task 2 완료 후**에 수행한다. 드래그 메커니즘은 jsdom 불가라 이게 #3/#4의 *유일한 결정적 증명*이다. KeyboardSensor는 Playwright에서 미발화 → **pointer 드래그만**. `browser_drag`은 원자적이라 드래그 *중* 상태는 **held 드래그**(`browser_run_code_unsafe`로 `page.mouse.down → move → 관측 → up`)로.

**선행:** 워크트리에서 `cd ui && pnpm dev`(vite 5173) — `/scenarios/new`는 클라이언트-only(백엔드 불필요). 다른 워크트리/master의 5173 선점 확인(lsof). Monaco 프로그램 setValue 불가라 시나리오는 **추가버튼으로 구성**(+ HTTP 스텝 여러 개 + + 반복/조건/동시).

- [ ] **체크 #3-재현(pre-fix, spec §6.1) — Task 2 *전*에 수행:** Task 1만 머지된 상태(순수 리팩터 = #3 여전히 존재)에서, 최상위 HTTP 스텝을 컨테이너 위로 끄는 held 드래그를 시도해 **드래그가 취소됨을 관측**한다. `onDragCancel`에 임시 계측(로그/카운터)을 붙여 취소 발화를 확인(이 계측은 fix 검증 후 제거하거나 영구 `onDragCancel`로 정리). 이 베이스라인이 있어야 fix 후 "취소 사라짐"과 §7 fallback 판단이 의미를 가진다. **재현이 안 되면**(이미 안정적) 그 사실을 기록하고 진행 — 단, 그땐 #3-a의 "수회 반복"으로 간헐 취소 부재를 더 강하게 확인.
- [ ] **체크 #3-a (취소 제거 + 실재 재정렬):** 최상위 HTTP 스텝을 LOOP/IF/PARALLEL 컨테이너를 *지나* 최상위 다른 위치로 `browser_drag` → ① 드래그가 취소되지 않고 ② **최상위 순서가 실제로 바뀜**을 둘 다 확인(드롭 후 아웃라인 순서/YAML 모달 비교). **no-op 드롭을 '고쳐짐'으로 오인 금지**(spec F6) — `over`가 컨테이너 중첩 자식으로 잡히면 `computeReorder`=null이라 재정렬 안 됨. 간헐성 커버 위해 **수회 반복**.
- [ ] **체크 #3-b (컨테이너 직접 드래그):** 컨테이너를 핸들로 직접 잡아 다른 컨테이너를 지나 최상위 재정렬 → 취소 없이 이동.
- [ ] **체크 #3-c (그룹-스코프 충돌 회귀):** ① 단순 최상위 HTTP↔HTTP 두 leaf swap이 여전히 동작 + ② **그룹내 중첩 재정렬**(loop `do` 안 스텝끼리, parallel 한 분기 안 스텝끼리)도 여전히 동작 — 커스텀 충돌이 같은-그룹 재정렬을 깨지 않음을 확인.
- [ ] **체크 #4-a (오버레이=서브트리):** held 드래그로 컨테이너를 잡은 채 `DragOverlay` 포털(`[data-dnd-kit] / .` 오버레이 컨테이너) 안에 **헤더 + 자식 행**이 함께 존재함을 `getBoundingClientRect`로 실측.
- [ ] **체크 #4-b (소스 숨김, F2):** 같은 held 시점에 **원위치 소스 서브트리가 시각적으로 숨겨짐**을 단언 — 포털 밖에서 그 자식 이름의 보이는 사본이 1개를 넘지 않거나 원 밴드 computed `opacity`/`visibility`가 hidden(이중-밴드 아티팩트 가드).
- [ ] **콘솔:** Zod/React 에러 0(`browser_console_messages`).
- [ ] **Fallback(spec §7):** #3-a/#3-b에서 취소가 *여전히 재현되면* A로는 #3을 못 잡는 것 → 멈추고 사용자에게 **B(flat-tree) 승격** 제안(A의 DragOverlay/프리뷰/충돌·측정 설정은 B로 재사용). 임의로 PASS 처리 금지.

---

## Self-Review (작성자 체크)

**1. Spec coverage:**
- spec §3.1(DndContext 설정 = 그룹-스코프 충돌 + measuring + 소스 transform 제로화 + onDragStart/Cancel) → Task 2 Step 3(b2)·Step 4(collision 함수+DndContext props). §3.2(DragOverlay 서브트리 + 소스 숨김) → Task 1(프리뷰)·Task 2(배선+hide). §3.3(공유 조각·프리뷰 accent 미표시·aria-hidden) → Task 1. §3.4(setActivatorNodeRef) → Task 2 Step 3(c). §3.5(byte-identical) → Global Constraints + 두 task 모두 reorder/model/ko 무변경(`findStepSiblings`는 read-only). §4(non-goals)·§6.2(단위) → Task 1·2 테스트. §6.1(재현 우선)·§6.3(Playwright)·§7(fallback) → Task 3. §8(위험: 그룹-스코프 충돌 회귀·measuring 비용) → Task 3 #3-c·Task 2 Step 5 메모. ✅ 빠짐 없음.
**2. Placeholder scan:** TBD/TODO/"적절히"/빈 코드블록 없음 — 모든 step에 완전한 코드/명령. Task 2 Step 4의 `{/* …기존 트리… 그대로… */}`는 삭제-금지 keep-marker(빈 블록 아님, 인접 주석으로 명시). ✅
**3. Type consistency:** `RowContent({step})`·`ContainerBands({step,depth,renderGroup})`·`OutlineRowPreview({step,depth})`·`findStepById(steps,id):Step|null`·`findStepSiblings(steps,id):ReadonlyArray<Step>` — Task 1 정의와 Task 2 소비 시그니처 일치. `collisionDetection`은 `useCallback<CollisionDetection>([steps])`로 정의·DndContext에서 소비(같은 task). `headerRow`는 Task 1 const → Task 2 함수(extra:string)로 전환(같은 task 내 정합). `hidden`/`setActivatorNodeRef`/`isDragging`/소스 transform 제로화는 Task 2에서만 도입·사용. ✅

<!-- REVIEW-GATE: APPROVED -->
