# 시나리오 복제/포크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 시나리오를 한 번의 클릭으로 복제(`name`에 유일한 `(copy)` 서픽스) — 목록 행과 에디터 헤더 두 진입점, 에디터는 미저장 변경 시 저장 확인 다이얼로그.

**Architecture:** 순수 클라이언트(approach A). 새 `cloneName` 순수 함수(이름 dedup) + `renameScenarioYaml` YAML Document API 헬퍼(`name:`만 수정, 주석 보존) + `useCloneScenario` 훅(둘을 조합해 기존 `api.createScenario` 호출 + 목록 invalidate). 두 페이지가 이 훅을 공유. **백엔드·proto·migration·store·엔진·워커 무변경.**

**Tech Stack:** TypeScript/React, Zustand, `yaml`(Document API), @tanstack/react-query v5, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-06-scenario-clone-design.md`

---

## 슬라이스 전역 주의 (모든 task 공통)

- **이건 UI-only지만 pre-commit hook은 비-`.md` 커밋마다 전체 cargo workspace(build+clippy+test, e2e/워커 포함)를 돌린다 — 수 분.** 그래서: ① 첫 task 전에 `cargo build -p handicap-worker && cargo build --workspace`로 warm(cold-build 워커 race flake 회피), ② 각 커밋은 `run_in_background`로, ③ UI 게이트(`pnpm lint && pnpm test && pnpm build`)는 hook이 **안** 돌리므로 **커밋 전 수동**으로 돌린다.
- **vitest `include` = `src/**/__tests__/**/*.{test,spec}.{ts,tsx}`** — 테스트 파일은 반드시 `__tests__/` 디렉터리에. sibling `*.test.ts`는 조용히 안 돈다.
- **단일 파일 반복은 `pnpm test <name>`(‘`--`’ 붙이지 말 것 — 붙으면 전체 스위트). 머지 전 1회는 인자 없는 전체 `pnpm test`.**
- **tdd-guard**: 새 src 파일/ src 편집 전에 **테스트 파일을 디스크에 먼저** 둔다(각 task Step 1).
- 새 Zod 스키마 추가 없음(복제는 기존 `createScenario` 재사용) → `.default()` 누출 함정 비해당.
- 작업 시작 전 워크트리에 `ui/node_modules`가 있는지 확인(없으면 `cd ui && pnpm install`).

---

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/scenario/cloneName.ts` (신규) | 이름 dedup 순수 함수 | 1 |
| `ui/src/scenario/__tests__/cloneName.test.ts` (신규) | 위 단위 테스트 | 1 |
| `ui/src/scenario/yamlDoc.ts` (수정) | `renameScenarioYaml` export 추가 | 2 |
| `ui/src/scenario/__tests__/yamlDoc.test.ts` (수정) | `renameScenarioYaml` 테스트 추가 | 2 |
| `ui/src/api/hooks.ts` (수정) | `useCloneScenario` 추가 | 3 |
| `ui/src/pages/ScenarioListPage.tsx` (수정) | 행별 "복제" 버튼 | 3 |
| `ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx` (신규) | 목록 복제 RTL | 3 |
| `ui/src/pages/ScenarioEditPage.tsx` (수정) | 헤더 "복제" + dirty 다이얼로그 | 4 |
| `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx` (신규) | 에디터 복제 RTL | 4 |
| `docs/roadmap.md`·`CLAUDE.md`·memory (수정) | 상태 갱신 | 5 |

---

## Task 1: `cloneName` 순수 함수 (이름 dedup)

**Files:**
- Create: `ui/src/scenario/cloneName.ts`
- Test: `ui/src/scenario/__tests__/cloneName.test.ts`

- [ ] **Step 1: 실패 테스트 작성** (`__tests__/cloneName.test.ts` — 새 src 파일 unblock 위해 먼저)

