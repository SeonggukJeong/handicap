# 시나리오 공유 메모(notes) Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 YAML에 운반-전용 `notes` 필드를 추가하고, 수정 페이지 에디터 최상단에 accent Callout으로 표출/접기/그 자리 편집 + 2MiB 저장 사전 가드를 붙인다.

**Architecture:** 엔진 `Scenario`에 optional 필드 1개(실행 경로 0-diff, 컨트롤러·proto·migration 0-diff) → UI Zod 모델·yamlDoc `setNotes` edit·store 액션 → 신규 `ScenarioNotesCallout` 4상태 컴포넌트를 `EditorShell` 최상단에 배선 → API 클라이언트 시나리오 저장 래퍼에 2MiB 사전 가드.

**Tech Stack:** Rust(serde_yaml 계열, 기존 `Scenario::from_yaml`/`to_yaml`), TypeScript/React(Zod·Zustand·yaml Document API·RTL/vitest·Tailwind).

**Spec:** `docs/superpowers/specs/2026-07-24-scenario-notes-design.md` (US1~4 + R1~R8 — task-brief에 US 블록 첨부는 orchestrator 담당)

## Global Constraints

- **색상**: 메모 Callout은 기존 `Callout` `info` 변형(accent)만 — amber 금지(검증 경고와 충돌, spec 결정 표).
- **문구**: 신규 문구 전부 `ko.ts` 신설 `scenarioNotes` 섹션 경유 — aria-label 포함(ADR-0035). 카피는 아래 표 verbatim.
- **문구 충돌**: `"공유 메모"`는 기존 ko.ts에 0매치(2026-07-24 `grep -n "공유 메모" ui/src/i18n/ko.ts` 실측 — 재검증하려면 재실행). `접기/펼치기/편집/완료/취소`는 기존 카탈로그에 흔함 → **RTL 단언은 반드시 aria-label 정확 매치**(`getByRole("button", { name: ko.scenarioNotes.…Aria })`), 가시 라벨 문자열 단독 조회 금지.
- **WCAG Label-in-Name**: aria-label은 `"공유 메모 " + 가시 라벨` 형태(가시 텍스트 포함 필수 — think-time-dashboard 선례).
- **2MiB** = `2 * 1024 * 1024` bytes, `>=`에서 차단(서버 초과 기준 `>`과 같거나 엄격 — spec R6).
- **notes는 운반-전용**: runner/trace/template 어디에도 읽는 코드를 추가하지 않는다.
- **멀티라인 직렬화**: yamlDoc `setNotes`는 raw `doc.setIn(["notes"], value)` — `plainScalar()` 금지(PLAIN 강제는 멀티라인을 못 담는다, yamlDoc.ts:622–626).
- **tdd-guard**: 각 task의 **첫 스텝 = 테스트 파일 생성**(직전 커밋 후 clean tree에서 production 편집이 차단되는 훅 — `.claude/hooks/tdd-guard.sh`).
- **RED 실증**: 각 task에 "expect FAIL" 스텝 포함 — 회귀 가드 이빨 증명([[plan-mandated-vacuous-tests]]). 단언은 단일 조건·정확 매치 위주로 작성됨.
- **git**: `git commit … | tail` 등 파이프 금지, `--no-verify` 금지. Task 1 커밋은 cargo 전체 게이트(수 분) — FOREGROUND 단일 호출(timeout 600000ms).

### ko.ts 카피 표 (verbatim — Task 3·4에서 사용)

| key | 값 |
|---|---|
| `title` | `공유 메모` |
| `addLine` | `＋ 공유 메모 추가 — 팀원에게 전할 주의점을 남겨두세요` |
| `addAria` | `공유 메모 추가` |
| `collapse` / `collapseAria` | `접기` / `공유 메모 접기` |
| `expand` / `expandAria` | `펼치기` / `공유 메모 펼치기` |
| `edit` / `editAria` | `편집` / `공유 메모 편집` |
| `done` / `doneAria` | `완료` / `공유 메모 편집 완료` |
| `cancel` / `cancelAria` | `취소` / `공유 메모 편집 취소` |
| `textareaAria` | `공유 메모 내용` |
| `sizeLimitError(mb)` | `` `시나리오가 저장 한도(2MB)를 초과했습니다 (현재 ${mb}MB) — 공유 메모나 스텝 수를 줄여주세요.` `` |

---

### Task 1: 엔진 `notes` 운반-전용 필드

