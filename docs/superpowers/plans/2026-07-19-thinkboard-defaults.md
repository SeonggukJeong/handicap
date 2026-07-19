# thinkboard-defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** think-time 현황판 상단에서 시나리오 기본값을 직접 편집하게 하고(US1), `{0,0}`을 "0–0ms"라 부르는 마지막 두 문자열을 "대기없음"으로 통일한다(US2).

**Architecture:** `ui/src/scenario/thinkTime.ts`(이미 *판정* 단일 소스)에 *표시* 단일 소스 `formatThink`를 추가하고, ko 두 함수의 시그니처를 `(min, max)` → `(formatted: string)`으로 바꿔 소비처가 반드시 경유하게 만든다. 현황판의 읽기 전용 요약 `<p>`는 `<table>` **밖**에서 인라인 편집 행으로 승격한다(표 안에 넣으면 선택/일괄 로직이 오염된다).

**Tech Stack:** TypeScript · React 18 · Zustand(`scenario/store.ts`) · vitest + @testing-library/react + user-event · Tailwind · 기존 `components/ui/Input` 프리미티브.

**Spec:** `docs/superpowers/specs/2026-07-19-thinkboard-defaults-design.md` (spec-plan-reviewer 2라운드 → clean APPROVE)

## Global Constraints

모든 task의 요구사항에 암묵적으로 포함된다.

- **UI-only.** `crates/**`·`proto/**`·migration·서버 store **0-diff**. 와이어(`think_time` 형식) 무변경.
- **`Modal.tsx` 0-diff · `EditorShell.tsx` 0-diff · `scenario/store.ts` 0-diff** (기존 `setDefaultThinkTime`·`setStepField` 재사용, 새 `Edit` 변형 없음).
- **`<table>`에 열·행을 추가하지 않는다.** 기본값 편집기는 표 바깥이다.
- **`FlowOutline` 칩의 표시 조건 무변경** — `step.think_time !== undefined`일 때만 렌더(`FlowOutline.tsx:169`). 문자열만 교정한다.
- **신규 ko 문자열은 아래 값을 그대로** 쓴다(부분문자열 충돌까지 회피된 값이다):
  - `thinkBoardDefaultLabel: "기본 think time"`
  - `thinkBoardDefaultMinAria: "현황판 기본 대기 최솟값 (ms)"`
  - `thinkBoardDefaultMaxAria: "현황판 기본 대기 최댓값 (ms)"`
  - `thinkBoardDefaultNone: "없음 — 상속 스텝은 모두 대기없음"` (기존 키 **값만** 개정, 키명 유지)
- **draft 시드 표현식은 반드시 `X === undefined ? "" : String(X)`** 형이다. `X ? String(X) : ""`(truthy)는 `0`을 falsy로 떨어뜨려 기본값 `{0,0}`을 빈 칸으로 시드하고, 이어지는 blur가 키를 삭제한다.
- **`useEffect` deps에서 `eslint-disable` 금지.** `ui/package.json:10`이 `eslint . --max-warnings=0`이고 `exhaustive-deps`가 `warn`이라 경고 1건 = 게이트 실패. 필요한 dep은 **추가**해서 해결한다.
- **게이트는 파이프 없이 종료코드를 명시 캡처**한다: `pnpm lint; echo exit=$?` 식. `| tail`은 실패를 마스킹한 선례가 있다.
- **커밋에 `--no-verify` 금지.**

## 이빨 실증 의무 (이 plan의 핵심 검증 규칙)

이 저장소는 직전 슬라이스에서 **plan이 verbatim 지시한 회귀 테스트 3건이 구조적으로 공허**했던 사고를 겪었다. 따라서 아래 표시된 테스트는 **작성만으로 완료가 아니다** — 각 task의 지정 스텝에서 **고의 회귀 주입 → RED 확인 → 원복 → GREEN 확인**을 실제로 실행하고, 그 출력을 커밋 메시지 또는 task 리포트에 남긴다.

| 테스트 | RED 대상 단언 | 주입할 회귀 |
|---|---|---|
| T1-2 동치 락인 | `expect(formatThink(undefined)).toBe(formatThink({0,0}))` | `formatThink`에서 `(t.min_ms === 0 && t.max_ms === 0)` 항 제거 |
| T2-8 시드 회귀 | 입력 `value === "0"` + blur 후 YAML 키 생존 | 시드를 `defMin ? String(defMin) : ""`로 교체 |
| T2-9 dep 회귀 | 기본값 draft가 `"1000"`으로 생존 | 재시드 effect dep을 `[model?.default_think_time]`(객체)로 교체 |

**포커스 이동 = 암묵 blur = 커밋 1회 (이 plan에서 실제로 두 테스트를 깨뜨린 축)**

`user.click`/`user.clear`/`user.type`은 대상에 **포커스를 옮기고**, 그 순간 직전 포커스 요소에 `blur`가 발화해 `onBlur={commit}`이 **한 번 실행된다**. 저장소가 이 동작을 자기 테스트 주석에 못박아 뒀다 — `ThinkTimeBoard.test.tsx:237-239`("포커스 이동으로 위 no-op이 먼저 blur-commit되고, 이 커밋이 모델을 reparse해…").

**min/max 쌍을 편집하는 테스트에서 특히 위험하다**: `min=1000`을 친 뒤 `max` 입력으로 포커스를 옮기면 그 순간 draft가 `{min:"1000", max:"500"}`이라 `min > max` → `resolveThinkDraft`가 **`revert`** → 드래프트가 원값으로 되돌아간다. 기존 테스트들이 안 깨지는 이유는 중간 상태가 항상 "한 칸 빔 → `noop`"이기 때문이다.

→ **min/max 쌍 편집은 포커스를 옮기지 않는 이디엄으로 쓴다**: `fireEvent.change`(min) + `fireEvent.change`(max) + `fireEvent.blur`(max). 선례 = `ScenarioDefaults.test.tsx:52-58` — 그 픽스처엔 `default_think_time`이 **없는데** change 2회 + blur 후 `{500,1000}`이 커밋되므로, `fireEvent.change`가 controlled draft를 실제로 갱신함이 증명된다(`:61-65`는 빈 값 → clear 경로). `:117-120`(revert 케이스)은 draft가 안 바뀌어도 같은 단언이 통과하므로 **단독 증명력이 없다**.

