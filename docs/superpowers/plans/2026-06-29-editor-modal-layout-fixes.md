# 에디터 후속 버그 수정 (슬라이스 A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터 아웃라인 재설계(ADR-0044) 후 사용자가 보고한 3개 레이아웃 회귀를 닫는다 — 변수 패널 세로 스택+값 가시화+사용 힌트, 아웃라인 스텝명/URL 각 한 줄, YAML 모달 Monaco 높이.

**Architecture:** UI-only. 새 읽기 전용 헬퍼(`countFlowVarUsage`)와 소형 컴포넌트(`AutoGrowTextarea`)를 추가하고, `VariablesPanel`/`FlowOutline`/`EditorShell`의 *마크업·표시*만 바꾼다. 모델/wire/store-편집 의미론 byte-identical. `MonacoYamlView`는 `automaticLayout: true` 한 줄만.

**Tech Stack:** TypeScript, React 18, Tailwind v3.4, Zustand, Zod, Vitest + Testing Library, monaco-editor 0.50 / @monaco-editor/react 4.7, dnd-kit.

**Spec:** `docs/superpowers/specs/2026-06-29-editor-modal-layout-fixes-design.md` (normative = 그 §2 R-표). 본 plan은 R-id로 대조된다.

## Global Constraints

- **모델/wire/store-편집 byte-identical** — `model.ts`/`yamlDoc.ts`/`store.ts` 편집 액션 무변경. 기존 `scanFlowVars`/`scanEnvVars` 무변경(소비처 DataBindingPanel·InsertTemplateModal 보존). (spec §5)
- **그리드 변수 컬럼 210px 유지** — `EditorShell` grid 문자열(`grid-cols-[210px_minmax(260px,300px)_1fr]`) 무변경. R7은 모달 안 래퍼 div만 추가. (spec R1/§5)
- **드래그/재정렬(dnd-kit) 배선 무변경** — `useSortable`·`setNodeRef`·`transform`·`SortableContext`·`resolveDragEnd`·`moveStep`·키보드 센서·드래그 핸들 그대로. R5/R6은 마크업만. (spec §3.5/§5)
- **사용자 노출 문구는 전부 `ko.editor.*` 경유** (ADR-0035) — 하드코딩 영어/한국어 금지. aria-label 포함.
- **TDD 순서 = 테스트 먼저** — `ui/CLAUDE.md` tdd-guard 함정: watched `ui/src/**`(non-test) 편집 전 *pending(modified/untracked) test-path 파일*이 있어야 한다. **각 task의 첫 step은 테스트 파일 편집**(test-path는 가드 항상 통과). import 미해결로 RED여도 무방.
- **커밋 게이트**: `ui/` 변경 커밋은 pre-commit이 `pnpm lint && pnpm test && pnpm build`(UI 게이트)를 돌린다. **커밋은 단일 foreground blocking 호출**(`run_in_background:false`, timeout 600000ms, 폴링 금지 — A4b 함정).
- **단일 파일 빠른 반복**: `pnpm test <name>`(예 `pnpm test scanVars`) = 그 1파일(`--` 붙이지 말 것 — 전체 스위트 됨). 머지 전 인자 없는 전체 `pnpm test` 1회.

---

## Task 1: `countFlowVarUsage` 사용량 스캐너 (R3)

**Files:**
- Modify: `ui/src/scenario/scanVars.ts` (현재 76줄 — 함수 추가, 기존 `scanFlowVars`/`scanEnvVars` 무변경)
- Test: `ui/src/scenario/__tests__/scanVars.test.ts:1-3,233` (새 `describe` 블록 추가)

**Interfaces:**
- Produces: `export function countFlowVarUsage(scenario: Scenario): Map<string, number>` — 변수명 → 그 변수를 참조하는 *스텝 수*. http 요청 url/헤더/바디 + if/elif **조건 피연산자**(`scanFlowVars`가 빠뜨리는 표면)를 전체 스텝 트리(중첩 컨테이너 포함) 하강하며 센다. 한 스텝이 같은 변수를 다회 참조해도 그 스텝에 대해 +1.
- Consumes: 모듈-사설 `collectFromString`/`collectFromJson`(이미 scanVars.ts에 존재), `type Step`/`type Condition`/`type Scenario`(`./model`).

