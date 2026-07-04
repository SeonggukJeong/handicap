# 에디터 뷰포트 폴리시 v2 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터 5개 마찰 해소 — 얇은 스크롤바(A)·1줄입력 스크롤바 제거(E)·사용처 팝오버 위치 정확화(D)·sticky 접이식 크롬(C)·변수-넓게 뷰모드(B).

**Architecture:** UI-only. A=글로벌 CSS(`index.css` @layer base), E=`AutoGrowTextarea` 캡초과-only 스크롤, D=`VarUsagePopover.computePos` 실측높이+뷰포트 clamp, C=`ScenarioEditPage` 전용 sticky wrapper + `EditorShell` `chromeCollapsed` prop→cap 토글, B=`EditorShell` `varsWide` 상태기계(wideOpen 거울상). 3 task(A+E+D / C / B) 각 독립 green 커밋. 와이어/모델/store 무접촉.

**Tech Stack:** React 18 + TypeScript(strict) + Tailwind v3(JIT) + Vitest/RTL + Zustand + dnd-kit.

**설계 출처:** spec `docs/superpowers/specs/2026-07-05-editor-viewport-polish-v2-design.md`(spec-plan-reviewer clean APPROVE, §6 결정). 이 계획은 그 §6을 따른다.

## Global Constraints

이 절은 **모든 task에 암묵 적용**된다. 값은 spec에서 verbatim.

