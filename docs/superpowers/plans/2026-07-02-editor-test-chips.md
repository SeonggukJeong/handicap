# 에디터 테스트 흐름 칩 스트립 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `TestRunSection` 상단에 시나리오 흐름을 가로 flex-wrap 그룹 칩 스트립으로 상시 미러하고, test-run 트레이스로 스텝별 결과(✓/✗/○)를 색+아이콘으로 표시하며, 칩 클릭으로 스텝을 선택한다.

**Architecture:** 순수 파생 모듈(`chipResults.ts` — trace→결과 맵, branch 라벨 단일 소스)과 프레젠테이셔널 컴포넌트(`TestFlowChips.tsx` — 재귀 그룹 칩 렌더)를 새로 만들고, `TestRunSection`이 이미 보유한 `traceSteps`/`testRun.data`/`useScenarioEditor`로 배선만 한다. 백엔드·스키마·store·모델 0-diff (spec R8).

**Tech Stack:** React + TS + Tailwind (신규 의존성 0), vitest + RTL.

**Spec:** `docs/superpowers/specs/2026-07-02-editor-test-chips-design.md` (R1–R9가 정규 요구사항)

## Global Constraints

- **tdd-guard**: 각 task는 **테스트 파일 편집을 가장 먼저**(pending test가 있어야 `ui/src` non-test 편집이 허용됨 — `ui/CLAUDE.md` 게이트 함정). import 미해결로 RED여도 무방.
- **커밋 = 게이트**: pre-commit이 `ui/` staged 커밋마다 `pnpm lint && pnpm test && pnpm build`를 돌린다(`--max-warnings=0`). 개발 중 반복은 `pnpm test <파일명>`(**`--` 없이** — `pnpm test -- X`는 전체 스위트).
- **ADR-0035**: 신규 사용자 노출 문구(aria-label 포함)는 전부 `ko.ts` 경유. 예외: 추출된 branch 라벨(`then`/`elif 0`/`(미매치)`)은 기존 문자열 byte-identical 유지(spec R7).
- **elif 계약(0-based)**: 구조 라벨·타진 매칭 키 = `then` / `elif_${i}`(0-based — 엔진 `select_branch`의 `format!("elif_{j}")`와 1:1) / `else`, 표시 문자열 = `branchText(키)`(첫 elif = "elif 0"). 1-based로 쓰면 off-by-one (spec R3 must-fix 이력).
- **결과 색 = 데이터-식별 도메인**: emerald/red/slate 직접 사용, `accent` 토큰 금지(accent는 선택 링 전용). 아이콘(✓/✗/○)은 `aria-hidden`, 결과는 aria-label 텍스트로(색맹 a11y, spec R5).
- **선택 링**: `border-accent-500 ring-1 ring-accent-500`(FlowOutline 규약). 같은 요소에 `border-*` 2개를 겹치지 말 것 — 선택 시 결과 border를 **교체**(Tailwind 클래스 순서 footgun).
- **무변경 파일(spec R8)**: `crates/**`·`*.proto`·`*.sql`·`ui/src/api/schemas.ts`·`ui/src/scenario/model.ts`·`ui/src/scenario/yamlDoc.ts`·`ui/src/scenario/store.ts` 절대 수정 금지. `TestRunPanel.tsx`는 branch 라벨 추출 import만, `FlowOutline.tsx`는 `METHOD_BADGE` 추출 import만.
- **테스트 fixture의 step id는 26자 ULID**(`model.ts` `ULID_RE` 강제 — I/L/O/U 제외). 비-ULID id는 `parseScenarioDoc`가 조용히 실패해 steps=[]가 된다.
- 리포트 `.md`는 워크트리 루트에 쓰지 말고 지정된 sdd 경로에만, `git add`는 아래 명시된 파일만.

---

### Task 1: `chipResults.ts` — 결과 파생 순수 모듈 + branch 라벨 추출

**Files:**
- Test: `ui/src/scenario/__tests__/chipResults.test.ts` (신규)
- Create: `ui/src/scenario/chipResults.ts`
- Modify: `ui/src/components/scenario/TestRunPanel.tsx` (로컬 `BRANCH_LABEL`/`branchText` 제거 → import)

