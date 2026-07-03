# 에디터 공간·이름 QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스텝 인스펙터를 접이식 섹션(localStorage 영속)으로 압축하고, "스텝 넓게 보기" 모드(전폭 아웃라인 + 흐름 칩 점프 + 모달 편집)를 추가하며, 스텝 이름의 즉시-Untitled 스냅을 blur-시 폴백으로 바꾼다.

**Architecture:** 전부 UI-only — `Inspector.tsx`에 `StepNameField`/`InspectorSection` 내부 컴포넌트 도입 + 신규 `scenario/editorPrefs.ts`(localStorage), `EditorShell.tsx`에 와이드 토글·그리드 분기·`TestFlowChips` 재마운트·편집 `Modal`, `FlowOutline.tsx`에 optional `wide`/`onActivateStep` prop(비-와이드 DOM byte-identical). 모델/YAML/store 액션/와이어 0-diff.

**Tech Stack:** React 18 + TS + Tailwind, Zustand(기존 store 읽기만), vitest + RTL, Playwright-MCP(라이브 시각 실측).

**Spec:** `docs/superpowers/specs/2026-07-03-editor-space-qol-design.md` (R1–R16이 권위; §0 컴패니언 확정 사항 + 목업 원본 `docs/superpowers/specs/assets/2026-07-03-editor-space-qol/`).

## Global Constraints

- **UI-only**: `crates/**`·proto·migration·`ui/src/scenario/model.ts`·`yamlDoc.ts`·store 액션 시그니처·`reorder.ts`·`dropRules.ts` 무변경 (R14). `git diff --stat`으로 매 task 확인.
- **게이트**: 매 task 커밋 전 `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build` 전부 green (`pnpm lint`는 `--max-warnings=0`).
- **tdd-guard**: 각 task의 **첫 편집은 테스트 파일**(`__tests__/` 경로 — pending test 없이 `ui/src` 편집 시 차단됨). import 미해결 RED 무방.
- **ko.ts**: 신규 사용자 노출 문구(aria-label 포함) 전부 `ui/src/i18n/ko.ts` 경유 — 인라인 한글/영어 금지 (R15).
- **비-와이드 byte-identical**: `wide` 미전달 시 FlowOutline DOM 무변화(R9) — 기존 FlowOutline/페이지 테스트 무수정 green이 증거.
- **localStorage 테스트 위생**: localStorage를 읽는 컴포넌트 테스트 파일은 `beforeEach`에 `window.localStorage.clear()` 필수(테스트 간 누수 방지 — `test/setup.ts` 폴리필은 clear를 지원).
- **jsdom엔 `scrollIntoView`가 없다** — 호출은 반드시 `el?.scrollIntoView?.(…)` 옵셔널 형태.
- 커밋 메시지 트레일러(모든 커밋): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01Wq9C4mZ1nv4m8LbXTEccgz`

---

### Task 1: `StepNameField` — 이름 blur-Untitled (R12, R13)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (이름 입력 4곳: `:235-241` http / `:863-871` parallel / `:955-961` loop / `:1293-1299` if — 정확 라인은 grep `\|\| "Untitled"`)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (describe 추가)

**Interfaces:**
- Consumes: `useScenarioEditor` store의 `setStepField(id, ["name"], v)` (기존).
- Produces: `Inspector.tsx` 내부(비export) `StepNameField({ stepId, name }: { stepId: string; name: string })` — 이후 task가 직접 참조하지 않음(렌더 결과만 동일 위치).

- [ ] **Step 1: 실패하는 테스트 작성** — `Inspector.test.tsx` 끝에 추가:

```tsx
describe("StepNameField — 이름 blur-Untitled (R12/R13)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("이름을 전부 지워도 타이핑 중 Untitled로 스냅되지 않는다 — draft는 빈 채 유지, store는 직전 이름", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    expect(input).toHaveValue(""); // 기존 구현은 여기서 "Untitled"로 스냅됨 → RED
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("login"); // 빈 값 미커밋 (R13)
  });

  it("빈 이름으로 blur하면 Untitled가 커밋된다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    await user.tab(); // blur
    expect(input).toHaveValue("Untitled");
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("Untitled");
  });

  it("비-빈 타이핑은 즉시 커밋된다 (아웃라인 라이브 갱신 유지)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    await user.type(input, "로그인");
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("로그인");
  });
});
```

(`loadAndSelect`·`VALID_YAML`은 파일 상단에 이미 있는 헬퍼 재사용. `VALID_YAML` 스텝 이름은 `login`.)

- [ ] **Step 2: RED 확인** — `pnpm test Inspector` (주의: `--` 붙이면 전체 스위트가 돈다). Expected: 첫 테스트 FAIL(`toHaveValue("")` — 실제 "Untitled").

- [ ] **Step 3: 구현** — `Inspector.tsx`의 `Field` 함수 정의(`:1363`) 근처에 추가:

```tsx
/** 이름 draft + 하이브리드 커밋(R12): 비-빈은 onChange 즉시 커밋(라이브 갱신),
 *  빈 값은 미커밋(draft 유지), blur 시 trim-빈이면 "Untitled" 폴백. store엔 빈
 *  이름이 절대 안 들어가 model min(1)/reparse 실패 경로 없음(R13). name dep
 *  재시드는 YAML 모달 등 외부 편집이 같은 스텝 이름을 바꿔도 draft가 따라가게 한다. */