- **UI-only 0-diff**: `crates`/proto/migration/`model.ts`(Zod)/YAML 직렬화/store/wire 무접촉. 최종 `git diff --name-only`는 `ui/**`·`docs/**`만.
- **모든 사용자 노출 문구 + `aria-label`은 `ko.ts` 카탈로그 경유**(ADR-0035) — 하드코딩 영어/한글 금지. RTL 셀렉터도 ko 키로 lockstep.
- **임의 Tailwind 값은 소스 리터럴이어야 JIT 생성**(`tailwind.config.ts` content=`./src/**/*.{ts,tsx}`, safelist 없음) — 동적 `calc(...${x}...)`/문자열 조립 클래스 금지. cap 토글은 **두 리터럴 클래스 삼항**.
- **#4/slice-1 보존 클래스 유지**: `min-h-[520px]`·`grid-rows-[minmax(0,1fr)]`·열 `overflow-auto min-h-0`·변수 aside `overflow-visible`·VariablesPanel `pr-1.5`.
- **TDD 순서(tdd-guard)**: 각 task는 **테스트 파일 편집을 먼저**(pending RED) 한 뒤 src 편집(`ui/src/**` non-test는 pending 테스트 없으면 편집 차단). 테스트 파일(`__tests__/`·`*.test.tsx`)은 항상 편집 허용.
- **커밋 전 게이트**: `cd ui && pnpm lint && pnpm test && pnpm build` **모두 green**(`pnpm lint`=`--max-warnings=0`이라 경고도 실패). UI-only라 pre-commit은 cargo 게이트 skip + UI 게이트만.
- **컴포넌트 파일에서 비-컴포넌트 export 금지 트랩**: `react-refresh/only-export-components` warn(=lint 실패). D의 `computePos` export는 파일 유지 + `// eslint-disable-next-line react-refresh/only-export-components`(warn 발화=directive 사용됨=unused 아님).
- **커밋은 단일 foreground 호출**(`run_in_background:false`), 폴링 금지. 커밋 후 `git log -1`로 landed 확인. `| tail`/`| head` 파이프 금지(git-guard deny).
- **subagent 리포트 경로**: 리포트 `.md`는 `.superpowers/sdd/`(또는 지정 경로)에만 — worktree 루트에 쓰거나 `git add` 금지(ui/**-only diff 불변식 보호).

---

## Task 1: A(얇은 스크롤바) + E(1줄입력 스크롤바 제거) + D(팝오버 위치)

세 소fix. **A·E 결합 필수**(A의 styled `::-webkit-scrollbar`가 overlay 스크롤바를 always-visible로 바꿔 overlay-설정 환경에서 E의 1줄 바를 새로 노출 — 반드시 같이 랜딩). D는 독립이나 소규모라 동봉.

**Files:**
- Modify: `ui/src/index.css` (A — @layer base 스크롤바)
- Modify: `ui/src/components/AutoGrowTextarea.tsx:17-28` (E — 캡초과-only 스크롤)
- Modify: `ui/src/components/scenario/VarUsagePopover.tsx:10-21,44-45` (D — computePos export + 실측높이 + 뷰포트 clamp)
- Test: `ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx` (D — computePos 4케이스 추가)
- Test: `ui/src/components/__tests__/AutoGrowTextarea.test.tsx` (E — overflow no-op 계약)

**Interfaces:**
- Produces: `export function computePos(anchor: HTMLElement, popoverH?: number): { top: number; left: number }` (from `VarUsagePopover.tsx`) — 순수, 뷰포트 clamp. Task 2/3 미소비(내부 전용).

### D 먼저 (실 유닛테스트 보유 → 첫 pending RED로 tdd-guard 언블록)

- [ ] **Step 1: computePos 4케이스 테스트 추가 (RED — 아직 export 안 됨)**

`ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx` 상단 import에 `computePos`를 추가하고(`import { VarUsagePopover, computePos } from "../VarUsagePopover";`) 파일 끝(마지막 `});` 뒤)에 append:

```tsx
function mockAnchor(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}), ...rect,
    }) as DOMRect;
  return el;
}
function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

describe("computePos (순수)", () => {
  it("① 아래 공간 충분 → 앵커 바로 아래(top=bottom+4)", () => {
    setViewport(1000, 900);
    const a = mockAnchor({ left: 100, right: 140, top: 100, bottom: 120 });
    expect(computePos(a, 154)).toEqual({ top: 124, left: 100 });
  });
  it("② 아래 부족·위 여유 → 위로 flip flush(top=r.top-4-h)", () => {
    setViewport(560, 560);
    const a = mockAnchor({ left: 100, right: 140, top: 470, bottom: 490 });
    // below=494, below+154=648 > 552(=innerH-8) → 아래 부족; above=312≥8 → flip; bottom=312+154=466=r.top-4 flush
    expect(computePos(a, 154)).toEqual({ top: 312, left: 100 });
  });
  it("③ 아래·위 둘 다 부족 → clamp [8, innerH-h-8]", () => {
    setViewport(400, 200);
    const a = mockAnchor({ left: 50, right: 90, top: 100, bottom: 120 });
    const { top } = computePos(a, 154);
    expect(top).toBe(38); // innerH-h-8 = 200-154-8
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(200 - 154 - 8);
  });
  it("④ 우측 넘침 → 우측정렬 후 좌우 clamp [8, innerW-W-8]", () => {
    setViewport(300, 900);
    const a = mockAnchor({ left: 200, right: 240, top: 100, bottom: 120 });
    // left+240=440 > 292(=innerW-8) → right-align: right-240=0 → clamp max(8, min(0, 52))=8
    expect(computePos(a, 154).left).toBe(8);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test VarUsagePopover`
Expected: FAIL — `computePos`가 export 안 되어 `computePos is not a function` 또는 import 에러.

- [ ] **Step 3: computePos export + 실측높이 + 뷰포트 clamp 구현**

`VarUsagePopover.tsx`의 현재 `function computePos(anchor: HTMLElement) { … }`(라인 10-21)를 아래로 교체(앞줄에 eslint-disable):

```tsx
// computePos는 순수 위치 계산(테스트 대상)이라 export. 컴포넌트 파일이라
// react-refresh 규칙이 mixed-export를 warn하지만 순수 헬퍼라 무해.
// eslint-disable-next-line react-refresh/only-export-components
export function computePos(anchor: HTMLElement, popoverH = POPOVER_MAX_H) {
  const r = anchor.getBoundingClientRect();
  const M = 8;
  let left = r.left + POPOVER_WIDTH > window.innerWidth - M ? r.right - POPOVER_WIDTH : r.left;
  left = Math.max(M, Math.min(left, window.innerWidth - POPOVER_WIDTH - M));
  const below = r.bottom + 4;
  const above = r.top - 4 - popoverH;
  let top: number;
  if (below + popoverH <= window.innerHeight - M) top = below;
  else if (above >= M) top = above;
  else top = window.innerHeight - popoverH - M;
  top = Math.max(M, Math.min(top, window.innerHeight - popoverH - M));
  return { top, left };
}
```

그리고 `useLayoutEffect`(현재 라인 45 `useLayoutEffect(() => setPos(computePos(anchor)), [anchor]);`)를 실측 높이로 재계산하게 교체:

```tsx
useLayoutEffect(() => {
  const h = panelRef.current?.getBoundingClientRect().height;
  setPos(computePos(anchor, h || undefined));
}, [anchor]);
```

(`panelRef`·`const [pos, setPos] = useState(() => computePos(anchor));`는 이미 존재 — 유지.)

- [ ] **Step 4: D GREEN 확인**

Run: `cd ui && pnpm test VarUsagePopover`
Expected: PASS — 기존 3 거동 테스트 + computePos 4케이스 모두 green.

### E (AutoGrowTextarea)

- [ ] **Step 5: E 계약 테스트 추가 (RED)**

`ui/src/components/__tests__/AutoGrowTextarea.test.tsx`의 마지막 `it` 뒤(닫는 `});` 앞)에 append:

```tsx
  it("E: 캡 미만 값은 세로 스크롤바 없음 — overflow-y-auto 제거, overflowY=hidden", () => {
    render(<AutoGrowTextarea value="short" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" }) as HTMLTextAreaElement;
    expect(ta).not.toHaveClass("overflow-y-auto"); // A의 styled 바가 1줄에서 노출되던 원인 제거
    expect(ta).toHaveClass("resize-none");
    expect(ta).toHaveClass("max-h-40");
    // jsdom scrollHeight=0 → full(0) ≤ MAX(160) → overflowY="hidden"
    expect(ta.style.overflowY).toBe("hidden");
  });
```

- [ ] **Step 6: RED 확인**

Run: `cd ui && pnpm test AutoGrowTextarea`
Expected: FAIL — 현재 className에 `overflow-y-auto`가 있어 `not.toHaveClass` 실패, `overflowY`도 미설정.

- [ ] **Step 7: E 구현**

`AutoGrowTextarea.tsx`의 `useLayoutEffect`(라인 17-22)를 교체:

```tsx
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    const MAX = 160; // max-h-40
    el.style.height = `${Math.min(full, MAX)}px`;
    el.style.overflowY = full > MAX ? "auto" : "hidden"; // 캡 넘칠 때만 스크롤(1줄=바 없음)
  }, [value]);
```

그리고 className(라인 28)에서 `overflow-y-auto` 제거:

```tsx
      className={`resize-none max-h-40 ${className ?? ""}`}
```

- [ ] **Step 8: E GREEN 확인**

Run: `cd ui && pnpm test AutoGrowTextarea`
Expected: PASS.

### A (글로벌 얇은 스크롤바 — 유닛테스트 없음, 라이브 검증)

- [ ] **Step 9: index.css @layer base 스크롤바 추가**

`ui/src/index.css`(현재 3 `@tailwind` 줄) 아래에 append:

```css

@layer base {
  * {
    scrollbar-width: thin;
    scrollbar-color: rgb(203 213 225) transparent;
  }
  *::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  *::-webkit-scrollbar-track {
    background: transparent;
  }
  *::-webkit-scrollbar-thumb {
    background-color: rgb(203 213 225);
    border-radius: 9999px;
  }
  *::-webkit-scrollbar-thumb:hover {
    background-color: rgb(148 163 184);
  }
}
```

(A는 `getComputedStyle`로 `::-webkit-scrollbar` 폭을 못 읽어 유닛테스트 없음 — 머지 전 라이브 검증에서 스크린샷/실측. Monaco는 합성 overlay `<div>` 스크롤바라 이 규칙 영향 낮음, 그래도 라이브 확인.)

### Task 1 게이트 + 커밋

- [ ] **Step 10: 전체 UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 3개 모두 PASS(경고 0). 특히 `computePos` export의 eslint-disable로 `react-refresh` warn 없음 확인.

- [ ] **Step 11: 커밋** (`run_in_background:false`, 단일 호출)

```bash
git add ui/src/index.css ui/src/components/AutoGrowTextarea.tsx ui/src/components/scenario/VarUsagePopover.tsx ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx ui/src/components/__tests__/AutoGrowTextarea.test.tsx
git commit -m "fix(editor): 얇은 스크롤바(A)+1줄입력 스크롤바 제거(E)+팝오버 뷰포트 clamp(D)"
```

커밋 후 `git log -1 --oneline`로 landed 확인.

---

## Task 2: C — sticky 접이식 크롬

ScenarioEditPage에 브레드크럼+제목행만 감싸는 **전용 sticky wrapper** 신설 + `chromeCollapsed` 토글, `EditorShell`에 `chromeCollapsed` prop → 3개 cap 리터럴 사이트 토글(11rem↔16rem).

**Files:**
- Modify: `ui/src/i18n/ko.ts` (editor 섹션 — `chromeCollapse`/`chromeExpand`)
- Modify: `ui/src/components/scenario/EditorShell.tsx` (chromeCollapsed prop + capClass, 3 사이트)
- Modify: `ui/src/pages/ScenarioEditPage.tsx:128-213` (sticky wrapper + state + 토글 + prop 전달)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (C3 prop→cap 계약)
- Test: `ui/src/pages/__tests__/ScenarioEditPage.chrome.test.tsx` (신규 — 접기/펴기 + 배선)

**Interfaces:**
- Produces: `EditorShell`에 optional prop `chromeCollapsed?: boolean`(기본 false=16rem, byte-identical). Task 3(B)가 이 prop의 `capClass`를 재사용 → **Task 2 필수 선행**.
- Produces: `ko.editor.chromeCollapse: "헤더 접기"`, `ko.editor.chromeExpand: "헤더 펴기"`.

- [ ] **Step 1: EditorShell C3 계약 테스트 추가 (RED — 테스트-먼저로 tdd-guard 언블록)**

> **tdd-guard**: task 시작 시 트리가 clean이라 pending 테스트가 없으면 watched-production(`ui/src/**` non-test·`ko.ts` 포함) 편집이 `[tdd-guard] Blocked`. 그래서 **테스트 파일 편집을 Step 1로** 둬 pending RED를 먼저 만든다(이 EditorShell 테스트는 새 ko 키를 참조하지 않아 자체 RED). 이후 ko.ts·src 편집 허용.

`ui/src/components/scenario/__tests__/EditorShell.test.tsx`의 최상위 `describe("EditorShell", …)` 안, 기존 `#4` 테스트(라인 65~) 뒤에 추가:

```tsx
  it("C3: chromeCollapsed prop이 그리드 cap을 11rem으로 토글(기본=16rem)", () => {
    const yaml = 'version: 1\nname: "x"\nsteps: []\n';
    const { rerender } = render(<EditorShell initialYaml={yaml} />);
    expect(screen.getByTestId("editor-grid").className).toContain("max-h-[calc(100vh-16rem)]");
    rerender(<EditorShell chromeCollapsed initialYaml={yaml} />);
    const cls = screen.getByTestId("editor-grid").className;
    expect(cls).toContain("max-h-[calc(100vh-11rem)]");
    expect(cls).not.toContain("max-h-[calc(100vh-16rem)]");
  });
```

- [ ] **Step 2: ko 키 추가**

`ui/src/i18n/ko.ts`의 `editor:` 객체 안(예: `wideFlowStripAria` 근처)에 추가:

```ts
    chromeCollapse: "헤더 접기",
    chromeExpand: "헤더 펴기",
```

(Step 1에서 테스트 파일이 pending이 됐으므로 이 watched-production 편집 허용. 이 키를 Step 6 chrome 테스트와 Step 8 impl이 참조.)

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: FAIL — chromeCollapsed 미구현이라 11rem 없음.

- [ ] **Step 4: EditorShell chromeCollapsed prop + capClass 구현**

`EditorShell.tsx` 시그니처(라인 15-21)에 prop 추가:

```tsx
export function EditorShell({
  initialYaml,
  onChange,
  chromeCollapsed = false,
}: {
  initialYaml: string;
  onChange?: (yaml: string) => void;
  chromeCollapsed?: boolean;
}) {
```

본문 상단(return 전, 예: `jumpToStep` 정의 뒤)에 capClass 상수 추가:

```tsx
  // C3: 접힘이면 크롬이 줄어 그리드가 세로를 되찾는다. 두 값 모두 소스 리터럴(JIT).
  const capClass = chromeCollapsed
    ? "max-h-[calc(100vh-11rem)]"
    : "max-h-[calc(100vh-16rem)]";
```

그리고 3개 리터럴 사이트를 `capClass`로 교체:

1) 비-wide 그리드(라인 104) — 인라인 `max-h-[calc(100vh-16rem)]`을 `${capClass}`로:
```tsx
            : `grid gap-4 min-h-[520px] ${capClass} grid-rows-[minmax(0,1fr)] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
```

2) wide 변수 aside(라인 111) — `${wideOpen ? "max-h-[calc(100vh-16rem)]" : ""}`를 `${wideOpen ? capClass : ""}`로:
```tsx
            className={`flex min-h-0 flex-col overflow-visible rounded-md border border-slate-200 bg-white p-3 ${wideOpen ? capClass : ""}`}
```

3) wide 아웃라인/flow 컨테이너(라인 117) — `max-h-[calc(100vh-16rem)]`을 `${capClass}`로:
```tsx
          <div className={`flex ${capClass} min-h-0 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3`}>
```

(주의: `min-h-[520px]`·`grid-rows-[minmax(0,1fr)]`·`overflow-visible`·`min-h-0`는 전부 유지. 기본 chromeCollapsed=false → capClass=16rem → 기존 `#4` 테스트 3사이트 전부 byte-identical.)

- [ ] **Step 5: EditorShell GREEN 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: PASS — 신규 C3 + 기존 `#4`·wide·나머지 전부 green.

- [ ] **Step 6: ScenarioEditPage 크롬 테스트 추가 (RED)**

신규 파일 `ui/src/pages/__tests__/ScenarioEditPage.chrome.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({ TestRunSection: () => null }));

const fetchMock = vi.fn();
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = { id: "S1", name: "demo", yaml: DEMO_YAML, version: 1, created_at: 0, updated_at: 0 };
function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios") && method === "GET") return jsonResponse({ scenarios: [DEMO] });
  return jsonResponse({ error: "unexpected" }, 500);
}
function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scenarios/S1"]}>
          <Routes>
            <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

describe("ScenarioEditPage 헤더 접기/펴기 (C)", () => {
  it("접으면 브레드크럼·부제 숨김·제목/저장 유지, 펴면 복귀 + EditorShell cap 배선", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    // 펼침 기본: 부제("updated")·브레드크럼("시나리오") 보임
    expect(screen.getByText(/updated/)).toBeInTheDocument();
    expect(screen.getByText(ko.nav.scenarios)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("editor-grid").className).toContain("max-h-[calc(100vh-16rem)]"),
    );

    // 접기
    await user.click(screen.getByRole("button", { name: ko.editor.chromeCollapse }));
    expect(screen.queryByText(/updated/)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.nav.scenarios)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument(); // 제목 유지
    expect(screen.getByRole("button", { name: ko.common.save })).toBeInTheDocument(); // 액션 유지
    // 배선: 접힘이 EditorShell grid cap을 11rem으로
    await waitFor(() =>
      expect(screen.getByTestId("editor-grid").className).toContain("max-h-[calc(100vh-11rem)]"),
    );

    // 펴기
    await user.click(screen.getByRole("button", { name: ko.editor.chromeExpand }));
    expect(screen.getByText(/updated/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: RED 확인**

Run: `cd ui && pnpm test ScenarioEditPage.chrome`
Expected: FAIL — 접기 버튼(`chromeCollapse`) 미존재.

- [ ] **Step 8: ScenarioEditPage sticky wrapper + 토글 + prop 전달 구현**

(a) state 추가 — 다른 `useState`들 근처(예: 라인 31 뒤):

```tsx
  const [chromeCollapsed, setChromeCollapsed] = useState(false);
```

(b) return(라인 128~)의 구조 재편 — 브레드크럼+제목행을 **새 sticky wrapper**로 감싸고, 접힘 시 브레드크럼·부제 숨김 + 접기 토글 추가. 현재:

```tsx
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: liveName }]} />
      <div className="flex items-center justify-between">
        <div>
          {nameEditing ? ( … ) : ( … )}
          <p className="text-sm text-slate-600">
            v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          … 액션 버튼들 …
        </div>
      </div>
      {update.error && …}
```

를 아래로 (sticky wrapper 추가 + 브레드크럼/부제 게이트 + 접기 토글):

```tsx
  return (
    <div className="flex flex-col gap-4">
      {/* C: 전용 sticky 크롬 wrapper(브레드크럼+제목행만). 내부 gap-2, outer는 gap-4 유지.
          bg-slate-50 = 페이지 배경(index.html:12 `<body class="bg-slate-50">`)이라 그리드 투과 방지.
          정확한 top offset·z·bg·border는 라이브로 확정(§6 Q2 폴백). */}
      <div className="sticky top-0 z-20 -mx-6 flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-6">
        {!chromeCollapsed && (
          <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: liveName }]} />
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <button
              type="button"
              aria-label={chromeCollapsed ? ko.editor.chromeExpand : ko.editor.chromeCollapse}
              aria-expanded={!chromeCollapsed}
              onClick={() => setChromeCollapsed((v) => !v)}
              className="mt-1 text-slate-500 hover:text-slate-700"
            >
              <span aria-hidden="true">{chromeCollapsed ? "▸" : "▾"}</span>
            </button>
            <div>
              {nameEditing ? ( … 기존 Input … ) : ( … 기존 h2+연필 … )}
              {!chromeCollapsed && (
                <p className="text-sm text-slate-600">
                  v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            … 기존 액션 버튼들(저장/복제/템플릿/runs) 그대로 …
          </div>
        </div>
      </div>
      {update.error && …}
```

(주의: `nameEditing ? … : …` 블록과 액션 버튼 `<div>`는 **내용 변경 없이** 위치만 이동. `<p>`부제와 `<Breadcrumb>`만 `{!chromeCollapsed && …}` 게이트. 새 접기 토글 버튼과 title-stack을 감싸는 `flex items-start gap-2` div가 추가됨.)

(c) EditorShell에 prop 전달 — 라인 222:

```tsx
      {seeded && (
        <EditorShell
          initialYaml={data.yaml}
          onChange={handleEditorChange}
          chromeCollapsed={chromeCollapsed}
        />
      )}
```

- [ ] **Step 9: 크롬 테스트 GREEN + 기존 페이지 테스트 무회귀 확인**

Run: `cd ui && pnpm test ScenarioEditPage`
Expected: PASS — 신규 `.chrome` + 기존 name/dirty/save/clone/testrun 전부 green(sticky wrapper는 heading/버튼 셀렉터 무영향).

- [ ] **Step 10: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 3개 PASS(경고 0).

- [ ] **Step 11: 커밋** (`run_in_background:false`)

```bash
git add ui/src/i18n/ko.ts ui/src/components/scenario/EditorShell.tsx ui/src/pages/ScenarioEditPage.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx ui/src/pages/__tests__/ScenarioEditPage.chrome.test.tsx
git commit -m "feat(editor): sticky 접이식 크롬(C) — chromeCollapsed prop→그리드 cap 토글(11rem↔16rem)"
```

`git log -1 --oneline`로 확인.

---

## Task 3: B — 변수-넓게 뷰모드 (`varsWide`)

EditorShell에 `varsWide` 상태(wideOpen 거울상): 변수 1fr 좌 + 아웃라인 base 우 + 인스펙터 모달. wideOpen과 상호배타. **Task 2의 `capClass`를 재사용하므로 Task 2 필수 선행.**

**Files:**
- Modify: `ui/src/i18n/ko.ts` (editor — `varsWideToggle`/`varsWideToggleAria`/`varsWideActiveTitle`)
- Modify: `ui/src/components/scenario/EditorShell.tsx` (varsWide state·툴바 토글·grid 분기·aside 게이트·모달 게이트·vars 토글 disable)
- Modify: `ui/src/components/scenario/FlowOutline.tsx:302` (data-step-id: wide 또는 onActivate 있을 때)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (varsWide 계약)

**Interfaces:**
- Consumes: `EditorShell`의 `capClass`(Task 2), `FlowOutline`의 `onActivateStep`(기존).
- Produces: `ko.editor.varsWideToggle: "변수 넓게 보기"`, `varsWideToggleAria: "변수 넓게 보기 전환"`, `varsWideActiveTitle: "변수 넓게 보기 중"`.

- [ ] **Step 1: varsWide 계약 테스트 추가 (RED — 테스트-먼저로 tdd-guard 언블록)**

> **tdd-guard**: task 시작 clean 트리 → pending 테스트 없으면 `ko.ts`/src 편집 차단. 테스트 파일을 Step 1로. 이 테스트가 새 ko 키(`varsWideToggleAria` 등)를 참조하지만 실행은 Step 3(RED 확인)에서 — 그때 Step 2의 ko 키가 존재해 깨끗한 RED(varsWide 미구현).

`EditorShell.test.tsx`의 최상위 `describe("EditorShell", …)` 안, 기존 `describe("스텝 넓게 보기 토글 …")` 블록 뒤에 중첩 describe 추가(store-reset beforeEach 상속):

```tsx
  describe("변수 넓게 보기 토글 (B/varsWide)", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it("ON: grid-cols [1fr_minmax] + aria-pressed + 인스펙터 열 미렌더 + 변수 aside 유지", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const toggle = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("editor-grid").className).toContain(
        "grid-cols-[1fr_minmax(260px,300px)]",
      );
      expect(screen.queryByLabelText(ko.editor.inspectorAria)).not.toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { name: ko.editor.varsPanelAria }),
      ).toBeInTheDocument();
    });

    it("varsWide↔wideOpen 상호배타", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const wideT = screen.getByRole("button", { name: ko.editor.wideToggleAria });
      const varsWideT = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      await user.click(varsWideT);
      expect(varsWideT).toHaveAttribute("aria-pressed", "true");
      await user.click(wideT); // 스텝 넓게 켜기 → 변수 넓게 꺼짐
      expect(wideT).toHaveAttribute("aria-pressed", "true");
      expect(varsWideT).toHaveAttribute("aria-pressed", "false");
    });

    it("varsWide ON이면 변수 show/hide 토글 disabled(title 힌트)", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const varsToggle = screen.getByRole("button", { name: ko.editor.varsToggleAria });
      expect(varsToggle).not.toBeDisabled();
      await user.click(screen.getByRole("button", { name: ko.editor.varsWideToggleAria }));
      expect(varsToggle).toBeDisabled();
      expect(varsToggle).toHaveAttribute("title", ko.editor.varsWideActiveTitle);
    });

    it("varsWide OFF 복귀 시 그리드 className byte-identical", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const before = screen.getByTestId("editor-grid").className;
      const t = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      await user.click(t);
      await user.click(t);
      expect(screen.getByTestId("editor-grid").className).toBe(before);
    });

    it("varsWide 행 활성화 → 편집 모달(Inspector) + 아웃라인 행 data-step-id", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      await user.click(screen.getByRole("button", { name: ko.editor.varsWideToggleAria }));
      // 아웃라인 행에 data-step-id(스크롤 지원) 부여됨
      expect(document.querySelector("[data-step-id]")).toBeInTheDocument();
      await user.click(screen.getByRole("option", { name: ko.editor.outlineRowAria("login") }));
      expect(
        screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle }),
      ).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: ko 키 추가**