```ts
import { describe, expect, it } from "vitest";
import { cloneName } from "../cloneName";

describe("cloneName", () => {
  it("appends (copy) when base has no copy suffix", () => {
    expect(cloneName("Foo", ["Foo"])).toBe("Foo (copy)");
  });

  it("increments to (copy 2) when (copy) is taken", () => {
    expect(cloneName("Foo", ["Foo", "Foo (copy)"])).toBe("Foo (copy 2)");
  });

  it("strips an existing (copy) suffix before numbering (no (copy) (copy) pileup)", () => {
    expect(cloneName("Foo (copy)", ["Foo", "Foo (copy)"])).toBe("Foo (copy 2)");
  });

  it("strips an existing (copy N) suffix to find the base", () => {
    expect(cloneName("Foo (copy 2)", ["Foo", "Foo (copy)", "Foo (copy 2)"])).toBe("Foo (copy 3)");
  });

  it("fills the first empty slot — may produce a lower number than the source", () => {
    // base = "Foo"; "(copy)" is free → fills it, not "(copy 3)"
    expect(cloneName("Foo (copy 2)", ["Foo (copy 2)"])).toBe("Foo (copy)");
  });

  it("does not treat an unrelated name as a copy", () => {
    expect(cloneName("Bar", ["Foo"])).toBe("Bar (copy)");
  });

  it("works with empty existing list", () => {
    expect(cloneName("Foo", [])).toBe("Foo (copy)");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test cloneName`
Expected: FAIL — "Failed to resolve import ../cloneName" 또는 "cloneName is not a function".

- [ ] **Step 3: 구현 작성** (`ui/src/scenario/cloneName.ts`)

```ts
const COPY_SUFFIX = /^(.*) \(copy(?: (\d+))?\)$/;

/**
 * 복제본 이름을 만든다. base = sourceName에서 기존 "(copy)"/"(copy N)" 접미사를
 * 벗긴 것. 후보 체인은 **항상 "(copy)"부터 위로** 스캔해 existingNames에 없는
 * 첫 빈 자리를 고른다(소스 번호로 시드하지 않음 — "첫 빈 자리" 시맨틱).
 * existingNames에 UNIQUE 강제는 없으니 best-effort 정돈일 뿐.
 */
export function cloneName(sourceName: string, existingNames: string[]): string {
  const m = COPY_SUFFIX.exec(sourceName);
  const base = m ? m[1] : sourceName;
  const taken = new Set(existingNames);
  if (!taken.has(`${base} (copy)`)) return `${base} (copy)`;
  for (let n = 2; ; n++) {
    const candidate = `${base} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test cloneName`
Expected: PASS (7 tests).

- [ ] **Step 5: 커밋** (먼저 `pnpm lint`로 새 파일 경고 0 확인; cargo 게이트는 background)

```bash
cd ui && pnpm lint
cd /Users/sgj/develop/handicap
git add ui/src/scenario/cloneName.ts ui/src/scenario/__tests__/cloneName.test.ts
git commit -m "feat(ui): cloneName — 시나리오 복제 이름 dedup 순수 함수"
```

---

## Task 2: `renameScenarioYaml` (YAML `name:` 수정 헬퍼)

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (새 export 추가)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts` (describe 블록 추가)

- [ ] **Step 1: 실패 테스트 작성** (`yamlDoc.test.ts` 맨 끝에 추가; 상단 import 라인에 `renameScenarioYaml` 추가)

`yamlDoc.test.ts:2` import 수정:
```ts
import { parseScenarioDoc, serializeDoc, applyEdit, renameScenarioYaml, type Edit } from "../yamlDoc";
```

파일 끝에 추가:
```ts
describe("renameScenarioYaml", () => {
  it("changes only the name and preserves other keys + comments", () => {
    const src = "version: 1\n# top comment\nname: demo\ncookie_jar: auto\nsteps: []\n";
    const out = renameScenarioYaml(src, "demo (copy)");
    expect(out).toContain("name: demo (copy)");
    expect(out).toContain("# top comment");
    expect(out).toContain("cookie_jar: auto");
    expect(out).toContain("version: 1");
    expect(out).not.toContain("name: demo\n"); // 옛 값 잔류 없음
  });

  it("writes a PLAIN scalar (no inherited quotes)", () => {
    const src = 'version: 1\nname: "quoted demo"\nsteps: []\n';
    const out = renameScenarioYaml(src, "demo (copy)");
    expect(out).toContain("name: demo (copy)"); // 따옴표 비상속
  });

  it("round-trips through parseScenarioDoc with the new name", () => {
    const src = "version: 1\nname: demo\nsteps:\n  - { type: http, id: 01HZX0000000000000000000A0, name: home, request: { method: GET, url: /, headers: {} } }\n";
    const out = renameScenarioYaml(src, "demo (copy)");
    const parsed = parseScenarioDoc(out);
    expect("model" in parsed).toBe(true);
    if ("model" in parsed) expect(parsed.model.name).toBe("demo (copy)");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test yamlDoc`