**공허해지는 경로(알려진 것 — 피할 것)**:
- T2-5의 **행** `실효 대기` 셀 단언은 이빨이 없다. `normalizeEffective`(`thinkTime.ts:33-35`)가 상류에서 이미 `{0,0}→undefined`로 접으므로 `formatThink`를 망가뜨려도 그 셀은 "대기없음"을 유지한다. → RED 대상은 **`getByTestId("default-summary")` 단독**이고, 행 단언은 US1 일관성 락인으로만 유지한다.
- T2-9에서 대상 행을 상속 행(`로그인`)으로 잡으면 draft 두 칸이 다 `""`라 `resolveThinkDraft`가 **`noop`**(`thinkTime.ts:71`)을 반환해 `dispatch` 자체가 없다 → `model` 불변 → 객체 dep으로 되돌려도 재시드가 안 일어나 RED가 안 뜬다. → 대상 행은 반드시 **`주문`**(`think_time: {800,900}`이 픽스처에 실재).
- "대기없음"은 화면에 여러 개 존재한다. **`getAllByText(...)[0]` 금지** — `getByTestId`/`within(row(...))`로 앵커한다.

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/scenario/thinkTime.ts` | 판정 + **표시** 단일 소스. `formatThink` 추가 | 1 |
| `ui/src/i18n/ko.ts` | 문구 카탈로그. 2함수 시그니처 변경(T1), 3키 추가·1키 값 개정·2키 삭제(T2) | 1, 2 |
| `ui/src/components/scenario/Inspector.tsx` | 상속 안내 1줄 | 1 |
| `ui/src/components/scenario/FlowOutline.tsx` | wide 칩 1줄 | 1 |
| `ui/src/components/scenario/ThinkTimeBoard.tsx` | `effectiveText` 제거(T1) → 요약 줄을 편집 행으로 승격(T2) | 1, 2 |
| `ui/src/components/scenario/ScenarioDefaults.tsx` | 마지막 4분기 복제본을 `resolveThinkDraft`로 수렴 | 3 |

테스트는 전부 **기존 파일에 추가**한다(신규 테스트 파일 없음): `scenario/__tests__/thinkTime.test.ts` · `components/scenario/__tests__/{ThinkTimeBoard,Inspector,FlowOutline}.test.tsx`.

---

### Task 1: 표시 단일 소스 `formatThink` + 소비처 3곳 (R1 / US2 완결)

**Files:**
- Modify: `ui/src/scenario/thinkTime.ts` (파일 끝에 `formatThink` 추가)
- Modify: `ui/src/i18n/ko.ts:462`, `ui/src/i18n/ko.ts:599`
- Modify: `ui/src/components/scenario/Inspector.tsx:415`
- Modify: `ui/src/components/scenario/FlowOutline.tsx:171`
- Modify: `ui/src/components/scenario/ThinkTimeBoard.tsx:33` (로컬 `effectiveText` 삭제), `:178` (호출부)
- Test: `ui/src/scenario/__tests__/thinkTime.test.ts`, `ui/src/components/scenario/__tests__/Inspector.test.tsx`, `ui/src/components/scenario/__tests__/FlowOutline.test.tsx`

**Interfaces:**
- Consumes: 기존 `ko.editor.thinkNoWait`(`"대기없음"`), `ko.editor.thinkRange(min, max)`(`"N–Mms"`), 타입 `ThinkTime = { min_ms: number; max_ms: number }`(`scenario/model.ts`).
- Produces: `export function formatThink(t: ThinkTime | undefined): string` — Task 2가 상태 문구에 쓴다. ko 두 함수의 새 시그니처 `inheritedThink(formatted: string)` · `wideChipThink(formatted: string)`.

- [ ] **Step 1: `thinkTime.test.ts`에 실패 테스트 3건 작성**

`ui/src/scenario/__tests__/thinkTime.test.ts` 파일 끝에 추가. import 목록에 `formatThink`를 더한다.

```ts
describe("formatThink — 표시 단일 소스 (R1)", () => {
  it("undefined는 '대기없음'", () => {
    expect(formatThink(undefined)).toBe(ko.editor.thinkNoWait);
  });

  it("{0,0}은 '대기없음' (엔진 pace(0)이 즉시 반환 — undefined와 구별 불가능)", () => {
    expect(formatThink({ min_ms: 0, max_ms: 0 })).toBe(ko.editor.thinkNoWait);
  });

  // 이빨: 두 반환값을 서로 직접 비교한다. 각각을 리터럴 "대기없음"과 비교하면
  // 한쪽 분기만 틀려도 통과할 수 있다.
  it("undefined와 {0,0}이 같은 문자열이다 (동치 락인)", () => {
    expect(formatThink(undefined)).toBe(formatThink({ min_ms: 0, max_ms: 0 }));
  });

  it("값이 있으면 범위 표기", () => {
    expect(formatThink({ min_ms: 200, max_ms: 500 })).toBe(ko.editor.thinkRange(200, 500));
  });

  it("0이 한쪽만이면 범위 경로 (둘 다 0일 때만 대기없음)", () => {
    expect(formatThink({ min_ms: 0, max_ms: 1 })).toBe(ko.editor.thinkRange(0, 1));
    expect(formatThink({ min_ms: 1, max_ms: 0 })).toBe(ko.editor.thinkRange(1, 0));
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm vitest run src/scenario/__tests__/thinkTime.test.ts; echo exit=$?
```
Expected: FAIL — `formatThink is not a function` / import 에러.

- [ ] **Step 3: `formatThink` 구현**

`ui/src/scenario/thinkTime.ts` 파일 끝에 추가:

```ts
/** ThinkTime을 사람이 읽는 한 조각으로. {0,0}과 undefined는 엔진에서 구별 불가능한
 *  동작이므로(pacing.rs:56-57 — pace(0)은 즉시 Slept) 같은 문자열이어야 한다.
 *  판정(classifyThink)과 표시가 같은 모듈에 있어야 세 화면이 어긋나지 않는다(R1). */
export function formatThink(t: ThinkTime | undefined): string {
  return t === undefined || (t.min_ms === 0 && t.max_ms === 0)
    ? ko.editor.thinkNoWait
    : ko.editor.thinkRange(t.min_ms, t.max_ms);
}
```

`pacing.rs:56-57`은 같은 파일 `:31` 주석과 **동일 참조**여야 한다(lockstep).

- [ ] **Step 4: 통과 확인**

```bash
pnpm vitest run src/scenario/__tests__/thinkTime.test.ts; echo exit=$?
```
Expected: PASS.

- [ ] **Step 5: 이빨 실증 (T1-2 동치 락인)**

`formatThink`에서 `|| (t.min_ms === 0 && t.max_ms === 0)`를 **일시 제거** → 위 명령 재실행 → **"undefined와 {0,0}이 같은 문자열이다" 테스트가 FAIL** 하는 것을 눈으로 확인 → 원복 → 재실행하여 PASS 확인. RED 출력을 리포트에 남긴다.

- [ ] **Step 6: ko 두 함수 시그니처 변경**

`ui/src/i18n/ko.ts:462`:
```ts
    wideChipThink: (formatted: string) => `think ${formatted}`,
```
`ui/src/i18n/ko.ts:599`:
```ts
    inheritedThink: (formatted: string) => `시나리오 기본값 ${formatted} 상속 중`,
```

- [ ] **Step 7: 소비처 3곳 교체**

`ThinkTimeBoard.tsx` — 로컬 `effectiveText`(`:33-35`)를 **삭제**하고 import에 `formatThink`를 더한 뒤 `:178` 호출부를 바꾼다:
```tsx
        {formatThink(row.effective)}
```

`Inspector.tsx:415` (import에 `formatThink` 추가):
```tsx
            {ko.editor.inheritedThink(formatThink(defaultThink))}
```

`FlowOutline.tsx:171` (import에 `formatThink` 추가):
```tsx
                {ko.editor.wideChipThink(formatThink(step.think_time))}
```

- [ ] **Step 8: 기존 호출부 갱신 + 신규 회귀 테스트**

`Inspector.test.tsx:1327`·`:1371`의 `(500, 1000)` 호출을 새 시그니처로 — **기대 문자열은 불변**이어야 한다:
```tsx
    expect(
      screen.getByText(ko.editor.inheritedThink(ko.editor.thinkRange(500, 1000))),
    ).toBeInTheDocument();
```
(`:1371`은 동일 변환 + `queryByText(...)`/`not.toBeInTheDocument()` 유지)

`FlowOutline.test.tsx:527`:
```tsx
    expect(
      within(row).getByText(ko.editor.wideChipThink(ko.editor.thinkRange(100, 200))),
    ).toBeInTheDocument();
```

**`Inspector.test.tsx`** — 기존 `DEFAULTS_YAML`(`:1280-1304`)은 기본값이 `{500,1000}`이라 `{0,0}` 픽스처를 **새로 추가**해야 한다. 기존 `DEFAULTS_YAML` 정의 바로 아래에 넣는다(스텝 id·구조는 동일하게 유지해 기존 헬퍼가 그대로 먹히도록):

```tsx
const DEFAULTS_ZERO_YAML = `version: 1
name: "demo"
default_think_time:
  min_ms: 0
  max_ms: 0
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000020"
    name: "assets"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000021"
            name: "img"
            type: http
            request:
              method: GET
              url: "/img"
`;
```

그리고 `describe("Inspector — think time 3상태 …")` 블록 안에 **두 건**을 추가한다. **`await openTiming(user)` 필수** — 타이밍 섹션은 접이식이라(`Inspector.test.tsx:1308-1311`, 기존 테스트 전부가 호출) 열지 않으면 문구가 렌더되지 않아 거짓 RED가 난다:

```tsx
  it("US2-①: 기본값이 {0,0}이면 '0–0ms'가 아니라 '대기없음'으로 안내한다", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_ZERO_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    render(<Inspector />);
    await openTiming(user);
    expect(
      screen.getByText(ko.editor.inheritedThink(ko.editor.thinkNoWait)),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0–0ms/)).not.toBeInTheDocument();
  });

  // spec 테스트 16 — 이 슬라이스가 건드리는 삼항(Inspector.tsx:411-417)이
  // 기본값 {0,0}에서도 분기 우선순위를 유지하는지. 기존 :1362 테스트는
  // {500,1000}만 덮으므로 {0,0} 변형이 따로 필요하다.
  it("US2-①: 기본값이 {0,0}이어도 분기 안 스텝은 미적용 안내가 우선한다", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_ZERO_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000021"); // 분기 안 http
    });
    render(<Inspector />);
    await openTiming(user);
    expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
    expect(
      screen.queryByText(ko.editor.inheritedThink(ko.editor.thinkNoWait)),
    ).not.toBeInTheDocument();
  });