function StepNameField({ stepId, name }: { stepId: string; name: string }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [stepId, name]);
  return (
    <Field label={ko.editor.fieldName}>
      <input
        className="w-full border border-slate-300 rounded px-2 py-1"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (v !== "") setStepField(stepId, ["name"], v); // raw 검사 — trim은 blur만 (R12)
        }}
        onBlur={() => {
          if (draft.trim() === "") {
            setStepField(stepId, ["name"], "Untitled");
            setDraft("Untitled");
          }
        }}
      />
    </Field>
  );
}
```

4곳의 기존 블록(아래 형태)을 전부 `<StepNameField stepId={step.id} name={step.name} />`로 교체:

```tsx
<Field label={ko.editor.fieldName}>
  <input
    className="w-full border border-slate-300 rounded px-2 py-1"
    value={step.name}
    onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
  />
</Field>
```

교체 후 `grep -n '|| "Untitled"' ui/src/components/scenario/Inspector.tsx` → 0건 확인. (`ParallelBranchEditor`의 분기명 draft는 스텝 이름이 아님 — 무변경.)

- [ ] **Step 4: GREEN 확인** — `pnpm test Inspector` 전부 PASS.
- [ ] **Step 5: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): 스텝 이름 blur-시 Untitled 폴백 — 타이핑 중 스냅 제거 (R12/R13)"
```

---

### Task 2: `editorPrefs` + `InspectorSection` + HttpStepInspector 재배치 (R1–R4)

**Files:**
- Create: `ui/src/scenario/editorPrefs.ts`
- Create: `ui/src/scenario/__tests__/editorPrefs.test.ts`
- Create: `ui/src/components/scenario/__tests__/Inspector.sections.test.tsx`
- Modify: `ui/src/components/scenario/Inspector.tsx`, `ui/src/i18n/ko.ts`
- Modify(테스트 갱신): `ui/src/components/scenario/__tests__/Inspector.test.tsx`

**Interfaces:**
- Produces: `editorPrefs.ts` → `type SectionKey = "headers" | "body" | "timing" | "assert" | "extract"`, `type SectionPrefs = Record<SectionKey, boolean>`, `DEFAULT_SECTION_PREFS: SectionPrefs`(전부 `false`), `loadSectionPrefs(): SectionPrefs`, `saveSectionPrefs(p: SectionPrefs): void`.
- Produces: `ko.editor.sectionTiming = "타이밍"`, `ko.editor.sectionSetHint = "설정됨"`, `ko.editor.sectionCountHint: (n: number) => string` (`` `${n}개` ``).
- Consumes: Task 1의 `StepNameField`(위치 그대로 유지).

- [ ] **Step 1: editorPrefs 실패 테스트** — `ui/src/scenario/__tests__/editorPrefs.test.ts` 신규:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SECTION_PREFS, loadSectionPrefs, saveSectionPrefs } from "../editorPrefs";

const KEY = "handicap:editor:inspector-sections:v1";

describe("editorPrefs — 섹션 열림 localStorage 영속 (R3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("저장이 없으면 기본값(전부 접힘)", () => {
    expect(loadSectionPrefs()).toEqual(DEFAULT_SECTION_PREFS);
  });

  it("save → load 라운드트립", () => {
    saveSectionPrefs({ ...DEFAULT_SECTION_PREFS, headers: true });
    expect(loadSectionPrefs()).toEqual({ ...DEFAULT_SECTION_PREFS, headers: true });
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it("malformed JSON이면 기본값 + 무throw (fail-soft)", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadSectionPrefs()).toEqual(DEFAULT_SECTION_PREFS);
  });

  it("비-boolean 값·미지 키는 기본값으로 강등", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ headers: "yes", junk: 1, body: true }));
    const p = loadSectionPrefs();
    expect(p.headers).toBe(false);
    expect(p.body).toBe(true);
    expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULT_SECTION_PREFS).sort());
  });
});
```

- [ ] **Step 2: 섹션 컴포넌트 실패 테스트** — `ui/src/components/scenario/__tests__/Inspector.sections.test.tsx` 신규:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

// 배지 fixture: 헤더 active 1 + disabled 1, JSON 바디, 타임아웃, think, 검증 1, 추출 1
const RICH_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
      headers:
        accept: "application/json"
      disabled:
        headers:
          x-debug: "1"
      body:
        json: { a: 1 }
    timeout_seconds: 30
    think_time: { min_ms: 100, max_ms: 200 }
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.token"
  - id: "01HX0000000000000000000002"
    name: "next"
    type: http
    request:
      method: GET
      url: "/next"
    assert:
      - status: 200
`;

const SECTION_TITLES = [
  ko.editor.headersLabel,
  ko.editor.bodyLabel,
  ko.editor.sectionTiming,
  ko.editor.assertionsLegend,
  ko.editor.extractsLegend,
];

function loadRich(selectId = "01HX0000000000000000000001") {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(RICH_YAML);
  useScenarioEditor.getState().select(selectId);
}

