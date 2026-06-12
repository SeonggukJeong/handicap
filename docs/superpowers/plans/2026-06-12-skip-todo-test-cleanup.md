# skip/todo UI 테스트 정리 — 구현 계획 (2026-06-12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ui 테스트 스위트의 `it.todo` 18건을 0건으로 — 9건은 실제 테스트로 구현, 9건은 obsolete/중복 근거로 삭제 (spec `docs/superpowers/specs/2026-06-12-skip-todo-test-cleanup-design.md` §4 처분 매트릭스).

**Architecture:** UI-only 테스트 위생 슬라이스. production 코드 무변경(테스트가 국소 버그를 드러낼 때만 test-first 수정 — 사용자 승인 정책). 구현 테스트는 전부 **기존 동작의 특성화(characterization) 테스트**라 RED 단계가 없다 — 작성 즉시 PASS가 기대값이고, FAIL이면 그 자체가 버그 발견(정책 발동). 삭제는 각 커밋 메시지에 근거 1줄.

**Tech Stack:** vitest + RTL + user-event v14, `@xyflow/react` v12(ReactFlowProvider), Zustand store(getInitialState shim), `yaml` Document API.

**워크트리:** `/Users/sgj/develop/handicap/.claude/worktrees/skip-todo-test-cleanup` (모든 경로는 그 안의 `ui/` 기준, 명령은 `ui/`에서 실행. baseline `pnpm install`+`cargo build` 완료됨.)

**공통 규칙:**
- 단일 파일 반복: `pnpm test <이름>` — **`--` 붙이면 전체 스위트가 돈다(금지)**.
- 모든 편집이 test-path 파일(+ 문서)이라 tdd-guard 자동 통과. 커밋은 ui/docs-only라 pre-commit cargo skip(수초).
- 커밋은 파이프 없이, 직후 `git log -1`로 landed 확인.

---

### Task 1: TabBar 테스트 2건 구현

**Files:**
- Modify: `ui/src/components/scenario/__tests__/TabBar.test.tsx` (전체 교체 — 현재 todo 2줄뿐)

컴포넌트 사실(이미 확인): `TabBar({active, onChange})`가 `role="tablist"` 안에 "Canvas"/"YAML" 두 `role="tab"` 버튼, active 탭에 `aria-selected="true"` + `border-slate-900` 클래스, 클릭 시 `onChange(tab)`.

- [ ] **Step 1: 파일 전체를 실제 테스트로 교체**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../TabBar";

describe("TabBar", () => {
  it("renders both tab labels with the active one styled", () => {
    render(<TabBar active="canvas" onChange={() => {}} />);
    const canvas = screen.getByRole("tab", { name: "Canvas" });
    const yaml = screen.getByRole("tab", { name: "YAML" });
    expect(canvas).toHaveAttribute("aria-selected", "true");
    expect(yaml).toHaveAttribute("aria-selected", "false");
    expect(canvas.className).toContain("border-slate-900");
    expect(yaml.className).not.toContain("border-slate-900");
  });

  it("calls onChange when an inactive tab is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TabBar active="canvas" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(onChange).toHaveBeenCalledWith("yaml");
  });
});
```

- [ ] **Step 2: 실행 — 즉시 PASS 기대(특성화)**

Run: `pnpm test TabBar`
Expected: `2 passed` (todo 0). FAIL이면 버그 정책 발동 전에 단언이 컴포넌트 사실과 일치하는지 먼저 재확인.

- [ ] **Step 3: Commit**

```bash
git add src/components/scenario/__tests__/TabBar.test.tsx
git commit -m "test(ui): TabBar todo 2건 실테스트 전환 — 라벨/aria-selected/onChange"
```

---

### Task 2: HttpStepNode 테스트 2건 구현

**Files:**
- Modify: `ui/src/components/scenario/__tests__/HttpStepNode.test.tsx` (전체 교체 — 현재 todo 2줄뿐)

컴포넌트 사실: `HttpStepNode`는 `memo`, `NodeProps<Node<HttpStepNodeData,"http">>`에서 **`data`만 destructure**. `<Handle>` 2개 → **`ReactFlowProvider` 래핑 필수**(없으면 zustand provider 에러로 throw; provider 있으면 node-컨텍스트 부재 error#010 콘솔 경고만 — 무해, 렌더 진행). selected 시 루트 div 클래스에 `ring-1`/`border-slate-900`. `HttpStepNodeData`는 export됨.

- [ ] **Step 1: 파일 전체를 실제 테스트로 교체**

```tsx
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { HttpStepNode, type HttpStepNodeData } from "../HttpStepNode";