**Interfaces:**
- Consumes: `ScenarioTrace`/`StepTrace` 타입(`ui/src/api/schemas.ts` — type-only import).
- Produces (Task 2가 사용):
  - `export type ChipResult = { kind: "http"; result: "pass" | "fail" } | { kind: "if"; branches: string[] }`
  - `export function deriveChipResults(trace: ScenarioTrace): Map<string, ChipResult>`
  - `export function branchText(branch: string): string` / `export const BRANCH_LABEL: Record<string, string>`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/chipResults.test.ts` (테스트 파일 먼저 = tdd-guard 해제)

```ts
import { describe, expect, it } from "vitest";
import { branchText, deriveChipResults } from "../chipResults";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";

const httpRow = (over: Partial<StepTrace>): StepTrace => ({
  step_id: "s1",
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "/x", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 1,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
  ...over,
});

const ifRow = (branch: string): StepTrace =>
  httpRow({ step_id: "g1", kind: "if", branch, request: null, response: null });

const trace = (steps: StepTrace[]): ScenarioTrace => ({
  ok: true,
  total_ms: 1,
  steps,
  final_vars: {},
  truncated: false,
  error: null,
});

describe("deriveChipResults (spec R4 ①–⑧)", () => {
  it("① 클린 1행 = pass", () => {
    const m = deriveChipResults(trace([httpRow({})]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "pass" });
  });

  it("② error 행 포함 = fail", () => {
    const m = deriveChipResults(trace([httpRow({ error: "status 200 != 201" })]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("③ status 500 = fail", () => {
    const bad = httpRow({});
    bad.response = { ...bad.response!, status: 500 };
    const m = deriveChipResults(trace([bad]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("④ loop 3행 중 1 fail = fail (순서 무관 집계)", () => {
    const bad = httpRow({ loop_index: 1 });
    bad.response = { ...bad.response!, status: 500 };
    const m = deriveChipResults(
      trace([httpRow({ loop_index: 0 }), bad, httpRow({ loop_index: 2 })]),
    );
    expect(m.get("s1")).toEqual({ kind: "http", result: "fail" });
  });

  it("⑤ 행 없음 = 맵 미포함 (not-run)", () => {
    const m = deriveChipResults(trace([httpRow({})]));
    expect(m.has("other")).toBe(false);
  });

  it("⑥ if 단일 then = branches ['then']", () => {
    const m = deriveChipResults(trace([ifRow("then")]));
    expect(m.get("g1")).toEqual({ kind: "if", branches: ["then"] });
  });

  it("⑦ if then+else 두 행 = 고유 집합 순서 보존", () => {
    const m = deriveChipResults(trace([ifRow("then"), ifRow("else"), ifRow("then")]));
    expect(m.get("g1")).toEqual({ kind: "if", branches: ["then", "else"] });
  });

  it("⑧ 3xx 클린 행 = pass (fail 아님 = 성공, statusClass 3-상태와 의도적 차이)", () => {
    const redirect = httpRow({});
    redirect.response = { ...redirect.response!, status: 304 };
    const m = deriveChipResults(trace([redirect]));
    expect(m.get("s1")).toEqual({ kind: "http", result: "pass" });
  });
});

describe("branchText (TestRunPanel에서 byte-identical 추출)", () => {
  it("elif는 0-based 키를 그대로 표시", () => {
    expect(branchText("elif_0")).toBe("elif 0");
    expect(branchText("elif_2")).toBe("elif 2");
  });
  it("none = (미매치), then/else = 원문", () => {
    expect(branchText("none")).toBe("(미매치)");
    expect(branchText("then")).toBe("then");
    expect(branchText("else")).toBe("else");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test chipResults`
Expected: FAIL — `Cannot find module '../chipResults'`

- [ ] **Step 3: `ui/src/scenario/chipResults.ts` 구현**

```ts
import type { ScenarioTrace } from "../api/schemas";

// TestRunPanel에서 추출한 branch 라벨 단일 소스 — 문자열 byte-identical(spec R3).
// 키는 엔진 select_branch의 값 그대로: "then" / "elif_{j}"(0-based) / "else" / "none".
export const BRANCH_LABEL: Record<string, string> = {
  none: "(미매치)",
  then: "then",
  else: "else",
};

export function branchText(branch: string): string {
  if (BRANCH_LABEL[branch]) return BRANCH_LABEL[branch];
  const m = /^elif_(\d+)$/.exec(branch);
  return m ? `elif ${m[1]}` : branch;
}

export type ChipResult =
  | { kind: "http"; result: "pass" | "fail" }
  | { kind: "if"; branches: string[] };

/** 마지막 test-run trace에서 스텝별 칩 결과를 파생한다(spec R4).
 *  http: 같은 step_id 행 중 하나라도 error∥status≥400 → fail, 아니면 pass
 *  (statusClass의 fail 판정과 동일 기준 — 3xx 클린 행은 pass).
 *  if: 타진 branch 고유 집합(순서 보존 — loop 안 if는 반복마다 다른 분기 가능).
 *  맵에 없는 step_id = 이번 실행에서 행 없음 = 미실행(○). */
export function deriveChipResults(trace: ScenarioTrace): Map<string, ChipResult> {
  const out = new Map<string, ChipResult>();
  for (const row of trace.steps) {
    if (row.kind === "if") {
      const prev = out.get(row.step_id);
      const branches = prev?.kind === "if" ? prev.branches : [];
      if (row.branch != null && !branches.includes(row.branch)) branches.push(row.branch);
      out.set(row.step_id, { kind: "if", branches });
      continue;
    }
    const failed = row.error != null || (row.response != null && row.response.status >= 400);
    const prev = out.get(row.step_id);
    const wasFail = prev?.kind === "http" && prev.result === "fail";
    out.set(row.step_id, { kind: "http", result: failed || wasFail ? "fail" : "pass" });
  }
  return out;
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test chipResults`
Expected: PASS (10 tests)

- [ ] **Step 5: `TestRunPanel.tsx`에서 라벨 제거 → import 교체**

`ui/src/components/scenario/TestRunPanel.tsx`의 로컬 정의(현재 `:226-236`)를 삭제:

```tsx
// 삭제할 블록:
const BRANCH_LABEL: Record<string, string> = {
  none: "(미매치)",
  then: "then",
  else: "else",
};

function branchText(branch: string): string {
  if (BRANCH_LABEL[branch]) return BRANCH_LABEL[branch];
  const m = /^elif_(\d+)$/.exec(branch);
  return m ? `elif ${m[1]}` : branch;
}
```

그리고 상단 import에 추가(기존 `../../scenario/model` import 근처):

```tsx
import { branchText } from "../../scenario/chipResults";
```

- [ ] **Step 6: 기존 패널 테스트 green 확인**

Run: `cd ui && pnpm test TestRunPanel`
Expected: PASS (기존 branch 라벨 단언 — "(미매치)" 등 — 전부 유지)

- [ ] **Step 7: Commit** (pre-commit이 lint+test+build 전체 게이트를 돌림 — 수 분, 단일 FOREGROUND 호출·타임아웃 600000ms·폴링 금지)

```bash
git add ui/src/scenario/chipResults.ts ui/src/scenario/__tests__/chipResults.test.ts ui/src/components/scenario/TestRunPanel.tsx
git commit -m "feat(ui): chipResults 결과 파생 모듈 + branch 라벨 단일 소스 추출 (spec R3/R4)"
```

---

### Task 2: `TestFlowChips` 컴포넌트 + `METHOD_BADGE` 공유 추출 + ko 키

**Files:**
- Test: `ui/src/components/scenario/__tests__/TestFlowChips.test.tsx` (신규)
- Create: `ui/src/components/scenario/TestFlowChips.tsx`, `ui/src/components/scenario/methodBadge.ts`
- Modify: `ui/src/components/scenario/FlowOutline.tsx` (로컬 `METHOD_BADGE` 제거 → import), `ui/src/i18n/ko.ts` (editor 섹션 신규 키)

**Interfaces:**
- Consumes: Task 1의 `deriveChipResults`/`branchText`/`ChipResult`; `isLoopStep`/`isIfStep`/`isParallelStep`/`Step`(`ui/src/scenario/model.ts`); `ScenarioTrace`(`ui/src/api/schemas.ts`).
- Produces (Task 3이 사용): `export function TestFlowChips(props: { steps: ReadonlyArray<Step>; trace: ScenarioTrace | null; selectedStepId: string | null; onSelect: (id: string) => void }): JSX.Element | null`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/components/scenario/__tests__/TestFlowChips.test.tsx`

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestFlowChips } from "../TestFlowChips";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import type { ScenarioTrace, StepTrace } from "../../../api/schemas";

// loop/if(elif·else 포함)/parallel 전 유형 fixture. id는 유효 ULID 필수(model.ts ULID_RE).
const CHIP_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000010"
    name: gate
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: confirm
        type: http
        request:
          method: POST
          url: "/confirm"
    elif:
      - cond:
          left: "{{code}}"
          op: eq
          right: "500"
        then:
          - id: "01HX0000000000000000000012"
            name: alt
            type: http
            request:
              method: GET
              url: "/alt"
    else:
      - id: "01HX0000000000000000000013"
        name: cancel
        type: http
        request:
          method: GET
          url: "/cancel"
  - id: "01HX0000000000000000000020"
    name: retry
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000021"
        name: ping
        type: http
        request:
          method: GET
          url: "/ping"
  - id: "01HX0000000000000000000030"
    name: fan
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000031"
            name: get-user
            type: http
            request:
              method: GET
              url: "/user"
      - name: feed
        steps:
          - id: "01HX0000000000000000000032"
            name: get-feed
            type: http
            request:
              method: GET
              url: "/feed"
`;

const parsed = parseScenarioDoc(CHIP_YAML);
if (!("model" in parsed)) throw new Error("fixture must parse");
const STEPS = parsed.model.steps;

const httpRow = (step_id: string, over?: Partial<StepTrace>): StepTrace => ({
  step_id,
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "/x", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 1,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
  ...over,
});

const failRow = (step_id: string, loop_index: number | null): StepTrace => {
  const r = httpRow(step_id, { loop_index });
  r.response = { ...r.response!, status: 500 };
  return r;
};

const ifRow = (step_id: string, branch: string): StepTrace =>
  httpRow(step_id, { kind: "if", branch, request: null, response: null });

const mkTrace = (steps: StepTrace[]): ScenarioTrace => ({
  ok: false,
  total_ms: 5,
  steps,
  final_vars: {},
  truncated: false,
  error: null,
});

// login pass · gate → elif_0 타짐 · alt pass · ping 2회 중 1 fail · get-user pass.
// confirm/cancel/get-feed는 행 없음(미실행 ○).
const TRACE = mkTrace([
  httpRow("01HX0000000000000000000001"),
  ifRow("01HX0000000000000000000010", "elif_0"),
  httpRow("01HX0000000000000000000012"),
  httpRow("01HX0000000000000000000021", { loop_index: 0 }),
  failRow("01HX0000000000000000000021", 1),
  httpRow("01HX0000000000000000000031"),
]);

const noop = () => {};

describe("TestFlowChips — 구조 (spec R2)", () => {
  it("컨테이너 그룹 안에 자식 칩이 중첩되고 최상위 구분자 수 = 최상위 스텝 - 1", () => {
    const { container } = render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    const loopGroup = container.querySelector('[data-group="01HX0000000000000000000020"]');
    expect(loopGroup).not.toBeNull();
    expect(within(loopGroup as HTMLElement).getByTitle("ping")).toBeInTheDocument();
    // 라벨: glyph(aria-hidden) + 이름 + × 2
    expect(within(loopGroup as HTMLElement).getByText("× 2")).toBeInTheDocument();
    // parallel 그룹: 분기명 라벨 + 자식
    const parGroup = container.querySelector('[data-group="01HX0000000000000000000030"]');
    expect(within(parGroup as HTMLElement).getByText("user:")).toBeInTheDocument();
    expect(within(parGroup as HTMLElement).getByTitle("get-feed")).toBeInTheDocument();
    // 최상위 4개 → 구분자 3개 (밴드 라벨 "→then:"은 단일 텍스트 노드라 exact "→"에 안 걸림)
    expect(screen.getAllByText("→")).toHaveLength(3);
    // 빈 steps → null 렌더
    const empty = render(
      <TestFlowChips steps={[]} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    expect(empty.container.firstChild).toBeNull();
  });
});

describe("TestFlowChips — run 전 플레인 미러 (spec R4/R5)", () => {
  it("trace 없음 = 아이콘·결과 접미 없는 플레인 칩", () => {
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(screen.queryByText("✓")).not.toBeInTheDocument();
    expect(screen.queryByText("✗")).not.toBeInTheDocument();
    expect(screen.queryByText("○")).not.toBeInTheDocument();
    // aria-label = 이름만
    expect(screen.getByRole("button", { name: "login" })).toBeInTheDocument();
  });
});

describe("TestFlowChips — 결과 색/아이콘/aria (spec R4/R5)", () => {
  it("pass/fail/not-run 3상태의 클래스와 aria-label", () => {
    render(<TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />);
    const pass = screen.getByRole("button", { name: "login — 성공" });
    expect(pass.className).toContain("border-emerald-300");
    const fail = screen.getByRole("button", { name: "ping — 실패" }); // loop 2행 중 1 fail 집계
    expect(fail.className).toContain("border-red-300");
    const notRun = screen.getByRole("button", { name: "get-feed — 미실행" });
    expect(notRun.className).toContain("border-slate-200");
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(screen.getAllByText("○").length).toBeGreaterThanOrEqual(3); // confirm·cancel·get-feed
  });
});

describe("TestFlowChips — if 분기 라벨 (spec R3)", () => {
  it("타진 elif_0 라벨은 → 접두 + 강조, 안 타진 then/else는 dimmed", () => {
    render(<TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />);
    const taken = screen.getByText("→elif 0:");
    expect(taken.className).toContain("text-violet-700");
    expect(screen.getByText("then:").className).toContain("text-slate-300");
    expect(screen.getByText("else:").className).toContain("text-slate-300");
  });

  it("branch none 행 = 그룹 라벨 옆 (미매치) 표지", () => {
    const noneTrace = mkTrace([ifRow("01HX0000000000000000000010", "none")]);
    render(<TestFlowChips steps={STEPS} trace={noneTrace} selectedStepId={null} onSelect={noop} />);
    expect(screen.getByText("(미매치)")).toBeInTheDocument();
  });

  it("parallel 분기 라벨은 trace 유무와 무관하게 동일(중립) 클래스", () => {
    const a = render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    const before = within(a.container).getByText("user:").className;
    a.unmount();
    const b = render(
      <TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />,
    );
    const after = within(b.container).getByText("user:").className;
    expect(after).toBe(before);
  });
});

describe("TestFlowChips — 클릭/선택 (spec R6)", () => {
  it("http 칩 클릭 → onSelect(id); 컨테이너 라벨 클릭 → onSelect(컨테이너 id)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "login" }));
    expect(onSelect).toHaveBeenCalledWith("01HX0000000000000000000001");
    await user.click(screen.getByRole("button", { name: /retry/ }));
    expect(onSelect).toHaveBeenCalledWith("01HX0000000000000000000020");
  });

  it("selectedStepId 칩만 accent 링 (클릭 대상 = 링 대상)", () => {
    render(
      <TestFlowChips
        steps={STEPS}
        trace={null}
        selectedStepId={"01HX0000000000000000000001"}
        onSelect={noop}
      />,
    );
    const selected = screen.getByRole("button", { name: "login" });
    expect(selected.className).toContain("ring-accent-500");
    expect(selected.className).toContain("border-accent-500");
    const other = screen.getByTitle("confirm").closest("button");
    expect(other?.className).not.toContain("ring-accent-500");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test TestFlowChips`
Expected: FAIL — `Cannot find module '../TestFlowChips'`

- [ ] **Step 3: `ui/src/components/scenario/methodBadge.ts` 생성 + `FlowOutline.tsx` import 교체**

신규 `ui/src/components/scenario/methodBadge.ts`:

```ts
// 데이터-식별 팔레트(메서드별) — accent 토큰과 별개 도메인(ui/CLAUDE.md 디자인시스템 노트).
// FlowOutline(아웃라인 행)·TestFlowChips(테스트 흐름 칩)가 공유 — 시각 어휘 단일 소스.
export const METHOD_BADGE: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-violet-100 text-violet-700",
  DELETE: "bg-red-100 text-red-700",
  HEAD: "bg-slate-100 text-slate-600",
  OPTIONS: "bg-slate-100 text-slate-600",
};
```

`FlowOutline.tsx`: 로컬 `const METHOD_BADGE = {...}` 블록(현재 `:35-44`)을 삭제하고 import 추가:

```tsx
import { METHOD_BADGE } from "./methodBadge";
```

- [ ] **Step 4: `ui/src/i18n/ko.ts` — editor 섹션에 신규 키 추가** (test-run 키 그룹 근처)

```ts
// ── 테스트 흐름 칩 스트립 (B13 슬라이스 2) ──
testFlowTitle: "테스트 흐름",
chipAriaPass: (name: string) => `${name} — 성공`,
chipAriaFail: (name: string) => `${name} — 실패`,
chipAriaNotRun: (name: string) => `${name} — 미실행`,
```

- [ ] **Step 5: `ui/src/components/scenario/TestFlowChips.tsx` 구현**

```tsx
import { Fragment, useMemo } from "react";
import type { ScenarioTrace } from "../../api/schemas";
import { isIfStep, isLoopStep, isParallelStep, type Step } from "../../scenario/model";
import { branchText, deriveChipResults, type ChipResult } from "../../scenario/chipResults";
import { METHOD_BADGE } from "./methodBadge";
import { ko } from "../../i18n/ko";

// 결과 상태별 칩 표면 — 데이터-식별 도메인(accent 토큰 금지, TestRunPanel emerald/red 계열 통일).
// border는 선택 링과 충돌하므로 표면과 분리: 선택 시 결과 border를 SELECTED_RING으로 *교체*
// (같은 요소에 border-* 2개를 겹치면 Tailwind 스타일시트 순서에 좌우된다 — spec §4.2).
type ChipState = "plain" | "pass" | "fail" | "notRun";
const CHIP_BORDER: Record<ChipState, string> = {
  plain: "border-slate-300",
  pass: "border-emerald-300",
  fail: "border-red-300",
  notRun: "border-slate-200",
};
const CHIP_SURFACE: Record<ChipState, string> = {
  plain: "bg-white text-slate-800",
  pass: "bg-emerald-50 text-emerald-900",
  fail: "bg-red-50 text-red-900",
  notRun: "bg-slate-50 text-slate-400",
};
const CHIP_ICON: Record<Exclude<ChipState, "plain">, string> = {
  pass: "✓",
  fail: "✗",
  notRun: "○",
};
// 선택 링(클릭 대상 = 링 대상) — FlowOutline 행과 동일 규약(spec R6).
const SELECTED_RING = "border-accent-500 ring-1 ring-accent-500";

function chipAria(name: string, state: ChipState): string {
  if (state === "pass") return ko.editor.chipAriaPass(name);
  if (state === "fail") return ko.editor.chipAriaFail(name);
  if (state === "notRun") return ko.editor.chipAriaNotRun(name);
  return name;
}

interface NodeProps {
  step: Step;
  results: Map<string, ChipResult> | null;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}

// 분기 밴드(구조 키 = 엔진 select_branch와 1:1 — then/elif_{i}(0-based)/else).
// taken: true=타짐(violet 강조+→), false=안 타짐(run 후 dimmed), null=중립(loop 본문·parallel 분기).
function containerBands(
  step: Step,
): { key: string; label: string | null; children: Step[] }[] {
  if (isLoopStep(step)) return [{ key: "do", label: null, children: step.do }];
  if (isIfStep(step)) {
    return [
      { key: "then", label: branchText("then"), children: step.then },
      ...step.elif.map((e, i) => ({
        key: `elif_${i}`,
        label: branchText(`elif_${i}`),
        children: e.then,
      })),
      ...(step.else.length > 0
        ? [{ key: "else", label: branchText("else"), children: step.else }]
        : []),
    ];
  }
  if (isParallelStep(step)) {
    return step.branches.map((b) => ({ key: b.name, label: b.name, children: b.steps }));
  }
  return [];
}

function ChipNode({ step, results, selectedStepId, onSelect }: NodeProps) {
  const selected = step.id === selectedStepId;

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    const r = results?.get(step.id);
    const taken = r?.kind === "if" ? r.branches : [];
    const hasIfResult = r?.kind === "if";
    const glyph = isLoopStep(step) ? "⟳" : isIfStep(step) ? "⎇" : "⇉";
    return (
      <span
        data-group={step.id}
        className="inline-flex flex-wrap items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-1"
      >
        <button
          type="button"
          onClick={() => onSelect(step.id)}
          className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ${selected ? SELECTED_RING : "border-transparent"}`}
        >
          <span aria-hidden="true">{glyph}</span>
          <span className="max-w-[8rem] truncate" title={step.name}>
            {step.name}
          </span>
          {isLoopStep(step) && <span className="shrink-0">× {step.repeat}</span>}
          {taken.includes("none") && (
            <span className="shrink-0 text-violet-700">{branchText("none")}</span>
          )}
        </button>
        {containerBands(step).map((b) => {
          const isTaken = hasIfResult && taken.includes(b.key);
          const isDimmed = hasIfResult && !taken.includes(b.key) && isIfStep(step);
          return (
            <Fragment key={b.key}>
              {b.label != null && (
                <span
                  className={`shrink-0 text-[11px] font-semibold ${
                    isTaken ? "text-violet-700" : isDimmed ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {isTaken ? "→" : ""}
                  {b.label}:
                </span>
              )}
              {b.children.map((c) => (
                <ChipNode
                  key={c.id}
                  step={c}
                  results={results}
                  selectedStepId={selectedStepId}
                  onSelect={onSelect}
                />
              ))}
            </Fragment>
          );
        })}
      </span>
    );
  }

  // http leaf
  const r = results?.get(step.id);
  const state: ChipState =
    results == null ? "plain" : r?.kind === "http" ? (r.result === "fail" ? "fail" : "pass") : "notRun";
  return (
    <button
      type="button"
      aria-label={chipAria(step.name, state)}
      onClick={() => onSelect(step.id)}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${selected ? SELECTED_RING : CHIP_BORDER[state]} ${CHIP_SURFACE[state]}`}
    >
      <span
        className={`shrink-0 rounded px-1 text-[10px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}
      >
        {step.request.method}
      </span>
      <span className="max-w-[10rem] truncate" title={step.name}>
        {step.name}
      </span>
      {state !== "plain" && <span aria-hidden="true">{CHIP_ICON[state]}</span>}
    </button>
  );
}

/** 시나리오 흐름을 가로 flex-wrap 그룹 칩으로 미러하는 상시 스트립(spec R1/R2).
 *  run 전 = 플레인 미러, run 후 = deriveChipResults로 스텝별 ✓/✗/○(spec R4/R5).
 *  칩 클릭 = onSelect(stepId) — 부모가 store select로 배선(spec R6). */
export function TestFlowChips({
  steps,
  trace,
  selectedStepId,
  onSelect,
}: {
  steps: ReadonlyArray<Step>;
  trace: ScenarioTrace | null;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}) {
  const results = useMemo(() => (trace ? deriveChipResults(trace) : null), [trace]);
  if (steps.length === 0) return null;
  return (
    <div role="group" aria-label={ko.editor.testFlowTitle} className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{ko.editor.testFlowTitle}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 && (
              <span aria-hidden="true" className="text-slate-300">
                →
              </span>
            )}
            <ChipNode step={s} results={results} selectedStepId={selectedStepId} onSelect={onSelect} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test TestFlowChips`
Expected: PASS (8 tests)

Run: `cd ui && pnpm test FlowOutline`
Expected: PASS (METHOD_BADGE 추출 후 기존 아웃라인 테스트 green)

- [ ] **Step 7: Commit** (단일 FOREGROUND 호출·타임아웃 600000ms)

```bash
git add ui/src/components/scenario/TestFlowChips.tsx ui/src/components/scenario/methodBadge.ts ui/src/components/scenario/__tests__/TestFlowChips.test.tsx ui/src/components/scenario/FlowOutline.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): TestFlowChips 그룹 칩 스트립 컴포넌트 + METHOD_BADGE 공유 추출 (spec R2/R3/R5/R6)"
```

---

### Task 3: `TestRunSection` 배선 + 섹션 테스트 + 전수 검증

**Files:**
- Test: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx` (갱신)
- Modify: `ui/src/components/scenario/TestRunSection.tsx`

**Interfaces:**
- Consumes: Task 2의 `TestFlowChips`; 기존 `useScenarioEditor`(`selectedStepId` 셀렉터 + `getState().select`).
- Produces: 없음(최종 배선).

- [ ] **Step 1: 기존 테스트 파일에 신규 테스트·mock 갱신 먼저** — `TestRunSection.test.tsx`

파일 상단의 store mock을 교체(기존 `addStepExtract`만 있던 것에 `select` 스파이와 셀렉터 지원 추가 — 기존 `const mutate = vi.fn();` 패턴과 동일하게 mock 위에 선언):

```tsx
// 교체 전:
vi.mock("../../../scenario/store", () => ({
  useScenarioEditor: Object.assign(
    vi.fn(() => undefined),
    {
      getState: () => ({ addStepExtract: vi.fn() }),
    },
  ),
}));

// 교체 후:
const select = vi.fn();
vi.mock("../../../scenario/store", () => ({
  useScenarioEditor: Object.assign(
    vi.fn((selector?: (s: { selectedStepId: string | null }) => unknown) =>
      selector ? selector({ selectedStepId: null }) : undefined,
    ),
    {
      getState: () => ({ addStepExtract: vi.fn(), select }),
    },
  ),
}));
```

`beforeEach`에 `select.mockReset();` 추가. 파일 끝에 신규 describe 추가:

```tsx
// 스트립 렌더용 fixture — id는 유효 ULID 필수(비-ULID면 parseScenarioDoc가 실패해 스트립이 안 뜸)
const CHIP_YAML = `version: 1
name: s
steps:
  - id: "01HX0000000000000000000001"
    name: ping
    type: http
    request:
      method: GET
      url: http://x/ping
`;

describe("TestRunSection flow chip strip (spec R1/R6)", () => {
  it("파싱 가능한 버퍼면 스트립을 렌더하고 칩 클릭이 store select로 배선된다", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={CHIP_YAML} />);
    expect(screen.getByRole("group", { name: "테스트 흐름" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ping" }));
    expect(select).toHaveBeenCalledWith("01HX0000000000000000000001");
  });

  it("파싱 불가 버퍼면 스트립을 렌더하지 않는다", () => {
    render(<TestRunSection yamlText={"version: ["} />);
    expect(screen.queryByRole("group", { name: "테스트 흐름" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test TestRunSection`
Expected: 신규 2 테스트 FAIL(스트립 미렌더), 기존 테스트 PASS 유지

- [ ] **Step 3: `TestRunSection.tsx` 배선**

컴포넌트 상단(기존 state 선언들 옆)에 셀렉터 구독 추가:

```tsx
const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
```

import에 `TestFlowChips` 추가:

```tsx
import { TestFlowChips } from "./TestFlowChips";
```

JSX에서 인트로 문단(`{ko.editor.testRunIntro}</p>`) 바로 아래·`<EnvironmentPicker` 위에 마운트:

```tsx
<TestFlowChips
  steps={traceSteps}
  trace={testRun.data ?? null}
  selectedStepId={selectedStepId ?? null}
  onSelect={(id) => useScenarioEditor.getState().select(id)}
/>
```

그 외 로직(파싱 memo·mutation·패널 배선) 무변경(spec R8).

- [ ] **Step 4: GREEN + 전체 스위트**

Run: `cd ui && pnpm test TestRunSection`
Expected: PASS (기존 + 신규 2)

Run: `cd ui && pnpm test`
Expected: 전체 PASS (targeted-green ≠ full-green 함정 — 머지 전 전체 1회 필수)

- [ ] **Step 5: R7/R8 전수 검증 grep**

```bash
# R8: 무변경 경로 (전부 출력 없음이어야 함)
git diff master...HEAD --name-only | grep -E '^crates/|\.proto$|\.sql$' || echo "R8 paths OK"
git diff master...HEAD -- ui/src/api/schemas.ts ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts
# → 출력 없음 = OK

# R7: 신규 컴포넌트 하드코딩 문구 (ko 경유·branchText 경유·glyph·메서드명 외 0)
grep -n '"[가-힣]' ui/src/components/scenario/TestFlowChips.tsx ui/src/scenario/chipResults.ts
# → chipResults.ts의 BRANCH_LABEL("(미매치)" — byte-identical 추출, R7 허용 예외)만 나와야 함
```

- [ ] **Step 6: Commit** (단일 FOREGROUND 호출·타임아웃 600000ms)

```bash
git add ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/__tests__/TestRunSection.test.tsx
git commit -m "feat(ui): TestRunSection에 테스트 흐름 칩 스트립 배선 (spec R1/R6/R8)"
```

---

## 구현 후 (오케스트레이터 체크리스트 — implementer 범위 밖)

1. **최종 whole-feature 리뷰**: `handicap-reviewer` APPROVE (+ `finish-slice` §0 보안 표면 grep — 이 슬라이스는 요청실행/템플릿/env/업로드/trace-뷰어 *변경* 없음이라 N/A 예상).
2. **라이브 검증**(spec §6, `/live-verify` + Playwright): responder 상대 시나리오(성공 + assertion 실패 + if 분기 + loop)로 test-run 실행 → ① 칩 ✓/✗/○ 색 실측(클래스 + screenshot + `getBoundingClientRect` 높이 > 0) ② 좁은 뷰포트 flex-wrap 줄바꿈 ③ 칩 클릭 → 디테일 편집기에 해당 스텝 폼 ④ run 전 플레인 미러.
3. `/finish-slice`: build-log 단락·roadmap-status B13 frontier 전진·CLAUDE 상태줄 교체·메모리 → ff-merge → `ExitWorktree`.
