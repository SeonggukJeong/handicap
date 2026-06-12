# U4 — 에디터 검증 피드백 배너 + test-run 승격 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터 상단에 두 계층(모델-가용/게이트 에러) 문제 요약 배너를 상시 슬롯으로 추가하고, 하단 `TestRunSection`을 헤더 버튼 "미리 1회 실행"으로 승격한다 (spec `docs/superpowers/specs/2026-06-11-ux-beginner-friendly-redesign-design.md` §5.4–5.5 권위). 완료 시 영역 U(ADR-0035) 완결.

**Architecture:** UI-only (엔진·proto·controller·migration 무변경, payload byte-identical). 순수 수집 모듈 `scenario/problems.ts`(모델 walk + yamlError 한국어 매핑) → store-구독 `ValidationBanner`를 `EditorShell` 상단에 mount. test-run 승격은 `TestRunSection`을 `forwardRef`+`useImperativeHandle`로 `runNow()` 핸들만 노출(state 리프트 없음, mutation 경로 무변경) — `ScenarioNewPage`·`ScenarioEditPage` 두 헤더에 배선.

**Tech Stack:** React 18 + TS + Zustand(`useScenarioEditor`) + Zod v3 + vitest/RTL. 신규 문구는 전부 `ko.ts` 카탈로그 경유(ADR-0035, 함수 상수 항목은 U5 전례).

---

## 설계 결정 (spec 해석 — implementer는 그대로 따를 것)

1. **게이트 에러 시 모델-가용 항목 숨김(short-circuit)**: `yamlError !== null`이면 모델은 신뢰 불가(`dispatch`/`commitPendingYaml` 실패 경로는 마지막 정상 모델이 잔존 = stale, `loadFromString` 실패 경로는 `model: null`) — spec §5.4가 "stale 모델 기준 선택은 거짓 정보"라 스텝 선택을 비활성하는 것과 같은 근거로, 그 모델에서 나온 스텝 문제 항목 자체를 내지 않는다. 게이트 항목만 표시.
2. **host-less `/` URL 검출 포함**: U3 인계 항목("host-less `/` 시드 URL 검출 검토", roadmap §A8) 해소 — `addStep`이 시드하는 `url: "/"`는 엔진에서 항상 fail-fast(status 0)이므로 검출이 참 정보다. 판정: `url.trim().startsWith("/")` (빈 URL 우선, `${BASE_URL}/…`·`{{var}}/…`·`https://…`는 `/`로 시작하지 않아 false-positive 없음). **캔버스 ⚠ 배지(`urlMissing`)는 U3 그대로 두고 확장하지 않는다** — 접근 가능한 열거는 배너 담당(U3 인계 문언 그대로).
3. **배너 "(상시)" 해석**: 두 탭(캔버스/YAML) 공통 상단 슬롯 + dismiss 불가. 문제 0건이면 미렌더(빈 배너 chrome 금지). yamlError가 YAML 탭에서만 보이던 갭(캔버스 탭 무표시)을 이 배너가 해소.
4. **게이트 문구 매핑**: `parseScenarioDoc`이 Zod issues를 `"path: message; path: message"`로 join하므로(`yamlDoc.ts:84`) `"; "` split 후 세그먼트별 정규식 매핑(Zod v3 `Required`/`Invalid literal value, expected X`/`Expected X, received Y` + 자체 superRefine `duplicate branch name "x"`/`… required`). 매핑 불가(YAML 라이브러리 prettyErrors 멀티라인 등)는 원문 fallback — spec §5.4 명시 허용.
5. **헤더 버튼 설명 부착**: `title` 단독 금지(U3 인계가 title-only를 비접근성으로 지적) — 기존 `<HelpTip>` ⓘ popover를 버튼 옆에 배치.
6. **클릭 시 스텝 선택 + 캔버스 탭 전환**: spec은 "해당 스텝 선택"만 말하지만 YAML 탭에서 선택만 하면 보이지 않으므로 `select(id)` + `setActiveTab("canvas")`를 함께.

## File Structure