describe("InspectorSection — 접이식 섹션 (R1/R2/R3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadRich();
  });

  it("기본은 5개 섹션 전부 접힘 — 편집기 미렌더, 토글 버튼 aria-expanded=false (R1)", () => {
    render(<Inspector />);
    for (const title of SECTION_TITLES) {
      expect(screen.getByRole("button", { name: title })).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.queryByPlaceholderText("헤더 이름")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(ko.editor.fieldTimeout)).not.toBeInTheDocument();
    // 핵심(이름·메서드·URL)은 항상 노출
    expect(screen.getByLabelText(ko.editor.fieldName)).toBeInTheDocument();
    expect(screen.getByLabelText(ko.editor.urlLabel)).toBeInTheDocument();
  });

  it("접힌 섹션에 값이 있으면 힌트 배지 — 정확 매치 (R2)", () => {
    render(<Inspector />);
    const hintOf = (title: string) => {
      const btn = screen.getByRole("button", { name: title });
      return btn.closest("legend")!.textContent;
    };
    expect(hintOf(ko.editor.headersLabel)).toContain(ko.editor.sectionCountHint(2)); // active 1 + disabled 1
    expect(hintOf(ko.editor.bodyLabel)).toContain(ko.editor.bodyJson);
    expect(hintOf(ko.editor.sectionTiming)).toContain(ko.editor.sectionSetHint);
    expect(hintOf(ko.editor.assertionsLegend)).toContain(ko.editor.sectionCountHint(1));
    expect(hintOf(ko.editor.extractsLegend)).toContain(ko.editor.sectionCountHint(1));
  });

  it("값 없는 섹션엔 힌트 배지 없음 (R2)", () => {
    loadRich("01HX0000000000000000000002"); // 헤더/바디/타이밍/추출 없음, 검증 1
    render(<Inspector />);
    const legendOf = (title: string) =>
      screen.getByRole("button", { name: title }).closest("legend")!.textContent!;
    expect(legendOf(ko.editor.headersLabel)).not.toContain("개");
    expect(legendOf(ko.editor.bodyLabel)).not.toContain(ko.editor.bodyJson); // kind 배지 없음
    expect(legendOf(ko.editor.sectionTiming)).not.toContain(ko.editor.sectionSetHint);
  });

  it("펼치면 편집기 렌더 + localStorage 기록, 스텝 전환에도 열림 유지 (R3)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }));
    expect(screen.getByPlaceholderText("헤더 이름")).toBeInTheDocument();
    // 스텝 전환 — 섹션 종류별 전역 상태라 다른 스텝에서도 열려 있음
    useScenarioEditor.getState().select("01HX0000000000000000000002");
    expect(await screen.findByRole("button", { name: ko.editor.headersLabel })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("재마운트(페이지 재진입) 시 localStorage에서 복원 (R3)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    unmount();
    render(<Inspector />);
    expect(screen.getByRole("button", { name: ko.editor.extractsLegend })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("컨테이너(loop) 인스펙터는 섹션 버튼이 없다 (R4)", () => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(RICH_YAML);
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);
    for (const title of SECTION_TITLES) {
      expect(screen.queryByRole("button", { name: title })).not.toBeInTheDocument();
    }
  });
});
```

(주의: 배지-없음 단언의 `legendOf(bodyLabel)` 줄은 구현 후 실제 textContent에 맞춰 "제목만" 형태로 다듬는다 — 의도는 *배지 텍스트 부재*. caret `▸`는 `aria-hidden` span이라 버튼 accname엔 안 들어간다 — `getByRole("button", { name: title })` 정확 매치가 성립.)

- [ ] **Step 3: RED 확인** — `pnpm test editorPrefs` → 모듈 없음 FAIL; `pnpm test Inspector.sections` → FAIL.

- [ ] **Step 4: `editorPrefs.ts` 구현**:

```ts
/** 인스펙터 섹션 열림 상태의 localStorage 영속(R3). `onboarding/state.ts` 이디엄:
 *  localStorage 불가/오염 시 fail-soft(기본값·no-op) — 기능 저하는 "기본 접힘"뿐. */
export type SectionKey = "headers" | "body" | "timing" | "assert" | "extract";
export type SectionPrefs = Record<SectionKey, boolean>;

export const DEFAULT_SECTION_PREFS: SectionPrefs = {
  headers: false,
  body: false,
  timing: false,
  assert: false,
  extract: false,
};

const KEY = "handicap:editor:inspector-sections:v1";

export function loadSectionPrefs(): SectionPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_SECTION_PREFS };
    const parsed: unknown = JSON.parse(raw);
    const out = { ...DEFAULT_SECTION_PREFS };
    if (typeof parsed === "object" && parsed !== null) {
      for (const k of Object.keys(DEFAULT_SECTION_PREFS) as SectionKey[]) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === "boolean") out[k] = v;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SECTION_PREFS };
  }
}

export function saveSectionPrefs(prefs: SectionPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 메모리 상태만으로 동작)
  }
}
```

- [ ] **Step 5: ko.ts 키 추가** — `ko.editor`에 (`thinkHint` 근처):

```ts
sectionTiming: "타이밍",
sectionSetHint: "설정됨",
sectionCountHint: (n: number) => `${n}개`,
```

- [ ] **Step 6: `InspectorSection` + 재배치 구현** — `Inspector.tsx`:

① import 추가: `import { loadSectionPrefs, saveSectionPrefs, type SectionKey, type SectionPrefs } from "../../scenario/editorPrefs";`

② 모듈 레벨(Field 근처)에 disclosure 컴포넌트(ScenarioSnapshot 이디엄 + fieldset `min-w-0` — spec §4.1의 overflow 가드 필수):

```tsx
/** 접이식 인스펙터 섹션(R1). fieldset+legend-버튼 disclosure — RunDialog SLO/
 *  ScenarioSnapshot 이디엄. fieldset `min-w-0`은 canvas-fix overflow 가드(필수). */
function InspectorSection({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint: string | null;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600 flex items-center gap-1">
        <button type="button" onClick={onToggle} aria-expanded={open} className="hover:underline">
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
        </button>
        {!open && hint !== null && <span className="font-normal text-slate-400">{hint}</span>}
      </legend>
      {open && children}
    </fieldset>
  );
}
```

③ `Inspector()` 최상위(useMemo 위 아님 — 기존 훅들 위에 추가해도 무방, 순서 고정만 유지)에 상태 소유:

```tsx
const [sectionPrefs, setSectionPrefs] = useState<SectionPrefs>(loadSectionPrefs);
const toggleSection = (k: SectionKey) => {
  const next = { ...sectionPrefs, [k]: !sectionPrefs[k] };
  setSectionPrefs(next);
  saveSectionPrefs(next);
};
```

`HttpStepInspector`에만 prop으로 전달: `<HttpStepInspector step={step} sectionPrefs={sectionPrefs} onToggleSection={toggleSection} />` (loop/if/parallel 인스펙터 시그니처 무변경 — R4).

④ `HttpStepInspector({ step, sectionPrefs, onToggleSection })` 재배치 — 배지 파생 + JSX:

```tsx
const headerCount =
  Object.keys(step.request.headers ?? {}).length +
  Object.keys(step.request.disabled?.headers ?? {}).length;
