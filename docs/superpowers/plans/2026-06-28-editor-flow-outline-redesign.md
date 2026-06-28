# 에디터 흐름 아웃라인 재설계 Implementation Plan (슬라이스 1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터의 React Flow 팬 캔버스를 세로 인터랙티브 아웃라인으로 교체하고, 디테일 편집기를 1fr로 넓히며, 변수 패널을 접이식으로, YAML을 양방향 모달로 빼서 편집 공간을 확보한다.

**Architecture:** 같은 Zustand store/모델 위에 새 *뷰*(`FlowOutline`)와 드래그 어피던스를 올린다. 모델·YAML 편집 의미론(`yamlDoc.ts`/`store.ts` 편집 액션·`moveStep`)·엔진/proto/migration은 byte-identical. React Flow를 에디터에서 완전히 제거하고 `dnd-kit`(그룹내 정렬)을 추가한다. YAML 편집은 기존 디바운스-라이브 sync(`pendingYamlText`/`commitPendingYaml`)를 그대로 쓰되 위치만 탭→모달로 옮긴다.

**Tech Stack:** TypeScript + React + Vite + Tailwind + Zustand + `@monaco-editor/react`(YAML 모달) + `@dnd-kit/core`+`@dnd-kit/sortable`(신규, 그룹내 드래그). 테스트 = vitest + @testing-library/react + userEvent. 게이트 = `pnpm lint && pnpm test && pnpm build`.

## Global Constraints

- **계약 경계 없음**: UI Zod ↔ engine serde / proto / migration / CSV·XLSX 어느 것도 건드리지 않는다. 머지 diff = `ui/`(+`docs/`·`package.json`·`pnpm-lock.yaml`)만 — `crates/`·`*.proto`·`*.sql` 0건 (spec R11).
- **모델/YAML/store 편집 의미론 byte-identical**: `scenario/model.ts`·`yamlDoc.ts`(편집 apply 6종)·`store.ts` 편집 액션 무변경. `moveStep(stepId, toIndex)` 그대로 재사용. (R11)
- **양방향 sync 불변식 보존**: `pendingYamlText`/`setPendingYamlText`/`commitPendingYaml`/`clearPendingYaml`·dirty-flag·`baselineSeededRef` 무변경. (R8)
- **`TestRunSection` 무변경**: 하단 흐름 다이어그램·테스트 결과 색상은 슬라이스 2 연기. 두 페이지에서 에디터 아래 그대로. (R12)
- **모든 사용자 노출 문구·`aria-label`은 `ko.ts` 경유** (ADR-0035). 하드코딩 영어 금지.
- **오프라인/CSP**: `default-src 'self'` — 신규 dep은 npm 번들(dnd-kit는 순수 JS, 외부 fetch 0). `pnpm-lock.yaml` 커밋(R14). `index.html` CSP 메타 무변경.
- **UI 게이트 순서**: `tdd-guard` 때문에 각 task는 **테스트 파일을 먼저** 편집(pending RED diff)한 뒤 src 편집. 머지 전 `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체, 인자 없이)·`pnpm build`(`tsc -b`) 전부 green.
- **`ResizeObserver` 폴리필(`ui/src/test/setup.ts`) 유지** — recharts `ResponsiveContainer`(ReportView/RunDetailPage 테스트)가 공동 의존. 절대 제거 금지(R7).
- **셀렉터 fallback은 모듈 스코프 안정 상수**(`EMPTY_STEPS` 등) — 인라인 `?? []` 금지(getSnapshot 경고/크래시). (M3)

---

## Task 1: 의존성 + 추가 ko 키 + 죽은 문구 정정

**Files:**
- Modify: `ui/package.json` (dnd-kit deps 추가), `ui/pnpm-lock.yaml` (자동 갱신)
- Modify: `ui/src/i18n/ko.ts` (신규 키 추가 + `problemGateAction`/`problemGateIntro` 값 정정)
- Test: `ui/src/i18n/__tests__/editorRedesignKeys.test.ts` (신규)

**Interfaces:**
- Produces: 새 `ko.editor.*` 키 — `varsToggle: string`(변수 패널 토글 라벨), `varsToggleAria: string`, `openYaml: string`(`</> YAML` 버튼), `yamlModalTitle: string`, `dragHandleAria: (name: string) => string`, `outlineRowAria: (name: string) => string`. 정정된 `problemGateAction`/`problemGateIntro`.
- Note: dnd-kit는 Task 5에서 import — 여기선 설치만(미사용 dep은 lint/build 무해).

- [ ] **Step 1: dnd-kit 설치 (config, 테스트 불요)**

```bash
cd ui && pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```
Expected: `package.json` dependencies에 3개 추가, `pnpm-lock.yaml` 갱신. (설치만으로는 번들/동작 변화 없음.)

- [ ] **Step 2: 실패 테스트 작성 (ko 키 + 정정 문구)**

`ui/src/i18n/__tests__/editorRedesignKeys.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { ko } from "../ko";