| 파일 | 역할 |
|---|---|
| Modify `ui/src/i18n/ko.ts` | `editor` 네임스페이스에 배너·게이트 매핑·test-run 승격 문구 추가 |
| Create `ui/src/scenario/problems.ts` | 순수: `collectProblems(steps, yamlError)` + `formatGateMessages(yamlError)` |
| Create `ui/src/scenario/__tests__/problems.test.ts` | 위 순수 로직 단위 테스트 |
| Create `ui/src/components/scenario/ValidationBanner.tsx` | store-구독 배너 컴포넌트 |
| Create `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx` | 배너 RTL |
| Modify `ui/src/components/scenario/EditorShell.tsx` | 배너 mount(그리드 위) |
| Modify `ui/src/components/scenario/__tests__/EditorShell.test.tsx` | 배너 통합 1케이스 |
| Modify `ui/src/components/scenario/TestRunSection.tsx` | `forwardRef` + `TestRunHandle.runNow()` |
| Modify `ui/src/components/scenario/__tests__/TestRunSection.test.tsx` | runNow/스크롤/isPending 가드 |
| Modify `ui/src/pages/ScenarioNewPage.tsx`, `ui/src/pages/ScenarioEditPage.tsx` | 헤더 "미리 1회 실행" 버튼 + ref 배선 |
| Modify `ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx`, `…/ScenarioEditPage.testrun.test.tsx` | 헤더 버튼 발사 검증 |

## 공통 규칙 (모든 task)

- 작업 디렉터리: `/Users/sgj/develop/handicap/.claude/worktrees/ux-u4-validation-banner` (subagent prompt 첫 줄 `cd` 필수).
- 각 task 마무리 게이트: `cd ui && pnpm lint && pnpm test && pnpm build` (3개 전부 — `pnpm test`만으론 `tsc -b` 에러를 못 잡는다, lint는 `--max-warnings=0`).
- 단일 파일 테스트 반복은 `pnpm test <이름>` (`--` 붙이면 전체 스위트가 돈다 — ui/CLAUDE.md).
- commit은 **명시 경로 `git add`**(절대 `-A` 금지) + **foreground 단일 호출(run_in_background 금지, 파이프 금지)**, 직후 `git log -1`로 landed 확인. UI-only라 pre-commit cargo는 skip된다(빠름).
- ULID fixture 상수: `01ARZ3NDEKTSV4RRFFQ69G5FA1`(끝자리만 바꿔 변형 — UI Zod가 `^[0-9A-HJKMNP-TV-Z]{26}$`를 강제, `id: a`는 parse 실패).
- TS 템플릿 리터럴 안의 `${BASE_URL}` 문구는 **`\${BASE_URL}` 이스케이프 필수**(U3 templates.ts 함정).

---

### Task 1: ko.ts 카탈로그 + `problems.ts` 순수 수집 모듈

**Files:**
- Modify: `ui/src/i18n/ko.ts` (editor 네임스페이스, `discardConfirm` 아래)
- Create: `ui/src/scenario/problems.ts`
- Test: `ui/src/scenario/__tests__/problems.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/problems.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import type { Step } from "../model";
import { collectProblems, formatGateMessages } from "../problems";
import { parseScenarioDoc } from "../yamlDoc";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ULID_B = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const ULID_C = "01ARZ3NDEKTSV4RRFFQ69G5FA3";

function stepsOf(yaml: string): Step[] {
  const parsed = parseScenarioDoc(yaml);
  if (!("model" in parsed)) throw new Error(`fixture must parse: ${parsed.error}`);
  return parsed.model.steps;
}

describe("collectProblems — 모델-가용 항목", () => {
  it("빈 URL 스텝을 step 문제로 낸다", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemEmptyUrl("ping") },
    ]);
  });

  it("호스트 없는 / 시작 URL을 step 문제로 낸다 (addStep 시드 '/' 포함)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: login
    request:
      method: GET
      url: /login
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemHostlessUrl("login") },
    ]);
  });

  it("절대 URL·환경변수·흐름변수 URL은 문제로 내지 않는다", () => {
    // 주의: TS 템플릿 리터럴이라 ${BASE_URL}는 \${BASE_URL}로 이스케이프
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: a
    request:
      method: GET
      url: https://api.example.com/health
  - type: http
    id: ${ULID_B}
    name: b
    request:
      method: GET
      url: "\${BASE_URL}/login"
  - type: http
    id: ${ULID_C}
    name: c
    request:
      method: GET
      url: "{{base}}/x"
`);
    expect(collectProblems(steps, null)).toEqual([]);
  });

  it("컨테이너(loop) 안의 빈 URL도 검출한다 (flattenHttpSteps 재귀)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: loop
    id: ${ULID_A}
    name: l
    repeat: 2
    do:
      - type: http
        id: ${ULID_B}
        name: inner
        request:
          method: GET
          url: ""
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_B, message: ko.editor.problemEmptyUrl("inner") },
    ]);
  });

  it("steps가 null(pre-load)이고 yamlError도 없으면 빈 배열", () => {
    expect(collectProblems(null, null)).toEqual([]);
  });
});