**Files:**
- Create: `crates/engine/tests/notes_roundtrip.rs`
- Modify: `crates/engine/src/scenario.rs:26–28` (`default_think_time` 필드 뒤)
- Modify: `crates/engine/tests/proptests.rs:235` 부근 (필드 열거 `Scenario { … }` 리터럴 — 레포 유일)

**Interfaces:**
- Consumes: `Scenario::from_yaml(&str) -> Result<Self>` (scenario.rs:558) · `to_yaml(&self) -> Result<String>` (scenario.rs:562)
- Produces: `Scenario.notes: Option<String>` — 이후 task는 엔진에 의존하지 않음(UI는 자체 Zod 모델)

- [ ] **Step 1: 실패 테스트 작성** — `crates/engine/tests/notes_roundtrip.rs` 생성

```rust
//! scenario `notes` — 운반-전용 필드 라운드트립 (spec R1/R7).
use handicap_engine::scenario::Scenario;

const BASE_NO_NOTES: &str = "version: 1\nname: base\nsteps: []\n";

#[test]
fn absent_notes_roundtrip_stays_absent() {
    let s = Scenario::from_yaml(BASE_NO_NOTES).expect("parses");
    assert_eq!(s.notes, None);
    let out = s.to_yaml().expect("serializes");
    assert!(
        !out.contains("notes"),
        "notes 미사용 시나리오 직렬화에 notes 키 등장: {out}"
    );
    assert_eq!(Scenario::from_yaml(&out).expect("reparses").notes, None);
}

#[test]
fn multiline_notes_roundtrip_preserved() {
    let yaml = "version: 1\nname: base\nnotes: |-\n  운영 환경 금지.\n  BASE_URL 필수.\nsteps: []\n";
    let s = Scenario::from_yaml(yaml).expect("parses");
    assert_eq!(s.notes.as_deref(), Some("운영 환경 금지.\nBASE_URL 필수."));
    let out = s.to_yaml().expect("serializes");
    let s2 = Scenario::from_yaml(&out).expect("reparses");
    assert_eq!(s2.notes, s.notes, "notes 값이 라운드트립에서 보존되어야 한다");
}

#[test]
fn unknown_top_level_key_still_denied() {
    let yaml = "version: 1\nname: base\nbogus: 1\nsteps: []\n";
    assert!(
        Scenario::from_yaml(yaml).is_err(),
        "deny_unknown_fields 회귀 가드"
    );
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-engine --test notes_roundtrip`
Expected: **컴파일 실패** — `no field `notes` on type` (필드 미존재 = RED)

- [ ] **Step 3: `Scenario`에 필드 추가** — `crates/engine/src/scenario.rs`, `default_think_time` 필드(line 27) 바로 뒤·`steps` 앞

```rust
    /// 팀 공유용 메모(2026-07-24 scenario-notes). 운반-전용 — 실행 경로(runner/trace/
    /// 템플릿)는 이 값을 읽지 않는다. 없으면 직렬화 생략(기존 YAML byte-identical).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
```

- [ ] **Step 4: proptests 리터럴 수정** — `crates/engine/tests/proptests.rs:235` 부근 `prop_map` 클로저의 `Scenario { … }`에 한 줄 추가

```rust
        .prop_map(|(name, cookie_jar, variables, steps)| Scenario {
            version: 1,
            name,
            cookie_jar,
            default_think_time: None,
            notes: None,
            variables,
            steps,
        })
```

- [ ] **Step 5: GREEN 확인**

Run: `cargo test -p handicap-engine --test notes_roundtrip ; echo exit=$?`
Expected: `3 passed` · `exit=0`
Run: `cargo test -p handicap-engine --test proptests ; echo exit=$?`
Expected: pass · `exit=0`

- [ ] **Step 6: 워크스페이스 게이트 사전 확인**

Run: `cargo fmt && cargo clippy -p handicap-engine --all-targets -- -D warnings ; echo exit=$?`
Expected: `exit=0` (경고 0)

- [ ] **Step 7: Commit** (cargo 전체 게이트 — 수 분, FOREGROUND timeout 600000ms)

```bash
git add crates/engine/src/scenario.rs crates/engine/tests/notes_roundtrip.rs crates/engine/tests/proptests.rs
git commit -m "feat(engine): scenario notes 운반-전용 필드 — 라운드트립 3종 (scenario-notes T1)"
```

커밋 후 `git log -1`로 landed 확인.

---