describe("editor redesign ko keys", () => {
  it("새 툴바/아웃라인/모달 키가 비어있지 않은 문자열이다", () => {
    expect(ko.editor.varsToggle).toBeTruthy();
    expect(ko.editor.varsToggleAria).toBeTruthy();
    expect(ko.editor.openYaml).toBeTruthy();
    expect(ko.editor.yamlModalTitle).toBeTruthy();
    expect(ko.editor.dragHandleAria("로그인")).toContain("로그인");
    expect(ko.editor.outlineRowAria("로그인")).toContain("로그인");
    // ADR-0035: 아웃라인/변수 패널의 사용자 노출 문구도 ko 경유 (finding 3)
    expect(ko.editor.varsPanelAria).toBeTruthy();
    expect(ko.editor.urlMissingTitle).toBe("URL이 비어 있습니다");
    expect(ko.editor.containerLoop).toBeTruthy();
    expect(ko.editor.containerIf).toBeTruthy();
    expect(ko.editor.containerParallel).toBeTruthy();
  });

  it("죽은 UI 참조 문구 정정 (C1) — '탭'/'캔버스' 제거", () => {
    expect(ko.editor.problemGateAction).toBe("YAML 열어 확인");
    expect(ko.editor.problemGateAction).not.toContain("탭");
    expect(ko.editor.problemGateIntro).not.toContain("캔버스");
    expect(ko.editor.problemGateIntro).toContain("에디터");
  });
});
```

- [ ] **Step 3: 테스트 RED 확인**

Run: `cd ui && pnpm test editorRedesignKeys`
Expected: FAIL (키 미존재 / 옛 문구).

- [ ] **Step 4: ko.ts 편집**

`ui/src/i18n/ko.ts`의 `editor` 객체에 키 추가(기존 키 옆, 적절 위치):
```typescript
    varsToggle: "변수",
    varsToggleAria: "변수 패널 접기/펼치기",
    varsPanelAria: "변수",
    openYaml: "YAML",
    yamlModalTitle: "YAML 편집",
    dragHandleAria: (name: string) => `"${name}" 스텝 순서 이동 (드래그)`,
    outlineRowAria: (name: string) => `스텝: ${name}`,
    urlMissingTitle: "URL이 비어 있습니다",
    containerLoop: "반복",
    containerIf: "조건",
    containerParallel: "동시",
```
그리고 기존 값 정정(키는 유지):
- `problemGateAction`: 기존 `"YAML 탭에서 확인"` → `"YAML 열어 확인"`.
- `problemGateIntro`: 기존 값에서 `"캔버스"`를 `"에디터"`로 치환(나머지 문장 보존 — 예: "…에디터에 마지막 정상 상태가 표시될 수 있습니다.").

(이 task에서는 `tabCanvas`/`tabYaml`/`yamlTabNoInspector`를 **아직 제거하지 않는다** — TabBar/EditorShell이 Task 3까지 쓰므로 Task 4에서 제거.)

- [ ] **Step 5: 테스트 GREEN 확인**

Run: `cd ui && pnpm test editorRedesignKeys`
Expected: PASS.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/package.json ui/pnpm-lock.yaml ui/src/i18n/ko.ts ui/src/i18n/__tests__/editorRedesignKeys.test.ts
git commit -m "feat(editor): dnd-kit 의존성 + 아웃라인 재설계 ko 키 + 게이트 문구 정정 (R14/C1)"
```
Expected: 전체 green, 커밋 landed.

---

## Task 2: `FlowOutline` 컴포넌트 (정적 — 렌더·선택·키보드, 드래그 없이)

**Files:**
- Create: `ui/src/components/scenario/FlowOutline.tsx`
- Create: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

**Interfaces:**
- Consumes: store `model.steps`/`selectedStepId`/`select`/`addStep`/`addLoopStep`/`addStepInLoop`/`addIfStep`/`addParallelStep` (기존), `isLoopStep`/`isIfStep`/`isParallelStep`/`summarizeCondition`/`Step` from `scenario/model.ts`. (`findStepById`는 이 컴포넌트가 쓰지 않으니 import 금지 — unused-import lint.)
- Produces: `export function FlowOutline()`. 모듈 스코프 `const EMPTY_STEPS: Step[] = []`. 모듈 스코프 `METHOD_BADGE: Record<string,string>` (메서드별 색 클래스). (드래그는 Task 5에서 추가.)
- Note: 이 task 시점엔 `CanvasView`가 아직 `EditorShell`에 마운트돼 있다(공존). `FlowOutline`은 자기 테스트만 import(미사용 production 컴포넌트는 lint/build 무해).

- [ ] **Step 1: 실패 테스트 작성 (전체 렌더·선택·키보드·빈상태·URL 배지)**

`ui/src/components/scenario/__tests__/FlowOutline.test.tsx`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const NESTED_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000010"
    name: gate
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000020"
        name: inner-loop
        type: loop
        repeat: 3
        do:
          - id: "01HX0000000000000000000021"
            name: ping
            type: http
            request:
              method: GET
              url: "/ping"
            assert:
              - status: 200
  - id: "01HX0000000000000000000030"
    name: fan-out
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000031"
            name: get-user
            type: http
            request:
              method: GET
              url: "/user"
            assert:
              - status: 200
      - name: feed
        steps:
          - id: "01HX0000000000000000000032"
            name: get-feed
            type: http
            request:
              method: GET
              url: "/feed"
            assert:
              - status: 200
