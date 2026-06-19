# 에디터 test-run UX 정리 + 스킴-없는 URL 검출 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터의 헤더 `미리 1회 실행` 버튼(중복·숨은-기본값 발사)을 없애고 test-run을 에디터 아래 섹션 하나로 통합·목적 자명화하며, 검증 배너가 스킴-없는 host URL도 잡게 한다.

**Architecture:** 순수 `ui/` 폴리시. (1) 검증 배너 `collectProblems` URL 검사 일반화, (2) 페이지 헤더 test-run 버튼 제거, (3) `TestRunSection` ref-free + 제목/안내 자명화 + 공유 `testRunTitle` 키 분리. 엔진/proto/controller/migration 무변경, test-run 와이어 byte-identical.

**Tech Stack:** React + TS + Vitest/RTL + Zod + `ko.ts` 메시지 카탈로그(ADR-0035).

**Spec:** `docs/superpowers/specs/2026-06-19-editor-ux-polish-design.md` (R1–R12).

<!-- spec-plan-reviewer: spec 3 rounds + plan 2 rounds → clean APPROVE (2026-06-19) -->
REVIEW-GATE: APPROVED

## Global Constraints

- **전부 `ui/` 변경** — 엔진·proto·controller·migration·워커 0. 머지 diff = `ui/`(+docs)만. (R10)
- **test-run 와이어 byte-identical** — `api.createTestRun`/`useTestRun`/`ScenarioTraceSchema`/`POST /api/test-runs` payload(`apply_think_time` 포함) 무변경. `TestRunPanel`은 제목 라벨 한 줄(`:455`)만 변경. (R10)
- **모든 사용자-노출 문구는 `ko.ts` 경유**(ADR-0035) — 하드코딩 영어/인라인 한국어 금지. `aria-label`도 포함.
- **`${BASE_URL}`은 `ko.ts`(TS 템플릿 리터럴)에서 `\${BASE_URL}`로 escape**(현 `problemHostlessUrl:263` 선례, ui/CLAUDE.md 함정).
- **`RequestModel.url`은 빈 문자열 허용** — `.min(1)`로 고치지 말 것(U3, 무관하지만 인접 코드).
- **게이트**: 각 task 끝에 `cd ui` 에서 빠른 단일파일 `pnpm test <name>`(`--` 없이) 후, 커밋 전 task 영향 범위 확인. 슬라이스 머지 전 `pnpm lint && pnpm test && pnpm build` 전체 1회(§Final).
- **green-commit 순서(tsc -b 전체 타입체크)**: `TestRunHandle`은 `TestRunSection`이 export하고 두 페이지가 `import type`한다 → **페이지가 먼저 import/ref를 끊고(Task 2)** 그 뒤 `TestRunSection`이 ref-free(Task 3). Task 2 동안 `TestRunSection`은 `forwardRef`인 채로 둔다(미사용 ref·`TestRunSection.test` runNow 블록 모두 그대로 컴파일·통과).
- **TDD 가드**: `ui/src/*.{ts,tsx}` 편집 전 같은 task에서 test-path 파일(`__tests__/*.test.tsx`)을 먼저 건드린다(각 task가 그렇게 구성됨).
- **`pnpm test <name>` 단일파일은 `--` 없이**(붙이면 전체 스위트, ui/CLAUDE.md).

---

## Task 1: 검증 배너 — 스킴-없는 URL 일반화

**Files:**
- Modify: `ui/src/scenario/problems.ts` (`collectProblems` URL 분기 + `startsWithVar` 헬퍼)
- Modify: `ui/src/i18n/ko.ts` (`editor.problemHostlessUrl` → `editor.problemUrlNeedsScheme`)
- Test: `ui/src/scenario/__tests__/problems.test.ts`

**Interfaces:**
- Consumes: `flattenHttpSteps`/`Step` (`../model`), `ko.editor.*`.
- Produces: `ko.editor.problemUrlNeedsScheme(stepName: string): string` (기존 `problemEmptyUrl`/`problemHostlessUrl`과 동일 시그니처). `problemHostlessUrl`은 제거됨 — 이 task 이후 잔존 참조 0.