`ui/src/i18n/ko.ts` editor 섹션(기존 `wideToggle`/`wideToggleAria` 근처):

```ts
    varsWideToggle: "변수 넓게 보기",
    varsWideToggleAria: "변수 넓게 보기 전환",
    varsWideActiveTitle: "변수 넓게 보기 중",
```

(Step 1 테스트가 pending → 이 watched-production 편집 허용. Step 1 테스트·Step 5 impl이 참조.)

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: FAIL — varsWide 토글/거동 미구현.

- [ ] **Step 4: FlowOutline data-step-id 확장**

`FlowOutline.tsx:302`의 `...(view?.wide ? { "data-step-id": step.id } : {})`를 교체:

```tsx
    ...(view?.wide || view?.onActivate ? { "data-step-id": step.id } : {}),
```

(비-wide·onActivate 없는 기존 `<FlowOutline />`(EditorShell:133)는 여전히 data-step-id 없음 → byte-identical. varsWide는 onActivate 주입 → data-step-id 부여.)

- [ ] **Step 5: EditorShell varsWide 구현**

(a) state 추가(라인 32 `detailOpen` 근처):

```tsx
  const [varsWide, setVarsWide] = useState(false);
```

(b) wide 토글 onClick(라인 90-93)에 상호배타 추가:

```tsx
          onClick={() => {
            setWideOpen((v) => !v);
            setVarsWide(false); // 상호배타
            setDetailOpen(false);
          }}
```

(c) vars show/hide 토글(라인 70-77)에 disabled+title 추가:

```tsx
        <button
          type="button"
          aria-label={ko.editor.varsToggleAria}
          disabled={varsWide}
          title={varsWide ? ko.editor.varsWideActiveTitle : undefined}
          onClick={() => setVarsOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-50"
        >
          <span aria-hidden="true">☰</span> {ko.editor.varsToggle}
        </button>
```

(d) 새 varsWide 토글 버튼 — wide 토글(라인 86-97) 뒤에 추가:

```tsx
        <button
          type="button"
          aria-label={ko.editor.varsWideToggleAria}
          aria-pressed={varsWide}
          onClick={() => {
            setVarsWide((v) => !v);
            setWideOpen(false); // 상호배타
            setDetailOpen(false);
          }}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">◧</span> {ko.editor.varsWideToggle}
        </button>
```

(e) grid className — **선행 `varsWide` 삼항**으로(byte-identity: non-varsWide 경로가 현 로직 그대로). 라인 99-106의 `className={ wideOpen ? … : … }`를:

```tsx
        className={
          varsWide
            ? `grid gap-4 min-h-[520px] ${capClass} grid-rows-[minmax(0,1fr)] grid-cols-[1fr_minmax(260px,300px)]`
            : wideOpen
              ? `grid gap-4 ${varsOpen ? "grid-cols-[210px_1fr]" : "grid-cols-[1fr]"}`
              : `grid gap-4 min-h-[520px] ${capClass} grid-rows-[minmax(0,1fr)] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
        }