### Task 2: UI 모델·yamlDoc·store — `setNotes`

**Files:**
- Create: `ui/src/scenario/__tests__/notes.test.ts`
- Modify: `ui/src/scenario/model.ts:400–408` (`ScenarioModel` — `default_think_time` 뒤)
- Modify: `ui/src/scenario/yamlDoc.ts:31–34` (Edit union) · `:148–157` 뒤 (applyEdit case)
- Modify: `ui/src/scenario/store.ts:55` 근처(인터페이스) · `:163–165` 뒤(구현) · `:472` 근처(actions 맵)

**Interfaces:**
- Consumes: `dispatch(set, get, edit)` 기존 경로, `parseScenarioDoc`/`serializeDoc` (변경 없음)
- Produces: `useScenarioEditor.getState().setNotes(value: string | undefined): void` · `model.notes?: string` · Edit variant `{ type: "setNotes"; value: string | undefined }` — Task 3가 사용

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/scenario/__tests__/notes.test.ts` 생성

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useScenarioEditor } from "../store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

const BASE = 'version: 1\nname: "노트 테스트"\nsteps: []\n';

describe("setNotes (spec R1/R4/R8)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(BASE);
  });

  it("메모 설정 → yamlText·model 반영 + 라운드트립 보존", () => {
    useScenarioEditor.getState().setNotes("운영 환경 금지.\nBASE_URL 필수.");
    const { yamlText, model } = useScenarioEditor.getState();
    expect(model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
    expect(yamlText).toContain("notes:");
    useScenarioEditor.getState().loadFromString(yamlText);
    expect(useScenarioEditor.getState().model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
  });

  it("undefined 커밋 → notes 키 삭제", () => {
    useScenarioEditor.getState().setNotes("지울 메모");
    useScenarioEditor.getState().setNotes(undefined);
    const { yamlText, model } = useScenarioEditor.getState();
    expect(model?.notes).toBeUndefined();
    expect(yamlText).not.toContain("notes");
  });

  it("notes 없는 시나리오 직렬화에 notes 키 미등장", () => {
    expect(useScenarioEditor.getState().yamlText).not.toContain("notes");
  });

  it('YAML 유래 notes: "" 는 모델에 빈 문자열로 남는다(렌더 술어가 처리)', () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: x\nnotes: ""\nsteps: []\n');
    expect(useScenarioEditor.getState().model?.notes).toBe("");
  });

  it("yamlError 동안 setNotes는 no-op(무음 유실 가드의 전제)", () => {
    useScenarioEditor.getState().setNotes("보존될 메모");
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const afterErr = useScenarioEditor.getState().yamlText;
    useScenarioEditor.getState().setNotes("삼켜질 메모");
    expect(useScenarioEditor.getState().yamlText).toBe(afterErr);
    expect(useScenarioEditor.getState().model?.notes).toBe("보존될 메모");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test src/scenario/__tests__/notes.test.ts ; echo exit=$?`
Expected: FAIL — `setNotes is not a function` (5건 전부 실패) · `exit=1`

- [ ] **Step 3: Zod 모델** — `ui/src/scenario/model.ts` `ScenarioModel`의 `default_think_time` 줄 뒤에 추가

```ts
    default_think_time: ThinkTimeModel.optional(),
    notes: z.string().optional(),
    steps: z.array(StepModel).default([]),
```

- [ ] **Step 4: yamlDoc Edit union + applyEdit** — `ui/src/scenario/yamlDoc.ts`

union(`setDefaultThinkTime` variant 뒤):

```ts
  | { type: "setDefaultThinkTime"; value: ThinkTime | undefined }
  | { type: "setNotes"; value: string | undefined }
```

`applyEdit`(`setDefaultThinkTime` case의 `return;` 뒤):

```ts
    case "setNotes":
      if (edit.value === undefined) {
        doc.deleteIn(["notes"]);
      } else {
        // plainScalar 금지 — PLAIN 강제는 멀티라인을 못 담는다. raw setIn이 setVariable
        // 이디엄이고, 멀티라인은 yaml 라이브러리가 block scalar로 직렬화한다.
        doc.setIn(["notes"], edit.value);
      }
      return;
```

- [ ] **Step 5: store 액션** — `ui/src/scenario/store.ts` 세 곳

인터페이스(`setDefaultThinkTime` 선언 뒤):

```ts
  /** 공유 메모(운반-전용 notes). undefined → 키 제거. */
  setNotes(value: string | undefined): void;
```