`;

describe("FlowOutline render (full nesting)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("renders every leaf + container with full nesting", () => {
    render(<FlowOutline />);
    // top-level http
    expect(screen.getByText("login")).toBeInTheDocument();
    // method badge text (R6: color + text)
    expect(screen.getByText("POST")).toBeInTheDocument();
    // raw url shown (parity with old canvas — raw, not resolved)
    expect(screen.getByText("/login")).toBeInTheDocument();
    // if container + condition summary + THEN band
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText(/\{\{code\}\} eq 200/)).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    // nested loop container + repeat badge + depth-2 leaf
    expect(screen.getByText("inner-loop")).toBeInTheDocument();
    expect(screen.getByText(/×\s*3/)).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument();
    // parallel container + lane labels + branch leaves
    expect(screen.getByText("fan-out")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("feed")).toBeInTheDocument();
    expect(screen.getByText("get-user")).toBeInTheDocument();
    expect(screen.getByText("get-feed")).toBeInTheDocument();
  });

  it("indents nested rows deeper than top-level rows", () => {
    render(<FlowOutline />);
    const top = screen.getByRole("option", { name: /login/ });
    const nested = screen.getByRole("option", { name: /ping/ });
    // depth is encoded as a data attribute (data-depth) for a deterministic assertion
    expect(Number(nested.getAttribute("data-depth"))).toBeGreaterThan(
      Number(top.getAttribute("data-depth")),
    );
  });
});

describe("FlowOutline selection", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("clicking a row selects that step", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    await user.click(screen.getByText("login"));
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
  });

  it("pressing Enter on a focused row selects it (keyboard a11y, M2)", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /ping/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000021");
  });

  it("clicking the empty background clears selection", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    await user.click(screen.getByTestId("outline-blank"));
    expect(useScenarioEditor.getState().selectedStepId).toBeNull();
  });

  it("the selected row carries the accent highlight class", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /login/ });
    expect(row.className).toMatch(/border-accent-500|ring-accent/);
  });
});

describe("FlowOutline url-missing badge + add buttons + empty state", () => {
  beforeEach(() => reset());

  it("renders a ⚠ badge only on http rows whose url is empty", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    name: "no-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
  - id: "01HX0000000000000000000041"
    name: "has-url"
    type: http
    request:
      method: GET
      url: "/ok"
    assert:
      - status: 200
`);
    render(<FlowOutline />);
    expect(screen.getAllByTitle("URL이 비어 있습니다")).toHaveLength(1);
  });

  it("shows the empty-state message and the 4 add buttons", () => {
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    expect(screen.getByText(/HTTP 스텝을 추가해 시작하세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 조건(if)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 동시 실행(parallel)" })).toBeInTheDocument();
  });

  it("the add-HTTP button appends a step and selects it", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    const st = useScenarioEditor.getState();
    expect(st.model!.steps.length).toBe(1);
    expect(st.selectedStepId).not.toBeNull();
  });

  it("selecting a top-level loop morphs the primary add button into the in-loop variant", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps[0].type === "loop" && steps[0].do.length).toBe(2); // seed child + 1
  });
});
```

- [ ] **Step 2: 테스트 RED 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: FAIL (`Cannot find module '../FlowOutline'`).

- [ ] **Step 3: `FlowOutline.tsx` 구현**

`ui/src/components/scenario/FlowOutline.tsx` — 재귀 트리 렌더러. 핵심 구조(프레젠테이셔널 JSX 디테일은 idiom대로 채우되, 아래 계약을 만족):

```typescript
import { useMemo } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import {
  isLoopStep,
  isIfStep,
  isParallelStep,
  summarizeCondition,
  type Step,
} from "../../scenario/model";

// 데이터-식별 팔레트(메서드별) — accent 토큰과 별개 도메인(ui/CLAUDE.md 디자인시스템 노트).
const METHOD_BADGE: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-violet-100 text-violet-700",
  DELETE: "bg-red-100 text-red-700",
  HEAD: "bg-slate-100 text-slate-600",
  OPTIONS: "bg-slate-100 text-slate-600",
};

// 셀렉터 fallback은 모듈 스코프 안정 상수(M3 — 인라인 `?? []` 금지).
const EMPTY_STEPS: Step[] = [];