```

**`FlowOutline.test.tsx`** — 기존 `RICH_ROW_YAML`(`:494-512`)은 스텝이 **1개뿐이고 그 스텝이 `think_time`을 갖고 있어** `{0,0}` 케이스도 "칩 없는 스텝" 락인도 만들 수 없다. 픽스처와 시드 함수를 **새로 추가**한다:

```tsx
const ZERO_CHIP_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "instant"
    type: http
    request:
      method: GET
      url: "/now"
    think_time: { min_ms: 0, max_ms: 0 }
  - id: "01HX0000000000000000000002"
    name: "inherit"
    type: http
    request:
      method: GET
      url: "/later"
`;

function seedZeroChip() {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(ZERO_CHIP_YAML);
}
```

`describe("wide 모드 행 (R9) …")` 블록에 추가:

```tsx
  it("US2-②: {0,0} 스텝 칩은 'think 0–0ms'가 아니라 'think 대기없음'이다", () => {
    seedZeroChip();
    render(<FlowOutline wide />);
    const zeroRow = screen.getByRole("option", { name: ko.editor.outlineRowAria("instant") });
    expect(
      within(zeroRow).getByText(ko.editor.wideChipThink(ko.editor.thinkNoWait)),
    ).toBeInTheDocument();
    expect(within(zeroRow).queryByText(/think 0–0ms/)).not.toBeInTheDocument();
  });

  // 비목표 락인 — 표시 조건(step.think_time !== undefined)은 이 슬라이스에서
  // 바뀌지 않는다. 상속 스텝에 칩을 새로 띄우는 것은 범위 밖.
  it("US2-②: think_time이 없는 스텝엔 여전히 think 칩이 없다", () => {
    seedZeroChip();
    render(<FlowOutline wide />);
    const inheritRow = screen.getByRole("option", { name: ko.editor.outlineRowAria("inherit") });
    expect(within(inheritRow).queryByText(/^think /)).not.toBeInTheDocument();
  });
```