Expected: FAIL — "renameScenarioYaml is not a function" / import 에러.

- [ ] **Step 3: 구현 작성** — `yamlDoc.ts`의 `serializeDoc` 함수(현재 `yamlDoc.ts:90-92`) **바로 아래**에 추가. (`plainScalar`는 같은 모듈의 private 헬퍼라 직접 호출 가능.)

```ts
/**
 * 시나리오 YAML의 `name:`만 바꾼 새 YAML 문자열을 반환(주석·다른 키 보존,
 * `setName` Edit과 동일한 Document API targeted edit). 복제(clone)용 단일 진입 헬퍼.
 * PLAIN scalar로 set해 원본의 인용 스타일 상속을 피한다.
 */
export function renameScenarioYaml(yamlText: string, newName: string): string {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  }
  doc.setIn(["name"], plainScalar(newName));
  return String(doc);
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test yamlDoc`
Expected: PASS (기존 + 신규 3 tests).

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint
cd /Users/sgj/develop/handicap
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): renameScenarioYaml — name만 수정하는 Document API 헬퍼(주석 보존)"
```

---

## Task 3: `useCloneScenario` 훅 + 목록 행 "복제" 버튼

**Files:**
- Modify: `ui/src/api/hooks.ts` (`useCloneScenario` 추가)
- Modify: `ui/src/pages/ScenarioListPage.tsx` (행별 "복제" 버튼)
- Test: `ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx` (신규 — 훅을 페이지를 통해 통합 검증)

- [ ] **Step 1: 실패 테스트 작성** (`__tests__/ScenarioListPage.clone.test.tsx` — 새 파일 먼저)

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioListPage } from "../ScenarioListPage";

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
const CREATED = { ...DEMO, id: "S2", name: "demo (copy)", yaml: "version: 1\nname: demo (copy)\nsteps: []\n" };

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(CREATED, 201);
  if (url.endsWith("/api/scenarios") && method === "GET") return jsonResponse({ scenarios: [DEMO] });
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
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioListPage clone", () => {
  it("clones the row's scenario via POST with a (copy)-munged YAML", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: "복제" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.yaml).toContain("name: demo (copy)");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioListPage.clone`
Expected: FAIL — "복제" 버튼 없음(`Unable to find role="button" name "복제"`).

- [ ] **Step 3a: 훅 추가** (`ui/src/api/hooks.ts`)

상단 import 추가(파일 기존 import 블록에):
```ts
import { cloneName } from "../scenario/cloneName";
import { renameScenarioYaml } from "../scenario/yamlDoc";
```

`useCreateScenario`(현재 `hooks.ts:42-50`) 바로 아래에 추가:
```ts
export function useCloneScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sourceYaml,
      sourceName,
      existingNames,
    }: {
      sourceYaml: string;
      sourceName: string;
      existingNames: string[];
    }) => {
      const newName = cloneName(sourceName, existingNames);
      const newYaml = renameScenarioYaml(sourceYaml, newName);
      return api.createScenario(newYaml);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}
```

- [ ] **Step 3b: 목록 행 "복제" 버튼** (`ui/src/pages/ScenarioListPage.tsx`)