// loop `do` / if 밴드(then·elif[].then·else) / parallel 레인을 라벨 붙은
// 들여쓴 그룹으로 렌더하는 재귀 함수. depth는 data-depth로 노출(테스트 결정성).
function OutlineRow({ step, depth }: { step: Step; depth: number }) {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const selected = step.id === selectedStepId;
  const accent = selected ? "border-accent-500 ring-1 ring-accent-500" : "border-slate-200";

  // 행 컨테이너는 role="option" + tabIndex (button-in-button 회피 — 드래그 핸들이 Task 5에서 별도 button).
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
    style: { marginLeft: `${depth * 16}px` },
    className: `flex items-center gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`,
  };

  if (isLoopStep(step)) {
    return (
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
          <span className="font-medium">{step.name}</span>
          <span className="text-xs text-slate-500">× {step.repeat}</span>
        </div>
        <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
          {step.do.map((c) => (
            <OutlineRow key={c.id} step={c} depth={depth + 1} />
          ))}
        </div>
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
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⎇" label={ko.editor.containerIf} />
          <span className="font-medium">{step.name}</span>
          <span className="text-xs text-slate-500">{summarizeCondition(step.cond)}</span>
        </div>
        {bands.map((b) => (
          <div key={b.label} className="mt-1 border-l-2 border-slate-200">
            <div className="px-2 text-[11px] font-semibold text-slate-400" style={{ marginLeft: `${(depth + 1) * 16}px` }}>
              {b.label}
            </div>
            <div className="flex flex-col gap-1">
              {b.children.map((c) => (
                <OutlineRow key={c.id} step={c} depth={depth + 1} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (isParallelStep(step)) {
    return (
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⇉" label={ko.editor.containerParallel} />
          <span className="font-medium">{step.name}</span>
        </div>
        {step.branches.map((b) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div className="px-2 text-[11px] font-semibold text-slate-400" style={{ marginLeft: `${(depth + 1) * 16}px` }}>
              {b.name}
            </div>
            <div className="flex flex-col gap-1">
              {b.steps.map((c) => (
                <OutlineRow key={c.id} step={c} depth={depth + 1} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // http leaf
  const urlMissing = step.request.url.trim() === "";
  return (
    <div {...rowProps}>
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}>
        {step.request.method}
      </span>
      <span className="font-medium">{step.name}</span>
      <span className="truncate text-xs text-slate-500" title={step.request.url}>
        {step.request.url}
      </span>
      {urlMissing && (
        <span title={ko.editor.urlMissingTitle} className="text-amber-500">
          ⚠
        </span>
      )}
    </div>
  );
}

function ContainerTag({ glyph, label }: { glyph: string; label: string }) {
  // glyph는 장식(aria-hidden), 라벨 텍스트만 ko 경유(ADR-0035).
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  );
}

export function FlowOutline() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);
  const addLoopStep = useScenarioEditor((s) => s.addLoopStep);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);
  const addIfStep = useScenarioEditor((s) => s.addIfStep);
  const addParallelStep = useScenarioEditor((s) => s.addParallelStep);

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  return (
    <div className="flex h-full flex-col">
      <div
        data-testid="outline-blank"
        className="flex-1 overflow-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
      >
        <div className="flex flex-col gap-1">
          {steps.map((s) => (
            <OutlineRow key={s.id} step={s} depth={0} />
          ))}
        </div>
        {steps.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">{ko.editor.canvasEmpty}</p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-slate-400 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          onClick={() => {
            const id = selectedLoopId
              ? addStepInLoop(selectedLoopId, `Step ${steps.length + 1}`)
              : addStep(`Step ${steps.length + 1}`);
            select(id);
          }}
        >
          {selectedLoopId ? ko.editor.addHttpStepInLoop : ko.editor.addHttpStep}
        </button>
        <button type="button" className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addLoopStep(`Loop ${steps.length + 1}`))}>
          {ko.editor.addLoop}
        </button>
        <button type="button" className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addIfStep(`If ${steps.length + 1}`))}>
          {ko.editor.addIf}
        </button>
        <button type="button" className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addParallelStep(`Parallel ${steps.length + 1}`))}>
          {ko.editor.addParallel}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">{ko.editor.containerCaption}</p>
    </div>
  );
}
```

주의: `OutlineRow`가 store 셀렉터(`select`/`selectedStepId`)를 구독해도 되지만, 행이 많으면 부모에서 한 번 구독해 prop으로 내려도 된다 — 구현자 판단(테스트가 동작을 고정). `border-accent-500`/`ring-accent-500`는 ADR-0043 accent 토큰(=indigo) 별칭.

- [ ] **Step 4: 테스트 GREEN 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS (전부).

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "feat(editor): 세로 인터랙티브 아웃라인 FlowOutline (렌더·선택·키보드·추가 — 드래그 제외) (R3/R4/R6 M2/M3)"
```
Expected: 전체 green. (`CanvasView`는 아직 EditorShell에 마운트돼 있고 FlowOutline은 미사용 — 무해.)

---

## Task 3: `EditorShell` + `ValidationBanner` 재배선 (FlowOutline 마운트 · YAML 모달 · 변수 접기 · onOpenYaml)

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx`
- Modify: `ui/src/components/scenario/ValidationBanner.tsx`
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (기존 2 테스트 재작성)
- Test: `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx` (lines 32/44 테스트 재작성)

**Interfaces:**
- Consumes: `FlowOutline`(Task 2), `Modal`(`ui/src/components/Modal.tsx` — `{open,onClose,title,children}`), `MonacoYamlView`, `Inspector`, `VariablesPanel`, store `commitPendingYaml`/`pendingYamlText`.
- Produces: `ValidationBanner`에 신규 prop `onOpenYaml?: () => void`. EditorShell이 `<ValidationBanner onOpenYaml={() => setYamlOpen(true)} />`로 주입.
- Note: 이 task에서 `CanvasView`/`TabBar` 파일은 **삭제하지 않는다**(Task 4). EditorShell이 그것들을 더 이상 *import하지 않을* 뿐 — 파일·그 테스트는 그대로 green. store `activeTab`도 이 task에선 유지(TabBar/그 테스트가 아직 씀).

- [ ] **Step 1: 실패 테스트 작성 (EditorShell 재배선)**

`ui/src/components/scenario/__tests__/EditorShell.test.tsx` — 기존 `describe("EditorShell")`의 `"hides the inspector when the YAML tab is active"`(line 58) **삭제**하고, `describe("EditorShell YAML tab placeholder (U3)")`(line 71) 블록 **전체 삭제**. 대신 아래를 추가(파일 첫 `it`인 getSnapshot 핀 테스트는 **그대로 첫 위치 유지**):
```typescript
  it("디테일 편집기 컬럼이 고정 320px가 아닌 가변(1fr)이다 (R1)", () => {
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    const grid = screen.getByTestId("editor-grid");
    expect(grid.className).toContain("1fr"); // 디테일 = 1fr 가변
    expect(grid.className).not.toContain("320px"); // 옛 고정폭 제거
  });

  it("YAML 버튼 클릭 시 모달에 Monaco(yaml-view)가 열리고 닫힌다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    // 인스펙터는 항상 보인다(더 이상 탭 게이트 없음)
    expect(screen.getByRole("complementary", { name: ko.editor.inspectorAria })).toBeInTheDocument();
    expect(screen.queryByTestId("yaml-view")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.openYaml }));
    expect(screen.getByTestId("yaml-view")).toBeInTheDocument();
    // 디바운스 윈도에 미커밋 편집이 있다고 가정 — 닫기가 flush-커밋하는지(R8)를
    // 관측가능 상태(model 갱신 + pendingYamlText null)로 검증(Monaco는 모킹이라 직접 못 침).
    useScenarioEditor.setState({ pendingYamlText: 'version: 1\nname: "flushed"\nsteps: []\n' });
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByTestId("yaml-view")).not.toBeInTheDocument();
    expect(useScenarioEditor.getState().model?.name).toBe("flushed"); // flush 커밋됨
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("변수 토글 버튼이 VariablesPanel을 접고 편다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nvariables: {BASE_URL: "http://h"}\nsteps: []\n'} />);
    // 펼친 기본 상태: 변수 패널(complementary, name=ko.editor.varsPanelAria) 보임.
    // getByText(/변수/)는 토글 텍스트와 패널 h3 둘 다 매치해 throw → role로 정확 스코프(finding 2).
    expect(screen.getByRole("complementary", { name: ko.editor.varsPanelAria })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: ko.editor.varsToggleAria });
    await user.click(toggle); // 접기
    expect(screen.queryByRole("complementary", { name: ko.editor.varsPanelAria })).not.toBeInTheDocument();
    await user.click(toggle); // 다시 펼치기
    expect(screen.getByRole("complementary", { name: ko.editor.varsPanelAria })).toBeInTheDocument();
  });