- [ ] **Step 9: 전체 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`. `tsc -b`가 놓친 ko 호출부를 잡아준다 — 실패하면 그 파일이 남은 소비처다.

- [ ] **Step 10: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults
git add ui/src/scenario/thinkTime.ts ui/src/scenario/__tests__/thinkTime.test.ts ui/src/i18n/ko.ts ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/FlowOutline.tsx ui/src/components/scenario/ThinkTimeBoard.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx ui/src/components/scenario/__tests__/FlowOutline.test.tsx
git commit -m "feat(ui): thinkTime 표시 단일 소스 formatThink — {0,0}을 세 화면에서 '대기없음'으로 통일 (US2)"
```

**Acceptance:** 기본값이 `{0,0}`일 때 Inspector가 "시나리오 기본값 대기없음 상속 중"을, `[스텝 넓게 보기]` 칩이 "think 대기없음"을 보여준다. `{0,0}`이 아닌 값에서는 세 표면 출력이 이전과 byte-identical. T1-2의 이빨이 RED로 실증됐다.

---

### Task 2: 현황판 기본값 인라인 편집기 (R2 / US1 완결)

**Files:**
- Modify: `ui/src/components/scenario/ThinkTimeBoard.tsx` (`defaultSummary` 삭제, 상태 2개 + effect 2개 + commit 1개 추가, `:255-257` `<p>` → 편집 행)
- Modify: `ui/src/i18n/ko.ts` (3키 추가, `thinkBoardDefaultNone` 값 개정, `thinkBoardDefaultZero`·`thinkBoardDefaultSummary` 삭제)
- Test: `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `formatThink(t)` · 기존 `resolveThinkDraft(minDraft, maxDraft): ThinkDraftOutcome`(`thinkTime.ts:67-78`, 4분기 `clear`/`noop`/`commit`/`revert`) · 기존 store 액션 `setDefaultThinkTime(value: ThinkTime | undefined)`(`store.ts:54`).
- Produces: 없음(최종 소비처).

- [ ] **Step 1: 실패 테스트 작성 (US1 핵심 + 4분기 + 엣지)**

`ThinkTimeBoard.test.tsx`에 헬퍼와 describe 블록을 추가한다. 기존 헬퍼(`table()`, `row()`, `stepThink()`)와 픽스처(`YAML` = 기본값 `{200,500}` + `로그인`/`주문`{800,900}/`즉시`{0,0}/`이미지`, `YAML_DEFAULT_ZERO` = 기본값 `{0,0}` + `핑`)를 재사용한다.

```tsx
function defMinInput() {
  return screen.getByLabelText(ko.editor.thinkBoardDefaultMinAria);
}
function defMaxInput() {
  return screen.getByLabelText(ko.editor.thinkBoardDefaultMaxAria);
}
function defaultThink() {
  return useScenarioEditor.getState().model?.default_think_time;
}