**충족 R: R5, R6, R7**

> **TDD-guard 순서**: `ko.ts`·`problems.ts`는 guarded `ui/src` 코드라, 같은 작업트리에 pending test-path diff가 **먼저** 있어야 편집이 허용된다 → Step 1에서 `problems.test.ts`를 먼저 수정한다.

- [ ] **Step 1: 테스트 작성 — 스킴-없음 flag / 변수-prefix non-flag / 키 마이그레이션 (먼저)**

`ui/src/scenario/__tests__/problems.test.ts` 수정:
- 기존 `/login` 테스트(현 :34-48)와 `//host` 테스트(현 :114-128)의 기대 메시지를 `ko.editor.problemHostlessUrl(...)` → `ko.editor.problemUrlNeedsScheme(...)`로 변경(케이스·이름·URL은 유지).
- 기존 "절대 URL·환경변수·흐름변수" non-flag 테스트(현 :50-75)는 그대로 유지(이미 `https://`·`\${BASE_URL}/login`·`{{base}}/x` non-flag 커버).
- 아래 두 테스트를 `describe("collectProblems — 모델-가용 항목")` 안에 **추가**:

```ts
  it("스킴 없는 리터럴 URL을 step 문제로 낸다 (example.com / localhost / 상대경로)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: a
    request:
      method: GET
      url: example.com/api
  - type: http
    id: ${ULID_B}
    name: b
    request:
      method: GET
      url: "localhost:8080/x"
  - type: http
    id: ${ULID_C}
    name: c
    request:
      method: GET
      url: api/users
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemUrlNeedsScheme("a") },
      { kind: "step", stepId: ULID_B, message: ko.editor.problemUrlNeedsScheme("b") },
      { kind: "step", stepId: ULID_C, message: ko.editor.problemUrlNeedsScheme("c") },
    ]);
  });

  it("변수로 시작하면 flag 안 함; 변수를 포함해도 리터럴 prefix면 flag (false-negative-safe)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: a
    request:
      method: GET
      url: "\${BASE_URL}"
  - type: http
    id: ${ULID_B}
    name: b
    request:
      method: GET
      url: "api/\${path}"
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_B, message: ko.editor.problemUrlNeedsScheme("b") },
    ]);
  });
```

(`HTTP://`/`HTTPS://` 대문자도 non-flag임을 보강하려면 기존 non-flag 테스트에 `url: HTTPS://api.example.com/x` 행을 추가해도 좋다 — 선택.)

- [ ] **Step 2: 테스트 실행 — 실패 확인 (RED)**

Run: `cd ui && pnpm test problems` (`--` 없이)
Expected: 새 두 테스트 FAIL(아직 `example.com/api`가 flag 안 됨 / `problemUrlNeedsScheme` 미정의 → `undefined` 호출 TypeError) + `/login`·`//host` 마이그레이션 테스트 FAIL.

- [ ] **Step 3: `ko.ts` 메시지 키 교체 + `problems.ts` URL 검사 일반화**

먼저 `ui/src/i18n/ko.ts`의 `problemHostlessUrl`(현 :262-263)을 아래로 **교체**(키 이름 변경 + 초보자용 통합 문구, `\${BASE_URL}` escape 유지; `problemEmptyUrl`은 유지):

```ts
    problemUrlNeedsScheme: (stepName: string) =>
      `"${stepName}" 스텝의 URL은 http:// 또는 https:// 로 시작해야 합니다 — 예: https://api.example.com/path 또는 \${BASE_URL}/path`,