```
(`describe("EditorShell 검증 배너 (U4)")` 블록(line 84~)은 그대로 유지 — 배너는 계속 렌더된다.)

VariablesPanel을 접이식으로 만들기 위해 EditorShell이 그 패널을 `<aside role="complementary" aria-label={ko.editor.varsPanelAria}>` 래퍼에 두거나, 접힘 시 미렌더한다. 위 테스트는 "접으면 complementary(`varsPanelAria`) 부재"로 고정 — 구현은 접힘 시 패널 미렌더(또는 width 0 + DOM 제거).

- [ ] **Step 2: 실패 테스트 작성 (ValidationBanner onOpenYaml)**

`ui/src/components/scenario/__tests__/ValidationBanner.test.tsx` — line 32 테스트와 line 44 테스트를 아래로 교체(나머지 `"문제 0건이면 렌더하지 않는다"`는 유지):
```typescript
  it("빈 URL 스텝을 나열하고 클릭 시 해당 스텝을 선택한다 (탭 전환 없음)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    render(<ValidationBanner />);

    expect(screen.getByText(ko.editor.problemsBannerTitle(1))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /"ping" 스텝의 URL이 비어/ }));
    expect(useScenarioEditor.getState().selectedStepId).toBe(ULID_A);
  });

  it("게이트 에러는 스텝 항목을 숨기고 한국어 매핑 + YAML 모달 열기 버튼만 보인다", async () => {
    const user = userEvent.setup();
    const onOpenYaml = vi.fn();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner onOpenYaml={onOpenYaml} />);

    expect(screen.queryByRole("button", { name: /"ping"/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(ko.editor.gateRequired("steps.0.request.url"))).toBeInTheDocument();
    expect(screen.getByText(ko.editor.problemGateIntro)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.problemGateAction }));
    expect(onOpenYaml).toHaveBeenCalledTimes(1);
  });