describe("ThinkTimeBoard — 기본값 인라인 편집 (R2)", () => {
  it("US1: 기본값을 바꾸면 상속 행의 실효 대기가 같은 화면에서 갱신된다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // 포커스를 옮기지 않는 이디엄(ScenarioDefaults.test.tsx:52-58)이 필수다.
    // user.clear/type으로 min→max 이동하면 중간 상태 {min:"1000", max:"500"}에서
    // 암묵 blur가 발화해 min>max → revert로 떨어져 올바른 구현에서도 FAIL한다.
    fireEvent.change(defMinInput(), { target: { value: "1000" } });
    fireEvent.change(defMaxInput(), { target: { value: "2000" } });
    fireEvent.blur(defMaxInput());
    expect(within(row("로그인")).getByTestId("effective")).toHaveTextContent("1000–2000ms");
  });

  it("R2-a: 기본값 {0,0}이면 요약이 '대기없음'이다", () => {
    act(() => {
      useScenarioEditor.getState().loadFromString(YAML_DEFAULT_ZERO);
    });
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // 이빨 대상은 이 단언 하나다. 아래 행 단언은 normalizeEffective가 상류에서
    // 접어주므로 formatThink를 망가뜨려도 RED가 안 난다(일관성 락인으로만 유지).
    expect(screen.getByTestId("default-summary")).toHaveTextContent(ko.editor.thinkNoWait);
    expect(within(row("핑")).getByTestId("effective")).toHaveTextContent(ko.editor.thinkNoWait);
  });

  it("두 칸을 비우고 blur하면 기본값 키가 사라진다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    fireEvent.change(defMinInput(), { target: { value: "" } });
    fireEvent.change(defMaxInput(), { target: { value: "" } });
    fireEvent.blur(defMaxInput());
    expect(defaultThink()).toBeUndefined();
    expect(screen.getByTestId("default-summary")).toHaveTextContent(
      ko.editor.thinkBoardDefaultNone,
    );
  });

  it("한 칸만 비우면 no-op — draft가 보존되고 모델은 그대로다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    fireEvent.change(defMinInput(), { target: { value: "" } });
    fireEvent.blur(defMinInput());
    expect(defaultThink()).toEqual({ min_ms: 200, max_ms: 500 });
    expect(defMinInput()).toHaveValue(null); // 비운 채 보존(revert되지 않음)
    expect(defMaxInput()).toHaveValue(500);
  });

  it("R2-c: 기본값 {0,0}이 빈 칸이 아니라 0/0으로 시드되고, 만지지 않으면 키가 산다", () => {
    act(() => {
      useScenarioEditor.getState().loadFromString(YAML_DEFAULT_ZERO);
    });
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(defMinInput()).toHaveValue(0);
    expect(defMaxInput()).toHaveValue(0);
    fireEvent.blur(defMinInput());
    expect(defaultThink()).toEqual({ min_ms: 0, max_ms: 0 });
  });

  it("R2-c: 다른 행을 커밋해도 입력 중인 기본값 draft가 살아남는다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // fireEvent.change는 포커스를 옮기지 않는다 — user.clear/type을 쓰면 '주문' 행으로
    // 포커스가 가는 순간 기본값에 암묵 blur가 발화하고, 그때 draft가 {"1000","500"}이라
    // min>max → revert로 떨어져 dep과 무관하게 항상 FAIL한다(이빨 실증 불가).
    fireEvent.change(defMinInput(), { target: { value: "1000" } }); // blur 안 함
    // 대상은 반드시 '주문'(configured {800,900} 실재). 상속 행이면 draft가 둘 다
    // ""라 resolveThinkDraft가 noop을 내고 dispatch가 없어 이 테스트가 공허해진다.
    fireEvent.change(minInput("주문"), { target: { value: "850" } });
    fireEvent.blur(minInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 850, max_ms: 900 });
    expect(defMinInput()).toHaveValue(1000);
  });

  it("R2-f: blur 없이 모달을 닫았다 열면 draft가 모델 값으로 재시드된다", () => {
    const { rerender } = render(<ThinkTimeBoard open onClose={() => {}} />);
    fireEvent.change(defMinInput(), { target: { value: "9999" } }); // blur 안 함
    rerender(<ThinkTimeBoard open={false} onClose={() => {}} />);
    rerender(<ThinkTimeBoard open onClose={() => {}} />);
    expect(defMinInput()).toHaveValue(200);
  });

  it("R2-g: 스텝이 0개여도 기본값 편집기가 보인다", () => {
    act(() => {
      useScenarioEditor.getState().loadFromString(`version: 1
name: "e"
cookie_jar: auto
variables: {}
steps: []
`);
    });
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(defMinInput()).toBeInTheDocument();
    expect(screen.getByText(ko.editor.thinkBoardEmpty)).toBeInTheDocument();
  });

  it("yamlError면 기본값 입력이 비활성화된다", () => {
    // yamlError 유도는 기존 R6 게이트 테스트(:395-397)와 동일한 이디엄이다.
    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(defMinInput()).toBeDisabled();
    expect(defMaxInput()).toBeDisabled();
  });
});
```

기존 `:159`(`toHaveTextContent("200–500ms")`)는 그대로 통과한다(`formatThink({200,500})`가 같은 문자열). 기존 `:165`의 `thinkBoardDefaultZero` 테스트는 **위 "R2-a" 테스트로 대체**하고 삭제한다(키가 사라지므로).

- [ ] **Step 2: ko 문자열 추가·개정 (삭제는 아직 하지 않는다)**

`ui/src/i18n/ko.ts` — 신규 3키 추가 + `thinkBoardDefaultNone` **값만** 개정:

```ts
    thinkBoardDefaultLabel: "기본 think time",
    thinkBoardDefaultNone: "없음 — 상속 스텝은 모두 대기없음",
    thinkBoardDefaultMinAria: "현황판 기본 대기 최솟값 (ms)",
    thinkBoardDefaultMaxAria: "현황판 기본 대기 최댓값 (ms)",
```

> **`thinkBoardDefaultSummary`·`thinkBoardDefaultZero` 삭제는 Step 4에서** 컴포넌트 교체와 **같은 편집으로** 한다. 지금 지우면 아직 살아 있는 `defaultSummary`(`ThinkTimeBoard.tsx:37-41`)가 없는 키를 참조해 `tsc`가 깨지고, vitest는 타입체크를 안 하므로 런타임에 `undefined`가 렌더돼 **기존 `:159` 테스트까지** 무관하게 실패한다.

삭제 안전성은 확인됨 — ko 테스트 2파일(`ko.test.ts`·`editorRedesignKeys.test.ts`) 어디에도 두 키가 없고, `ko.test.ts:126-148`의 `ko.editor` 고정 리스트 루프에도 미포함이다.

> **왜 테스트(Step 1)가 먼저인가 — `tdd-guard`**: `.claude/hooks/tdd-guard.sh`가 `/ui/src/.+\.(ts|tsx|js|jsx)$`를 production으로 보고(`:28`), 작업트리에 **수정/미추적 테스트 파일이 하나도 없으면 편집을 `exit 2`로 거부**한다(`:107`/`:128`). Task 1 커밋 직후 작업트리는 clean이므로 `ui/src/i18n/ko.ts`를 먼저 건드리면 **차단된다**. Step 1이 테스트 파일을 수정해 pending을 만들어 둬야 이 편집이 통과한다.

- [ ] **Step 3: 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm vitest run src/components/scenario/__tests__/ThinkTimeBoard.test.tsx; echo exit=$?
```
Expected: 신규 9건 중 **8건**이 `Unable to find a label with the text of: 현황판 기본 대기 최솟값 (ms)`로 실패한다(= `defMinInput()`/`defMaxInput()`을 부르는 전부).

**"R2-a: 기본값 {0,0}이면 요약이 '대기없음'이다" 1건은 이 시점에도 통과한다** — `toHaveTextContent`는 **부분 문자열** 매칭이고, 구현 전 `default-summary`의 값은 아직 `thinkBoardDefaultZero` = `"시나리오 기본값 대기없음"`이라 `"대기없음"`을 포함하기 때문이다. 정상이므로 "테스트가 이빨이 없다"고 오판하지 말 것(그 테스트의 이빨은 Step 6·7이 아니라 `formatThink`의 `{0,0}` 분기 제거 → `"0–0ms"`에 대해 성립한다).