const bodyKind: BodyKind = step.request.body?.kind ?? "none";
const bodyKindLabel: string | null =
  bodyKind === "none"
    ? null
    : bodyKind === "json"
      ? ko.editor.bodyJson
      : bodyKind === "form"
        ? ko.editor.bodyForm
        : ko.editor.bodyRaw;
const hasTiming = step.timeout_seconds !== undefined || step.think_time !== undefined;
```

JSX 골격(핵심은 유지·5섹션 래핑 — 타임아웃/think `Field`들과 `thinkHint` `<p>`는 "타이밍" 섹션 children으로 이동):

```tsx
return (
  <aside aria-label={ko.editor.inspectorAria} className="flex flex-col gap-4 text-sm">
    <header className="flex items-center justify-between">{/* 기존 그대로 */}</header>
    <StepNameField stepId={step.id} name={step.name} />
    <fieldset className="flex flex-col gap-2 min-w-0 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600">
        {ko.editor.requestLegend}
      </legend>
      {/* VarCheatSheet 행·메서드 Field·URL Field·빈 URL 경고 — 기존 그대로 (HeadersEditor/BodyEditor는 아래 섹션으로 이동) */}
    </fieldset>
    <InspectorSection
      title={ko.editor.headersLabel}
      hint={headerCount > 0 ? ko.editor.sectionCountHint(headerCount) : null}
      open={sectionPrefs.headers}
      onToggle={() => onToggleSection("headers")}
    >
      <HeadersEditor step={step} />
    </InspectorSection>
    <InspectorSection
      title={ko.editor.bodyLabel}
      hint={bodyKindLabel}
      open={sectionPrefs.body}
      onToggle={() => onToggleSection("body")}
    >
      <BodyEditor step={step} />
    </InspectorSection>
    <InspectorSection
      title={ko.editor.sectionTiming}
      hint={hasTiming ? ko.editor.sectionSetHint : null}
      open={sectionPrefs.timing}
      onToggle={() => onToggleSection("timing")}
    >
      {/* 기존 타임아웃 Field + think min/max Field + thinkHint <p> 그대로 이동 */}
    </InspectorSection>
    <InspectorSection
      title={ko.editor.assertionsLegend}
      hint={step.assert.length > 0 ? ko.editor.sectionCountHint(step.assert.length) : null}
      open={sectionPrefs.assert}
      onToggle={() => onToggleSection("assert")}
    >
      <AssertEditor step={step} setStepAssert={setStepAssert} />
    </InspectorSection>
    <InspectorSection
      title={ko.editor.extractsLegend}
      hint={step.extract.length > 0 ? ko.editor.sectionCountHint(step.extract.length) : null}
      open={sectionPrefs.extract}
      onToggle={() => onToggleSection("extract")}
    >
      <ExtractEditor step={step} />
    </InspectorSection>
  </aside>
);
```

⑤ **이중 크롬 제거**: `HeadersEditor`의 자체 라벨 `<div …>{ko.editor.headersLabel}</div>`(`:329`) 삭제(제목은 섹션이 소유). `AssertEditor`(`:517-520`)·`ExtractEditor`(`:662-668`)의 바깥 `<fieldset>`+`<legend>`를 `<div className="flex flex-col gap-2 min-w-0">`로 교체(legend 제거 — 제목·min-w-0은 InspectorSection fieldset이 승계, ExtractEditor의 `aria-label`도 제거). `BodyEditor`의 자체 라벨 `<div …>{ko.editor.bodyLabel}</div>`(`:378`) 삭제.

- [ ] **Step 7: 기존 테스트 갱신** — `pnpm test`(전체)를 돌려 깨진 테스트를 수정. 예상 표면은 `Inspector.test.tsx`(헤더/바디/타이밍/검증/추출 입력을 직접 집는 케이스들):
  - 각 케이스 선두에 펼침 추가: `await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }))` (섹션별 해당 타이틀).
  - `beforeEach`에 `window.localStorage.clear()` **필수 추가**(펼침 클릭이 localStorage에 남아 파일 내 뒤 테스트의 기본 접힘 전제를 깨는 누수 방지).
  - 헤더-shrinkable `min-w-0` 테스트(`:493-499`): 펼침 후 `getByPlaceholderText("헤더 이름").closest("fieldset")`은 이제 InspectorSection fieldset(min-w-0 보유)을 잡는다 — 단언이 그대로 성립하면 유지, 아니면 새 컨테이너 기준으로 재작성(spec §3-6).
  - `getByRole("group", { name: ko.editor.extractsLegend })`류가 있으면 InspectorSection fieldset(legend accname=제목)으로 그대로 매치 — 실패 시 within-스코프로 조정.
- [ ] **Step 8: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/scenario/editorPrefs.ts ui/src/scenario/__tests__/editorPrefs.test.ts ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/ ui/src/i18n/ko.ts
git commit -m "feat(ui): 인스펙터 접이식 섹션 5종 — 기본 접힘·N개 힌트·localStorage 영속 (R1–R4)"
```

---