describe("collectProblems — 게이트 에러 short-circuit", () => {
  it("yamlError가 있으면 (stale) 모델 문제는 숨기고 게이트 항목만 낸다", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`);
    const out = collectProblems(steps, "steps.0.request.url: Required");
    expect(out).toEqual([
      { kind: "gate", message: ko.editor.gateRequired("steps.0.request.url") },
    ]);
  });
});

describe("formatGateMessages — Zod 원문 → 한국어 매핑 + fallback", () => {
  it("Required를 매핑한다", () => {
    expect(formatGateMessages("steps.0.request.url: Required")).toEqual([
      ko.editor.gateRequired("steps.0.request.url"),
    ]);
  });

  it("Invalid literal을 매핑한다 (version: 1)", () => {
    expect(formatGateMessages("version: Invalid literal value, expected 1")).toEqual([
      ko.editor.gateInvalidLiteral("version", "1"),
    ]);
  });

  it("invalid_type(Expected/received)을 매핑한다", () => {
    expect(formatGateMessages("steps.0.repeat: Expected number, received string")).toEqual([
      ko.editor.gateInvalidType("steps.0.repeat", "number", "string"),
    ]);
  });

  it("자체 superRefine 문구(name required / duplicate branch name)를 매핑한다", () => {
    expect(formatGateMessages("steps.0.name: step name required")).toEqual([
      ko.editor.gateNameRequired("steps.0.name"),
    ]);
    // superRefine issue path는 스텝 기준 ["branches", i, "name"] — 실제 join 결과는 아래 형식
    expect(formatGateMessages('steps.1.branches.1.name: duplicate branch name "b1"')).toEqual([
      ko.editor.gateDuplicateBranch("steps.1.branches.1.name", "b1"),
    ]);
  });

  it("여러 세그먼트를 분리하고, 미지의 문구는 원문 그대로 둔다", () => {
    expect(
      formatGateMessages("a: Required; Nested mappings are not allowed in compact mappings"),
    ).toEqual([
      ko.editor.gateRequired("a"),
      "Nested mappings are not allowed in compact mappings",
    ]);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test problems`
Expected: FAIL — `Cannot find module '../problems'` (또는 ko 키 부재 TS 에러)

- [ ] **Step 3: ko.ts 문구 추가** — `ui/src/i18n/ko.ts`의 `editor` 네임스페이스, `discardConfirm: "저장하지 않은 변경을 버릴까요?",` 바로 아래에:

```ts
    // ── 시나리오 문제 요약 배너 (§5.4, U4) ──
    problemsBannerAria: "시나리오 문제 요약",
    problemsBannerTitle: (n: number) => `시나리오 문제 ${n}건`,
    problemEmptyUrl: (stepName: string) =>
      `"${stepName}" 스텝의 URL이 비어 있습니다 — 실행하면 요청이 실패합니다.`,
    problemHostlessUrl: (stepName: string) =>
      `"${stepName}" 스텝의 URL에 호스트가 없습니다 — 전체 URL 또는 \${BASE_URL} 같은 환경 변수로 시작하세요.`,
    problemGateIntro: "YAML이 유효하지 않아 캔버스가 마지막 정상 상태로 표시될 수 있습니다.",
    problemGateAction: "YAML 탭에서 확인",
    gateRequired: (path: string) => `${path}: 필수 항목이 없습니다`,
    gateNameRequired: (path: string) => `${path}: 이름이 비어 있습니다`,
    gateInvalidLiteral: (path: string, expected: string) =>
      `${path}: 값이 올바르지 않습니다 (기대값 ${expected})`,
    gateInvalidType: (path: string, expected: string, received: string) =>
      `${path}: 타입이 올바르지 않습니다 (기대 ${expected}, 입력 ${received})`,
    gateDuplicateBranch: (path: string, name: string) =>
      `${path}: 분기 이름 "${name}"이 중복됩니다`,
    // ── test-run 승격 (§5.5, U4) ──
    testRunNow: "미리 1회 실행",
    testRunNowHelpLabel: "미리 1회 실행 설명",
    testRunNowHelp: "저장 없이 현재 내용으로 실제 요청 1회를 보내 확인합니다.",
```

- [ ] **Step 4: `problems.ts` 구현** — Create `ui/src/scenario/problems.ts`:

```ts
import { ko } from "../i18n/ko";
import { flattenHttpSteps, type Step } from "./model";

/** 배너 한 줄 (spec §5.4). step 항목 = 모델-가용(클릭 시 해당 스텝 선택),
 *  gate 항목 = YAML 파싱/Zod 게이트 실패(모델 stale — 스텝 선택 비활성). */
export type ScenarioProblem =
  | { kind: "step"; stepId: string; message: string }
  | { kind: "gate"; message: string };

/** 게이트 에러(yamlError)가 있으면 모델은 stale — 모델-가용 항목은 내지 않는다
 *  (stale 모델 기준 스텝 선택은 거짓 정보, spec §5.4와 같은 근거). */
export function collectProblems(
  steps: ReadonlyArray<Step> | null,
  yamlError: string | null,
): ScenarioProblem[] {
  if (yamlError !== null) {
    return formatGateMessages(yamlError).map((message) => ({ kind: "gate" as const, message }));
  }
  if (!steps) return [];
  const out: ScenarioProblem[] = [];
  for (const s of flattenHttpSteps(steps)) {
    const url = s.request.url.trim();
    if (url === "") {
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemEmptyUrl(s.name) });
    } else if (url.startsWith("/")) {
      // 엔진은 상대 URL을 해석할 수 없어 항상 fail-fast(status 0) — addStep 시드 "/" 포함.
      out.push({ kind: "step", stepId: s.id, message: ko.editor.problemHostlessUrl(s.name) });
    }
  }
  return out;
}

/** parseScenarioDoc은 Zod issues를 "path: message; path: message"로 join한다(yamlDoc.ts) —
 *  세그먼트별로 알려진 문구를 한국어로 매핑, 못 알아보면 원문 유지(spec §5.4 fallback).
 *  알려진 한계: 메시지 자체에 "; "가 들어 있으면(YAML 라이브러리 멀티 에러 등) 둘로
 *  쪼개진다 — 둘 다 매핑 불가 fallback으로 떨어질 뿐 정보 손실은 없다. */
export function formatGateMessages(yamlError: string): string[] {
  return yamlError.split("; ").map(formatSegment);
}

function formatSegment(seg: string): string {
  let m = /^(.+): Required$/.exec(seg);
  if (m) return ko.editor.gateRequired(m[1]);
  m = /^(.+): (?:step name|branch name|name) required$/.exec(seg);
  if (m) return ko.editor.gateNameRequired(m[1]);
  m = /^(.+): Invalid literal value, expected (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidLiteral(m[1], m[2]);
  m = /^(.+): Expected (.+), received (.+)$/.exec(seg);
  if (m) return ko.editor.gateInvalidType(m[1], m[2], m[3]);
  m = /^(.+): duplicate branch name "(.+)"$/.exec(seg);
  if (m) return ko.editor.gateDuplicateBranch(m[1], m[2]);
  return seg;
}
```

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test problems`
Expected: PASS (전 케이스)

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/i18n/ko.ts ui/src/scenario/problems.ts ui/src/scenario/__tests__/problems.test.ts
git commit -m "feat(ui): U4 시나리오 문제 수집 헬퍼 + 카탈로그 문구 (spec §5.4)"
git log -1 --oneline
```

---

### Task 2: `ValidationBanner` 컴포넌트 + EditorShell mount

**Files:**
- Create: `ui/src/components/scenario/ValidationBanner.tsx`
- Modify: `ui/src/components/scenario/EditorShell.tsx`
- Test: `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx`
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx` (1케이스 추가)

- [ ] **Step 1: 실패하는 테스트 작성** — Create `ui/src/components/scenario/__tests__/ValidationBanner.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { ValidationBanner } from "../ValidationBanner";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FA1";

const EMPTY_URL_YAML = `version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`;

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("ValidationBanner", () => {
  it("문제 0건이면 렌더하지 않는다", () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: "x"\nsteps: []\n');
    render(<ValidationBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("빈 URL 스텝을 나열하고 클릭 시 해당 스텝 선택 + 캔버스 탭 전환", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.getState().setActiveTab("yaml");
    render(<ValidationBanner />);

    expect(screen.getByText(ko.editor.problemsBannerTitle(1))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /"ping" 스텝의 URL이 비어/ }));
    expect(useScenarioEditor.getState().selectedStepId).toBe(ULID_A);
    expect(useScenarioEditor.getState().activeTab).toBe("canvas");
  });

  it("게이트 에러는 스텝 항목을 숨기고 한국어 매핑 + YAML 탭 유도 버튼만 보인다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML); // 모델엔 빈 URL 스텝 존재
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner />);

    // stale 모델 기준 스텝 선택은 거짓 정보 — 스텝 문제 버튼이 없어야 한다 (spec §5.4)
    expect(screen.queryByRole("button", { name: /"ping"/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(ko.editor.gateRequired("steps.0.request.url")),
    ).toBeInTheDocument();
    expect(screen.getByText(ko.editor.problemGateIntro)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.problemGateAction }));
    expect(useScenarioEditor.getState().activeTab).toBe("yaml");
  });
});
```

- [ ] **Step 2: EditorShell 통합 테스트 추가** — `ui/src/components/scenario/__tests__/EditorShell.test.tsx` 끝에 describe 추가 (기존 `vi.mock("../MonacoYamlView", …)` 그대로 활용):

```tsx
describe("EditorShell 검증 배너 (U4)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("문제 있는 시나리오 로드 시 상단에 시나리오 문제 요약 배너가 보인다", () => {
    const yaml = `version: 1
name: s
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA1
    name: ping
    request:
      method: GET
      url: ""
`;
    render(<EditorShell initialYaml={yaml} />);
    expect(screen.getByRole("status", { name: ko.editor.problemsBannerAria })).toBeInTheDocument();
  });
});
```

(파일 상단 import에 `import { ko } from "../../../i18n/ko";` 추가 필요.)

- [ ] **Step 3: RED 확인**

Run: `cd ui && pnpm test ValidationBanner && pnpm test EditorShell`
Expected: FAIL — `Cannot find module '../ValidationBanner'`, EditorShell 케이스는 배너 부재로 FAIL

- [ ] **Step 4: `ValidationBanner.tsx` 구현** — Create:

```tsx
import { useMemo } from "react";
import { ko } from "../../i18n/ko";
import { collectProblems } from "../../scenario/problems";
import { useScenarioEditor } from "../../scenario/store";