기존 테스트는 이 시점에 **전부 통과해야 한다**(ko 키를 아직 안 지웠으므로). 기존이 깨졌다면 Step 2에서 삭제를 앞당긴 것이다.

- [ ] **Step 4: 편집기 구현 + ko 두 키 삭제**

`ui/src/i18n/ko.ts`에서 `thinkBoardDefaultSummary`·`thinkBoardDefaultZero` **두 줄을 삭제**하고, 같은 편집으로 `ThinkTimeBoard.tsx`의 로컬 `defaultSummary`(`:37-41`)를 **삭제**한 뒤, `ThinkTimeBoard` 본문에 추가:

```tsx
  const setDefaultThinkTime = useScenarioEditor((s) => s.setDefaultThinkTime);
  const defaultThink = model?.default_think_time;
  // dep은 원시값이어야 한다(BoardRow와 같은 이유) — 객체를 쓰면 표 어느 행에서
  // 커밋할 때마다 model이 교체되어 입력 중이던 기본값 draft가 사라진다.
  const defMin = defaultThink?.min_ms;
  const defMax = defaultThink?.max_ms;
  // 시드는 반드시 === undefined 비교다. truthy(`defMin ? … : ""`)로 쓰면 {0,0}이
  // 빈 칸으로 시드되고 다음 blur가 clear로 떨어져 기본값 키를 지운다.
  const [defMinDraft, setDefMinDraft] = useState(defMin === undefined ? "" : String(defMin));
  const [defMaxDraft, setDefMaxDraft] = useState(defMax === undefined ? "" : String(defMax));

  useEffect(() => {
    setDefMinDraft(defMin === undefined ? "" : String(defMin));
    setDefMaxDraft(defMax === undefined ? "" : String(defMax));
  }, [defMin, defMax]);

  const commitDefault = () => {
    const outcome = resolveThinkDraft(defMinDraft, defMaxDraft);
    switch (outcome.kind) {
      case "clear":
        setDefaultThinkTime(undefined);
        return;
      case "noop":
        return;
      case "commit":
        setDefaultThinkTime(outcome.value);
        return;
      case "revert":
        setDefMinDraft(defMin === undefined ? "" : String(defMin));
        setDefMaxDraft(defMax === undefined ? "" : String(defMax));
        return;
    }
  };
```

기존 `!open` 리셋 effect(`:208-216`)를 확장한다. **deps에 `defMin`/`defMax`를 추가**하고 `eslint-disable`을 쓰지 않는다(본문 전체가 `if (!open) return` 가드 뒤라 열린 상태에서 dep이 변해도 no-op이다):

```tsx
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setBulkMin("");
      setBulkMax("");
      // blur 없이 ESC/백드롭으로 닫으면 commit도 revert도 안 일어난다 — 다음
      // 오픈에 stale draft가 모델과 어긋나 보이지 않도록 여기서 재시드한다(R2-f).
      setDefMinDraft(defMin === undefined ? "" : String(defMin));
      setDefMaxDraft(defMax === undefined ? "" : String(defMax));
    }
  }, [open, defMin, defMax]);
```

`:255-257`의 `<p>`를 교체한다. **빈 상태 삼항 바깥 위치를 유지**해야 스텝 0개에서도 보인다(R2-g):

```tsx
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
        <span className="font-semibold">{ko.editor.thinkBoardDefaultLabel}</span>
        <div className="w-20">
          <Input
            numeric
            compact
            size="sm"
            type="number"
            min={0}
            max={600000}
            aria-label={ko.editor.thinkBoardDefaultMinAria}
            value={defMinDraft}
            disabled={disabled}
            onChange={(e) => setDefMinDraft(e.target.value)}
            onBlur={commitDefault}
          />
        </div>
        <span aria-hidden="true">–</span>
        <div className="w-20">
          <Input
            numeric
            compact
            size="sm"
            type="number"
            min={0}
            max={600000}
            aria-label={ko.editor.thinkBoardDefaultMaxAria}
            value={defMaxDraft}
            disabled={disabled}
            onChange={(e) => setDefMaxDraft(e.target.value)}
            onBlur={commitDefault}
          />
        </div>
        <span>ms</span>
        <span data-testid="default-summary" className="text-slate-500">
          {defaultThink === undefined ? ko.editor.thinkBoardDefaultNone : formatThink(defaultThink)}
        </span>
      </div>
```

`Input`의 BASE에 `w-full`이 있으므로 **폭은 래퍼 `<div className="w-20">`로 준다**(`className="w-20"`을 Input에 직접 주면 `w-full`과 Tailwind 순서 충돌이 난다).

- [ ] **Step 5: 통과 확인**

```bash
pnpm vitest run src/components/scenario/__tests__/ThinkTimeBoard.test.tsx; echo exit=$?
```
Expected: PASS (신규 9건 + 기존 전부).

- [ ] **Step 6: 이빨 실증 ① — T2-8 시드 회귀**

시드 표현식 `X === undefined ? "" : String(X)`를 `X ? String(X) : ""` 형으로 일시 교체한다. **사이트는 8곳이고 전부 바꿔야 한다** — 부분 주입은 거짓 GREEN을 만든다(특히 `useState` 2곳만 바꾸면 마운트 직후 재시드 effect가 올바른 값으로 덮어써 테스트가 통과해버려 "이빨 없음"으로 오판된다):

1. `useState(defMin === undefined ? …)` — min
2. `useState(defMax === undefined ? …)` — max
3. 재시드 effect의 `setDefMinDraft(...)`
4. 재시드 effect의 `setDefMaxDraft(...)`
5. `!open` effect의 `setDefMinDraft(...)`
6. `!open` effect의 `setDefMaxDraft(...)`
7. `commitDefault`의 `revert` 분기 `setDefMinDraft(...)`
8. `commitDefault`의 `revert` 분기 `setDefMaxDraft(...)`