전체를 아래로 교체:
```tsx
import { Link } from "react-router-dom";
import { useCloneScenario, useScenarios } from "../api/hooks";
import { Button } from "../components/Button";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();
  const clone = useCloneScenario();

  function onClone(scenario: { yaml: string; name: string }) {
    const existingNames = data?.scenarios.map((s) => s.name) ?? [];
    clone.mutate({ sourceYaml: scenario.yaml, sourceName: scenario.name, existingNames });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Scenarios</h2>
        <Link to="/scenarios/new">
          <Button>New scenario</Button>
        </Link>
      </div>

      {isLoading && <p className="text-slate-500">Loading…</p>}
      {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
      {clone.error && (
        <p role="alert" className="mb-3 text-red-600">
          복제 실패: {(clone.error as Error).message}
        </p>
      )}

      {data && data.scenarios.length === 0 && (
        <p className="text-slate-500">No scenarios yet. Create one to get started.</p>
      )}

      {data && data.scenarios.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Version</th>
              <th className="py-2 pr-4 font-medium">Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.scenarios.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium">
                  <Link to={`/scenarios/${s.id}`} className="hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-slate-600">v{s.version}</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(s.updated_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <div className="flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => onClone(s)}
                      disabled={clone.isPending}
                      className="text-slate-700 hover:underline disabled:text-slate-400"
                    >
                      복제
                    </button>
                    <Link to={`/scenarios/${s.id}/runs`} className="text-slate-700 hover:underline">
                      runs →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScenarioListPage.clone`
Expected: PASS (1 test).

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint
cd /Users/sgj/develop/handicap
git add ui/src/api/hooks.ts ui/src/pages/ScenarioListPage.tsx ui/src/pages/__tests__/ScenarioListPage.clone.test.tsx
git commit -m "feat(ui): useCloneScenario 훅 + 목록 행 복제 버튼"
```

---

## Task 4: 에디터 헤더 "복제" + dirty 확인 다이얼로그

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx` (신규)

- [ ] **Step 1: 실패 테스트 작성** (`__tests__/ScenarioEditPage.clone.test.tsx`)

`EditorShell`을 스텁으로 대체(미저장 dirty를 결정적으로 구동)하고 `TestRunSection`을 no-op으로:
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
      <button type="button" onClick={() => onChange("version: 1\nname: demo\nsteps: []\n# edited\n")}>
        edit
      </button>
    </div>
  ),
}));
vi.mock("../../components/scenario/TestRunSection", () => ({ TestRunSection: () => null }));

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
const COPY = {
  ...DEMO,
  id: "S2",
  name: "demo (copy)",
  yaml: "version: 1\nname: demo (copy)\nsteps: []\n",
};

let putShould409 = false;
function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    return putShould409
      ? jsonResponse({ error: "stale version" }, 409)
      : jsonResponse({ ...DEMO, version: 2 });
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios/S2")) return jsonResponse(COPY);
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(COPY, 201);
  if (url.endsWith("/api/scenarios") && method === "GET") return jsonResponse({ scenarios: [DEMO] });
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

function postBody() {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}
function putCalled() {
  return fetchMock.mock.calls.some(
    ([u, i]) => String(u).endsWith("/api/scenarios/S1") && (i as RequestInit)?.method === "PUT",
  );
}