### Task 3: EditorShell 와이드 토글 + 그리드 골격 (R5, R6 구조, R10)

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx`

**Interfaces:**
- Produces: `ko.editor.wideToggle = "스텝 넓게 보기"`, `ko.editor.wideToggleAria = "스텝 넓게 보기 전환"`. EditorShell 내부 `wideOpen` state — Task 5가 같은 파일에서 칩 스트립·모달을 이어 붙인다.
- Consumes: 기존 `FlowOutline`(prop 없이 — 와이드 셀 안에서도 아직 기본 렌더).

- [ ] **Step 1: 실패 테스트** — `EditorShell.test.tsx`에 추가 (기존 `vi.mock("../MonacoYamlView", …)`·store reset `beforeEach` 재사용):

```tsx
const WIDE_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
`;

describe("스텝 넓게 보기 토글 (R5/R10)", () => {
  it("ON: 인스펙터 열 미렌더 + 아웃라인 전폭 그리드, aria-pressed 토글", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={WIDE_YAML} />);
    const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText(ko.editor.inspectorAria)).toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText(ko.editor.inspectorAria)).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-grid").className).toContain("grid-cols-[210px_1fr]");
  });

  it("OFF 복귀: 기존 그리드 클래스 byte-identical", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={WIDE_YAML} />);
    const before = screen.getByTestId("editor-grid").className;
    const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.getByTestId("editor-grid").className).toBe(before);
  });

  it("재마운트 시 와이드 OFF (R10 — 마운트 수명)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<EditorShell initialYaml={WIDE_YAML} />);
    await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
    unmount();
    render(<EditorShell initialYaml={WIDE_YAML} />);
    expect(screen.getByRole("button", { name: ko.editor.wideToggleAria })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test EditorShell`. Expected: FAIL(`wideToggleAria` 키/버튼 없음).
- [ ] **Step 3: 구현** — ① ko.ts: `wideToggle: "스텝 넓게 보기"`, `wideToggleAria: "스텝 넓게 보기 전환"` (`varsToggle` 근처). ② `EditorShell.tsx`:

```tsx
const [wideOpen, setWideOpen] = useState(false);
```

툴바(YAML 버튼 뒤)에:

```tsx
<button
  type="button"
  aria-label={ko.editor.wideToggleAria}
  aria-pressed={wideOpen}
  onClick={() => setWideOpen((v) => !v)}
  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
>
  <span aria-hidden="true">⛶</span> {ko.editor.wideToggle}
</button>
```

그리드를 분기(비-와이드 가지는 기존 문자열 그대로 — byte-identical):

```tsx
<div
  data-testid="editor-grid"
  className={
    wideOpen
      ? `grid gap-4 ${varsOpen ? "grid-cols-[210px_1fr]" : "grid-cols-[1fr]"}`
      : `grid gap-4 min-h-[680px] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
  }
>
  {varsOpen && <aside {/* 기존 변수 패널 그대로 */}>…</aside>}
  {wideOpen ? (
    <div className="flex max-h-[calc(100vh-16rem)] min-h-0 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
      <div className="min-h-0 flex-1">
        <FlowOutline />
      </div>
    </div>
  ) : (
    <>
      <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto">
        <FlowOutline />
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <Inspector />
      </div>
    </>
  )}
</div>
```

핵심 제약(spec §4.3, 리뷰어 finding 5): 와이드 셀은 **`overflow-auto` 없음**(스크롤은 FlowOutline 내부 `flex-1 overflow-auto`가 소유 — add-버튼 하단 고정 유지), `min-h-[680px]`는 와이드 가지에서 제외, `max-h-[calc(100vh-16rem)]`의 `16rem` 오프셋은 Task 7 라이브 실측에서 조정.

- [ ] **Step 4: GREEN + 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 스텝 넓게 보기 토글 + 전폭 그리드 골격 — 뷰포트 고정·마운트 수명 (R5/R6/R10)"
```

---

### Task 4: FlowOutline `wide` prop — 행 칩·활성화 훅·data-step-id (R9, R8 전제, R11)

**Files:**
- Modify: `ui/src/components/scenario/FlowOutline.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

**Interfaces:**
- Produces: `FlowOutline({ wide?: boolean; onActivateStep?: (id: string) => void })` — Task 5의 EditorShell이 소비. `ko.editor.wideChipAssert: (n: number) => string`(`` `검증 ${n}` ``), `wideChipExtract: (n: number) => string`(`` `추출 ${n}` ``), `wideChipThink: (min: number, max: number) => string`(`` `think ${min}–${max}ms` ``).
- Consumes: 없음(자기 완결).

- [ ] **Step 1: 실패 테스트** — `FlowOutline.test.tsx`에 추가(파일의 기존 store-시드 헬퍼/YAML 컨벤션 재사용; 아래 fixture는 Task 2의 `RICH_YAML`과 동형 — 검증 1·추출 1(`token`)·think 100–200):

```tsx
// (파일 상단 import에 fireEvent·within·vi가 없으면 추가)
const RICH_ROW_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    think_time: { min_ms: 100, max_ms: 200 }
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.token"
`;

function seedRich() {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(RICH_ROW_YAML);
}

describe("wide 모드 행 (R9) + 활성화 훅 (R8 전제)", () => {
  it("wide: http 행에 부가 칩 + data-step-id", () => {
    seedRich();
    render(<FlowOutline wide />);
    const row = screen.getByRole("option", { name: ko.editor.outlineRowAria("login") });
    expect(row).toHaveAttribute("data-step-id", "01HX0000000000000000000001");
    expect(within(row).getByText(ko.editor.wideChipAssert(1))).toBeInTheDocument();
    expect(within(row).getByText(ko.editor.wideChipExtract(1))).toHaveAttribute("title", "token");
    expect(within(row).getByText(ko.editor.wideChipThink(100, 200))).toBeInTheDocument();
  });

  it("비-wide: 칩·data-step-id 부재 (byte-identical, R9)", () => {
    seedRich();
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: ko.editor.outlineRowAria("login") });
    expect(row).not.toHaveAttribute("data-step-id");
    expect(within(row).queryByText(ko.editor.wideChipAssert(1))).not.toBeInTheDocument();
  });

  it("행 클릭/Enter/Space는 onActivateStep 호출, 드래그 핸들 클릭은 select만", async () => {
    seedRich();
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<FlowOutline wide onActivateStep={onActivate} />);
    const row = screen.getByRole("option", { name: ko.editor.outlineRowAria("login") });
    await user.click(row);
    expect(onActivate).toHaveBeenCalledWith("01HX0000000000000000000001");
    onActivate.mockClear();
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
    onActivate.mockClear();
    await user.click(screen.getByRole("button", { name: ko.editor.dragHandleAria("login") }));
    expect(onActivate).not.toHaveBeenCalled(); // 핸들 무이동 클릭은 모달 활성화 제외
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001"); // select는 유지
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test FlowOutline`. Expected: FAIL(`wide` prop 없음/칩 부재).
- [ ] **Step 3: 구현** — ① ko.ts 3키 추가. ② `FlowOutline.tsx`:

시그니처·view 컨텍스트(파일 상단 타입 + FlowOutline):

```tsx
type RowView = { wide: boolean; onActivate?: (id: string) => void };

export function FlowOutline({
  wide = false,
  onActivateStep,
}: {
  wide?: boolean;
  onActivateStep?: (id: string) => void;
} = {}) {
  // …기존 본문…
  const view = useMemo<RowView>(
    () => ({ wide, onActivate: onActivateStep }),
    [wide, onActivateStep],
  );
```

`OutlineRow` props에 `view?: RowView` 추가 — 루트 렌더(`:589`)와 `ContainerBands` `renderGroup` 내부(`:337`) **두 곳** 모두 `view={view}`/`view={view0}` 전달(renderGroup은 OutlineRow 안이므로 자신의 `view` prop을 그대로 내림). `rowAria` 수정:

```tsx
const activate = (target: EventTarget) => {
  // 드래그 핸들(행 안의 유일한 <button>) 경유 활성화 제외 — select만(spec §4.4)
  if (!(target as HTMLElement).closest("button")) view?.onActivate?.(step.id);
};
const rowAria = {
  role: "option" as const,
  "aria-selected": selected,
  "aria-label": ko.editor.outlineRowAria(step.name),
  tabIndex: 0,
  "data-depth": String(depth),
  ...(view?.wide ? { "data-step-id": step.id } : {}),
  onClick: (e: React.MouseEvent) => {
    select(step.id);
    activate(e.target);
  },
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(step.id);
      activate(e.target);
    }
  },
};
```

`RowContent` 확장(http 분기 끝, `urlMissing` 앞이 아니라 **fragment 마지막**에 — `ml-auto`로 우측 정렬):

```tsx
function RowContent({ step, wide = false }: { step: Step; wide?: boolean }) {
  // …기존 분기 그대로, http 분기 return의 마지막 자식으로:
  {wide && (step.assert.length > 0 || step.extract.length > 0 || step.think_time !== undefined) && (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {step.assert.length > 0 && (
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
          {ko.editor.wideChipAssert(step.assert.length)}
        </span>
      )}
      {step.extract.length > 0 && (
        <span
          title={step.extract.map((x) => x.var).join(", ")}
          className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600"
        >
          {ko.editor.wideChipExtract(step.extract.length)}
        </span>
      )}
      {step.think_time !== undefined && (
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
          {ko.editor.wideChipThink(step.think_time.min_ms, step.think_time.max_ms)}
        </span>
      )}
    </span>
  )}
```

`RowContent` 호출부: `OutlineRow` 2곳은 `<RowContent step={step} wide={view?.wide ?? false} />`, **`OutlineRowPreview`는 `<RowContent step={step} />` 그대로**(오버레이 칩 미렌더 — spec §4.4).

- [ ] **Step 4: GREEN + R11/R14 확인 + 커밋** — `pnpm test FlowOutline` PASS + 기존 FlowOutline 테스트 무수정 green. `git diff --stat`에 `reorder.ts`/`dropRules.ts` 없음 확인.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): FlowOutline wide prop — 행 부가 칩·활성화 훅·data-step-id (R9, 비-와이드 byte-identical)"
```

---

### Task 5: 와이드 칩 스트립 + 점프 + 편집 모달 + blur-flush (R7, R8)

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `FlowOutline wide onActivateStep`, 기존 `TestFlowChips`(props: `steps`/`trace`/`selectedStepId`/`onSelect` — **`trace={null}` 명시 필수, required prop**), 기존 `Modal`(`open`/`onClose`/`title`), 기존 `Inspector`.
- Produces: `ko.editor.wideFlowStripAria = "스텝 흐름 (넓게 보기)"`, `ko.editor.stepDetailModalTitle = "스텝 편집"`.

- [ ] **Step 1: 실패 테스트** — `EditorShell.test.tsx`에 추가(타임아웃 blur-flush 검증 위해 스텝은 `timeout_seconds` 없이 시작):

```tsx
const WIDE_YAML2 = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000002"
    name: "next"
    type: http
    request:
      method: GET
      url: "/next"
    assert:
      - status: 200