→ 테스트 재실행 → **"R2-c: 기본값 {0,0}이 빈 칸이 아니라 0/0으로 시드되고…"가 FAIL**(`toHaveValue(0)` 불일치 + blur가 `clear`로 떨어져 `defaultThink()`가 `undefined`) 하는 것을 확인 → 8곳 전부 원복 → PASS 확인.

- [ ] **Step 7: 이빨 실증 ② — T2-9 dep 회귀**

재시드 effect의 deps를 `[defMin, defMax]` → `[model?.default_think_time]`로 일시 교체하고 본문 시드를 그 객체 기준으로 바꾼 뒤 재실행 → **"R2-c: 다른 행을 커밋해도 입력 중인 기본값 draft가 살아남는다" 테스트가 FAIL**(`toHaveValue(1000)` → `200`) 하는 것을 확인 → 원복 → PASS 확인.

두 RED 출력을 리포트에 남긴다.

- [ ] **Step 8: 전체 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`. `lint`가 실패하면 십중팔구 `exhaustive-deps` 경고다 — **`eslint-disable`이 아니라 deps 추가**로 고친다.

- [ ] **Step 9: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults
git add ui/src/components/scenario/ThinkTimeBoard.tsx ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 현황판 상단 기본 think time 인라인 편집 (US1)"
```

**Acceptance:** 현황판을 닫지 않고 기본값을 고칠 수 있고, 상속 행의 `실효 대기`가 즉시 따라온다. 기본값 `{0,0}`이 `0`/`0`으로 시드되어 열어보기만 해도 키가 지워지지 않는다. T2-8·T2-9가 RED로 실증됐다.

---

### Task 3: `ScenarioDefaults` 커밋 규칙 수렴 (R4 — 정리, **드롭 가능**)

> **이 task는 어느 US에도 매달리지 않는 리팩터다.** 일정·리스크가 생기면 잘라내고, `ScenarioDefaults.tsx::commit`에 `resolveThinkDraft`를 가리키는 주석만 남긴다.
> **이 task에 다른 finding을 접어 넣지 말 것** — 드롭 가능한 항목에 얹은 결정은 task와 함께 조용히 사라진다(직전 슬라이스 교훈).

**Files:**
- Modify: `ui/src/components/scenario/ScenarioDefaults.tsx:38-56`
- Test: `ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx` (**수정하지 않는다** — 무수정 통과가 acceptance)

**Interfaces:**
- Consumes: `resolveThinkDraft`(`thinkTime.ts:67-78`).
- Produces: 없음.

- [ ] **Step 1: 기존 테스트가 green인지 먼저 확인 (baseline)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm vitest run src/components/scenario/__tests__/ScenarioDefaults.test.tsx; echo exit=$?
```
Expected: PASS. 4분기가 이미 덮여 있다 — `:43` clear/commit · `:84` noop · `:108` revert · `:162` 재시드.

- [ ] **Step 2: `tdd-guard` 언블록 — 임시 `it.todo` 추가**

이 task는 `ScenarioDefaults.tsx`(watched production)를 고치면서 **테스트 파일은 무수정**이 acceptance라, 작업트리에 pending test가 0건이라 `tdd-guard`가 `exit 2`로 편집을 **차단한다**(`.claude/hooks/tdd-guard.sh:28/107/128` — 주석-only 패스스루도 실제 코드 변경이라 해당 없음).

`ScenarioDefaults.test.tsx`에 한 줄을 추가해 pending을 만든다:

```tsx
  it.todo("R4 수렴 — commit이 resolveThinkDraft를 경유한다");
```

이 줄은 **Step 5에서 제거**한다(독립 체크박스 — 잊으면 어떤 게이트도 못 잡는다). 그러면 커밋 diff에는 테스트 파일이 안 들어가 "무수정 통과"라는 acceptance가 그대로 보존된다. 훅은 파일 **내용을 열지 않고 존재만** 보므로(`tdd-guard.sh:92` "Any modified/untracked test file … counts as a pending RED") `it.todo` 한 줄로 충분하다.

- [ ] **Step 3: `commit()`을 `resolveThinkDraft`로 교체**

`ScenarioDefaults.tsx`의 `commit` 전체(`:38-56`)를 바꾼다. import에 `resolveThinkDraft`를 더한다:

```tsx
  // 4분기 커밋 규칙은 thinkTime.ts::resolveThinkDraft가 단일 소스다 — Inspector·
  // ThinkTimeBoard와 규칙을 공유한다. 여기선 outcome에 따른 store/setState 호출만.
  const commit = () => {
    const outcome = resolveThinkDraft(minDraft, maxDraft);
    switch (outcome.kind) {
      case "clear":
        setDefaultThinkTime(undefined);
        return;
      case "noop":
        return;
      case "commit":
        setDefaultThinkTime(outcome.value);
        return;
      case "revert":
        setMinDraft(defaultThink ? String(defaultThink.min_ms) : "");
        setMaxDraft(defaultThink ? String(defaultThink.max_ms) : "");
        return;
    }
  };
```

> revert 시드는 **기존 코드 그대로** 둔다(여기 `defaultThink`는 **객체**라 truthy 검사가 안전하다 — Task 2의 원시값 상황과 다르다). 이 줄을 "일관성" 명목으로 건드리면 동작-무변화 전제가 깨진다.

- [ ] **Step 4: 기존 테스트 무수정 통과 확인**

```bash
pnpm vitest run src/components/scenario/__tests__/ScenarioDefaults.test.tsx; echo exit=$?
```
Expected: PASS **without touching the test file**. 테스트를 한 줄이라도 고쳐야 한다면 그건 동작 변화이므로 수렴이 틀린 것이다 — 되돌리고 원인을 보고할 것.

- [ ] **Step 5: 임시 `it.todo` 제거 + 워크트리 확인**

Step 2에서 넣은 `it.todo` 줄을 `ScenarioDefaults.test.tsx`에서 제거한다. 그리고 **실제로 지워졌는지 확인**한다:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults
git status --porcelain ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx
```
Expected: **출력 없음**(테스트 파일이 pending에 안 남는다).