- [ ] **Step 1: 실패 테스트 작성** — `scanVars.test.ts` 상단 import에 `countFlowVarUsage` 추가하고 파일 끝(`scanEnvVars` describe 뒤)에 새 describe 추가.

import 줄(현재 `:2`)을 교체:

```ts
import { scanFlowVars, scanEnvVars, countFlowVarUsage } from "../scanVars";
```

파일 맨 끝에 추가:

```ts
describe("countFlowVarUsage", () => {
  it("counts http request-field usage per variable across steps", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/x?u={{tok}}", headers: {} },
        assert: [],
        extract: [],
      },
      {
        id: "01HX0000000000000000000002",
        name: "b",
        type: "http",
        request: { method: "GET", url: "/y", headers: { Authorization: "Bearer {{tok}}" } },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("tok")).toBe(2);
  });

  it("counts a variable referenced multiple times in one step as ONE step", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/{{id}}/{{id}}", headers: { "X-Id": "{{id}}" } },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("id")).toBe(1);
  });

  it("counts if + elif CONDITION operands that scanFlowVars omits (teeth)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000010",
          name: "gate",
          type: "if",
          cond: { left: "{{code}}", op: "eq", right: "{{want}}" },
          then: [
            {
              id: "01HX0000000000000000000011",
              name: "t",
              type: "http",
              request: { method: "GET", url: "/ok", headers: {} },
              assert: [],
              extract: [],
            },
          ],
          elif: [
            {
              cond: { left: "{{code}}", op: "eq", right: "404" },
              then: [
                {
                  id: "01HX0000000000000000000012",
                  name: "e",
                  type: "http",
                  request: { method: "GET", url: "/nf", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
            },
          ],
          else: [],
        },
      ],
    });
    const u = countFlowVarUsage(s);
    // {{code}}는 같은 if 스텝의 cond + elif cond 둘 다 → 1 스텝
    expect(u.get("code")).toBe(1);
    // {{want}}는 if cond에만 → 조건 스캔이 동작함을 증명(scanFlowVars는 못 봄)
    expect(u.get("want")).toBe(1);
    expect(scanFlowVars(s).has("want")).toBe(false); // 대조: 옛 스캐너는 조건을 빠뜨린다
  });

  it("recurses across nested containers (if-in-loop: condition + leaf both reached)", () => {
    const s = ScenarioModel.parse({
      version: 1,
      name: "x",
      cookie_jar: "auto",
      variables: {},
      steps: [
        {
          id: "01HX0000000000000000000030",
          name: "lp",
          type: "loop",
          repeat: 1,
          do: [
            {
              id: "01HX0000000000000000000031",
              name: "ifinner",
              type: "if",
              cond: { left: "{{nestedCond}}", op: "exists" },
              then: [
                {
                  id: "01HX0000000000000000000032",
                  name: "h",
                  type: "http",
                  request: { method: "GET", url: "/{{nestedUrl}}", headers: {} },
                  assert: [],
                  extract: [],
                },
              ],
              elif: [],
              else: [],
            },
          ],
        },
      ],
    });
    const u = countFlowVarUsage(s);
    expect(u.get("nestedCond")).toBe(1); // 중첩 if 조건 도달
    expect(u.get("nestedUrl")).toBe(1); // 중첩 http leaf 도달
  });

  it("returns no entry for an unreferenced variable name", () => {
    const s = scenario([
      {
        id: "01HX0000000000000000000001",
        name: "a",
        type: "http",
        request: { method: "GET", url: "/static", headers: {} },
        assert: [],
        extract: [],
      },
    ]);
    expect(countFlowVarUsage(s).get("ghost")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test scanVars`
Expected: FAIL — `countFlowVarUsage is not a function` (또는 import 에러).

- [ ] **Step 3: 최소 구현** — `scanVars.ts` import 줄(`:1`)을 교체하고 파일 끝에 함수 추가.

import 줄 교체:

```ts
import { flattenHttpSteps, type Scenario, type Step, type Condition } from "./model";
```

파일 끝(`scanFlowVars` 뒤)에 추가:

```ts
function collectCondRefs(c: Condition, out: Set<string>): void {
  if ("all" in c) {
    for (const x of c.all) collectCondRefs(x, out);
    return;
  }
  if ("any" in c) {
    for (const x of c.any) collectCondRefs(x, out);
    return;
  }
  collectFromString(c.left, out);
  if (c.right !== undefined) collectFromString(c.right, out);
}

/**
 * Per-variable count of how many STEPS reference each `{{var}}`. Surfaces = the
 * same http request fields as scanFlowVars (url / header values / body) PLUS
 * if/elif condition operands (which scanFlowVars intentionally skips). Recurses
 * through every container (loop `do`, if `then`/`elif[].then`/`else`, parallel
 * `branches[].steps`), including one-level nesting. A var referenced multiple
 * times within one step counts once for that step. Read-only — powers the
 * editor's per-variable usage hint; a hint must not lie, hence condition coverage.
 */
export function countFlowVarUsage(scenario: Scenario): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (refs: Set<string>): void => {
    for (const name of refs) counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const walk = (steps: ReadonlyArray<Step>): void => {
    for (const s of steps) {
      if (s.type === "http") {
        const refs = new Set<string>();
        collectFromString(s.request.url, refs);
        for (const v of Object.values(s.request.headers)) collectFromString(v, refs);
        const body = s.request.body;
        if (body?.kind === "raw") {
          collectFromString(body.value, refs);
        } else if (body?.kind === "form") {
          for (const v of Object.values(body.value)) collectFromString(v, refs);
        } else if (body?.kind === "json") {
          collectFromJson(body.value, refs);
        }
        bump(refs);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "parallel") {
        for (const b of s.branches) walk(b.steps);
      } else {
        // if: the if step itself "uses" its own cond + every elif cond operand
        const refs = new Set<string>();
        collectCondRefs(s.cond, refs);
        for (const e of s.elif) collectCondRefs(e.cond, refs);
        bump(refs);
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
    }
  };
  walk(scenario.steps);
  return counts;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test scanVars`
Expected: PASS (기존 scanFlowVars/scanEnvVars 케이스 + 새 5 케이스 전부 green).

- [ ] **Step 5: 커밋** (단일 foreground 호출)

```bash
git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "feat(editor): 변수 사용량 스캐너 countFlowVarUsage (조건 피연산자 포함·R3)"
```

---

## Task 2: `AutoGrowTextarea` 컴포넌트 (R2)

**Files:**
- Create: `ui/src/components/AutoGrowTextarea.tsx`
- Test: `ui/src/components/__tests__/AutoGrowTextarea.test.tsx`

**Interfaces:**
- Produces: `export function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string })` — 제어 textarea. value 변경 시 내용 높이에 맞춰 성장(상한 `max-h-40` 도달 시 내부 스크롤). `value`/`onChange`/`className`/`aria-label` 등 패스스루.
- Consumes: 없음(React만).

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/AutoGrowTextarea.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoGrowTextarea } from "../AutoGrowTextarea";