```

그다음 `ui/src/scenario/problems.ts`의 `collectProblems` http-step 루프(현 :21-29)를 아래로 교체:

```ts
  for (const s of flattenHttpSteps(steps)) {
    const url = s.request.url.trim();
    if (url === "") {
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemEmptyUrl(s.name) });
    } else if (startsWithVar(url)) {
      // ${...}/{{...}} 로 시작 = 변수 — 런타임 해석값을 모르므로 flag 안 함 (false-negative-safe, R6).
    } else if (!/^https?:\/\//i.test(url)) {
      // 변수-prefix가 아닌 리터럴인데 http(s):// 스킴이 없음 → 엔진 fail-fast(status 0). /login·//host·example.com/api·api/users 포괄 (R5/R7).
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemUrlNeedsScheme(s.name) });
    }
  }
```

그리고 파일 하단(또는 `collectProblems` 위)에 헬퍼 추가:

```ts
function startsWithVar(url: string): boolean {
  return url.startsWith("${") || url.startsWith("{{");
}
```

(기존 `url.startsWith("/")` 분기는 위 일반 규칙에 흡수되므로 **삭제**. `formatGateMessages`/`formatSegment`는 무변경.)

- [ ] **Step 4: 테스트 실행 — 통과 확인 (GREEN)**

Run: `cd ui && pnpm test problems`
Expected: PASS (전부).

- [ ] **Step 5: 잔존 참조 0 확인 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-ux-polish
grep -rn "problemHostlessUrl" ui/src    # 0건이어야 함
git add ui/src/scenario/problems.ts ui/src/i18n/ko.ts ui/src/scenario/__tests__/problems.test.ts
git commit -m "feat(ui): validation banner flags scheme-less host URLs (R5,R6,R7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

(UI-only 커밋 → pre-commit이 `cd ui && pnpm lint && pnpm test && pnpm build`를 자동 실행. node_modules는 baseline에서 깔림. 커밋은 파이프 없이.)

---

## Task 2: 헤더 test-run 버튼 제거 + 페이지/테스트 재작성

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx` (헤더 버튼/HelpTip/ref 제거)
- Modify: `ui/src/pages/ScenarioNewPage.tsx` (동일)
- Modify: `ui/src/i18n/ko.ts` (`testRunNow`/`testRunNowHelpLabel`/`testRunNowHelp` 제거, `desc.max_test_run_requests` lockstep)
- Test: `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`, `ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx`

**Interfaces:**
- Consumes: `TestRunSection`(이 task에선 아직 `forwardRef`, `ref` 없이 마운트), `ko.editor.testRunRun`("미리 실행", 섹션 버튼).
- Produces: 페이지 헤더에서 test-run 진입 제거 — 이후 유일 발사 경로 = 섹션 버튼 "미리 실행".

**충족 R: R1, R8, R11** (green: `TestRunSection`은 아직 `forwardRef`라 `<TestRunSection yamlText=...>`·`TestRunSection.test`의 runNow 블록 모두 컴파일·통과)

- [ ] **Step 1: 페이지 testrun 테스트 재작성 (RED 먼저)**

`ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`:
- 첫 테스트("POSTs the current buffer…", :63-89)의 버튼 찾기를 헤더→섹션 버튼으로:
  ```ts
  const runBtn = await screen.findByRole("button", { name: "미리 실행" });
  ```
  (현 :70 `name: "미리 1회 실행"` 교체. 나머지 body/region 단언은 그대로 — `region {name:/미리 실행 결과/}`도 유지.)
  그리고 같은 테스트 끝(또는 별도 it)에 헤더 부재 단언 추가:
  ```ts
  expect(screen.queryByRole("button", { name: "미리 1회 실행" })).not.toBeInTheDocument();
  ```
- U4 테스트("헤더 '미리 1회 실행' 버튼이 …", :91-109) **전체 삭제**(헤더 버튼 제거됨).
- 나머지 테스트(breadcrumb / "groups Save and Runs") 유지.

`ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx`:
- 첫 테스트("test-runs the unsaved draft buffer…", :52-81)의 :61 버튼을 `name: "미리 실행"`으로 교체 + 헤더 부재 단언 추가(위와 동형).
- U4 테스트("헤더 '미리 1회 실행' 버튼이 …", :101-123) **전체 삭제**.
- 나머지(그룹/Cancel) 유지.