> **왜 독립 스텝인가**: 이 제거는 다른 어떤 게이트도 못 잡는다 — `it.todo`는 vitest에서 todo로 집계될 뿐 실패가 아니라 Step 6이 green이고, Step 7의 `git add`는 소스 파일만 스테이징하므로 커밋 diff도 깨끗하다. 남는 흔적은 더티 워크트리뿐인데, 이 저장소는 orchestrator가 `git status`로 task 완료를 판정하므로 잊으면 "덜 끝났나?" 오판을 부르고 `finish-slice`의 docs 커밋에 딸려 들어갈 수 있다.

- [ ] **Step 6: 전체 게이트**

```bash
pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`.

- [ ] **Step 7: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults
git add ui/src/components/scenario/ScenarioDefaults.tsx
git commit -m "refactor(ui): ScenarioDefaults 커밋 규칙을 resolveThinkDraft로 수렴 (마지막 복제본)"
```

**Acceptance:** `ScenarioDefaults.test.tsx`가 **무수정** green. 4분기 규칙의 인라인 사본이 코드베이스에서 사라진다.

---

## 최종 검증 (전 task 완료 후 orchestrator가 직접 실행)

- [ ] **전체 게이트 재실행** (self-report 불신 — orchestrator가 직접)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults/ui
pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```

- [ ] **0-diff 게이트 — 스코프 위반 확인** (two-dot 금지)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/thinkboard-defaults
git diff --name-only $(git merge-base master HEAD)..HEAD
```
Expected: `docs/superpowers/**`와 `ui/src/**`만. `crates/`·`proto/`·`Modal.tsx`·`EditorShell.tsx`·`scenario/store.ts`가 나오면 **위반**이다.

- [ ] **`handicap-reviewer` 최종 whole-branch 리뷰** — BASE는 implementer 디스패치 직전 커밋(= spec 커밋 `368af55`). `HEAD~1` 금지(멀티커밋 절단).

- [ ] **보안 표면 게이트** — `finish-slice §0`의 grep을 **직접 실행**한다. plan이 "UI 문구라 무매치 예상"이라 적어놨어도 **grep이 지배한다**(직전 선례: plan의 N/A 예측이 틀려 `trace.rs` 매치로 security-reviewer가 필요했다).

- [ ] **라이브 검증 L1–L8** — spec의 라이브 표 그대로. `/live-verify`로 스택을 띄우되 **run 생성은 불필요**(부하 경로 무변경)하고, 그 근거를 build-log에 남긴다. 특히:
  - **L1·L2 양쪽 진입 화면**(`/scenarios/new`·`/scenarios/{id}`) — 한쪽만 보면 조건부 렌더 부재를 놓친다.
  - **L7**은 `<aside>`를 펼쳐 두 편집기를 동시에 노출한 상태에서 확인하고, 로케이터는 **`{ exact: true }`**로 조회한다.
  - **L8** 기본값 `{0,0}` 시나리오를 열어 입력이 `0`/`0`으로 보이고 만지지 않고 닫아도 YAML 키가 사는지.

---

## Self-Review

**1. Spec coverage**

| spec 요구 | task |
|---|---|
| R1 `formatThink` + R1-a ko 시그니처 + R1-b 소비처 3곳 + R1-c byte-identical | Task 1 |
| R2-a 상태 문구·키 삭제 / R2-b 커밋 / R2-c 시드·dep / R2-d 게이트 / R2-e 즉시 반영 / R2-f close 리셋 / R2-g 빈 상태 | Task 2 |
| R3 두 편집기 동기화(코드 0줄) | 구현 없음. **락인은 라이브 L7뿐이다** — R2-f 테스트는 `ThinkTimeBoard` 내부 close-재시드만 보므로 두 편집기 간 동기화를 검증하지 않는다(단위로는 두 컴포넌트를 함께 마운트하지 않기 때문). 의도된 선택: 동기화가 store 경유라 구현 코드가 0줄이고, 회귀는 라이브에서만 발생 가능하다 |
| R4 `ScenarioDefaults` 수렴 | Task 3 (드롭 가능) |
| 테스트 1–20 | T1: 1–3(thinkTime) · 14–19(Inspector/FlowOutline, **16 포함** — `{0,0}` + 분기 우선 변형을 Task 1 Step 8에 명시) / T2: 4–13 / T3: 20 |
| 라이브 L1–L8 | 최종 검증 |
| 비목표(0-diff·표 밖·칩 조건·`×` 없음·`scenarioHasThinkTime` 연기) | Global Constraints + 0-diff 게이트 |

갭 없음. (초안에서는 spec 테스트 16이 누락된 채 "갭 없음"이라 적혀 있었다 — 리뷰에서 적발되어 Task 1 Step 8에 `{0,0}` 변형으로 추가했다. 기존 `Inspector.test.tsx:1362`는 `{500,1000}`만 덮으므로 이 슬라이스가 건드리는 삼항의 `{0,0}` 경로는 커버되지 않았다.)

**2. Placeholder scan** — "TBD"/"적절히"/"테스트 작성" 류 없음. 코드가 필요한 모든 스텝에 실제 코드가 있다. 초안에 있던 조건부 2건은 해소됐다: `yamlError` 유도는 `setPendingYamlText`+`commitPendingYaml`(기존 R6 테스트 `:395-397`과 동일 이디엄)로 확정했고, Task 1 Step 8이 참조만 하던 픽스처 4개(`DEFAULTS_ZERO_YAML`·`ZERO_CHIP_YAML`·`seedZeroChip`·`openTiming` 호출)는 전문을 인라인했다.

**3. Type consistency** — `formatThink(t: ThinkTime | undefined): string`이 Task 1 정의 → Task 2 사용에서 이름·시그니처 일치. `resolveThinkDraft`의 outcome 태그(`clear`/`noop`/`commit`/`revert`)가 Task 2·3에서 동일. ko 키 이름이 Global Constraints·Task 2 Step 2(카탈로그 편집)·Task 2 Step 1(테스트 코드)에서 일치.

<!-- spec-plan-reviewer: spec 2라운드 → clean APPROVE / plan 3라운드 → clean APPROVE (2026-07-19) -->
<!-- REVIEW-GATE: APPROVED -->