```
파일 상단 import에 `vi`를 추가(`import { beforeEach, describe, expect, it, vi } from "vitest";`).

- [ ] **Step 3: 테스트 RED 확인**

Run: `cd ui && pnpm test EditorShell ValidationBanner`
Expected: FAIL (openYaml 버튼·varsToggle·onOpenYaml prop 미존재).

- [ ] **Step 4: `ValidationBanner.tsx` 수정**

- 시그니처에 prop 추가: `export function ValidationBanner({ onOpenYaml }: { onOpenYaml?: () => void } = {})`.
- 게이트-액션 버튼(`:35`)의 `onClick={() => setActiveTab("yaml")}` → `onClick={() => onOpenYaml?.()}`.
- 스텝-문제 버튼(`:51`)의 `setActiveTab("canvas");` 호출 **제거**(스텝 `select(...)`만 유지).
- `setActiveTab` 구독/import 제거(`const setActiveTab = useScenarioEditor((s) => s.setActiveTab)` 라인 삭제).

- [ ] **Step 5: `EditorShell.tsx` 수정**

```typescript
import { useEffect, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { FlowOutline } from "./FlowOutline";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { Modal } from "../Modal";
import { ValidationBanner } from "./ValidationBanner";
import { VariablesPanel } from "./VariablesPanel";

export function EditorShell({ initialYaml, onChange }: { initialYaml: string; onChange?: (yaml: string) => void }) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);

  const [yamlOpen, setYamlOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(true);

  const initialRef = useRef(initialYaml);
  useEffect(() => {
    loadFromString(initialRef.current);
  }, [loadFromString]);
  useEffect(() => {
    onChange?.(yamlText);
  }, [yamlText, onChange]);

  const closeYaml = () => {
    commitPendingYaml(); // 디바운스 윈도 중 닫기 시 마지막 편집 flush (R8)
    setYamlOpen(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <ValidationBanner onOpenYaml={() => setYamlOpen(true)} />
      <div className="flex items-center gap-2">
        <button type="button" aria-label={ko.editor.varsToggleAria}
          onClick={() => setVarsOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100">
          ☰ {ko.editor.varsToggle}
        </button>
        <button type="button"
          aria-label={ko.editor.openYaml}
          onClick={() => setYamlOpen(true)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100">
          <span aria-hidden="true">{"</>"}</span> {ko.editor.openYaml}
        </button>
      </div>
      <div data-testid="editor-grid" className={`grid gap-4 min-h-[680px] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`}>
        {varsOpen && (
          <aside role="complementary" aria-label={ko.editor.varsPanelAria} className="rounded-md border border-slate-200 bg-white p-3">
            <VariablesPanel />
          </aside>
        )}
        <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto">
          <FlowOutline />
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-3">
          <Inspector />
        </div>
      </div>
      <Modal open={yamlOpen} onClose={closeYaml} title={ko.editor.yamlModalTitle}>
        <MonacoYamlView />
      </Modal>
    </div>
  );
}
```
주의: `TabBar`/`activeTab`/`setActiveTab` import·사용 전부 제거. `Inspector`는 항상 렌더(YAML 탭 분기 없음). VariablesPanel을 `role="complementary" aria-label={ko.editor.varsPanelAria}`로 감싸 토글 테스트가 고정됨. grid는 변수 접힘 시 2열(변수 col 제거).

- [ ] **Step 6: 테스트 GREEN 확인**

Run: `cd ui && pnpm test EditorShell ValidationBanner`
Expected: PASS. (getSnapshot 핀 테스트도 green — FlowOutline이 안정 `EMPTY_STEPS` 사용.)

- [ ] **Step 7: 전체 게이트 (페이지 테스트 회귀 확인)**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전체 green. **주의**: `ScenarioPages.test`·`ScenarioEditPage.*.test`·`ScenarioNewPage.*.test`가 EditorShell을 마운트한다 — 이제 `CanvasView`(React Flow) 대신 `FlowOutline`(순수 HTML)을 렌더하므로 React Flow/ResizeObserver 의존이 사라져 더 단순해진다. 만약 이 페이지 테스트가 캔버스-특정 텍스트(예: 옛 탭 라벨)를 쿼리하면 그 단언만 새 구조로 갱신(대개 무영향 — test-run/save/clone 경로를 봄). red가 나면 그 파일을 같은 커밋에서 수정.

- [ ] **Step 8: 커밋**

```bash
git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/ValidationBanner.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx ui/src/components/scenario/__tests__/ValidationBanner.test.tsx
git commit -m "feat(editor): EditorShell 아웃라인+넓은 편집기+변수접기+YAML 모달 재배선, ValidationBanner onOpenYaml (R1/R2/R8/R13 F1)"
```
Expected: green 커밋.

---

## Task 4: React Flow / 탭 자산 정리 (삭제 — green-fold)

**Files:**
- Delete: `ui/src/components/scenario/CanvasView.tsx`, `HttpStepNode.tsx`, `LoopStepNode.tsx`, `IfStepNode.tsx`, `ParallelStepNode.tsx`, `TabBar.tsx`
- Delete: `ui/src/components/scenario/__tests__/CanvasView.test.tsx`, `HttpStepNode.test.tsx`, `TabBar.test.tsx`
- Modify: `ui/package.json` (`@xyflow/react` 제거), `ui/pnpm-lock.yaml`
- Modify: `ui/src/scenario/store.ts` (`activeTab`/`setActiveTab`/`Tab`/`INITIAL.activeTab`/`actions` shim 제거)
- Modify: `ui/src/i18n/ko.ts` (`tabCanvas`/`tabYaml`/`yamlTabNoInspector` 제거)
- Modify: `ui/src/test/setup.ts` (ResizeObserver 폴리필 **유지**, 주석만 갱신)
- Modify: store 테스트(있다면 `activeTab` 참조) — 검색 후 갱신

**Interfaces:**
- Note: Task 3 이후 이 자산들은 전부 미사용(EditorShell이 import 안 함). 삭제는 순수 정리라 동작 무변경. 이 task의 "테스트"는 grep 불변식 + 전체 게이트.

- [ ] **Step 0: tdd-guard 언블록 + 죽은 키 락인 (pending test 먼저)**

이 task는 watched src(`store.ts`·`ko.ts`)를 편집하지만 새 동작 테스트가 없다(순수 삭제) → `tdd-guard`가 첫 src 편집을 막을 수 있다. **먼저** `ui/src/i18n/__tests__/editorRedesignKeys.test.ts`에 죽은-키 단언을 추가해 pending test diff를 만든다(언블록 + 제거 락인):
```typescript
  it("죽은 탭 키가 제거됐다 (Task 4)", () => {
    const e = ko.editor as Record<string, unknown>;
    expect(e.tabCanvas).toBeUndefined();
    expect(e.tabYaml).toBeUndefined();
    expect(e.yamlTabNoInspector).toBeUndefined();
  });
```
이 테스트는 키 제거(Step 4) 전까지 RED — 자연 TDD. (test-path 편집은 tdd-guard가 항상 허용 → 이후 src 삭제/편집 언블록.)

- [ ] **Step 1: 미사용 확인 (grep)**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-flow-redesign
grep -rn "CanvasView\|HttpStepNode\|LoopStepNode\|IfStepNode\|ParallelStepNode\|TabBar" ui/src --include=*.tsx --include=*.ts | grep -v "__tests__/CanvasView\|__tests__/HttpStepNode\|__tests__/TabBar\|scenario/CanvasView.tsx\|scenario/HttpStepNode.tsx\|scenario/LoopStepNode.tsx\|scenario/IfStepNode.tsx\|scenario/ParallelStepNode.tsx\|scenario/TabBar.tsx"
```
Expected: **0줄 또는 `test/setup.ts`의 옛 주석 줄만**(EditorShell이 더 이상 import 안 함 — Task 3에서 제거됨; `test/setup.ts:5` 주석의 `CanvasView` 언급은 Step 5에서 치환되니 예상된 잔여, *코드* 사용처 아님). 그 외 줄이 남으면 그 소비처를 먼저 정리.

- [ ] **Step 2: 파일 삭제 + dep 제거**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-flow-redesign
git rm ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/HttpStepNode.tsx ui/src/components/scenario/LoopStepNode.tsx ui/src/components/scenario/IfStepNode.tsx ui/src/components/scenario/ParallelStepNode.tsx ui/src/components/scenario/TabBar.tsx
git rm ui/src/components/scenario/__tests__/CanvasView.test.tsx ui/src/components/scenario/__tests__/HttpStepNode.test.tsx ui/src/components/scenario/__tests__/TabBar.test.tsx
cd ui && pnpm remove @xyflow/react
```

- [ ] **Step 3: store `activeTab` 제거**

`ui/src/scenario/store.ts`에서 제거: `Tab` export(`:22` 부근), 인터페이스의 `activeTab`/`setActiveTab` 필드, `INITIAL` 객체의 `activeTab: "canvas"`(+ `INITIAL` 타입의 `"activeTab"` Pick), `setActiveTab(...)` 구현, `actions` shim의 `setActiveTab: s.setActiveTab`(`:369` 부근). `pendingYamlText` 관련은 **전부 유지**.

- [ ] **Step 4: 죽은 ko 키 제거**

`ui/src/i18n/ko.ts`의 `editor`에서 `tabCanvas`/`tabYaml`/`yamlTabNoInspector` 제거(Task 3 이후 소비처 0).

- [ ] **Step 5: ResizeObserver 폴리필 주석 *재작성* (폴리필 코드는 유지)**

`ui/src/test/setup.ts`의 ResizeObserver 폴리필 코드는 **그대로 두되**, 주석을 **재작성**한다 — 기존 주석이 `@xyflow/react`와 `CanvasView`를 언급하므로(현 `:5` 부근), 그 두 문자열을 **반드시 제거**하고 새 사유로 교체: `// recharts ResponsiveContainer (ReportView/RunDetailPage) requires ResizeObserver in jsdom`. (단순 *보강*이 아니라 *치환* — 안 그러면 Step 6의 `grep @xyflow/react ui/src`·R7 grep이 이 주석 줄을 잡아 0건 실패.) **폴리필 코드 삭제는 금지.**

- [ ] **Step 6: grep 불변식 + 전체 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-flow-redesign
grep -rn "@xyflow/react" ui/src ; echo "---" ; grep -n "xyflow" ui/package.json ; echo "---" ; grep -rn "\bactiveTab\b\|setActiveTab" ui/src
cd ui && pnpm lint && pnpm test && pnpm build
```
Expected: 3 grep 전부 **0줄**, 전체 게이트 green(ReportView/RunDetailPage 포함 — ResizeObserver 폴리필 유지로 통과). store 테스트가 `activeTab`을 참조했다면 이 step에서 같이 수정.

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "refactor(editor): React Flow·TabBar·activeTab·죽은 ko 키 제거 (R7/R13 — ResizeObserver 폴리필 유지)"
```
Expected: green 커밋.

---

## Task 5: 그룹내 드래그 재정렬 (`dnd-kit`)

**Files:**
- Create: `ui/src/scenario/reorder.ts` (순수 헬퍼)
- Create: `ui/src/scenario/__tests__/reorder.test.ts`
- Modify: `ui/src/components/scenario/FlowOutline.tsx` (dnd-kit Sortable + 드래그 핸들)
- Modify: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx` (moveStep 배선 테스트 추가)

**Interfaces:**
- Produces: `export function computeReorder(siblingIds: string[], activeId: string, overId: string | null): number | null` — `overId`가 같은 그룹(siblingIds)에 있고 `activeId !== overId`이면 over의 인덱스 반환, 아니면 `null`(그룹 밖·동일·null → no-op).
- Consumes: store `moveStep(stepId, toIndex)`(기존), `@dnd-kit/core`(`DndContext`,`PointerSensor`,`KeyboardSensor`,`useSensor`,`useSensors`), `@dnd-kit/sortable`(`SortableContext`,`useSortable`,`verticalListSortingStrategy`,`sortableKeyboardCoordinates`).

- [ ] **Step 1: 실패 테스트 작성 (순수 헬퍼)**

`ui/src/scenario/__tests__/reorder.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { computeReorder } from "../reorder";

describe("computeReorder", () => {
  const group = ["a", "b", "c"];
  it("returns the over index within the same group", () => {
    expect(computeReorder(group, "a", "c")).toBe(2);
    expect(computeReorder(group, "c", "a")).toBe(0);
  });
  it("returns null when active === over (no move)", () => {
    expect(computeReorder(group, "b", "b")).toBeNull();
  });
  it("returns null when over is null", () => {
    expect(computeReorder(group, "a", null)).toBeNull();
  });
  it("returns null when over is in a different group (cross-container drop ignored — slice 3)", () => {
    expect(computeReorder(group, "a", "z")).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 RED 확인**

Run: `cd ui && pnpm test reorder`
Expected: FAIL (`Cannot find module '../reorder'`).

- [ ] **Step 3: `reorder.ts` 구현**

```typescript
// 그룹내 정렬만 (컨테이너 경계 넘기 = 슬라이스 3). over가 같은 형제 그룹에
// 없으면(다른 컨테이너로 드롭) null = no-op.
export function computeReorder(
  siblingIds: string[],
  activeId: string,
  overId: string | null,
): number | null {
  if (overId === null || activeId === overId) return null;
  const idx = siblingIds.indexOf(overId);
  if (idx === -1) return null; // over가 이 그룹 밖
  if (siblingIds.indexOf(activeId) === -1) return null; // active가 이 그룹 밖
  return idx;
}
```

- [ ] **Step 4: 헬퍼 테스트 GREEN**

Run: `cd ui && pnpm test reorder`
Expected: PASS.

- [ ] **Step 5: FlowOutline 드래그 배선 테스트 추가**

`FlowOutline.test.tsx`에 추가(`moveStep` 호출 검증 — 실제 픽셀 드래그는 Playwright가 최종 검증):
```typescript
import { computeReorder } from "../../../scenario/reorder";

describe("FlowOutline drag wiring", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: first
    type: http
    request: { method: GET, url: "/1" }
    assert: [{ status: 200 }]
  - id: "01HX0000000000000000000002"
    name: second
    type: http
    request: { method: GET, url: "/2" }
    assert: [{ status: 200 }]
`);
  });

  it("renders a keyboard-operable drag handle per row", () => {
    render(<FlowOutline />);
    expect(
      screen.getByRole("button", { name: /"first" 스텝 순서 이동/ }),
    ).toBeInTheDocument();
  });

  it("computeReorder maps a same-group drop to moveStep's toIndex", () => {
    // 순수 매핑 단언(헬퍼는 reorder.test가 전수) — 여기선 그룹 id 순서가 모델과 일치함을 핀
    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(computeReorder(ids, ids[0], ids[1])).toBe(1);
  });
});
```
(실제 dnd-kit 드래그 시뮬레이션은 jsdom에서 불안정 → 통합 드래그는 Final 단계 Playwright가 검증. 여기선 핸들 존재 + 매핑 계약만 핀.)

- [ ] **Step 6: FlowOutline에 dnd-kit 배선**

`FlowOutline.tsx`:
- 최상위와 각 컨테이너 자식 그룹을 각각 `<SortableContext items={groupIds} strategy={verticalListSortingStrategy}>`로 감싼다.
- 전체를 하나의 `<DndContext sensors={sensors} onDragEnd={handleDragEnd}>`로 감싸되, `handleDragEnd`는 **active가 속한 형제 그룹**을 찾아 `computeReorder(groupIds, active.id, over?.id)` → 非null이면 `moveStep(active.id, toIndex)`.
- 각 행에 `useSortable({ id: step.id })`로 `attributes`/`listeners`/`setNodeRef`/`transform`을 받아 **드래그 핸들 `<button>`** 에 `{...attributes} {...listeners}`를 스프레드(`aria-label={ko.editor.dragHandleAria(step.name)}` — 행 `role="option"`과 별개 button이라 button-in-button 회피).
- 센서: `useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))`.
- 형제 그룹 id 목록은 모델에서 도출: 최상위 = `steps.map(id)`, loop = `step.do.map(id)`, if 밴드 = 각 `band.children.map(id)`, parallel 레인 = 각 `branch.steps.map(id)`. `handleDragEnd`는 active.id가 어느 그룹에 있는지 검색해 그 그룹으로 `computeReorder`.

구현 메모: `useSortable`은 행 컴포넌트 안에서 호출하고, 그 행이 어느 `SortableContext`(그룹) 안에 있느냐로 dnd-kit이 그룹을 인식한다. `handleDragEnd`에서 그룹 도출은 재귀 검색 헬퍼(예: `findSiblingIds(steps, activeId): string[] | null`)로 — 최상위/loop do/if 밴드/parallel 레인을 훑어 active를 포함한 배열의 id 목록 반환.

- [ ] **Step 7: 테스트 GREEN + 전체 게이트**

Run: `cd ui && pnpm test FlowOutline reorder && pnpm lint && pnpm test && pnpm build`
Expected: 전체 green.

- [ ] **Step 8: 커밋**

```bash
git add ui/src/scenario/reorder.ts ui/src/scenario/__tests__/reorder.test.ts ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "feat(editor): 그룹내 드래그 재정렬 (dnd-kit Sortable + 키보드 센서 → moveStep) (R5/R6)"
```
Expected: green 커밋.

---

## Final: 전체 게이트 + 라이브 검증 (orchestrator)

> subagent task 아님 — 모든 task 머지 후 orchestrator가 직접.

- [ ] **전체 UI 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` — 전부 green(인자 없는 전체 `pnpm test`로 페이지 테스트 회귀 포함).
- [ ] **whole-feature 리뷰**: `handicap-reviewer`(크로스커팅·repo 함정·머지 diff = `ui/`+docs+package.json/lock only 확인). 보안 표면(요청실행/템플릿/바인딩/업로드/trace) 미접촉 → `security-reviewer` N/A(스킵, 근거 build-log).
- [ ] **라이브 검증(`/live-verify` + Playwright)** — S-D 필수는 아니나(run-생성/리포트/엔진 무관) 드래그·모달·접기가 jsdom 미관측이라 실측:
  1. 그룹내 드래그로 스텝 순서가 바뀌고 YAML(모달)에 반영되는지.
  2. YAML 모달 열기→편집→닫기→아웃라인 갱신(flush 커밋).
  3. 변수 접기→편집기 영역 확대.
  4. 콘솔 Zod/React 경고 0.
  (Playwright 운전법 = `docs/dev/live-verify-playwright.md`.)