- [ ] **Step 2: 테스트 실행 — 실패 확인 (RED)**

Run: `cd ui && pnpm test ScenarioEditPage.testrun ScenarioNewPage.testrun`
Expected: 첫 테스트 FAIL(헤더 "미리 1회 실행" 버튼이 아직 존재 → 섹션 버튼 쿼리는 통과하나 "부재" 단언 FAIL; 또는 헤더 클릭 경로 잔존). U4 삭제로 그 테스트는 사라짐.

- [ ] **Step 3: `ScenarioEditPage.tsx` 헤더 버튼/HelpTip/ref 제거**

`ui/src/pages/ScenarioEditPage.tsx`:
- import에서 `HelpTip` 제거(현 :7). `import { TestRunSection, type TestRunHandle }` → `import { TestRunSection }`(현 :11). `useRef`는 유지(`baselineSeededRef`).
- `const testRunRef = useRef<TestRunHandle>(null);`(현 :31) **삭제**.
- 헤더의 아래 블록(현 :106-109) **삭제**:
  ```tsx
  <Button variant="secondary" onClick={() => testRunRef.current?.runNow()}>
    {ko.editor.testRunNow}
  </Button>
  <HelpTip label={ko.editor.testRunNowHelpLabel}>{ko.editor.testRunNowHelp}</HelpTip>
  ```
- `<TestRunSection ref={testRunRef} yamlText={yamlText} />`(현 :166) → `<TestRunSection yamlText={yamlText} />`.

- [ ] **Step 4: `ScenarioNewPage.tsx` 동일 제거**

`ui/src/pages/ScenarioNewPage.tsx`:
- import에서 `HelpTip` 제거(현 :6). `import { TestRunSection, type TestRunHandle }` → `import { TestRunSection }`(현 :10). `useRef` 유지(`didImportSeed`).
- `const testRunRef = useRef<TestRunHandle>(null);`(현 :28) **삭제**.
- 헤더 블록(현 :106-109, 위와 동일한 Button+HelpTip) **삭제**.
- `<TestRunSection ref={testRunRef} yamlText={yamlText} />`(현 :146) → `<TestRunSection yamlText={yamlText} />`.

- [ ] **Step 5: `ko.ts` 헤더 키 제거 + `max_test_run_requests` lockstep**

`ui/src/i18n/ko.ts`:
- `testRunNow`/`testRunNowHelpLabel`/`testRunNowHelp`(현 :275-277, 주석 `// ── test-run 승격 …` 포함) **삭제**.
- `desc.max_test_run_requests`(현 :805)의 리터럴 `"미리 1회 실행"`을 새 섹션 제목 표현으로 교체:
  ```ts
      max_test_run_requests: '에디터 "시나리오 미리 테스트"가 한 번에 보낼 수 있는 최대 요청 수.',
  ```
  (`effect.max_test_run_requests`(:820-821)는 리터럴 "미리 1회 실행"이 없고 "미리보기/미리 실행" 서술이라 **변경 불요** — F2 확인.)

- [ ] **Step 6: 테스트 실행 — 통과 확인 (GREEN)**

Run: `cd ui && pnpm test ScenarioEditPage.testrun ScenarioNewPage.testrun`
Expected: PASS. (`testRunNow` 참조가 더는 없어야 함 — 삭제된 U4 테스트가 유일 소비처였음.)

- [ ] **Step 7: 잔존 참조 0 확인 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-ux-polish
grep -rn "testRunNow" ui/src           # 0건
grep -rn "미리 1회 실행" ui/src/i18n/ko.ts   # 1건(아직 testRunTitle :344 — Task 3에서 제거)
git add ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioNewPage.tsx ui/src/i18n/ko.ts ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx
git commit -m "feat(ui): remove redundant header test-run button; test-run lives in one section (R1,R8,R11)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