describe("AutoGrowTextarea", () => {
  it("renders a textarea with the value and a stable accessible name", () => {
    render(<AutoGrowTextarea value="hello" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveValue("hello");
    expect(ta.tagName).toBe("TEXTAREA");
  });

  it("forwards onChange edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AutoGrowTextarea value="" aria-label="v" onChange={onChange} />);
    await user.type(screen.getByRole("textbox", { name: "v" }), "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("is full-width and merges a caller className (no resize handle)", () => {
    render(<AutoGrowTextarea value="" aria-label="v" className="border" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveClass("w-full"); // 전폭
    expect(ta).toHaveClass("resize-none"); // 사용자 리사이즈 핸들 없음(자동 성장)
    expect(ta).toHaveClass("border"); // caller className 병합
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test AutoGrowTextarea`
Expected: FAIL — 모듈 `../AutoGrowTextarea` 없음.

- [ ] **Step 3: 최소 구현** — `ui/src/components/AutoGrowTextarea.tsx`

```tsx
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/**
 * Controlled textarea that grows to fit its content (1 row when short, taller as
 * the value wraps) so long values — JWT tokens, URLs, JSON — are fully visible.
 * Caps at `max-h-40` then scrolls internally. jsdom reports scrollHeight 0, so the
 * auto-grow is a no-op in tests (value/onChange still work); the visual height is
 * verified live.
 */
export function AutoGrowTextarea({
  value,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      className={`block w-full resize-none overflow-y-auto max-h-40 ${className ?? ""}`}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test AutoGrowTextarea`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/AutoGrowTextarea.tsx ui/src/components/__tests__/AutoGrowTextarea.test.tsx
git commit -m "feat(editor): 자동 확장 textarea 컴포넌트 (긴 변수값 가시화·R2)"
```

---

## Task 3: `VariablesPanel` 세로 스택 + 값 textarea + 사용 힌트 (R1·R2·R4·R8)

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (현재 73줄)
- Modify: `ui/src/i18n/ko.ts` — `ko.editor`에 키 3개 추가(`:421` `variablesAdd` 뒤)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (기존 케이스 보존 + 추가)

**Interfaces:**
- Consumes: `AutoGrowTextarea`(Task 2), `countFlowVarUsage`(Task 1), `ko.editor.variableUnused`/`variableUsage`/`variableValueAria`(이 task).
- Produces: 없음(말단 UI).

- [ ] **Step 1: 실패 테스트 작성** — `VariablesPanel.test.tsx`에 새 케이스 추가(기존 4개는 그대로 — getSnapshot 핀 테스트는 *파일 첫 it* 위치 유지).

기존 `describe("VariablesPanel", ...)` 안, 마지막 it 뒤에 추가:

```ts
  it("R1/R2: 값을 전폭 textarea로 렌더하고 편집을 store에 커밋한다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "abc");
    render(<VariablesPanel />);
    const ta = screen.getByRole("textbox", { name: "tok 값" });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta).toHaveClass("w-full");
    await user.type(ta, "d");
    expect(useScenarioEditor.getState().model!.variables.tok).toBe("abcd");
  });

  it("R1: 변수명은 truncate + title 로 전폭 표시한다", () => {
    useScenarioEditor.getState().setVariable("a_very_long_variable_name", "v");
    render(<VariablesPanel />);
    const name = screen.getByText("a_very_long_variable_name");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "a_very_long_variable_name");
  });

  it("R4: 사용되는 변수는 'N개 스텝에서 사용', 안 쓰이는 변수는 '미사용' 힌트를 보인다", () => {
    // {{used}}를 한 http 스텝의 url에서 참조하는 시나리오 + 미참조 변수 {{lonely}}
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables:
  used: "u"
  lonely: "l"
steps:
  - id: "01HX0000000000000000000001"
    name: s
    type: http
    request:
      method: GET
      url: "/x?q={{used}}"
    assert:
      - status: 200
`);
    render(<VariablesPanel />);
    expect(screen.getByText("1개 스텝에서 사용")).toBeInTheDocument();
    expect(screen.getByText("미사용")).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test VariablesPanel`
Expected: FAIL — `getByRole("textbox", { name: "tok 값" })` 없음 / "미사용" 텍스트 없음.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts` `:421`(`variablesAdd: "추가",`) 바로 뒤에 추가:

```ts
    variableUnused: "미사용",
    variableUsage: (n: number) => `${n}개 스텝에서 사용`,
    variableValueAria: (name: string) => `${name} 값`,
```

- [ ] **Step 4: `VariablesPanel.tsx` 재구성** — 전체 파일을 아래로 교체:

```tsx
import { useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { VarCheatSheet } from "./VarCheatSheet";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { countFlowVarUsage } from "../../scenario/scanVars";

// 셀렉터 fallback은 안정 참조여야 한다 — 인라인 `?? {}`는 매 스냅샷 새 객체라
// model=null 동안 useSyncExternalStore 무한 리렌더(getSnapshot 캐싱 경고)
const EMPTY_VARS: Record<string, string> = {};

export function VariablesPanel() {
  const model = useScenarioEditor((s) => s.model);
  const variables = useScenarioEditor((s) => s.model?.variables ?? EMPTY_VARS);
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);

  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(variables);
  // 사용 힌트(R4): 모델 변경마다 1회 도출(셀렉터 안 인라인 스캔 금지 — getSnapshot 함정).
  const usage = useMemo(
    () => (model ? countFlowVarUsage(model) : new Map<string, number>()),
    [model],
  );

  return (
    <section aria-label={ko.editor.variablesTitle} className="flex flex-col gap-3">
      <div className="flex items-center">
        <h3 className="text-sm font-semibold text-slate-700">{ko.editor.variablesTitle}</h3>
        <VarCheatSheet />
      </div>
      <ul className="flex flex-col gap-3">
        {entries.map(([key, value]) => {
          const n = usage.get(key) ?? 0;
          return (
            <li key={key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
                  title={key}
                >
                  {key}
                </span>
                <button
                  type="button"
                  onClick={() => removeVariable(key)}
                  aria-label={ko.editor.removeVariableAria(key)}
                  className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                >
                  ×
                </button>
              </div>
              <AutoGrowTextarea
                aria-label={ko.editor.variableValueAria(key)}
                className="border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                value={value}
                onChange={(e) => setVariable(key, e.target.value)}
              />
              <span className="text-xs text-slate-400">
                {n === 0 ? ko.editor.variableUnused : ko.editor.variableUsage(n)}
              </span>
            </li>
          );
        })}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">{ko.editor.variablesEmpty}</li>
        )}
      </ul>

      <div className="flex gap-2">
        <input
          className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          placeholder="new_var"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
          }}
          disabled={newKey.trim().length === 0}
          className="shrink-0 px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          {ko.editor.variablesAdd}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test VariablesPanel`
Expected: PASS — 기존 4 케이스(getSnapshot 핀·목록/추가·제거·치트시트) + 새 3 케이스 전부 green.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(editor): 변수 패널 세로 스택+값 전폭 textarea+사용 힌트 (R1/R2/R4)"
```

---

## Task 4: `FlowOutline` http leaf 이름/URL 한 줄 + 컨테이너 헤더 truncate (R5·R6)

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx` (현재 307줄)
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx` (기존 케이스 보존 + 추가)

**Interfaces:**
- Consumes: 없음(기존 모델/store).
- Produces: 없음.

- [ ] **Step 1: 실패 테스트 작성** — `FlowOutline.test.tsx` 첫 describe(`FlowOutline render (full nesting)`, NESTED_YAML 사용) 안 마지막 it 뒤에 추가:

```ts
  it("R5: http leaf 의 이름과 URL 이 각각 truncate+title 한 줄이고 행은 items-start 다", () => {
    render(<FlowOutline />);
    const name = screen.getByText("login");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "login");
    const url = screen.getByText("/login");
    expect(url).toHaveClass("truncate");
    expect(url).toHaveAttribute("title", "/login");
    const row = screen.getByRole("option", { name: /login/ });
    expect(row).toHaveClass("items-start");
  });

  it("R6: 컨테이너 헤더 이름이 truncate+title 이고 행은 items-center 다", () => {
    render(<FlowOutline />);
    const gate = screen.getByText("gate"); // if 컨테이너 헤더
    expect(gate).toHaveClass("truncate");
    expect(gate).toHaveAttribute("title", "gate");
    const gateRow = screen.getByRole("option", { name: /gate/ });
    expect(gateRow).toHaveClass("items-center");
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: FAIL — name 에 `truncate`/`title` 없음, 행에 `items-start`/`items-center` 분리 안 됨.

- [ ] **Step 3: `rowProps`에서 정렬 분리 (items-center/items-start 충돌 회피)** — `FlowOutline.tsx`의 `OutlineRow` 안에서 `rowProps`의 `className`을 정렬 없는 `rowClassBase`로 빼고, 각 렌더 사이트가 정렬을 명시한다(Tailwind에서 같은 속성 두 유틸을 한 string에 두면 소스 순서가 아니라 stylesheet 순서로 이겨 신뢰 불가 → 베이스에서 `items-*` 제거).

`rowProps` 정의(`:60-75`)에서 `className` 줄을 **삭제**하고, 바로 위에 `rowClassBase` 상수를 추가:

```tsx
  // 정렬(items-*)은 렌더 사이트별로 명시 — 한 className에 items-center/items-start를
  // 같이 두면 Tailwind가 소스 순서가 아닌 stylesheet 순서로 이겨 신뢰 불가.
  const rowClassBase = `flex gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`;

  // 행 컨테이너는 role="option" + tabIndex (button-in-button 회피 — 드래그 핸들이 별도 button).
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
```

- [ ] **Step 4: 드래그 핸들·ContainerTag 에 `shrink-0` 추가** — `dragHandle`의 button className(`:85`)을 교체:

```tsx
      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
```

`ContainerTag`의 span className(`:209`)을 교체:

```tsx
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
```

- [ ] **Step 5: 컨테이너 헤더 3종에 정렬·이름 truncate 적용** — loop/if/parallel 헤더 행을 교체.

loop 헤더(`:94-99`):

```tsx
        <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center`}>
          {dragHandle}
          <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
          <span className="min-w-0 truncate font-medium" title={step.name}>
            {step.name}
          </span>
          <span className="shrink-0 text-xs text-slate-500">× {step.repeat}</span>
        </div>
```

if 헤더(`:118-123`):

```tsx
        <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center`}>
          {dragHandle}
          <ContainerTag glyph="⎇" label={ko.editor.containerIf} />
          <span className="min-w-0 truncate font-medium" title={step.name}>
            {step.name}
          </span>
          <span className="shrink-0 text-xs text-slate-500">{summarizeCondition(step.cond)}</span>
        </div>
```

parallel 헤더(`:150-154`):

```tsx
        <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center`}>
          {dragHandle}
          <ContainerTag glyph="⇉" label={ko.editor.containerParallel} />
          <span className="min-w-0 truncate font-medium" title={step.name}>
            {step.name}
          </span>
        </div>
```

- [ ] **Step 6: http leaf 행을 이름/URL 스택으로 교체** — `:180-203` return 블록 교체:

```tsx
  // http leaf
  const urlMissing = step.request.url.trim() === "";
  return (
    <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-start`}>
      {dragHandle}
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
    </div>
  );
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS — 기존 13 케이스(렌더/선택/⚠배지/추가버튼/드래그 배선) + 새 2 케이스 전부 green. (기존 `getByText("login")`/`getByText("/login")`/accent/드래그 핸들 단언은 텍스트·role·핸들 불변이라 영향 없음.)

- [ ] **Step 8: 커밋**

```bash
git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "fix(editor): 아웃라인 http leaf 이름/URL 각 한 줄 + 컨테이너 헤더 truncate (R5/R6)"
```

---

## Task 5: YAML 모달 확정 높이 — `EditorShell` 래퍼 + `MonacoYamlView` automaticLayout (R7)

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx:79-81`
- Modify: `ui/src/components/scenario/MonacoYamlView.tsx:81-88`(options 블록)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (추가)

**Interfaces:**
- Consumes: 없음.
- Produces: 없음.
- **주의**: 높이의 *실제 값*은 RTL이 못 본다(EditorShell 테스트가 MonacoYamlView를 목). 이 task의 RTL은 래퍼 *존재*만 핀(회귀 가드); 높이 ≈0 수정의 권위 검증은 Task 6 라이브(Playwright).

- [ ] **Step 1: 실패 테스트 작성** — `EditorShell.test.tsx`의 `describe("EditorShell", ...)` 안, YAML 모달 테스트(`:65-82`) 뒤에 추가:

```tsx
  it("R7: YAML 모달의 Monaco를 확정 높이(h-[70vh]) 컨테이너로 감싼다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    await user.click(screen.getByRole("button", { name: ko.editor.openYaml }));
    const view = screen.getByTestId("yaml-view");
    expect(view.parentElement).toHaveClass("h-[70vh]");
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: FAIL — `yaml-view`의 부모에 `h-[70vh]` 없음.

- [ ] **Step 3: `EditorShell` 래퍼 추가** — `:79-81` 교체:

```tsx
      <Modal open={yamlOpen} onClose={closeYaml} title={ko.editor.yamlModalTitle}>
        <div className="h-[70vh]">
          <MonacoYamlView />
        </div>
      </Modal>
```

- [ ] **Step 4: `MonacoYamlView` options 에 automaticLayout 추가** — `:81-88` options 객체에 한 줄 추가(첫 줄 `minimap` 위 또는 아무 위치):

```tsx
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
          }}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test EditorShell`
Expected: PASS — 기존 7 케이스(getSnapshot 핀·로드·onChange·grid 1fr·YAML 모달 열고닫기·변수 토글·검증 배너) + 새 R7 케이스 green. (MonacoYamlView 테스트는 `<Editor>`를 렌더 안 하므로 automaticLayout 추가에 영향 없음.)

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/MonacoYamlView.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "fix(editor): YAML 모달 확정 높이 h-[70vh] 래퍼 + Monaco automaticLayout (R7)"
```

---

## Task 6: 전체 게이트 + 라이브 검증 (spec §6)

**Files:** 없음(검증만).

- [ ] **Step 1: 전체 UI 게이트** (머지 전 인자 없는 전체 1회)

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고(`--max-warnings=0`), 전체 test green(새 케이스 포함), `tsc -b && vite build` 성공.

- [ ] **Step 2: 라이브 검증 (필수 — #5 시각 표면, RTL 불가)** — `/live-verify` 또는 vite dev로 띄워 Playwright로(에디터 YAML 모달은 클라이언트-only라 백엔드 불필요·`/scenarios/new` 진입 가능):
  - **#5**: `</> YAML` 모달 열기 → `.monaco-editor`의 `getBoundingClientRect().height > 300` **단언** + 실제 타이핑(텍스트가 에디터에 들어가는지) + 스크린샷. (직전 슬라이스가 클립보드 내용만 보고 false-PASS — **높이 측정/스크린샷이 권위**.)
  - **#1**: 변수 패널 — 긴 이름/값 변수 1~2개 + 미참조 변수 1개로, 세로 스택·값 전폭 가시성·"미사용"/"N개 스텝에서 사용" 힌트 스크린샷.
  - **#2**: 아웃라인 — 긴 스텝명/URL이 각 한 줄(truncate)로 보이는 스크린샷.
  - `--ui-dir`는 절대경로 `$PWD/ui/dist`(cwd-drift Monaco 청크 MIME 함정). `automaticLayout: true`가 일부 브라우저에서 무해한 `ResizeObserver loop … undelivered notifications` 콘솔 *경고*를 낼 수 있음 — Zod/React 에러 아니므로 PASS 막지 않음(실패로 오인 말 것).
  - 콘솔에 Zod/React 에러 0 확인.

> 라이브 검증은 슬라이스 파이프라인의 별도 단계(orchestrator가 최종 리뷰 후 수행). 이 task는 그 체크리스트를 plan에 고정한 것.

---

## Self-Review (작성자 체크)

- **Spec coverage**: R1(Task 3)·R2(Task 2+3)·R3(Task 1)·R4(Task 3)·R5(Task 4)·R6(Task 4)·R7(Task 5)·R8(Task 3) — 8개 R 전부 task로 매핑. spec §6 검증 = Task 6.
- **No placeholders**: 모든 코드 step에 완전한 코드. "적절한 에러 처리" 류 없음.
- **Type consistency**: `countFlowVarUsage(scenario: Scenario): Map<string, number>`(Task 1 정의 = Task 3 소비), `AutoGrowTextarea`(Task 2 정의 = Task 3 소비), ko 키 `variableUnused`/`variableUsage(n)`/`variableValueAria(name)`(Task 3 정의·소비). `rowClassBase`(Task 4 내부) 일관.
- **불변식**: 모델/wire/store 무변경 / 210px 그리드 무변경 / 드래그 배선 무변경 / ko 경유 — Global Constraints에 명시, 각 task가 마크업·읽기전용만 건드림.
- **tdd-guard**: 각 task Step 1 = 테스트 파일 편집(pending RED). Task 3는 ko.ts 편집 전 VariablesPanel 테스트가 pending이라 통과. Task 5는 EditorShell 테스트가 pending이라 MonacoYamlView 편집도 통과(가드는 per-file 아님).

_spec-plan-reviewer clean APPROVE (spec 2R + plan 1R, 2026-06-29) — 모든 R-id 코드/line-cite/타입-내로잉/테스트 단언 코드베이스 대조 검증._

<!-- REVIEW-GATE: APPROVED -->
