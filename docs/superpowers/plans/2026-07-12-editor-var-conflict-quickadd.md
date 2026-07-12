# 에디터 변수 충돌 배지 + 미정의 변수 원클릭 선언 — Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터 `VariablesPanel`에 (1) 선언 변수가 extract로 덮어써질 수 있음을 알리는 amber 배지, (2) ⚠ 미정의 변수 행의 원클릭 "선언 추가" 버튼을 추가한다.

**Architecture:** 순수 UI 3파일 — `scanVars.ts`에 읽기전용 스캐너 `flatExtractNames` 1개 추가(기존 `flatProducerNames` walker 재사용·재표현), `VariablesPanel.tsx`가 선언 행에 배지·미정의 행에 버튼을 렌더(기존 `setVariable` store action 재사용, 새 edit 변형 0), 문구는 전부 `ko.ts` 경유. 와이어/스토어 시그니처/모델 0-diff.

**Tech Stack:** React + Zustand + RTL(vitest) + Tailwind. spec: `docs/superpowers/specs/2026-07-12-editor-var-conflict-quickadd-design.md` (spec-plan-reviewer APPROVE, R1–R11).

## Global Constraints

- **작업 디렉토리**: 모든 명령은 `/Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd`에서 (subagent prompt 첫 줄 `cd` 필수).
- **변경 파일 화이트리스트 (spec R11)**: `ui/src/scenario/scanVars.ts` · `ui/src/components/scenario/VariablesPanel.tsx` · `ui/src/i18n/ko.ts` + 테스트 2파일(`scanVars.test.ts`·`VariablesPanel.test.tsx`). 그 외 파일 diff 금지(`crates/**`·store/model/yamlDoc 0-diff).
- **문구는 전부 `ko.editor.*` 카탈로그 경유 (ADR-0035, spec R10)** — aria-label·title 포함, 컴포넌트 한글 하드코딩 금지. 배지 title은 **조건형** 문구 byte-exact: `"스텝 추출이 같은 이름에 값을 쓸 수 있습니다 — 추출이 실행된 이후 스텝은 선언값 대신 추출값을 봅니다"`.
- **tdd-guard**: 각 task에서 **테스트 파일 편집을 가장 먼저**(pending test 없으면 src 편집 차단 — 테스트 경로 파일은 항상 허용).
- **클래스 단언은 정확-토큰**: `(el.getAttribute("class") ?? "").split(/\s+/)` 후 `toContain`/`not.toContain` — raw substring `toContain` 금지(실위험 쌍 예: `max-h-[calc…]` ⊃ `h-[calc…]` false-green, ui/CLAUDE.md).
- **단일 파일 테스트는 `pnpm test <이름>`** (`--` 붙이면 전체 스위트가 돎). task 마무리는 `cd ui && pnpm lint && pnpm test && pnpm build` 전체 3게이트(`pnpm test`는 인자 없이).
- **커밋은 단일 FOREGROUND 호출**(`run_in_background` 금지, timeout 600000ms) — pre-commit UI 게이트(lint+test+build)가 자동으로 돈다. `git commit … | tail` 파이프 금지.
- suite-wide flake 주의: full `pnpm test`가 무관 파일 1개를 간헐 실패시키면 그 파일을 격리 실행(`pnpm test <file>`)해 green이면 flake — 커밋 재시도(ui/CLAUDE.md).

---

### Task 1: `flatExtractNames` 스캐너 + `flatProducerNames` 재표현 (spec R1·R2)

**Files:**
- Modify: `ui/src/scenario/scanVars.ts:193-214` (`flatProducerNames` 자리)
- Test: `ui/src/scenario/__tests__/scanVars.test.ts` (기존 `describe("flatProducerNames (R2)")` 뒤에 추가)