- [ ] **신규 ADR 등재**: 에디터 1차 표현 = 캔버스(React Flow)→세로 아웃라인. `docs/adr/00XX-editor-outline-not-canvas.md`(다음 번호, MADR). 루트 CLAUDE.md "알아둘 결정들"에 한 줄.

---

## Self-Review (작성자 체크)

**Spec 커버리지 (R1~R14):**
- R1(레이아웃 1fr)→Task 3 Step 5/테스트. R2(변수 접기)→Task 3. R3(아웃라인 트리)→Task 2. R4(선택+키보드)→Task 2. R5(그룹내 드래그)→Task 5. R6(드래그 a11y+↑↓유지+배지 텍스트)→Task 2(배지)/Task 5(핸들)/Inspector ↑↓ 무변경. R7(RF 제거+폴리필 유지)→Task 4. R8(YAML 모달+flush)→Task 3. ~~R9~~ 연기(plan 범위 밖). R10(Inspector 무변경)→Task 3(그대로 마운트). R11(모델/wire byte-identical)→Global Constraints + Task 4 grep. R12(TestRunSection 무변경)→건드리지 않음(페이지 소유). R13(activeTab/TabBar 제거+ValidationBanner)→Task 3(배선)+Task 4(삭제). R14(dnd-kit 오프라인+lockfile+게이트)→Task 1+각 task 게이트.
- 누락 없음. C1(문구)→Task 1. M1(panelHint 드롭)→FlowOutline에 panelHint 없음(자연 반영). M2(키보드 선택)→Task 2. M3(안정 EMPTY_STEPS)→Task 2. M4(store 제거 surface)→Task 4.

**Placeholder 스캔:** 모든 코드 step에 실제 코드/명령/기대결과 포함. FlowOutline의 프레젠테이셔널 JSX는 계약(role/data-depth/title/배지 텍스트)을 테스트가 고정하므로 idiom 채움 허용.

**타입 일관성:** `computeReorder(string[], string, string|null): number|null`·`moveStep(stepId, toIndex)`·`ValidationBanner({onOpenYaml?})`·`ko.editor.*` 키 이름이 task 간 일치.

<!-- REVIEW-GATE: APPROVED -->