describe("ScenarioEditPage clone", () => {
  beforeEach(() => {
    putShould409 = false;
  });

  it("not dirty: clones immediately and navigates to the new scenario", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" })); // originalYaml = yamlText → not dirty

    await user.click(screen.getByRole("button", { name: "복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    expect(putCalled()).toBe(false);
    await screen.findByRole("heading", { name: "demo (copy)" }); // navigated to S2
  });

  it("dirty → save then clone: PUTs, then POSTs, then navigates", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 후 복제" }));

    await waitFor(() => expect(putCalled()).toBe(true));
    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    await screen.findByRole("heading", { name: "demo (copy)" });
  });

  it("dirty → clone without saving: POSTs from saved yaml, no PUT", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 없이 복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    expect(putCalled()).toBe(false);
    await screen.findByRole("heading", { name: "demo (copy)" });
  });

  it("dirty → save fails → continue with last saved", async () => {
    const user = userEvent.setup();
    putShould409 = true;
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 후 복제" }));

    // save-failed dialog appears
    await screen.findByText(/저장에 실패했습니다/);
    await user.click(screen.getByRole("button", { name: "저장본으로 복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    await screen.findByRole("heading", { name: "demo (copy)" });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioEditPage.clone`
Expected: FAIL — "복제" 버튼/다이얼로그 없음.

- [ ] **Step 3: 구현** — `ui/src/pages/ScenarioEditPage.tsx` 전체 교체:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCloneScenario, useScenario, useScenarios, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunSection } from "../components/scenario/TestRunSection";

type CloneDialog = null | { stage: "confirm" } | { stage: "save-failed"; message: string };

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const { data: scenarios } = useScenarios();
  const update = useUpdateScenario(id ?? "");
  const clone = useCloneScenario();
  const [yamlText, setYamlText] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [originalYaml, setOriginalYaml] = useState<string>("");
  const [cloneDialog, setCloneDialog] = useState<CloneDialog>(null);
  const baselineSeededRef = useRef(false);

  useEffect(() => {
    if (data) {
      setLoadedVersion(data.version);
      baselineSeededRef.current = false; // re-seed when data changes
    }
  }, [data]);

  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
    if (!baselineSeededRef.current) {
      baselineSeededRef.current = true;
      setOriginalYaml(next);
    }
  }, []);

  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;

  const dirty = originalYaml !== yamlText;
  const scenariosLoaded = scenarios !== undefined;

  // 클론 소스는 항상 data.yaml(현재 저장본) 또는 next.yaml(방금 저장한 결과) — 둘 다
  // 서버가 준 유효 YAML. originalYaml(정규화·post-mount까지 "")은 클론 소스로 쓰지 않음.
  async function cloneAndGo(sourceYaml: string, sourceName: string) {
    const existingNames = scenarios?.scenarios.map((s) => s.name) ?? [];
    const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
    setCloneDialog(null);
    navigate(`/scenarios/${created.id}`);
  }

  function onCloneClick() {
    if (!dirty) {
      void cloneAndGo(data.yaml, data.name);
      return;
    }
    setCloneDialog({ stage: "confirm" });
  }

  async function saveThenClone() {
    if (loadedVersion === null) return;
    try {
      const next = await update.mutateAsync({ yaml: yamlText, version: loadedVersion });
      setLoadedVersion(next.version);
      setOriginalYaml(next.yaml);
      baselineSeededRef.current = true;
      await cloneAndGo(next.yaml, next.name);
    } catch (e) {
      setCloneDialog({ stage: "save-failed", message: (e as Error).message });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{data.name}</h2>
          <p className="text-sm text-slate-600">
            v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              loadedVersion !== null &&
              update.mutate(
                { yaml: yamlText, version: loadedVersion },
                {
                  onSuccess: (next) => {
                    setLoadedVersion(next.version);
                    setOriginalYaml(next.yaml);
                    baselineSeededRef.current = true;
                  },
                },
              )
            }
            disabled={!dirty || update.isPending || loadedVersion === null}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="secondary"
            onClick={onCloneClick}
            disabled={!scenariosLoaded || clone.isPending}
          >
            {clone.isPending ? "복제 중…" : "복제"}
          </Button>
          <Link to={`/scenarios/${data.id}/runs`}>
            <Button variant="secondary">Runs</Button>
          </Link>
        </div>
      </div>

      {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}
      {clone.error && (
        <p role="alert" className="text-red-600">
          복제 실패: {(clone.error as Error).message}
        </p>
      )}

      <EditorShell initialYaml={data.yaml} onChange={handleEditorChange} />

      <TestRunSection yamlText={yamlText} />

      <Modal
        open={cloneDialog?.stage === "confirm"}
        onClose={() => setCloneDialog(null)}
        title="시나리오 복제"
      >
        <div className="flex flex-col gap-4">
          <p>변경사항이 저장되지 않았습니다. 복제 전에 저장할까요?</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCloneDialog(null)}>
              취소
            </Button>
            <Button variant="secondary" onClick={() => void cloneAndGo(data.yaml, data.name)}>
              저장 없이 복제
            </Button>
            <Button onClick={() => void saveThenClone()} disabled={update.isPending || clone.isPending}>
              저장 후 복제
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={cloneDialog?.stage === "save-failed"}
        onClose={() => setCloneDialog(null)}
        title="저장 실패"
      >
        <div className="flex flex-col gap-4">
          <p>
            저장에 실패했습니다: {cloneDialog?.stage === "save-failed" ? cloneDialog.message : ""}.
            마지막 저장본으로 복제를 계속할까요?
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCloneDialog(null)}>
              취소
            </Button>
            <Button onClick={() => void cloneAndGo(data.yaml, data.name)}>저장본으로 복제</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScenarioEditPage.clone`
Expected: PASS (4 tests). 그 뒤 회귀 확인: `cd ui && pnpm test ScenarioEditPage` (testrun 테스트 포함 — 헤더 그룹 테스트 `groups Save and Runs...`가 새 복제 버튼으로 깨지지 않는지; 깨지면 그 테스트의 그룹 단언을 복제 버튼 포함으로 보정).

- [ ] **Step 5: 커밋**

```bash
cd ui && pnpm lint
cd /Users/sgj/develop/handicap
git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx
git commit -m "feat(ui): 에디터 헤더 복제 버튼 + dirty 저장 확인 다이얼로그"
```

---

## Task 5: 전체 게이트 + 문서 갱신

**Files:**
- Modify: `docs/roadmap.md` (§B2' 시나리오 복제 → 완료 표기)
- Modify: `CLAUDE.md` (루트 상태 한 줄 — 선택; 작은 UI 슬라이스라 과하면 생략 가능)
- Modify: `ui/CLAUDE.md` (새 함정이 있으면 한 줄)

- [ ] **Step 1: 전체 UI 게이트** (머지 전 필수 — 단일 파일 필터로 놓친 회귀 차단)

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```
Expected: lint 0 warning, 전체 vitest PASS, `tsc -b && vite build` 성공.

- [ ] **Step 2: 라이브 검증** (선택이지만 권장 — RTL이 못 잡는 실제 클릭 경로)

`dev-doctor` 스킬로 controller+worker+UI 띄우고: 목록에서 한 시나리오 "복제" → 새 행 `(copy)` 등장 확인; 에디터에서 편집 후 "복제" → 다이얼로그 3버튼 동작(저장 후/저장 없이/취소) + 새 복제본 에디터로 이동 확인.

- [ ] **Step 3: 문서 갱신** — `docs/roadmap.md`의 §B2'(현재 "시나리오 복제 … → 시나리오 관리 슬라이스 또는 단독 spec")에 완료 한 줄 추가:

```
- ~~**시나리오 복제**~~ — **✅ 완료 (2026-06-06)**: UI-only 즉시 복제(클라). 유일 `(copy)` 서픽스(`cloneName`) + `renameScenarioYaml`(Document API, 주석 보존) + `useCloneScenario`(기존 createScenario 재사용) + 목록 행/에디터 헤더 진입점 + 에디터 dirty 시 저장 확인 다이얼로그(저장 후/저장 없이/취소, 저장 실패 시 계속 확인). 백엔드/proto/migration/엔진/워커 무변경. spec `docs/superpowers/specs/2026-06-06-scenario-clone-design.md`, plan `docs/superpowers/plans/2026-06-06-scenario-clone.md`. ADR 불필요(additive).
```

- [ ] **Step 4: 커밋** (docs-only → pre-commit fast-path)

```bash
git add docs/roadmap.md CLAUDE.md ui/CLAUDE.md
git commit -m "docs: 시나리오 복제 완료 반영(roadmap §B2')"
```

---

## Self-review note (작성자)

- **Spec coverage**: §4 cloneName→T1, §5 renameScenarioYaml→T2, §6.0 훅→T3, §6.1 목록→T3, §6.2 에디터+다이얼로그→T4, §8 테스트→각 T, §9 충돌→해당없음(A2-2 머지됨). 전부 커버.
- **타입 일관성**: `useCloneScenario` 인자 `{sourceYaml, sourceName, existingNames}` — T3 정의 / T4 호출 동일. `cloneName(sourceName, existingNames)` / `renameScenarioYaml(yamlText, newName)` 시그니처 T1·T2와 T3 호출 일치.
- **에디터 회귀**: 기존 `ScenarioEditPage.testrun.test.tsx`의 헤더 그룹 단언이 복제 버튼 추가로 깨질 수 있음 → T4 Step4에서 확인·보정 명시.
- **커밋 경계**: 각 task = 1 green 커밋(헬퍼→테스트→배선이 한 task 안에서 GREEN). dead-code/RED-only 단독 커밋 없음(cargo 전체게이트 호환).