```

(f) 변수 aside 렌더 게이트(라인 107 `{varsOpen && (`)를 `(varsWide || varsOpen)`로:

```tsx
        {(varsWide || varsOpen) && (
          <aside
```

(aside className의 cap은 `${wideOpen ? capClass : ""}` 유지 — varsWide에선 그리드 cap+grid-rows가 aside를 bound하므로 자체 max-h 불요, 비-wide와 동일.)

(g) 컬럼 분기 — 현재 `{wideOpen ? ( … ) : ( … )}`(라인 116-139)를 **varsWide 우선 3분기**로:

```tsx
        {varsWide ? (
          <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto min-h-0">
            <FlowOutline onActivateStep={() => setDetailOpen(true)} />
          </div>
        ) : wideOpen ? (
          … 기존 wide 분기(칩 스트립 + FlowOutline wide) 그대로 …
        ) : (
          … 기존 non-wide 분기(FlowOutline + Inspector 2열) 그대로 …
        )}
```

(h) detail 모달 게이트(라인 147 `open={wideOpen && detailOpen && selectedStepId !== null}`)를:

```tsx
        open={(wideOpen || varsWide) && detailOpen && selectedStepId !== null}
```

- [ ] **Step 6: EditorShell GREEN + 무회귀 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: PASS — varsWide 5케이스 + 기존 전부(특히 `#4`·C3·wide OFF byte-identical·varsWide OFF byte-identical) green.

- [ ] **Step 7: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 3개 PASS(경고 0). full `pnpm test`로 suite-wide 무회귀 확인(간헐 flake 시 격리 재실행).

- [ ] **Step 8: 커밋** (`run_in_background:false`)

```bash
git add ui/src/i18n/ko.ts ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "feat(editor): 변수 넓게 보기 뷰모드(B) — varsWide(wideOpen 거울상)+상호배타+모달 detail"
```

`git log -1 --oneline`로 확인.

---

## 최종 검증 (전 task 후 — orchestrator)

- [ ] **UI-only 0-diff 불변식**: `git diff --name-only master..HEAD` = `ui/**`·`docs/**`만(crates/proto/migration/model.ts/store 0).
- [ ] **전체 게이트 1회**: `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green.
- [ ] **whole-branch `handicap-reviewer`(Opus)** APPROVE — 크로스커팅·repo 함정·byte-identity·ko/aria(ADR-0035)·#4/slice-1 클래스 보존 확인. 보안 게이트 N/A(요청실행/템플릿/바인딩/업로드/trace 무접촉 — finish-slice §0 grep이 판정).
- [ ] **라이브 검증(`/live-verify`)** — 컨트롤러-served dist(워크트리 자체 바이너리). §6 경험적 항목 확정:
  - **A**: 스크롤바 8px(스크린샷/실측)·Monaco YAML 모달 스크롤 정상·리포트/목록 등 타 페이지 시각 무회귀(글로벌 blast).
  - **E**: 1줄 값 입력 `overflowY==="hidden"`·바 없음; >160px 값은 스크롤 유지.
  - **D**: 작은 창에서 팝오버가 앵커에 flush(위 flip 시 바닥=앵커top-4)·4변 뷰포트 내(8px 여백).
  - **C**: sticky top offset·z(팝오버 z-50 위 유지)·bg-slate-50 투과 방지·`chromeCollapsed` cap **11rem 실측 확정**(접힘 크롬 높이 실측 후 `N`rem 교정 여부 판단; 그리드 height ≈+80px·뷰포트 내). 라이브에서 `getBoundingClientRect`로 실측(#5 false-PASS 클래스 회피).
  - **B**: varsWide 변수 1fr·아웃라인 우측 base·인스펙터 모달·상호배타·변수 토글 disabled.

## Self-Review (계획 작성자 체크 — 완료)

- **Spec 커버리지**: A1→T1 Step9 · A2(Monaco)→라이브 · E1→T1 Step5-8 · D1→T1 Step1-4 · C1/C2→T2 Step8 · C3→T2 Step4 · B1→T3 Step5 · R-inv→최종검증. 전 R-id 커버.
- **Placeholder 스캔**: 각 코드 스텝에 실제 코드. "기존 … 그대로"는 이동-only 블록(내용 무변경)이라 재기입 불요 — 위치만 명시.
- **타입 일관성**: `chromeCollapsed?:boolean`(T2 정의→T3 capClass 소비), `computePos(anchor,popoverH?)`(T1 내부), ko 키명(chromeCollapse/chromeExpand·varsWideToggle/Aria/ActiveTitle) 전 task 일치.

<!-- spec-plan-reviewer clean APPROVE (2026-07-05, spec 2라운드 + plan 2라운드) — spec+plan 둘 다 통과. -->
<!-- REVIEW-GATE: APPROVED -->