/** 시나리오 문제 요약 배너 (U4, spec §5.4). 캔버스·YAML 두 탭 공통 상단 상시 슬롯 —
 *  yamlError가 YAML 탭에서만 보이던 갭도 해소한다. 문제 0건이면 미렌더.
 *  스텝 항목 클릭 = 해당 스텝 선택(+캔버스 탭), 게이트 항목 = YAML 탭 유도만(모델 stale). */
export function ValidationBanner() {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const select = useScenarioEditor((s) => s.select);
  const setActiveTab = useScenarioEditor((s) => s.setActiveTab);

  const problems = useMemo(
    () => collectProblems(model?.steps ?? null, yamlError),
    [model, yamlError],
  );
  if (problems.length === 0) return null;

  const hasGate = problems.some((p) => p.kind === "gate");

  return (
    <div
      role="status"
      aria-label={ko.editor.problemsBannerAria}
      className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{ko.editor.problemsBannerTitle(problems.length)}</p>
        {hasGate && (
          <button
            type="button"
            className="shrink-0 underline decoration-amber-400 hover:text-amber-900"
            onClick={() => setActiveTab("yaml")}
          >
            {ko.editor.problemGateAction}
          </button>
        )}
      </div>
      {hasGate && <p className="mt-1 text-xs">{ko.editor.problemGateIntro}</p>}
      <ul className="mt-1 flex flex-col gap-1">
        {problems.map((p, i) => (
          <li key={`${p.kind}-${i}`}>
            {p.kind === "step" ? (
              <button
                type="button"
                className="text-left underline decoration-amber-400 hover:text-amber-900"
                onClick={() => {
                  select(p.stepId);
                  setActiveTab("canvas");
                }}
              >
                {p.message}
              </button>
            ) : (
              <span className="whitespace-pre-wrap break-words">{p.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: EditorShell mount** — `ui/src/components/scenario/EditorShell.tsx`의 return을 래퍼로 감싼다 (import에 `ValidationBanner` 추가):

```tsx
import { ValidationBanner } from "./ValidationBanner";
```

```tsx
  return (
    <div className="flex flex-col gap-3">
      <ValidationBanner />
      <div className="grid grid-cols-[210px_1fr_320px] gap-4 min-h-[680px]">
        {/* …기존 3-column grid 내용 무변경… */}
      </div>
    </div>
  );
```

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test ValidationBanner && pnpm test EditorShell`
Expected: PASS (기존 EditorShell U3 케이스 포함)

- [ ] **Step 7: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/ValidationBanner.tsx ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/ValidationBanner.test.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "feat(ui): 에디터 시나리오 문제 요약 배너 — 2계층(모델/게이트) (U4 spec §5.4)"
git log -1 --oneline
```

주의: 전체 `pnpm test`에서 기존 페이지 테스트가 배너 때문에 깨지는지 확인 — 알려진 fixture는 전부 `steps: []`(배너 미렌더)이고 `ScenarioPages.test.tsx`의 `url: /` fixture는 컴포넌트 마운트 없는 순수 로직 시뮬레이션이라 무영향. 그 밖에 깨지면 fixture가 진짜 문제 URL을 갖고 있는지 먼저 본다(배너는 참 정보).

---

### Task 3: `TestRunSection` forwardRef `runNow()` 핸들

**Files:**
- Modify: `ui/src/components/scenario/TestRunSection.tsx`
- Test: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가** — `TestRunSection.test.tsx`를 다음과 같이 수정. (a) mock을 `isPending` 가변으로 확장, (b) import 확장, (c) afterEach에 scrollIntoView 정리, (d) 새 describe.

mock/임포트 부분 교체:

```tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection, type TestRunHandle } from "../TestRunSection";

// Spy on the test-run mutation. We mock the whole hooks module so that
// useTestRun's mutate is observable and the EnvironmentPicker's data hooks
// (useEnvironment/useEnvironments) return empty stubs (no QueryClient needed).
const mutate = vi.fn();
let isPending = false;
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending, error: null, data: undefined }),
  useEnvironment: () => ({ data: undefined }),
  useEnvironments: () => ({ data: [] }),
}));
```

beforeEach/afterEach 교체:

```tsx
beforeEach(() => {
  mutate.mockReset();
  isPending = false;
});
afterEach(() => {
  vi.clearAllMocks();
  // jsdom은 scrollIntoView 미구현 — 테스트가 깐 폴리필을 sibling 누수 없이 회수
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
```

파일 끝에 새 describe 추가:

```tsx
describe("TestRunSection runNow handle (U4 §5.5)", () => {
  it("runNow()는 섹션으로 스크롤하고 현재 입력값으로 mutation을 발사한다", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const ref = createRef<TestRunHandle>();
    render(<TestRunSection ref={ref} yamlText={VALID_YAML} />);

    act(() => ref.current!.runNow());

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      scenario_yaml: VALID_YAML,
      max_requests: 50,
      apply_think_time: false,
    });
  });

  it("isPending 중에는 runNow()가 중복 발사하지 않는다", () => {
    isPending = true;
    const ref = createRef<TestRunHandle>();
    render(<TestRunSection ref={ref} yamlText={VALID_YAML} />);
    act(() => ref.current!.runNow());
    expect(mutate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test TestRunSection`
Expected: FAIL — `TestRunHandle` export 부재 / ref 미지원

- [ ] **Step 3: 구현** — `TestRunSection.tsx` 전체를 다음으로 교체 (JSX 본문은 기존과 동일 — 버튼 onClick만 `fire`로, section에 `ref` 추가):

```tsx
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useEnvironment, useTestRun } from "../../api/hooks";
import { resolveEnv, type EnvEntry } from "../../api/envOverlay";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Step } from "../../scenario/model";
import { Button } from "../Button";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { TestRunPanel } from "./TestRunPanel";

export interface TestRunHandle {
  /** 섹션으로 스크롤 + 현재 입력값으로 test-run 1회 발사 — 헤더 "미리 1회 실행" 버튼용 (U4 §5.5). */
  runNow(): void;
}

/** Test-run controls + result panel for a scenario editor buffer. Self-contained
 *  unit whose only input is the live `yamlText` — so both the new-scenario page
 *  and the edit page reuse it (works on an unsaved draft; ephemeral, nothing is
 *  persisted). The `steps` parsed from the buffer feed `TestRunPanel`'s if-row
 *  condition summaries (the `ScenarioTrace` wire contract carries no cond text).
 *  ref 핸들(runNow)은 state 리프트 없이 컴포넌트 API만 확장한다 (spec §5.5). */
export const TestRunSection = forwardRef<TestRunHandle, { yamlText: string }>(
  function TestRunSection({ yamlText }, ref) {
    const testRun = useTestRun();
    const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
    const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
    const [maxRequests, setMaxRequests] = useState<number>(50);
    const [applyThinkTime, setApplyThinkTime] = useState(false);
    const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
    const baseVars = selectedEnv.data?.vars ?? {};
    const rootRef = useRef<HTMLElement | null>(null);

    const traceSteps = useMemo<Step[]>(() => {
      const parsed = parseScenarioDoc(yamlText);
      return "model" in parsed ? parsed.model.steps : [];
    }, [yamlText]);

    const fire = () => {
      if (testRun.isPending) return;
      testRun.mutate({
        scenario_yaml: yamlText,
        env: resolveEnv(baseVars, envEntries),
        max_requests: maxRequests,
        apply_think_time: applyThinkTime,
      });
    };

    // deps 없음 — 매 렌더 재생성으로 최신 state 클로저 유지(stale closure 방지).
    useImperativeHandle(ref, () => ({
      runNow() {
        // jsdom은 scrollIntoView 미구현 — optional call
        rootRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        fire();
      },
    }));

    return (
      <>
        <section
          ref={rootRef}
          aria-label="Test run controls"
          className="flex flex-col gap-3 rounded border border-slate-200 p-4"
        >
          <h3 className="text-lg font-semibold">Test run</h3>
          <EnvironmentPicker
            selectedEnvId={selectedEnvId}
            onSelect={setSelectedEnvId}
            baseVars={baseVars}
            overrides={envEntries}
            onOverridesChange={setEnvEntries}
          />
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-600">Max requests</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={maxRequests}
              onChange={(e) => setMaxRequests(Number(e.target.value))}
              className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={applyThinkTime}
              onChange={(e) => setApplyThinkTime(e.target.checked)}
            />
            <span className="text-slate-600">think time 적용 (천천히 전송)</span>
          </label>
          <div>
            <Button onClick={fire} disabled={testRun.isPending}>
              {testRun.isPending ? "Running…" : "Test run"}
            </Button>
          </div>
          {testRun.error && (
            <p className="text-sm text-red-700">{(testRun.error as Error).message}</p>
          )}
        </section>

        {testRun.data && <TestRunPanel trace={testRun.data} steps={traceSteps} />}
      </>
    );
  },
);
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test TestRunSection`
Expected: PASS — 기존 apply_think_time 2케이스 + 신규 2케이스

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/__tests__/TestRunSection.test.tsx
git commit -m "feat(ui): TestRunSection forwardRef runNow 핸들 — 스크롤+발사 (U4 spec §5.5)"
git log -1 --oneline
```

---

### Task 4: 두 페이지 헤더 "미리 1회 실행" 버튼 배선

**Files:**
- Modify: `ui/src/pages/ScenarioNewPage.tsx`
- Modify: `ui/src/pages/ScenarioEditPage.tsx`
- Test: `ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx`
- Test: `ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx` (mock만 — 아래 Step 4b)

- [ ] **Step 1: 실패하는 테스트 추가** — `ScenarioNewPage.testrun.test.tsx` describe 끝에:

```tsx
  it("헤더 '미리 1회 실행' 버튼이 현재 초안 버퍼로 test-run을 발사한다 (U4)", async () => {
    const user = userEvent.setup();
    renderPage();

    // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.blankName) }),
    );

    await user.click(await screen.findByRole("button", { name: ko.editor.testRunNow }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.scenario_yaml).toContain("Untitled"); // 미저장 초안 버퍼 그대로
  });
```

`ScenarioEditPage.testrun.test.tsx` describe 끝에:

```tsx
  it("헤더 '미리 1회 실행' 버튼이 현재 버퍼로 test-run을 발사한다 (U4)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Save/ });

    await user.click(screen.getByRole("button", { name: ko.editor.testRunNow }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.scenario_yaml).toContain("name: demo");
  });
```

(주: `getByRole("button", { name: ko.editor.testRunNow })`는 정확매치 — HelpTip ⓘ의 accessible name은 `testRunNowHelpLabel`("미리 1회 실행 설명")이라 충돌하지 않는다.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test ScenarioNewPage.testrun && pnpm test ScenarioEditPage.testrun`
Expected: FAIL — "미리 1회 실행" 버튼 부재

- [ ] **Step 3: `ScenarioNewPage.tsx` 배선**

import 변경/추가:

```tsx
import { useCallback, useRef, useState } from "react";
import { HelpTip } from "../components/HelpTip";
import { TestRunSection, type TestRunHandle } from "../components/scenario/TestRunSection";
```

컴포넌트 본문 state 옆에:

```tsx
  const testRunRef = useRef<TestRunHandle>(null);
```

에디터 단계(두 번째 return)의 헤더 버튼 div를 다음으로 교체 (`className`에 `items-center` 추가 — ⓘ 수직 정렬):

```tsx
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => testRunRef.current?.runNow()}>
            {ko.editor.testRunNow}
          </Button>
          <HelpTip label={ko.editor.testRunNowHelpLabel}>{ko.editor.testRunNowHelp}</HelpTip>
          <Button
            onClick={() =>
              mutation.mutate(yamlText, {
                onSuccess: (created) => navigate(`/scenarios/${created.id}`),
              })
            }
            disabled={mutation.isPending || yamlText.trim().length === 0}
          >
            {mutation.isPending ? ko.editor.creating : ko.editor.create}
          </Button>
          <Button variant="secondary" onClick={cancel}>
            {ko.editor.cancel}
          </Button>
        </div>
```

TestRunSection mount에 ref:

```tsx
      <TestRunSection ref={testRunRef} yamlText={yamlText} />
```

(갤러리 단계 return은 무변경 — TestRunSection이 없으니 버튼도 없다.)

- [ ] **Step 4: `ScenarioEditPage.tsx` 배선**

import 변경/추가:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { HelpTip } from "../components/HelpTip";
import { TestRunSection, type TestRunHandle } from "../components/scenario/TestRunSection";
```

state 옆에:

```tsx
  const testRunRef = useRef<TestRunHandle>(null);
```

헤더 버튼 div(`<div className="flex gap-2">`)를 `<div className="flex items-center gap-2">`로 바꾸고 Save 버튼 **앞**에:

```tsx
          <Button variant="secondary" onClick={() => testRunRef.current?.runNow()}>
            {ko.editor.testRunNow}
          </Button>
          <HelpTip label={ko.editor.testRunNowHelpLabel}>{ko.editor.testRunNowHelp}</HelpTip>
```

TestRunSection mount에 ref:

```tsx
      <TestRunSection ref={testRunRef} yamlText={yamlText} />
```

- [ ] **Step 4b: clone 테스트 mock을 forwardRef stub로** — `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx`는 `TestRunSection`을 plain 함수 `() => null`로 mock한다. EditPage가 이제 `ref`를 넘기므로 그대로 두면 매 렌더마다 React dev 경고("Function components cannot be given refs")가 콘솔을 채운다(테스트는 깨지지 않지만 이 repo 기준은 콘솔 0). mock을 다음으로 교체:

```tsx
vi.mock("../../components/scenario/TestRunSection", async () => {
  const { forwardRef } = await import("react");
  return {
    TestRunSection: forwardRef(function TestRunSection() {
      return null;
    }),
  };
});
```

(기존 mock의 정확한 형태는 그 파일에서 확인 — 핵심은 stub을 `forwardRef`로 감싸 ref 수신을 합법화하는 것.)

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test ScenarioNewPage.testrun && pnpm test ScenarioEditPage.testrun`
Expected: PASS — 신규 2케이스 + 기존 헤더 그룹/test-run 케이스 전부 (기존 "groups Create and Cancel"/"groups Save and Runs" 단언은 추가 버튼과 양립)

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && git add ui/src/pages/ScenarioNewPage.tsx ui/src/pages/ScenarioEditPage.tsx ui/src/pages/__tests__/ScenarioNewPage.testrun.test.tsx ui/src/pages/__tests__/ScenarioEditPage.testrun.test.tsx ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx
git commit -m "feat(ui): 에디터 헤더 '미리 1회 실행' 승격 — 두 페이지 배선 (U4 spec §5.5)"
git log -1 --oneline
```

---

## 라이브 검증 체크리스트 (orchestrator — 머지 전, plan task 아님)

1. 워크트리 root에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로** `./target/debug/controller --db /tmp/u4.db --ui-dir ui/dist`(먼저 `cd ui && pnpm build`). Playwright는 인라인 `browser_snapshot`/`browser_evaluate`만(파일 저장 금지).
2. **배너 — 모델 항목**: 시나리오 에디터에서 스텝 추가(시드 url `/`) → 배너에 호스트-없음 항목 → URL 비우면 빈-URL 항목 → 항목 클릭 시 해당 스텝 선택 + 캔버스 탭. URL을 `https://…`로 채우면 배너 소멸.
3. **배너 — 게이트 항목**: YAML 탭에서 `version: 1` 줄을 깨뜨림(예: `version: 2`) → 캔버스 탭으로 돌아와도 배너에 한국어 매핑 문구 + "YAML 탭에서 확인" 버튼 → 클릭 시 YAML 탭 전환. 복구 시 배너 소멸.
4. **미리 1회 실행**: 에디터 헤더 버튼 클릭 → 페이지가 Test run 섹션으로 스크롤 + trace 패널 렌더(실 요청 1회, wiremock 또는 python echo 타깃). 새 시나리오(미저장 초안)·기존 시나리오 편집 두 페이지 모두.
5. 콘솔 Zod/React 에러 0 확인.

## 마무리 (orchestrator)

- `docs/roadmap.md` §A8 U4 완료 표기 + 영역 U 완결 줄, U4 연기 항목 §A8에 추가(있다면).
- 루트 `CLAUDE.md` 상태줄 교체(영역 U 완결), `docs/build-log.md` 한 단락 append, 메모리 갱신.
- handicap-reviewer 최종 whole-feature 리뷰 → master ff-merge(`git -C /Users/sgj/develop/handicap merge --ff-only worktree-ux-u4-validation-banner`) → `ExitWorktree`.