구현(`setDefaultThinkTime` 구현 뒤):

```ts
  setNotes(value) {
    dispatch(set, get, { type: "setNotes", value });
  },
```

actions 맵(`setDefaultThinkTime: s.setDefaultThinkTime,` 줄 뒤):

```ts
    setNotes: s.setNotes,
```

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test src/scenario/__tests__/notes.test.ts ; echo exit=$?`
Expected: 5 passed · `exit=0`

- [ ] **Step 7: UI 게이트 사전 확인**

Run: `cd ui && pnpm lint ; echo exit=$?` → `exit=0`
Run: `cd ui && pnpm build ; echo exit=$?` → `exit=0` (`tsc -b`가 Edit union exhaustive switch를 검증)

- [ ] **Step 8: Commit** (UI 게이트 — lint+test+build)

```bash
git add ui/src/scenario/__tests__/notes.test.ts ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts
git commit -m "feat(ui): 시나리오 모델·yamlDoc·store에 setNotes — 삭제=키 제거·멀티라인 보존 (scenario-notes T2)"
```

---

### Task 3: `ScenarioNotesCallout` 4상태 컴포넌트 + EditorShell 배선 + ko.ts

**Files:**
- Create: `ui/src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx`
- Create: `ui/src/scenario/notesPrefs.ts`
- Create: `ui/src/components/scenario/ScenarioNotesCallout.tsx`
- Modify: `ui/src/i18n/ko.ts:418` 직전 (top-level `scenarioNotes` 섹션 신설 — `editor: {` 앞)
- Modify: `ui/src/components/scenario/EditorShell.tsx` (import + return 최상단 `<ScenarioNotesCallout />`)

**Interfaces:**
- Consumes: Task 2의 `setNotes`·`model.notes` · `Callout`(`ui/src/components/ui/Callout.tsx`, `info` 변형·`role`/`aria-label` props) · `Textarea`(forwardRef) · `useParams`(`react-router-dom` — ScenarioEditPage.tsx:2와 동일 소스)
- Produces: `ScenarioNotesCallout`(props 없음) · `loadNotesCollapsed(): Record<string, true>` · `setNotesCollapsed(id: string, collapsed: boolean): void` · `ko.scenarioNotes.*` (Task 4가 이 섹션에 키 추가)

**주의:** `useParams`는 Router 밖에서 throw하지 않고 `{}`를 반환한다(RouteContext 기본값) — 기존 `EditorShell.test.tsx`의 라우터 없는 render들이 그대로 green이어야 하며, Step 7에서 이를 실측한다.

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx` 생성

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ScenarioNotesCallout } from "../ScenarioNotesCallout";
import { EditorShell } from "../EditorShell";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

const WITH_NOTES =
  'version: 1\nname: "메모 시나리오"\nnotes: |-\n  운영 환경 금지.\n  BASE_URL 필수.\nsteps: []\n';
const NO_NOTES = 'version: 1\nname: "메모 없음"\nsteps: []\n';