type HttpNode = Node<HttpStepNodeData, "http">;

// 컴포넌트는 data만 읽는다 — 나머지 NodeProps 필드는 v12 타입을 만족시키는 고정값.
// (tsc -b가 필드 과부족을 지적하면 node_modules/@xyflow/react/dist/esm/types의
//  NodeProps 정의에 맞춰 이 헬퍼만 조정한다.)
function nodeProps(data: HttpStepNodeData): NodeProps<HttpNode> {
  return {
    id: "n1",
    type: "http",
    data,
    dragging: false,
    draggable: false,
    selectable: false,
    deletable: false,
    selected: false,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

const DATA: HttpStepNodeData = {
  name: "login",
  method: "POST",
  url: "/login",
  urlMissing: false,
  selected: false,
};

function renderNode(data: HttpStepNodeData) {
  return render(
    <ReactFlowProvider>
      <HttpStepNode {...nodeProps(data)} />
    </ReactFlowProvider>,
  );
}

describe("HttpStepNode", () => {
  it("renders the step's name and method+URL", () => {
    renderNode(DATA);
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByTitle("POST /login")).toBeInTheDocument();
  });

  it("applies a 'selected' style when the data.selected flag is true", () => {
    const { container: off } = renderNode(DATA);
    expect((off.firstElementChild as HTMLElement).className).not.toContain("ring-1");

    const { container: on } = renderNode({ ...DATA, selected: true });
    expect((on.firstElementChild as HTMLElement).className).toContain("ring-1");
  });
});
```

- [ ] **Step 2: 실행 — 즉시 PASS 기대**

Run: `pnpm test HttpStepNode`
Expected: `2 passed`. 콘솔에 React Flow error#010 경고가 보일 수 있음(무해 — node 컨텍스트 밖 Handle). provider 에러로 **throw**하면 ReactFlowProvider 래핑이 빠진 것.

- [ ] **Step 3: Commit**

```bash
git add src/components/scenario/__tests__/HttpStepNode.test.tsx
git commit -m "test(ui): HttpStepNode todo 2건 실테스트 전환 — ReactFlowProvider 직접 마운트"
```

---

### Task 3: EditorShell 테스트 3건 구현

**Files:**
- Modify: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (첫 `describe("EditorShell")` 블록의 todo 3줄을 실테스트로 교체 + `beforeEach` store reset 추가. 기존 U3/U4 describe·Monaco mock은 그대로)

컴포넌트 사실: mount 시 effect가 `loadFromString(initialYaml)`(1회, ref), 별도 effect가 `onChange?.(yamlText)`. **U3 B1 함정(문서화 동작)**: 두 effect가 같은 패스에 돌아 **첫 onChange는 mount-렌더에 캡처된 pre-load store 텍스트**(fresh store = `""`) — store 갱신 후 재렌더에서 canonical 텍스트로 재발화. inspector는 `<aside aria-label={ko.editor.inspectorAria}>`(role `complementary`), YAML 탭에선 미렌더(자리에 `ko.editor.yamlTabNoInspector` 안내문).

- [ ] **Step 1: 첫 describe 블록 교체**

기존:
```tsx
describe("EditorShell", () => {
  it.todo("loads the initialYaml into the store on mount");
  it.todo("calls onChange with the current yamlText whenever it changes");
  it.todo("hides the inspector when the YAML tab is active");
});
```

교체 (파일 상단 import에 `beforeEach`가 이미 있는지 확인 — 있음):
```tsx
describe("EditorShell", () => {
  beforeEach(() => {
    // getInitialState는 store.ts의 커스텀 shim(:303) — ui/CLAUDE.md의 "Zustand v5
    // 미제공" 노트는 shim 도입 전 서술이니 이 호출을 "고치지" 말 것(기존 U3/U4와 동일).
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("loads the initialYaml into the store on mount", () => {
    render(<EditorShell initialYaml={'version: 1\nname: "loadme"\nsteps: []\n'} />);
    const st = useScenarioEditor.getState();
    expect(st.yamlText).toContain("loadme");
    expect(st.model?.name).toBe("loadme");
  });

  it("calls onChange with the store text — first fire is the pre-load text (U3 B1), then the loaded canonical text", () => {
    const calls: string[] = [];
    render(
      <EditorShell
        initialYaml={'version: 1\nname: "loadme"\nsteps: []\n'}
        onChange={(y) => calls.push(y)}
      />,
    );
    // 문서화된 함정의 핀 고정: 첫 발화는 로드된 initialYaml이 아니라
    // mount-렌더에 캡처된 pre-load store 텍스트(fresh store = "").
    expect(calls[0]).toBe("");
    // 로드 완료 후 canonical 텍스트로 재발화 — store와 일치.
    expect(calls[calls.length - 1]).toContain("loadme");
    expect(calls[calls.length - 1]).toBe(useScenarioEditor.getState().yamlText);
  });

  it("hides the inspector when the YAML tab is active", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    expect(
      screen.getByRole("complementary", { name: ko.editor.inspectorAria }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(
      screen.queryByRole("complementary", { name: ko.editor.inspectorAria }),
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실행 — 즉시 PASS 기대**

Run: `pnpm test EditorShell`
Expected: `5 passed` (신규 3 + 기존 U3/U4 2). `calls[0]`이 `""`가 아니면 다른 테스트의 store 누수(reset 누락) 또는 effect 순서 변화 — 전자가 먼저 의심.

- [ ] **Step 3: Commit**

```bash
git add src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "test(ui): EditorShell todo 3건 실테스트 전환 — 로드/onChange 계약(U3 B1 핀)/YAML탭 inspector 부재"
```

---

### Task 4: yamlDoc miss no-op 테스트 fold + `yamlDoc-comments.test.ts` 삭제

**Files:**
- Modify: `ui/src/scenario/__tests__/yamlDoc.test.ts` (기존 `describe("applyEdit — setStepField")` 블록에 it 1개 추가)
- Delete: `ui/src/scenario/__tests__/yamlDoc-comments.test.ts` (todo 2줄뿐 — #8은 fold로 대체, #9 object-vs-primitive는 같은 describe의 기존 3개 테스트(:105 primitive/:121 object/:134 round-trip)가 중복 커버)

- [ ] **Step 1: miss no-op 테스트 추가** — `describe("applyEdit — setStepField")` 블록 끝(think_time 테스트 뒤)에:

```ts
  it("is a silent no-op when the stepId is not in the tree (stale stepId)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const before = serializeDoc(out.doc);
    applyEdit(out.doc, {
      type: "setStepField",
      stepId: "01HX0000000000000000000999", // 트리에 없는 ULID
      path: ["request", "method"],
      value: "DELETE",
    });
    expect(serializeDoc(out.doc)).toBe(before); // doc 직렬화 불변
  });
```

- [ ] **Step 2: 파일 삭제**

```bash
git rm src/scenario/__tests__/yamlDoc-comments.test.ts
```

- [ ] **Step 3: 실행 — 즉시 PASS 기대**

Run: `pnpm test yamlDoc`
Expected: yamlDoc.test.ts 전체 green(+1), yamlDoc-comments는 더 이상 안 잡힘. miss가 no-op이 **아니면**(throw/오염) production 버그 — `findStepPath` null 가드(yamlDoc.ts:391)를 확인하고 버그 정책 발동.

- [ ] **Step 4: Commit**

```bash
git add src/scenario/__tests__/yamlDoc.test.ts
git commit -m "test(ui): setStepField stale-stepId no-op 핀 + yamlDoc-comments.test.ts 삭제(findStepIndex obsolete·object/primitive 중복커버)"
```

---

### Task 5: `ScenarioEditPage.save.test.tsx` 신설 + ScenarioPages todo 4줄 삭제

**Files:**
- Create: `ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioPages.test.tsx:102-105` (todo 4줄 삭제만 — 3건은 gallery/testrun 테스트가 커버(spec §4.1), 4번째 "Save button calls update mutation"은 이 신설 파일이 대체)

페이지 사실: 저장 버튼 텍스트 `"Save"`(pending 시 `"Saving…"`, `disabled={!dirty || …}`), 클릭 시 `update.mutate({ yaml: yamlText, version: loadedVersion })` → `PUT /api/scenarios/{id}`, `loadedVersion`은 scenario GET의 `version`. dirty 메커니즘은 clone 테스트의 mocked EditorShell(seed/edit 버튼) 패턴 재사용(spec §4.2 #9 — 실 EditorShell은 baseline-seeding race로 비결정적).

- [ ] **Step 1: 신설 파일 작성** (스캐폴드는 `ScenarioEditPage.clone.test.tsx:1-94` 미러, clone 전용 부분 제거):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/EditorShell", () => ({
  EditorShell: ({ onChange }: { onChange: (s: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange("version: 1\nname: demo\nsteps: []\n")}>
        seed
      </button>
      <button
        type="button"
        onClick={() => onChange("version: 1\nname: demo\nsteps: []\n# edited\n")}
      >
        edit
      </button>
    </div>
  ),
}));
vi.mock("../../components/scenario/TestRunSection", async () => {
  const { forwardRef } = await import("react");
  return {
    TestRunSection: forwardRef(function TestRunSection() {
      return null;
    }),
  };
});

const fetchMock = vi.fn();
beforeEach(() => {
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

const DEMO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT")
    return jsonResponse({ ...DEMO, version: 2 });
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
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/S1"]}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function putBody() {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => String(u).endsWith("/api/scenarios/S1") && (i as RequestInit)?.method === "PUT",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

describe("ScenarioEditPage save", () => {
  it("Save PUTs {yaml, version}: the edited buffer + the loaded scenario version (optimistic lock)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Save" });
    await user.click(screen.getByRole("button", { name: "seed" })); // baseline → not dirty
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty → Save 활성화

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBody()).not.toBeNull());
    // 와이어 1:1 (client.ts:130-133): 정확히 {yaml, version} 두 키.
    expect(putBody()).toEqual({
      yaml: "version: 1\nname: demo\nsteps: []\n# edited\n",
      version: 1,
    });
  });
});
```

- [ ] **Step 2: ScenarioPages.test.tsx의 todo 4줄 삭제** (102–105행):

```tsx
  it.todo("ScenarioNewPage renders EditorShell instead of textarea");
  it.todo("ScenarioNewPage Create button calls mutation with yamlText from EditorShell");
  it.todo("ScenarioEditPage renders EditorShell initialized with scenario yaml");
  it.todo("ScenarioEditPage Save button calls update mutation with {yaml, version}");
```
→ 4줄 제거(주변 코드 무변경).

- [ ] **Step 3: 실행 — 즉시 PASS 기대**

Run: `pnpm test ScenarioEditPage.save` 그리고 `pnpm test ScenarioPages`
Expected: save 1 passed / ScenarioPages 기존 테스트 green(todo 0).

- [ ] **Step 4: Commit**

```bash
git add src/pages/__tests__/ScenarioEditPage.save.test.tsx src/pages/__tests__/ScenarioPages.test.tsx
git commit -m "test(ui): Save→PUT {yaml,version} 직접 단언 신설 + ScenarioPages todo 4건 처분(3건 기존 커버)"
```

---

### Task 6: 죽은 todo 파일 2개 삭제 + ui/CLAUDE.md doc rot 수정

**Files:**
- Delete: `ui/src/__tests__/flowVars.test.ts` (추출 *실행*은 엔진 책임 — UI엔 JSONPath 평가 코드 없음)
- Delete: `ui/src/__tests__/useRunReport.test.ts` (RunDetailPage.test.tsx가 게이팅:649/terminal:577/에러:680 커버)
- Modify: `ui/CLAUDE.md` — "`PATCH /scenarios/{id}` 의 optimistic lock과 extract 변경" → "`PUT /scenarios/{id}` …" (실제 메서드는 PUT, client.ts:133 — reviewer 발견 doc rot)

- [ ] **Step 1: 삭제 + 문서 수정** (`ui/`에서):

```bash
git rm src/__tests__/flowVars.test.ts src/__tests__/useRunReport.test.ts
```
이어서 `ui/CLAUDE.md`(cwd 기준 `CLAUDE.md`)에서 해당 한 줄의 `PATCH`를 `PUT`으로 수정(내용 그 외 무변경).

- [ ] **Step 2: Commit** (`ui/`에서):

```bash
git add CLAUDE.md
git commit -m "test(ui): obsolete todo 파일 삭제(flowVars=엔진 책임·useRunReport=RunDetailPage 커버) + ui/CLAUDE.md PATCH→PUT doc rot"
```

---

### Task 7: 최종 게이트 — todo 0 확인 + 전체 3종 게이트

**Files:** 없음 (검증만)

- [ ] **Step 1: 전체 게이트 실행** (`ui/`에서):

```bash
pnpm lint && pnpm build
pnpm test > /tmp/skip-todo-final.log 2>&1; echo "exit=$?"; grep -E "Test Files|Tests " /tmp/skip-todo-final.log
```
(`pnpm test`를 파이프로 줄이지 말 것 — exit code 마스킹. 리다이렉트 후 exit 확인.)

Expected:
- `pnpm lint`: 경고 0 (`--max-warnings=0`).
- `pnpm build`: `tsc -b` clean (HttpStepNode `nodeProps` 헬퍼·EditorShell `st.model?.name`이 여기서 최종 검증됨 — `pnpm test`는 esbuild라 타입을 안 잡는다).
- `pnpm test`: **`Tests 762 passed (762)`** — todo/skip 단어가 summary에 없어야 함. (현재 753 passed | 18 todo → 신규 9 추가·todo 18 제거 = 762. 산식이 어긋나면 처분 누락/중복을 의심하고 `grep -rn "it.todo" src`로 확인 — 결과 0줄이어야 함.)
- Test Files: 100 (102 − 삭제 3 + 신설 1).

- [ ] **Step 2: todo 잔존 grep 이중 확인**

```bash
grep -rn "\.todo(\|\.skip(" src --include="*.test.ts" --include="*.test.tsx"
```
Expected: 출력 없음 (exit 1).

- [ ] **Step 3: 커밋 없음** — 이 task는 게이트 검증. 이후 마무리(roadmap §B5 완료 표기·build-log append·CLAUDE.md 상태줄·master ff-merge)는 `/finish-slice` 의식에서 (spec §6).

---

## Self-review 노트 (plan 작성 시점)

- spec §4.1 삭제 9건 → Task 4에서 1(#9 object/primitive 중복 — #8은 구현으로 fold), Task 5에서 3(ScenarioPages), Task 6에서 5(flowVars 2+useRunReport 3) = 9. ✓
- spec §4.2 구현 9건 → Task 1(2)+Task 2(2)+Task 3(3)+Task 4(1)+Task 5(1) = 9. ✓
- spec §5 게이트 전부 Task 7에 반영(lint/test/build + todo-0 + 파이프 마스킹 회피). §6 마무리는 finish-slice로 위임.
- 타입 일관성: `nodeProps`/`HttpNode`는 Task 2 안에서만 사용, `putBody`는 Task 5 안에서만 — cross-task 참조 없음.