(pre-commit이 `pnpm lint`[unused `HelpTip` import 제거 확인]·`test`·`build`[tsc -b: `TestRunHandle` 아직 export됨·페이지 미import → green] 자동 실행.)

---

## Task 3: TestRunSection ref-free + 목적 자명화 + 공유키 분리

**Files:**
- Modify: `ui/src/components/scenario/TestRunSection.tsx` (ref 제거 + 제목/안내/think-time)
- Modify: `ui/src/components/scenario/TestRunPanel.tsx` (결과 제목 키 교체, :455)
- Modify: `ui/src/i18n/ko.ts` (`testRunTitle` rename + `testRunResultTitle`/`testRunIntro`/`testRunThinkTime` 추가)
- Test: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx`, `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`, `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx`, `ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx`

**Interfaces:**
- Consumes: `ko.editor.testRunTitle`/`testRunResultTitle`/`testRunIntro`/`testRunThinkTime`/`testRunRun`/`testRunControlsAria`/`testRunResultAria`.
- Produces: `TestRunSection`이 더는 `forwardRef`/`TestRunHandle` export 안 함 — 평범한 `function TestRunSection({ yamlText }: { yamlText: string })`. `ko.editor.testRunTitle`="시나리오 미리 테스트"(컨트롤), `ko.editor.testRunResultTitle`="미리 테스트 결과"(결과 패널).

**충족 R: R2, R3, R4, R9, R11, R12**

> **TDD-guard 순서**: `ko.ts`·`TestRunSection.tsx`·`TestRunPanel.tsx`는 guarded `ui/src` 코드 → Step 1에서 `TestRunSection.test.tsx`를 먼저 수정해 pending test-path diff를 만든 뒤 src/ko.ts를 편집한다.

- [ ] **Step 1: `TestRunSection.test.tsx` 재작성 (test-first)**

`ui/src/components/scenario/__tests__/TestRunSection.test.tsx`:
- import에서 `createRef` 제거(현 :3), `import { TestRunSection, type TestRunHandle }` → `import { TestRunSection }`(현 :5). `act`는 addedNote 테스트(:127)가 쓰므로 **유지**.
- `describe("TestRunSection runNow handle (U4 §5.5)")` 블록 전체(현 :85-113) **삭제**.
- `afterEach`(현 :56-60)에서 `Reflect.deleteProperty(Element.prototype, "scrollIntoView")` 라인 + 그 주석 삭제(`vi.clearAllMocks()`는 유지). 더는 scrollIntoView를 안 쓰므로.
- 새 테스트 추가(제목/안내 — R3):
  ```ts
  describe("TestRunSection 제목/안내 (목적 자명화)", () => {
    it("컨트롤 제목과 안내 문구를 렌더한다", () => {
      render(<TestRunSection yamlText={VALID_YAML} />);
      expect(screen.getByRole("heading", { name: "시나리오 미리 테스트" })).toBeInTheDocument();
      expect(screen.getByText(/저장·부하 없이 현재 내용으로/)).toBeInTheDocument();
    });
  });
  ```
  (think-time 토글 테스트의 `name: /think time/i`(:67)는 그대로 통과 — `testRunThinkTime` 값이 verbatim.)

- [ ] **Step 2: 테스트 실행 — 실패 확인 (RED)**

Run: `cd ui && pnpm test TestRunSection`
Expected: 새 제목 테스트 FAIL(아직 "미리 1회 실행" 렌더) + runNow 블록 삭제 반영.

- [ ] **Step 3: `ko.ts` 키 갱신/추가**

`ui/src/i18n/ko.ts`:
- `testRunTitle: "미리 1회 실행",`(현 :344) → `testRunTitle: "시나리오 미리 테스트",`
- 같은 블록(`testRunTitle` 인근)에 추가:
  ```ts
    testRunResultTitle: "미리 테스트 결과",
    testRunIntro:
      "저장·부하 없이 현재 내용으로 요청을 1회 보내 동작을 확인합니다. 실제 부하 실행은 시나리오를 저장한 뒤 ‘실행 목록’에서 합니다.",
    testRunThinkTime: "think time 적용 (천천히 전송)",
  ```
  (`testRunControlsAria`/`testRunResultAria`/`testRunRun`/`testRunRunning`/`testRunOk`/`testRunFail`/`testRunMaxRequests`는 그대로. `‘실행 목록’` = `ko.pages.runsBtn` 실제 버튼 라벨과 일치.)

- [ ] **Step 4: `TestRunSection.tsx` ref-free + 제목/안내/think-time**

`ui/src/components/scenario/TestRunSection.tsx` 교체:
- import 정리: `import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";` → `import { useMemo, useState } from "react";`(`forwardRef`/`useImperativeHandle`/`useRef` 제거).
- `TestRunHandle` 인터페이스(현 :12-15) **삭제**.
- 컴포넌트 시그니처: `export const TestRunSection = forwardRef<TestRunHandle, { yamlText: string }>(function TestRunSection({ yamlText }, ref) {` → `export function TestRunSection({ yamlText }: { yamlText: string }) {`. 함수 끝의 `});`(forwardRef 닫기)를 `}`로.
- `const rootRef = useRef<HTMLElement | null>(null);`(현 :33) **삭제**.
- `useImperativeHandle(...)` 블록(현 :51-58, 주석 포함) **삭제**.
- `<section ref={rootRef} aria-label={ko.editor.testRunControlsAria} …>`에서 `ref={rootRef}` 제거.
- `<h3 …>{ko.editor.testRunTitle}</h3>`(현 :67) 바로 아래에 안내 `<p>` 추가:
  ```tsx
  <h3 className="text-lg font-semibold">{ko.editor.testRunTitle}</h3>
  <p className="text-sm text-slate-600">{ko.editor.testRunIntro}</p>
  ```