/** /scenarios/:id 마운트 재현 — 접힘 영속(localStorage) 경로용 */
function renderWithId(id = "SC1") {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${id}`]}>
      <Routes>
        <Route path="/scenarios/:id" element={<ScenarioNotesCallout />} />
      </Routes>
    </MemoryRouter>,
  );
}

const note = () => screen.getByRole("note", { name: ko.scenarioNotes.title });

describe("ScenarioNotesCallout", () => {
  beforeEach(() => {
    reset();
    window.localStorage.clear();
  });

  it("메모 있으면 Callout에 제목+전문 표출 (US2)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    expect(note()).toHaveTextContent("운영 환경 금지.");
    expect(note()).toHaveTextContent("BASE_URL 필수.");
  });

  it("[접기] → 첫 줄 미리보기만, localStorage 기억 → 재마운트에도 접힘 (US3)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    const first = renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.collapseAria }));
    expect(note()).toHaveTextContent("운영 환경 금지.");
    expect(note()).not.toHaveTextContent("BASE_URL 필수."); // 둘째 줄 부재 = 접힘 판별
    first.unmount();
    renderWithId(); // 재마운트 — localStorage 초기값 경로
    expect(note()).not.toHaveTextContent("BASE_URL 필수.");
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.expandAria }));
    expect(note()).toHaveTextContent("BASE_URL 필수.");
  });

  it("[편집]→수정→[완료] → store 반영 (US1)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    const ta = screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria });
    expect(ta).toHaveValue("운영 환경 금지.\nBASE_URL 필수.");
    fireEvent.change(ta, { target: { value: "새 메모" } });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.doneAria }));
    expect(useScenarioEditor.getState().model?.notes).toBe("새 메모");
    expect(useScenarioEditor.getState().yamlText).toContain("새 메모");
  });

  it("공백-only [완료] → notes 키 삭제 + 빈 진입 라인 (R4)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    fireEvent.change(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria }), {
      target: { value: "   \n  " },
    });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.doneAria }));
    expect(useScenarioEditor.getState().yamlText).not.toContain("notes");
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeInTheDocument();
  });

  it("[취소] → 원본 유지", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    fireEvent.change(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria }), {
      target: { value: "버려질 편집" },
    });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.cancelAria }));
    expect(useScenarioEditor.getState().model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("메모 없음 → 진입 라인, 클릭 → 편집 모드 (R5)", () => {
    useScenarioEditor.getState().loadFromString(NO_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.addAria }));
    expect(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria })).toHaveValue("");
  });

  it('YAML 유래 notes: "" → 빈 Callout 대신 진입 라인', () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: x\nnotes: ""\nsteps: []\n');
    renderWithId();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeInTheDocument();
  });

  it("yamlError → 편집 disabled·접기 활성 (무음 유실 가드)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    renderWithId();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.editAria })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.collapseAria })).toBeEnabled();
  });

  it("메모 없음 + yamlError → 진입 라인 disabled", () => {
    useScenarioEditor.getState().loadFromString(NO_NOTES);
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    renderWithId();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeDisabled();
  });

  it("model === null → 아무것도 렌더하지 않음", () => {
    renderWithId(); // reset 상태 그대로 (model: null)
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("EditorShell 통합 — 라우터 없이도 안전 + 최상단 표출", () => {
    render(<EditorShell initialYaml={WITH_NOTES} />);
    expect(screen.getByRole("note", { name: ko.scenarioNotes.title })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx ; echo exit=$?`
Expected: FAIL — `Cannot find module '../ScenarioNotesCallout'` 류 import 실패 · `exit=1`

- [ ] **Step 3: `notesPrefs.ts` 생성** — `ui/src/scenario/notesPrefs.ts`

```ts
/** 공유 메모 접힘 상태의 localStorage 영속(spec R3). editorPrefs 이디엄:
 *  localStorage 불가/오염 시 fail-soft — 기능 저하는 "항상 펼침"뿐. */
const KEY = "handicap:scenario-notes-collapsed:v1";

export function loadNotesCollapsed(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    const out: Record<string, true> = {};
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v === true) out[k] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** collapsed=false는 키 삭제(맵 최소 유지) — "현재 시나리오 키 한정 정리"(spec R3)도 이 경로. */
export function setNotesCollapsed(id: string, collapsed: boolean): void {
  try {
    const map = loadNotesCollapsed();
    if (collapsed) map[id] = true;
    else delete map[id];
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 컴포넌트 상태만으로 동작)
  }
}
```

- [ ] **Step 4: `ko.ts` `scenarioNotes` 섹션 추가** — `ui/src/i18n/ko.ts`, `editor: {`(line 418) **앞**에 top-level 섹션

```ts
  // ── 시나리오 공유 메모 (scenario-notes) ──
  scenarioNotes: {
    title: "공유 메모",
    addLine: "＋ 공유 메모 추가 — 팀원에게 전할 주의점을 남겨두세요",
    addAria: "공유 메모 추가",
    collapse: "접기",
    collapseAria: "공유 메모 접기",
    expand: "펼치기",
    expandAria: "공유 메모 펼치기",
    edit: "편집",
    editAria: "공유 메모 편집",
    done: "완료",
    doneAria: "공유 메모 편집 완료",
    cancel: "취소",
    cancelAria: "공유 메모 편집 취소",
    textareaAria: "공유 메모 내용",
  },
```

- [ ] **Step 5: 컴포넌트 생성** — `ui/src/components/scenario/ScenarioNotesCallout.tsx`

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useScenarioEditor } from "../../scenario/store";
import { loadNotesCollapsed, setNotesCollapsed } from "../../scenario/notesPrefs";
import { Callout } from "../ui/Callout";
import { Textarea } from "../ui/Textarea";
import { ko } from "../../i18n/ko";