`;

describe("와이드 칩 스트립·점프·편집 모달 (R7/R8)", () => {
  async function renderWide() {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={WIDE_YAML2} />);
    await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
    return user;
  }
  const rowOf = (name: string) =>
    screen.getByRole("option", { name: ko.editor.outlineRowAria(name) });

  it("칩 스트립은 구분 wrapper region 안에 렌더 (R7 — 이중 role=group 회피)", async () => {
    await renderWide();
    const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
    expect(within(strip).getByText("login")).toBeInTheDocument();
  });

  it("칩 클릭 = 선택만, 모달 미오픈 (R7)", async () => {
    const user = await renderWide();
    const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
    await user.click(within(strip).getByRole("button", { name: /next/ }));
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000002");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("행 활성화 → 편집 모달(Inspector 재사용), 닫기 후 선택 유지 (R8)", async () => {
    const user = await renderWide();
    await user.click(rowOf("login"));
    const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
    expect(within(dialog).getByLabelText(ko.editor.inspectorAria)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
  });

  it("모달 내 삭제 → 모달 닫힘, 이후 칩 클릭이 모달을 재오픈하지 않는다 (R8 상태머신)", async () => {
    const user = await renderWide();
    await user.click(rowOf("login"));
    const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.delete }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
    await user.click(within(strip).getByRole("button", { name: /next/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // detailOpen 리셋 ②
  });

  it("와이드 재토글이 모달을 재오픈하지 않는다 (R8 리셋 ③)", async () => {
    const user = await renderWide();
    await user.click(rowOf("login"));
    expect(screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
    await user.click(toggle); // OFF — 모달 게이트로 언마운트
    await user.click(toggle); // ON
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("draft 타이핑 후 ESC 닫기 → blur-flush로 store 커밋 (R8)", async () => {
    const user = await renderWide();
    await user.click(rowOf("login"));
    const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.editor.sectionTiming }));
    await user.type(within(dialog).getByLabelText(ko.editor.fieldTimeout), "30");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useScenarioEditor.getState().model?.steps[0]).toMatchObject({ timeout_seconds: 30 });
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test EditorShell`. Expected: 신규 describe 전부 FAIL.
- [ ] **Step 3: 구현** — ① ko.ts 2키 추가. ② `EditorShell.tsx`:

import 추가: `TestFlowChips`, `Inspector`는 기존 import 유지, `Step` 타입 + store 셀렉터:

```tsx
import { TestFlowChips } from "./TestFlowChips";
import type { Step } from "../../scenario/model";

const EMPTY_STEPS: Step[] = []; // 셀렉터 안정 참조 — 인라인 `?? []` 금지(getSnapshot 함정)
```

컴포넌트 본문:

```tsx
const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
const select = useScenarioEditor((s) => s.select);
const [detailOpen, setDetailOpen] = useState(false);

// R8 리셋 ②: 선택 해제(모달 내 삭제 포함 — removeStep이 선택을 먼저 clear) 시 닫힘.
// 이 리셋이 없으면 stale detailOpen=true가 다음 칩 점프에서 모달을 재오픈한다.
useEffect(() => {
  if (selectedStepId === null) setDetailOpen(false);
}, [selectedStepId]);

// R8 리셋 ①+blur-flush: ESC는 blur 없이 Inspector를 언마운트해 onBlur-커밋 draft
// (타임아웃/think/JSON 바디/추출/조건)를 버린다 — 동기 blur로 커밋을 flush 후 닫기.
const closeDetail = () => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  setDetailOpen(false);
};

const jumpToStep = (id: string) => {
  select(id);
  // jsdom은 scrollIntoView 미구현 — 옵셔널 호출. block:nearest = 중첩 스크롤에서 페이지 이동 최소화.
  document
    .querySelector(`[data-step-id="${id}"]`)
    ?.scrollIntoView?.({ block: "nearest" });
};
```

와이드 토글 onClick을 R8 리셋 ③ 포함으로 교체:

```tsx
onClick={() => {
  setWideOpen((v) => !v);
  setDetailOpen(false); // 와이드 전환(양방향) 시 모달 상태 초기화 (R8 ③)
}}
```

와이드 셀(Task 3 골격)에 칩 스트립 + FlowOutline props:

```tsx
<div className="flex max-h-[calc(100vh-16rem)] min-h-0 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
  <section aria-label={ko.editor.wideFlowStripAria} className="shrink-0">
    <TestFlowChips
      steps={steps}
      trace={null}
      selectedStepId={selectedStepId}
      onSelect={jumpToStep}
    />
  </section>
  <div className="min-h-0 flex-1">
    <FlowOutline wide onActivateStep={() => setDetailOpen(true)} />
  </div>
</div>
```

그리드 아래(YAML Modal 형제로) 편집 모달:

```tsx
<Modal
  open={wideOpen && detailOpen && selectedStepId !== null}
  onClose={closeDetail}
  title={ko.editor.stepDetailModalTitle}
>
  <Inspector />
</Modal>
```

- [ ] **Step 4: GREEN + 전체 게이트 + 커밋** — 페이지-레벨 테스트(`ScenarioNewPage` 등)는 와이드 기본 OFF라 무영향이어야 함(전체 `pnpm test`로 확인).

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol/ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 와이드 흐름 칩 점프 + 스텝 편집 모달 — detailOpen 리셋 3지점·blur-flush (R7/R8)"
```

---

### Task 6: ko 하드코딩 sweep + roadmap 등재 (R15, R16)

**Files:**
- Modify: `docs/roadmap.md`
- 검증만: `ui/src/components/scenario/*.tsx`

- [ ] **Step 1: 하드코딩 sweep (R15)** — 이 슬라이스가 만진 파일 한정 2종 grep(둘 다 0건이어야; 기존 카탈로그 경유 문자열·주석은 제외 판단):

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol
git diff master --name-only -- 'ui/src/components/**/*.tsx' | while read -r f; do
  echo "== $f"
  grep -nE '"[^"]*[가-힣]' "$f" | grep -v "ko\." || true
  grep -nE '(aria-label|title)=\{[^}]*"[A-Za-z]' "$f" || true