- 인라인 think-time 라벨(현 :92) `<span className="text-slate-600">think time 적용 (천천히 전송)</span>` → `<span className="text-slate-600">{ko.editor.testRunThinkTime}</span>`.
- 실행 버튼(현 :95-97)은 그대로(default=primary, `ko.editor.testRunRun`/`testRunRunning`).

참고(완성 후 형태 — `forwardRef` 제거 후 본문은 동일):
```tsx
export function TestRunSection({ yamlText }: { yamlText: string }) {
  const testRun = useTestRun();
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [maxRequests, setMaxRequests] = useState<number>(50);
  const [applyThinkTime, setApplyThinkTime] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
  const traceSteps = useMemo<Step[]>(() => { /* 기존 그대로 */ }, [yamlText]);
  const fire = () => { /* 기존 그대로 */ };
  return ( /* <section> (ref 없음) + <h3> + <p intro> + picker + max + think(ko) + button + result */ );
}
```

- [ ] **Step 5: `TestRunPanel.tsx` 결과 제목 키 분리 (R12)**

`ui/src/components/scenario/TestRunPanel.tsx` :455의
```tsx
<h3 className="text-lg font-semibold">{ko.editor.testRunTitle}</h3>
```
→
```tsx
<h3 className="text-lg font-semibold">{ko.editor.testRunResultTitle}</h3>
```
(이 한 줄만. 결과 region aria·chip·timing·본문·`onAddExtract` 무변경 — R10.)

- [ ] **Step 6: `TestRunPanel.test.tsx` 결과 제목 단언 추가 (R12)**

`ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`의 첫 테스트(`renders the truncated banner…`, :50-68) 안에 추가, 또는 새 it:
```ts
  it("결과 패널 제목은 컨트롤 제목과 다른 '미리 테스트 결과'를 쓴다 (공유 키 분리)", () => {
    render(<TestRunPanel trace={TRACE} />);
    expect(screen.getByRole("heading", { name: "미리 테스트 결과" })).toBeInTheDocument();
  });
```