**Interfaces:**
- Consumes: `Scenario`/`Step` 타입(`../model`) — 기존 import 그대로.
- Produces: `export function flatExtractNames(scenario: Scenario): Set<string>` — Task 2가 `VariablesPanel`에서 import. `flatProducerNames`는 시그니처·반환값 불변.

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/scenario/__tests__/scanVars.test.ts` — 파일 내 `flatProducerNames`를 import하는 기존 import 문에 `flatExtractNames`를 추가하고, `describe("flatProducerNames (R2)")` 블록 **뒤에** 추가(이 파일의 `model(yaml)` 헬퍼 재사용):

```ts
describe("flatExtractNames (editor-var-conflict-quickadd R1)", () => {
  it("collects non-parallel extracts; excludes declared-only keys and parallel-branch extracts; descends loop", () => {
    const m = model(`version: 1
name: "t"
variables:
  base: "x"
steps:
  - { id: "01HX0000000000000000000010", type: http, name: s1, request: { method: GET, url: "/a" }, extract: [ { var: flat1, from: status } ] }
  - id: "01HX0000000000000000000040"
    type: loop
    name: lp
    repeat: 1
    do:
      - { id: "01HX0000000000000000000050", type: http, name: h, request: { method: GET, url: "/x" }, extract: [ { var: inLoop, from: status } ] }
  - id: "01HX0000000000000000000020"
    type: parallel
    name: par
    branches:
      - name: B
        steps:
          - { id: "01HX0000000000000000000030", type: http, name: b1, request: { method: GET, url: "/b" }, extract: [ { var: ponly, from: status } ] }
`);
    const ex = flatExtractNames(m);
    expect(ex.has("flat1")).toBe(true); // 최상위 http extract
    expect(ex.has("inLoop")).toBe(true); // loop do 하강
    expect(ex.has("base")).toBe(false); // 선언-only는 extract가 아님 (flatProducerNames와의 차이)
    expect(ex.has("ponly")).toBe(false); // parallel 분기 extract는 flat이 아님(네임스페이스 merge)
  });

  it("descends if then/elif/else", () => {
    const m = model(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000070"
    type: if
    name: cond
    cond: { left: "{{a}}", op: exists }
    then:
      - { id: "01HX0000000000000000000071", type: http, name: t1, request: { method: GET, url: "/t" }, extract: [ { var: inThen, from: status } ] }
    elif:
      - cond: { left: "{{b}}", op: exists }
        then:
          - { id: "01HX0000000000000000000072", type: http, name: t2, request: { method: GET, url: "/e" }, extract: [ { var: inElif, from: status } ] }
    else:
      - { id: "01HX0000000000000000000073", type: http, name: t3, request: { method: GET, url: "/l" }, extract: [ { var: inElse, from: status } ] }
`);
    const ex = flatExtractNames(m);
    expect(ex.has("inThen")).toBe(true);
    expect(ex.has("inElif")).toBe(true);
    expect(ex.has("inElse")).toBe(true);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd/ui && pnpm test scanVars`
Expected: FAIL — `flatExtractNames`가 export되지 않음(SyntaxError/undefined).

- [ ] **Step 3: 구현**

`ui/src/scenario/scanVars.ts`의 기존 `flatProducerNames`(193-214행)를 아래 두 함수로 교체(독스트링의 R2 인용 유지):

```ts
/** 비-parallel 서브트리(최상위·loop `do`·if `then`/`elif[].then`/`else`)의 http extract
 *  var 집합 — 선언 키 미포함. parallel branches는 미하강: 분기 extract는 flat이 아니라
 *  `{{branch.var}}`로 네임스페이스되기 때문. 선언↔추출 충돌 배지 판정의 flat 항. */
export function flatExtractNames(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  const walk = (steps: ReadonlyArray<Step>): void => {
    for (const s of steps) {
      if (s.type === "http") {
        for (const e of s.extract) out.add(e.var);
      } else if (s.type === "loop") {
        walk(s.do);
      } else if (s.type === "if") {
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      }
      // parallel: NOT descended (branch extracts are namespaced, not flat).
    }
  };
  walk(scenario.steps);
  return out;
}

/** 선언 키 ∪ parallel 분기 **밖** http extract var (R2) = 선언 ∪ flatExtractNames.
 *  shadow 판정용 — walker는 flatExtractNames와 단일화. */
export function flatProducerNames(scenario: Scenario): Set<string> {
  const out = flatExtractNames(scenario);
  for (const k of Object.keys(scenario.variables)) out.add(k);
  return out;
}
```

- [ ] **Step 4: GREEN 확인 (기존 flatProducerNames 테스트 포함)**

Run: `pnpm test scanVars`
Expected: PASS — 신규 2케이스 + 기존 `flatProducerNames (R2)` 3케이스 전부 green(R2 락인).

- [ ] **Step 5: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 6: Commit (foreground 단일 호출)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd
git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "feat(ui): scanVars flatExtractNames 스캐너 + flatProducerNames 재표현 (editor-var-conflict-quickadd R1/R2)"
```

---

### Task 2: 선언↔추출 충돌 amber 배지 (spec R3·R4·R9 + ko 2키)

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (import·`VarRow`·rows useMemo·선언 행 JSX)
- Modify: `ui/src/i18n/ko.ts` (`variableUndefinedAria` 근처 variable* 군집)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (신규 describe + **기존 단언 :695–697 반전**)

**Interfaces:**
- Consumes: Task 1의 `flatExtractNames` + 기존 `collectNamespacedProducers`(`scanVars.ts:160`).
- Produces: `ko.editor.variableOverwritten`(배지 텍스트) · `ko.editor.variableOverwrittenTitle`(title) — Task 4 라이브 검증이 참조.

- [ ] **Step 1: 실패하는 테스트 작성 — 신규 describe**

`VariablesPanel.test.tsx` 파일 끝에 추가(모듈 스코프 `MIXED` 재사용):

```tsx
describe("VariablesPanel — 선언↔추출 충돌 배지 (editor-var-conflict-quickadd R3/R4/R9)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  // 선언 token을 비-parallel 스텝 extract가 다시 씀 → flat 충돌(R3①)
  const FLAT_CONFLICT = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: login
    type: http
    request: { method: POST, url: "/login", headers: {} }
    extract:
      - from: body
        path: $.tok
        var: token
`;

  // bare 선언 s + parallel-only extract s → amber 배지 없음(R4, shadow 배지만)
  const BARE_SHADOW = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  // 점 포함 선언 brX.tok == parallel merge 키 → 진짜 덮어쓰기 배지(R3③, 리뷰 F2)
  const DOTTED = `version: 1
name: t
cookie_jar: auto
variables:
  brX.tok: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: brX
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: tok
`;

  // 3중 동명: 선언 s + flat extract s + parallel extract s → 배지 ∧ renamable=false (R9 최악 조합)
  const TRIPLE = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request: { method: GET, url: "/x", headers: {} }
    extract:
      - from: body
        path: $.u
        var: s
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  it("R3①: flat 충돌 선언 행에 amber 배지 + 조건형 title, rename 연필은 유지", () => {
    useScenarioEditor.getState().loadFromString(FLAT_CONFLICT);
    render(<VariablesPanel />);
    const badge = screen.getByText(ko.editor.variableOverwritten);
    expect(badge).toHaveAttribute("title", ko.editor.variableOverwrittenTitle);
    const t = tokens(badge);
    expect(t).toContain("bg-amber-50");
    expect(t).toContain("text-amber-700");
    expect(t).toContain("shrink-0");
    // flat 충돌은 rename 비활성 근거가 아니다(renamable은 parallelNames만 본다)
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }),
    ).toBeInTheDocument();
  });

  it("R3②: 충돌 없는 선언 행(MIXED token)엔 배지 부재", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    expect(screen.queryByText(ko.editor.variableOverwritten)).toBeNull();
  });

  it("R4: bare 선언 + parallel-only extract는 amber 배지 부재(shadow 배지만)", () => {
    useScenarioEditor.getState().loadFromString(BARE_SHADOW);
    render(<VariablesPanel />);
    expect(screen.queryByText(ko.editor.variableOverwritten)).toBeNull();
    expect(screen.getByTitle(ko.editor.variableBranchShadowTitle)).toBeInTheDocument();
  });

  it("R3③: 점 포함 선언이 merge 키와 리터럴 동일하면 배지 — 선언 행 within 스코프", () => {
    useScenarioEditor.getState().loadFromString(DOTTED);
    render(<VariablesPanel />);
    // getByTitle("brX.tok")은 선언 span(title=name)과 parallel 행 span(title=display)을
    // 동시 매치 — 선언 행 전용 앵커(값 textarea)로 li를 잡아 within 스코프(리뷰 nit #3)
    const li = screen
      .getByRole("textbox", { name: ko.editor.variableValueAria("brX.tok") })
      .closest("li")!;
    expect(within(li).getByText(ko.editor.variableOverwritten)).toBeInTheDocument();
  });

  it("R9: 배지 행 nameline은 flex-wrap(gap-2 부재), TRIPLE non-renamable 선언 span은 min-w-[72px] + 배지 동석", () => {
    useScenarioEditor.getState().loadFromString(TRIPLE);
    render(<VariablesPanel />);
    const li = screen
      .getByRole("textbox", { name: ko.editor.variableValueAria("s") })
      .closest("li")!;
    // renamable=false(parallel s 추출) → 연필 없음 = non-renamable span 경로
    expect(
      within(li).queryByRole("button", { name: ko.editor.renameVariableAria("s") }),
    ).toBeNull();
    const badge = within(li).getByText(ko.editor.variableOverwritten); // flat extract s → 배지
    const nameline = badge.parentElement!;
    const nt = tokens(nameline);
    expect(nt).toContain("flex-wrap");
    expect(nt).toContain("gap-x-2");
    expect(nt).toContain("gap-y-1");
    expect(nt).not.toContain("gap-2");
    const nameSpan = within(li).getByTitle("s");
    expect(tokens(nameSpan)).toContain("min-w-[72px]");
    expect(tokens(nameSpan)).not.toContain("min-w-0");
  });
});
```

- [ ] **Step 2: 기존 락인 반전 (리뷰 F1 — 같은 편집에서)**

`VariablesPanel.test.tsx`의 it `"R2/R5: parallel rename 래퍼·shadow 이름 span은 min-w-[72px], declared non-renamable span은 min-w-0 유지"`(:678) 안 마지막 3줄(:695–697)을 다음으로 교체하고, it 이름의 `declared non-renamable span은 min-w-0 유지`를 `declared non-renamable span도 min-w-[72px]`로 바꾼다:

```ts
    const declared = screen.getByTitle("s"); // declared non-renamable span — 배지 동석 대비 min-w-[72px] 전환(editor-var-conflict-quickadd R9, 구 "의도적 무변경" 락인 반전)
    expect(tokens(declared)).toContain("min-w-[72px]");
    expect(tokens(declared)).not.toContain("min-w-0");
```

**주의**: 이 반전으로 이 케이스는 구현 전까지 RED — 회귀가 아니라 의도된 RED(spec §4.4).

- [ ] **Step 3: RED 확인**

Run: `pnpm test VariablesPanel`
Expected: FAIL — `ko.editor.variableOverwritten` 미존재(TS 에러 아님 — vitest는 transpile-only라 런타임 undefined로 매처 실패) + R9/기존-반전 케이스 클래스 불일치.

- [ ] **Step 4: ko.ts 2키 추가**

`ui/src/i18n/ko.ts`의 `variableUndefinedAria`(:482) 바로 아래에:

```ts
    variableOverwritten: "추출 덮어씀",
    variableOverwrittenTitle:
      "스텝 추출이 같은 이름에 값을 쓸 수 있습니다 — 추출이 실행된 이후 스텝은 선언값 대신 추출값을 봅니다",
```

- [ ] **Step 5: VariablesPanel.tsx 구현**

① import 확장(:8-14):

```ts
import {
  collectProducedVars,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVars,
  parallelVarIdentities,
  flatExtractNames,
  collectNamespacedProducers,
} from "../../scenario/scanVars";
```

② `VarRow` declared 변형(:17)에 `overwritten: boolean` 추가:

```ts
  | { kind: "declared"; name: string; value: string; renamable: boolean; overwritten: boolean; refIds: string[] }
```

③ rows useMemo(:58-97) — 스캐너 2개 추가 + declared push 갱신:

```ts
    const flatEx = flatExtractNames(model);
    const namespaced = collectNamespacedProducers(model);
```

(기존 `const undef = undefinedVars(model);` 아래에) 그리고 declared push를:

```ts
    for (const [name, value] of Object.entries(model.variables))
      out.push({
        kind: "declared",
        name,
        value,
        renamable: !parallelNames.has(name),
        overwritten: flatEx.has(name) || namespaced.has(name),
        refIds: refIndex.get(name) ?? [],
      });
```

④ 선언 행 JSX(:225-244) — nameline 컨테이너를 wrap으로, non-renamable span `min-w-0`→`min-w-[72px]`, 배지를 name(또는 nameCell) 뒤·× 앞에 삽입:

```tsx
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {row.renamable ? (
                    nameCell(row.name)
                  ) : (
                    <span
                      className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                  )}
                  {row.overwritten && (
                    <span
                      className="shrink-0 rounded bg-amber-50 px-1.5 text-xs text-amber-700"
                      title={ko.editor.variableOverwrittenTitle}
                    >
                      {ko.editor.variableOverwritten}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVariable(row.name)}
                    aria-label={ko.editor.removeVariableAria(row.name)}
                    className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                  >
                    ×
                  </button>
                </div>
```

- [ ] **Step 6: GREEN 확인**

Run: `pnpm test VariablesPanel`
Expected: PASS — 신규 5케이스 + 반전 케이스 + 기존 전 케이스 green.

- [ ] **Step 7: 전체 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 8: Commit (foreground 단일 호출)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(ui): 선언↔추출 충돌 amber 배지 — flat ∪ namespaced 판정·조건형 title·선언 행 wrap (editor-var-conflict-quickadd R3/R4/R9)"
```

---

### Task 3: 미정의 변수 원클릭 "선언 추가" + 하단 추가 버튼 게이트 fold (spec R5–R8 + ko 2키)

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (미정의 행 JSX·하단 추가 버튼 disabled)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`

**Interfaces:**
- Consumes: 기존 `setVariable`(store, dispatch 편집 게이트 내장)·`setUsageNav`·`yamlError` 셀렉터 — 전부 컴포넌트에 이미 배선됨.
- Produces: `ko.editor.variableDeclareAdd` · `ko.editor.variableDeclareAddAria(name)` — Task 4 라이브 검증이 참조.

- [ ] **Step 1: 실패하는 테스트 작성**

`VariablesPanel.test.tsx` 파일 끝에 추가:

```tsx
describe("VariablesPanel — 미정의 변수 원클릭 선언 (editor-var-conflict-quickadd R5–R8)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const DOTTED_UNDEF = `version: 1
name: t
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request:
      method: GET
      url: "/x?a={{ghost.v}}"
      headers: {}
`;

  it("R5: '선언 추가' 클릭 → 빈 값 선언·⚠ 행 소멸·선언 행 등장·검색어 유지", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    const search = screen.getByPlaceholderText(ko.editor.varSearchPlaceholder);
    await user.type(search, "missing");
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }),
    );
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("missing", "");
    expect(useScenarioEditor.getState().yamlText).toContain("missing:");
    expect(screen.queryByTitle(ko.editor.variableUndefinedAria("missing"))).toBeNull();
    expect(
      screen.getByRole("textbox", { name: ko.editor.variableValueAria("missing") }),
    ).toBeInTheDocument();
    // 검색어 미클리어(R5) — 하단 추가 경로의 setQuery("") 복사 금지
    expect(search).toHaveValue("missing");
  });

  it("R7: 점 포함 미정의 이름도 리터럴 키로 선언", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(DOTTED_UNDEF);
    render(<VariablesPanel />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("ghost.v") }),
    );
    // 주의: toHaveProperty는 점을 경로로 해석 — 리터럴 키는 배열 형
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty(["ghost.v"], "");
  });

  it("R6: yamlError 상태에서 '선언 추가'·하단 '추가' 둘 다 disabled", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    useScenarioEditor.getState().commitPendingYaml(); // yamlError 세팅 — model은 보존됨
    render(<VariablesPanel />);
    expect(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }),
    ).toBeDisabled();
    // 하단 버튼: 이름을 먼저 타이핑해 빈-이름 disabled와 구분(teeth)
    await user.type(screen.getByPlaceholderText("new_var"), "x");
    expect(screen.getByRole("button", { name: ko.editor.variablesAdd })).toBeDisabled();
  });

  it("R8: 미정의 행 사용처 팝오버가 열린 채 키보드로 '선언 추가' → 팝오버 닫힘", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableUsageNavAria("missing") }),
    );
    expect(
      await screen.findByRole("menu", { name: ko.editor.varUsageListAria }),
    ).toBeInTheDocument();
    // 키보드 활성화(Enter) — 마우스 클릭은 팝오버의 outside-pointerdown이 선제로 닫아
    // R8 setUsageNav(null) 없이도 통과(false-green)하므로 반드시 키보드 경로로(teeth)
    screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm test VariablesPanel`
Expected: FAIL — `variableDeclareAddAria` 미존재로 4케이스 실패.

- [ ] **Step 3: ko.ts 2키 추가**

Task 2에서 추가한 `variableOverwrittenTitle` 바로 아래에:

```ts
    variableDeclareAdd: "선언 추가",
    variableDeclareAddAria: (name: string) => `${name}을(를) 변수로 선언`,
```

- [ ] **Step 4: VariablesPanel.tsx 구현**

① 미정의 행(:335-349) — ⚠ span 뒤·usageCell 앞에 버튼 삽입:

```tsx
          return (
            <li key={`u:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
                title={ko.editor.variableUndefinedAria(row.name)}
              >
                {row.name}
              </span>
              <span className="shrink-0 text-xs text-amber-600">
                <span aria-hidden="true">⚠ </span>
                {ko.editor.variableUndefined}
              </span>
              <button
                type="button"
                aria-label={ko.editor.variableDeclareAddAria(row.name)}
                disabled={yamlError !== null}
                onClick={() => {
                  setUsageNav(null); // 행 u:→d: 전이로 anchor unmount — detached 팝오버 방지(R8)
                  setVariable(row.name, "");
                }}
                className="shrink-0 text-xs text-accent-600 hover:underline disabled:opacity-40"
              >
                {ko.editor.variableDeclareAdd}
              </button>
              {usageCell(`u:${row.name}`, row.name, row.refIds)}
            </li>
          );
```

② 하단 "추가" 버튼(:377) disabled fold:

```tsx
          disabled={newKey.trim().length === 0 || yamlError !== null}
```

- [ ] **Step 5: GREEN 확인**

Run: `pnpm test VariablesPanel`
Expected: PASS — 신규 4케이스 + 기존 전 케이스 green.

- [ ] **Step 6: 전체 게이트 + 하드코딩 스윕**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd/ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

Run: `grep -nE '"[^"]*[가-힣]' ui/src/components/scenario/VariablesPanel.tsx ui/src/scenario/scanVars.ts`
Expected: **기존 주석 매치 2건만, 신규 매치 0건** (리뷰 M1 baseline 실측 — `VariablesPanel.tsx:115` `// 변경 없음`은 코드의 `""` 닫는 따옴표가 매치 시작점, `:130`은 주석 속 `"미사용"` 인용부호. 이 패턴은 라인 단위라 주석도 잡는다 — "출력 0줄"이 아니라 각 매치를 육안으로 문자열 리터럴/JSX 여부 판정해 **신규만 0건**이면 통과. 라인 번호는 이번 편집으로 밀릴 수 있으니 내용으로 식별).

- [ ] **Step 7: Commit (foreground 단일 호출)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-var-conflict-quickadd
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(ui): 미정의 변수 원클릭 '선언 추가' + 추가 버튼 yamlError 게이트 fold (editor-var-conflict-quickadd R5-R8)"
```

---

### Task 4 (orchestrator 직접 — subagent 디스패치 금지): 라이브 Playwright 실측 (spec R9·종합)

클라이언트-only(`/scenarios/new`, 백엔드 불요). run-생성/리포트/엔진 0-diff라 `/live-verify` 풀스택 불요.

- [ ] **Step 1**: `cd ui && pnpm dev`(background). vite는 IPv6 바인드 — Playwright는 `http://localhost:5173/scenarios/new`로 navigate(127.0.0.1 금지).
- [ ] **Step 2 (배지)**: 템플릿 picker에서 extract가 있는 템플릿(예: 로그인 흐름) 선택 → 변수 패널 하단 입력으로 그 extract와 **같은 이름**의 변수 추가 → 선언 행에 "추출 덮어씀" 배지 실측: `getComputedStyle(badge).backgroundColor`가 amber(rgb(255 251 235))·`title` 속성 일치·이름 span `getBoundingClientRect().width ≥ 72`(R9 — DOM-존재만으로 PASS 금지, [[implementation-rigor-over-spec]]).
- [ ] **Step 3 (원클릭 선언)**: 스텝 디테일 URL 필드에 `{{qa_probe}}` 추가(React controlled — fill이 onChange 발화) → 변수 패널 ⚠ 행 등장 → "선언 추가" 클릭 → 선언 행 전이 실측(값 textarea 존재·⚠ 부재) + YAML 모달 대신 **스텝 폼/패널 상태로 검증**(Monaco read 불신 — `ui/src/components/scenario/CLAUDE.md`).
- [ ] **Step 4**: 스크린샷(배지 행 + 전이 후) 저장, 브라우저 콘솔 에러 0 확인(`browser_console_messages`). `.playwright-mcp` 산출물은 머지 전 정리.
- [ ] **Step 5 (R11 최종 범위 확인)**: `git diff --stat master -- ui crates` — ui는 화이트리스트 5파일(scanVars.ts·VariablesPanel.tsx·ko.ts·테스트 2)만, `crates/**` 0-diff.

---

## Self-Review (작성 후 체크 완료)

- **Spec coverage**: R1·R2→Task 1, R3·R4·R9→Task 2, R5·R6·R7·R8→Task 3, R10→Task 2/3 ko 스텝+Task 3 Step 6 스윕, R11→화이트리스트(Global Constraints)+각 커밋 파일 목록. 갭 없음.
- **Placeholder scan**: TBD/TODO/"적절히" 없음 — 전 스텝 실코드.
- **Type consistency**: `flatExtractNames(scenario: Scenario): Set<string>`(Task 1 정의 = Task 2 소비), ko 키 4종 이름 일치(Task 2 정의 2 + Task 3 정의 2 = 테스트 참조와 동일).