done
```

주의: `Modal.tsx`의 `aria-label="닫기"`는 pre-existing(이 슬라이스 무접촉) — 발견돼도 스코프 밖.

- [ ] **Step 2: roadmap 등재 (R16)** — `docs/roadmap.md`에 미채택 도그푸딩 항목 5건 등재. **초장문 라인 Edit 금지** — Python 스플라이스(`s.index(anchor)` + `assert count==1`, 앵커 실바이트는 `repr`로 확인 — 루트 CLAUDE.md 규칙). §A 말미(또는 기존 에디터/데이터셋 절)에 새 소절로 추가할 텍스트:

```markdown
### §A12 도그푸딩 백로그 (2026-07-03, editor-space-qol 슬라이스에서 미채택 보존)

- **변수명 충돌 감지**: 추출(extract) 변수명 ↔ 수동 설정 변수명(variables/데이터셋 바인딩) 충돌을 에디터에서 경고. UI-only 소형.
- **Think Time 일괄 지정**: 시나리오-레벨 기본 think time + 스텝별 override(전체 무시 설정 포함). 엔진 serde+와이어+UI 수직 슬라이스 — Opus path-gate·live-verify RPS 검증 필요.
- **HAR 가져오기 host-환경 힌트**: 감지된 host가 기존 환경(environments)에 등록돼 있으면 어느 세트에 있는지 안내(비차단 — 다른 이름 저장 허용). UI-only 소형.
- **데이터셋 미리보기**: 저장된 데이터셋 행 미리보기(페이징 — 대용량 대비). 컨트롤러 rows API + UI.
- **에디터 데이터셋 test-run**: 에디터 test-run에서 데이터셋 사용 — 원하는 1행 선택 주입 / 1VU 순차 진행(전체 또는 N행 검증). test-run 경로(엔진/컨트롤러)+UI 중형.
```

- [ ] **Step 3: 확인 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-space-qol && git diff --stat docs/roadmap.md
git add docs/roadmap.md && git commit -m "docs(roadmap): 도그푸딩 미채택 항목 5건 등재 — 변수충돌·think일괄·HAR힌트·데이터셋 미리보기/test-run (R16)"
```

---

### Task 7: Playwright 라이브 시각 실측 (spec §6 — DOM-존재 PASS 금지)

> orchestrator가 직접 수행(subagent 아님). 백엔드 불필요 — `/scenarios/new`는 클라이언트-only. `docs/dev/live-verify-playwright.md`의 MCP 함정(스크린샷 cwd·업로드 루트) 참조.

**Files:** 없음(검증만; `max-h` 오프셋 조정 시 `EditorShell.tsx` 소폭 수정 허용 — 수정하면 전체 게이트 재실행 후 fix 커밋).

- [ ] **Step 1: vite dev 기동** — `lsof -i :5173`으로 선점 확인(다른 워크트리 프로세스면 kill), `cd ui && pnpm dev` background. **navigate는 `localhost:5173`**(vite는 IPv6 `[::1]` 바인드 — `127.0.0.1` 금지).
- [ ] **Step 2: 시나리오 구성** — `/scenarios/new` → 템플릿 선택 → 스텝 디테일에서 이름/URL fill(React controlled — Playwright fill이 onChange 발화) + `+ HTTP 스텝`으로 스텝 6개 이상(내부 스크롤 유발), 헤더/검증/추출 몇 개 설정(칩 확인용).
- [ ] **Step 3: 섹션 실측 (R1/R2/R3)** — ① 기본 접힘 스크린샷, ② 헤더 펼침 → `browser_evaluate`로 `localStorage.getItem("handicap:editor:inspector-sections:v1")`에 `"headers":true` 확인, ③ **페이지 새로고침 후 헤더가 여전히 펼침**(영속 실측).
- [ ] **Step 4: 와이드 실측 (R5/R6)** — 토글 전/후 아웃라인 컨테이너 `getBoundingClientRect().width` 비교(≥1.5× 확장), ON에서 목록 요소 `scrollHeight > clientHeight` && `document.documentElement.scrollHeight` 토글 전후 비증가(페이지 스크롤 불변). 오프셋(`16rem`)이 화면에서 어긋나면 조정 후 재실측.
- [ ] **Step 5: 칩 점프 + 모달 실측 (R7/R8)** — 마지막 스텝 칩 클릭 → 스크롤 컨테이너 `scrollTop` 변화 실측 + 모달 안 뜸; 행 클릭 → 모달 `getBoundingClientRect().height > 300` + 섹션 disclosure 동작; ESC 닫기 → 재편집 정상.
- [ ] **Step 6: 드래그 1회 (R11)** — 와이드 모드에서 `browser_drag`(핸들 행→타깃 행)로 순서 변경 → YAML 모달에서 순서 반영 확인.
- [ ] **Step 7: 콘솔 확인** — `browser_console_messages` 에러 0(단 cross-session 버퍼 주의 — 이 세션 발화분만 판정). 결과를 세션 노트로 기록(finish-slice의 build-log 입력).

---

## 최종 확인 (모든 task 후)

- [ ] `git log --oneline master..HEAD` — task별 독립 커밋 + spec/plan 커밋 확인.
- [ ] `git diff master --stat` — `crates/` 0건, `ui/src/scenario/model.ts`·`yamlDoc.ts`·`store.ts`·`reorder.ts`·`dropRules.ts` 0건 (R14; store.ts는 읽기만이라 diff 없음이 정상).
- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` 전체 green 1회 더(targeted-green ≠ full-green).
- [ ] 이후 `handicap-reviewer` 최종 리뷰(와이어 1:1은 N/A — UI-only지만 repo-trap 크로스커팅 확인) → `/finish-slice`.