- [ ] **Step 7: clone/save mock `forwardRef`→plain 단순화 (R-3)**

`ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx`(:23-30)와 `ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx`(:23-30)의 mock을 동일하게 단순화:
```ts
vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));
```

- [ ] **Step 8: 테스트 실행 — 통과 확인 (GREEN)**

Run: `cd ui && pnpm test TestRunSection TestRunPanel ScenarioEditPage.clone ScenarioEditPage.save`
Expected: PASS (전부).

- [ ] **Step 9: 잔존 참조 0 확인 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-ux-polish
grep -rn "TestRunHandle\|runNow" ui/src   # 0건
grep -rn "미리 1회 실행" ui/src            # 0건
git add ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/TestRunPanel.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/TestRunSection.test.tsx ui/src/components/scenario/__tests__/TestRunPanel.test.tsx ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx
git commit -m "feat(ui): TestRunSection ref-free + purpose-clear title; split shared testRunTitle (R2,R3,R4,R9,R11,R12)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Final: 전체 게이트 + 리뷰 + 라이브

- [ ] **Step 1: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warnings, 전체 스위트 green, `tsc -b` clean.

- [ ] **Step 2: 무변경 불변식 확인 (R10)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/editor-ux-polish
git diff --name-only master...HEAD     # ui/(+docs)만, crates/·proto·migration 0
git diff master...HEAD -- ui/src/api/hooks.ts ui/src/api/schemas.ts   # createTestRun/useTestRun/ScenarioTraceSchema 무변경(빈 diff)
```

- [ ] **Step 3: handicap-reviewer**

`handicap-reviewer` 에이전트로 whole-feature 리뷰(UI 일관성·a11y·`ko.ts` 단일소스·R10 무변경·와이어 무접촉). APPROVE까지.
(보안 게이트: diff가 요청실행/템플릿/캐스트/env·dataset 바인딩/업로드/trace-body 뷰어 *로직*을 안 건드림 → `security-reviewer` **N/A**. `finish-slice §0` grep이 트리거 없음을 확인.)

- [ ] **Step 4: 라이브 빠른 확인**

test-run 와이어·엔진 무변경이라 전체 `/live-verify` 스택 불요(spec §6 △). 컴포넌트 ref 제거 구조 변경만 검증: controller+worker 띄우고(또는 기존 dev 스택) 에디터에서 **섹션 "미리 실행" 버튼 클릭 → trace 패널("미리 테스트 결과") 표시** 1회 확인(Playwright 인라인 `browser_evaluate` 또는 수동). 헤더에 "미리 1회 실행" 버튼 부재 육안 확인.

- [ ] **Step 5: `/finish-slice`** — build-log·roadmap §A8 ①·CLAUDE 상태줄·메모리 기록 → ff-merge → worktree 정리.

---

## Self-Review (작성자 체크)

- **Spec coverage**: R1(Task2 S3-4)·R2(Task3 S4)·R3(Task3 S1,S4)·R4(Task3, aria 보존)·R5/R6/R7(Task1)·R8(Task2 S5)·R9(Task3 S1,S4)·R10(Final S2)·R11(Task2 S1 + Task3 S2,S6,S7)·R12(Task3 S1,S5,S6) — 전부 task 매핑됨.
- **Placeholder 스캔**: 모든 코드 step에 실제 코드/명령/기대값 명시. "적절히 처리" 류 없음.
- **Type 일관성**: `problemUrlNeedsScheme(stepName:string)` 시그니처 Task1 정의·Task1 소비 일치. `TestRunSection({yamlText}:{yamlText:string})` Task3 정의, Task2가 이미 `ref` 없이 마운트(forwardRef는 ref 옵션). `testRunResultTitle` Task3 S1 정의·S5/S6 소비 일치.
- **green-commit**: Task2(페이지)가 `type TestRunHandle` import를 먼저 끊고 Task3가 export 제거 → 중간 커밋 tsc green(Global Constraints).