/** 초기 표시 높이만 6줄(9.5rem=152px)로 클램프. max-height가 아니라 height 세팅이라
 *  네이티브 resize-y가 양방향으로 동작한다(max-height는 늘리기를 막는다 — spec R7).
 *  jsdom은 scrollHeight 0 → no-op(AutoGrowTextarea 선례), 실제 높이는 라이브 검증 담당. */
const INITIAL_CLAMP_PX = 152;

const GHOST_BTN =
  "shrink-0 rounded border border-accent-200 px-2 py-0.5 text-xs text-accent-800 " +
  "hover:bg-accent-100 disabled:opacity-50";

export function ScenarioNotesCallout() {
  const { id: scenarioId } = useParams<{ id: string }>();
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setNotes = useScenarioEditor((s) => s.setNotes);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    scenarioId !== undefined ? loadNotesCollapsed()[scenarioId] === true : false,
  );

  const notes = model?.notes;
  const hasNotes = notes !== undefined && notes.trim() !== "";

  // 접힘 기억 정리 — 현재 시나리오 키 한정(spec R3: 전역 스캔 없음).
  useEffect(() => {
    if (scenarioId !== undefined && model !== null && !hasNotes) {
      setNotesCollapsed(scenarioId, false);
    }
  }, [scenarioId, model, hasNotes]);

  const bodyRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el: HTMLElement | null = editing ? taRef.current : bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    if (full === 0) return; // jsdom — 레이아웃 미구현
    el.style.height = `${Math.min(full, INITIAL_CLAMP_PX)}px`;
  }, [editing, notes]);

  if (model === null) return null; // YAML 파싱 불가 — 죽은 진입 라인 노출 금지(spec)

  // yamlError 동안 dispatch는 no-op(무음 유실 — think-time-defaults S1) → 편집 차단.
  const locked = yamlError !== null;

  const startEdit = () => {
    setDraft(notes ?? "");
    setEditing(true);
  };
  const commit = () => {
    setNotes(draft.trim() === "" ? undefined : draft);
    setEditing(false);
  };
  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    if (scenarioId !== undefined) setNotesCollapsed(scenarioId, next);
  };

  if (!hasNotes && !editing) {
    return (
      <button
        type="button"
        disabled={locked}
        onClick={startEdit}
        aria-label={ko.scenarioNotes.addAria}
        className="rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-left text-sm text-slate-500 hover:border-accent-300 hover:text-accent-700 disabled:opacity-50"
      >
        {ko.scenarioNotes.addLine}
      </button>
    );
  }

  if (collapsed && !editing) {
    const firstLine = (notes ?? "").trim().split("\n")[0];
    return (
      <div
        role="note"
        aria-label={ko.scenarioNotes.title}
        className="flex items-center justify-between gap-2 rounded-md border border-accent-200 bg-accent-50 px-3 py-1.5 text-sm text-accent-800"
      >
        <p className="min-w-0 truncate">
          <span aria-hidden="true">📝 </span>
          <span className="font-medium">{ko.scenarioNotes.title}</span>
          <span aria-hidden="true"> · </span>
          {firstLine}
        </p>
        <button
          type="button"
          onClick={() => toggleCollapsed(false)}
          aria-label={ko.scenarioNotes.expandAria}
          className={GHOST_BTN}
        >
          {ko.scenarioNotes.expand}
        </button>
      </div>
    );
  }

  return (
    <Callout variant="info" role="note" aria-label={ko.scenarioNotes.title}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">
          <span aria-hidden="true">📝 </span>
          {ko.scenarioNotes.title}
        </p>
        {editing ? (
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={commit}
              aria-label={ko.scenarioNotes.doneAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.done}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label={ko.scenarioNotes.cancelAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.cancel}
            </button>
          </span>
        ) : (
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={() => toggleCollapsed(true)}
              aria-label={ko.scenarioNotes.collapseAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.collapse}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={startEdit}
              aria-label={ko.scenarioNotes.editAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.edit}
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={ko.scenarioNotes.textareaAria}
          className="mt-1.5 resize-y bg-white"
        />
      ) : (
        <pre
          ref={bodyRef}
          className="mt-1.5 resize-y overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm"
        >
          {notes}
        </pre>
      )}
    </Callout>
  );
}
```

- [ ] **Step 6: EditorShell 배선** — `ui/src/components/scenario/EditorShell.tsx`

import 추가:

```ts
import { ScenarioNotesCallout } from "./ScenarioNotesCallout";
```

return 최상단(`<ValidationBanner …/>` 바로 위):

```tsx
  return (
    <div className="flex flex-col gap-3">
      <ScenarioNotesCallout />
      <ValidationBanner onOpenYaml={() => setYamlOpen(true)} />
```

- [ ] **Step 7: GREEN + 기존 스위트 확인**

Run: `cd ui && pnpm test src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx ; echo exit=$?`
Expected: 11 passed · `exit=0`
Run: `cd ui && pnpm test src/components/scenario/__tests__/EditorShell.test.tsx ; echo exit=$?`
Expected: 기존 전부 pass(라우터 없는 render에서 `useParams` `{}` 반환 확인) · `exit=0`
Run: `cd ui && pnpm test ; echo exit=$?`
Expected: 전체 green · `exit=0`

- [ ] **Step 8: RED 실증(회귀 가드 이빨) — 고의 회귀 2건, 각각 확인 후 즉시 원복**

① 편집 버튼의 `disabled={locked}`를 `disabled={false}`로 임시 변경:
Run: `cd ui && pnpm test src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx ; echo exit=$?`
Expected: "yamlError → 편집 disabled" 테스트 **FAIL** · `exit=1` → 원복.

② `toggleCollapsed`의 `if (scenarioId !== undefined) setNotesCollapsed(scenarioId, next);` 줄을 임시 삭제:
Run: 같은 명령
Expected: "[접기] → … 재마운트에도 접힘 (US3)" 테스트 **FAIL**(재마운트 후 접힘 미유지) · `exit=1` → 원복 후 재실행 11 passed green.

- [ ] **Step 9: lint + build**

Run: `cd ui && pnpm lint ; echo exit=$?` → `exit=0`
Run: `cd ui && pnpm build ; echo exit=$?` → `exit=0`

- [ ] **Step 10: Commit**

```bash
git add ui/src/components/scenario/ScenarioNotesCallout.tsx ui/src/components/scenario/__tests__/ScenarioNotesCallout.test.tsx ui/src/scenario/notesPrefs.ts ui/src/i18n/ko.ts ui/src/components/scenario/EditorShell.tsx
git commit -m "feat(ui): 공유 메모 Callout — 4상태(표출/접힘/편집/진입)·yamlError 게이트·접힘 영속 (scenario-notes T3)"
```

---

### Task 4: 시나리오 저장 2MiB 사전 가드

**Files:**
- Create: `ui/src/api/__tests__/clientSizeGuard.test.ts`
- Modify: `ui/src/api/client.ts` (`createScenario`/`updateScenario` — client.ts:213–220 부근 + 헬퍼 신설)
- Modify: `ui/src/i18n/ko.ts` (`scenarioNotes` 섹션에 `sizeLimitError` 키 추가 — Task 3가 만든 섹션)

**Interfaces:**
- Consumes: Task 3의 `ko.scenarioNotes` 섹션(키 추가 대상) · 기존 `request()`·`ScenarioSchema`
- Produces: 시나리오 create/update가 2MiB 이상 body에서 fetch 없이 reject — 페이지 변경 없음(`ScenarioEditPage`의 `update.error`/`ScenarioNewPage`의 기존 에러 표출 경로가 그대로 문구를 보여줌)

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/api/__tests__/clientSizeGuard.test.ts` 생성

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../client";

describe("시나리오 저장 2MiB 사전 가드 (spec R6)", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2MiB 이상 body → fetch 없이 한국어 한도 에러 (create/update)", async () => {
    const huge = "a".repeat(2 * 1024 * 1024); // JSON 래퍼 오버헤드로 body는 확실히 >= 2MiB
    await expect(api.createScenario(huge)).rejects.toThrow("저장 한도");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(api.updateScenario("SC1", huge, 1)).rejects.toThrow("저장 한도");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("한도 미만 body → 가드 통과, fetch 발생", async () => {
    await api.createScenario("version: 1").catch(() => {
      // 응답 파싱 실패는 이 테스트 무관 — fetch 호출 여부만 본다
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test src/api/__tests__/clientSizeGuard.test.ts ; echo exit=$?`
Expected: FAIL — 가드 부재라 ① fetch가 호출되어 `fetchSpy` 미호출 단언 실패 ② promise는 stub 응답 `"{}"`의 Zod 파싱 에러로 reject되지만 메시지가 "저장 한도"가 아니라 `rejects.toThrow` 불일치(이중 RED — resolve가 아니라 *다른 이유의 reject*임에 유의) · `exit=1`

- [ ] **Step 3: `ko.ts`에 `sizeLimitError` 추가** — `scenarioNotes` 섹션 `textareaAria` 줄 뒤

```ts
    sizeLimitError: (mb: string) =>
      `시나리오가 저장 한도(2MB)를 초과했습니다 (현재 ${mb}MB) — 공유 메모나 스텝 수를 줄여주세요.`,
```

- [ ] **Step 4: client.ts 가드 구현** — `ko`는 **이미 import되어 있음**(client.ts:22 — `PoolCapacityError`가 사용, import 추가 시 lint 중복-import 실패). `api` 객체 정의 앞에 헬퍼만 추가:

```ts
/** 시나리오 저장 라우트의 axum 기본 DefaultBodyLimit(2MiB) — app.rs:35의 256MiB 상향은
 *  데이터셋 라우트 전용이라 시나리오 저장은 기본값이 문이다(spec R6). 클라 임계(>=)가
 *  서버 초과 기준(>)과 같거나 엄격 → UI 경로는 항상 사전 차단(서버 상태코드 매핑 불요). */
const SCENARIO_SAVE_BODY_LIMIT = 2 * 1024 * 1024;

function guardScenarioBody(body: string): string {
  const size = new Blob([body]).size;
  if (size >= SCENARIO_SAVE_BODY_LIMIT) {
    throw new Error(ko.scenarioNotes.sizeLimitError((size / (1024 * 1024)).toFixed(1)));
  }
  return body;
}
```

`api`의 두 엔트리를 교체 — **`async` 추가가 핵심**(동기 throw를 rejection으로 변환해 호출부 `.mutate` 에러 경로에 태운다):

```ts
  createScenario: async (yaml: string) =>
    request(
      "/scenarios",
      { method: "POST", body: guardScenarioBody(JSON.stringify({ yaml })) },
      ScenarioSchema,
    ),
  updateScenario: async (id: string, yaml: string, version: number) =>
    request(
      `/scenarios/${encodeURIComponent(id)}`,
      { method: "PUT", body: guardScenarioBody(JSON.stringify({ yaml, version })) },
      ScenarioSchema,
    ),
```

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test src/api/__tests__/clientSizeGuard.test.ts ; echo exit=$?`
Expected: 2 passed · `exit=0`
Run: `cd ui && pnpm test ; echo exit=$?`
Expected: 전체 green · `exit=0`

- [ ] **Step 6: lint + build**

Run: `cd ui && pnpm lint ; echo exit=$?` → `exit=0`
Run: `cd ui && pnpm build ; echo exit=$?` → `exit=0`

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/__tests__/clientSizeGuard.test.ts ui/src/api/client.ts ui/src/i18n/ko.ts
git commit -m "feat(ui): 시나리오 저장 2MiB 사전 가드 — fetch 전 차단·한국어 문구 (scenario-notes T4)"
```

---

## 라이브 검증 (구현 완료 후 — orchestrator, `/live-verify`)

plan task가 아니라 슬라이스 파이프라인 5단계. spec "테스트 전략" 라이브 표(US1~4 + R6 + 마운트 경로)를 척추로:

- 사전: `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`(워크트리 상대경로 — stale 바이너리 함정), `just ui-build` 후 `./target/debug/controller --db /tmp/scenario-notes.db --ui-dir ui/dist`.
- US1~4 + R6 + `/scenarios/new` 경로: spec 표 그대로 수행(두 마운트 경로 모두 — [[live-verify-all-mount-paths]]).
- **run 무영향 확인**: notes 있는 시나리오로 run 1회 — 정상 완료 + 로깅 echo responder 와이어에 notes 문자열 부재(운반-전용 증명; 스킬 번들 responder는 no-op 로깅이라 로깅 변형 사용 — 루트 CLAUDE.md 함정).
- resize 양방향·6줄 클램프는 시각 검증(스크린샷) — jsdom 미커버 영역.

## 리뷰 게이트 메모 (orchestrator)

- Task 1은 engine 경로 → 그 task의 code-quality 리뷰는 `model: opus` path-gate 대상.
- 보안 표면 게이트(§0 grep)는 finish 시 실측 — notes는 운반-전용이지만 diff가 `crates/engine/src/scenario.rs`를 건드리므로 grep 결과가 지배한다(예측으로 스킵 금지).
