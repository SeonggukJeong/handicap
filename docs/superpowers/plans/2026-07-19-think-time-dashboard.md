# think-time 현황판 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터에 모달 현황판을 추가해 전 http 스텝의 think-time 설정 상태와 **실효 대기 시간**을 한 표로 보이고, 행별 편집 + 체크박스 다중선택 일괄 3액션으로 그 자리에서 고치게 한다.

**Architecture:** 판정 로직은 순수 모듈 `ui/src/scenario/thinkTime.ts` 하나(엔진 규칙의 UI 미러 단일 소스). 표시·편집은 `ThinkTimeBoard.tsx` 모달이 담당하고 EditorShell 헤더 툴바에서 연다. 일괄 편집만 새 `Edit` 변형 `setStepsThinkTime` 1개로 **단일 트랜잭션**(doc mutation 1회 → reparse 1회 → `set` 1회), 행별 편집은 기존 `setStepField`를 그대로 쓴다.

**Tech Stack:** React 18 + TypeScript(strict) + Zustand + Zod + `yaml` Document API + Tailwind + vitest/RTL.

**Spec:** `docs/superpowers/specs/2026-07-19-think-time-dashboard-design.md` (spec-plan-reviewer clean APPROVE, 커밋 `3c69889`)

## Global Constraints

모든 task의 요구사항에 암묵적으로 포함된다.

- **문구**: 사용자 노출 문자열은 **`aria-label`·`title` 포함 전부** `ui/src/i18n/ko.ts`의 `ko.editor.*` 경유(ADR-0035). 컴포넌트에 한국어 리터럴 하드코딩 금지.
- **게이트**: 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 3개 전부. `pnpm lint`는 `--max-warnings=0`이라 경고 1개도 실패이고, **미사용 `eslint-disable` directive도 에러**다. `pnpm test`(esbuild)는 TS strict 에러를 놓치므로 `pnpm build`(`tsc -b`)가 최종 게이트.
- **게이트 판정에 파이프 금지**: `pnpm test | tail`은 실패를 마스킹한다. `pnpm test; echo exit=$?`로 종료코드를 명시 확인.
- **tsconfig `lib` = ES2022** — `findLast`/`toSorted` 등 ES2023 배열 메서드 금지(`pnpm test`는 통과하고 `pnpm build`만 잡는다).
- **`as any` 금지**(`no-explicit-any` + `--max-warnings=0`). 타입이 안 맞으면 타입을 고친다.
- **tdd-guard**: `ui/src/**`(non-test) 편집 전에 워킹트리에 pending test 파일이 있어야 한다 → **모든 task는 테스트 파일 편집으로 시작**한다. import 미해결로 RED여도 무방.
- **셀렉터 인라인 fallback 금지**: `useScenarioEditor((s) => s.model?.steps ?? [])`는 매 스냅샷 새 객체를 만들어 "getSnapshot should be cached" 경고/무한 렌더를 부른다. 모듈 스코프 상수를 쓴다.
- **0-diff 유지 (건드리면 안 되는 것)**: `crates/**` 전부 · `ui/src/api/**` · `ui/src/components/Modal.tsx` · `ui/src/components/scenario/ScenarioDefaults.tsx` · `EditorShell`의 레이아웃·그리드 분기(헤더 버튼 1개 + 모달 마운트 1줄만 추가).
- **판별 union 내로잉은 중간 boolean 변수를 통과하지 못한다** — JSX 조건 렌더는 인라인 판별 체크로.
- 커밋 메시지 말미에 다음 2줄을 붙인다:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Fh1phoT63ZezQFuMVBeQR6
  ```

---

### Task 1: 판정·행 모델 순수 모듈 `thinkTime.ts`

**Files:**
- Create: `ui/src/scenario/thinkTime.ts`
- Test: `ui/src/scenario/__tests__/thinkTime.test.ts`

**Interfaces:**
- Consumes: `ui/src/scenario/model.ts`의 `HttpStep`·`Step`·`Scenario`·`ThinkTime` 타입, `ui/src/i18n/ko.ts`의 `ko.editor.condThen`·`elifLabel`·`condElse`.
- Produces (Task 3·4·5가 그대로 import한다):
  - `type ThinkState = "inherited" | "inherited_none" | "override" | "no_wait" | "parallel_unset"`
  - `type ThinkRow = { stepId: string; name: string; method: string; url: string; path: string; state: ThinkState; configured: ThinkTime | undefined; effective: ThinkTime | undefined; insideParallel: boolean }`
  - `classifyThink(step: HttpStep, defaultThink: ThinkTime | undefined, insideParallel: boolean): { state: ThinkState; effective: ThinkTime | undefined; insideParallel: boolean }`
  - `buildThinkRows(sc: Scenario): ThinkRow[]`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다** (tdd-guard unblock)

Create `ui/src/scenario/__tests__/thinkTime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildThinkRows, classifyThink, type ThinkState } from "../thinkTime";
import type { HttpStep, Scenario, Step, ThinkTime } from "../model";

const ID = (n: number) => `01HX00000000000000000000${String(n).padStart(2, "0")}`;

function http(n: number, name: string, think?: ThinkTime): HttpStep {
  return {
    id: ID(n),
    name,
    type: "http",
    request: { method: "GET", url: `/p${n}`, headers: {} },
    assert: [],
    extract: [],
    ...(think ? { think_time: think } : {}),
  } as unknown as HttpStep;
}

function scenario(steps: Step[], def?: ThinkTime): Scenario {
  return {
    version: 1,
    name: "demo",
    cookie_jar: "auto",
    variables: {},
    steps,
    ...(def ? { default_think_time: def } : {}),
  } as unknown as Scenario;
}

const T = { min_ms: 200, max_ms: 500 };
const ZERO = { min_ms: 0, max_ms: 0 };

describe("classifyThink — 3×3×2 전조합", () => {
  // [think_time, default, insideParallel] → [state, effective]
  const cases: Array<[ThinkTime | undefined, ThinkTime | undefined, boolean, ThinkState, ThinkTime | undefined]> = [
    // think_time 없음
    [undefined, undefined, false, "inherited_none", undefined],
    [undefined, ZERO, false, "inherited", undefined], // R1-a2: 기본값 {0,0} → 대기없음
    [undefined, T, false, "inherited", T],
    [undefined, undefined, true, "parallel_unset", undefined],
    [undefined, ZERO, true, "parallel_unset", undefined],
    [undefined, T, true, "parallel_unset", undefined],
    // think_time = {0,0}
    [ZERO, undefined, false, "no_wait", undefined],
    [ZERO, ZERO, false, "no_wait", undefined],
    [ZERO, T, false, "no_wait", undefined],
    [ZERO, undefined, true, "no_wait", undefined],
    [ZERO, ZERO, true, "no_wait", undefined],
    [ZERO, T, true, "no_wait", undefined],
    // think_time = {200,500}
    [T, undefined, false, "override", T],
    [T, ZERO, false, "override", T],
    [T, T, false, "override", T],
    [T, undefined, true, "override", T],
    [T, ZERO, true, "override", T],
    [T, T, true, "override", T],
  ];

  it.each(cases)(
    "think=%o default=%o parallel=%s → %s",
    (think, def, inPar, expectedState, expectedEff) => {
      const r = classifyThink(http(1, "s", think), def, inPar);
      expect(r.state).toBe(expectedState);
      expect(r.effective).toEqual(expectedEff);
      expect(r.insideParallel).toBe(inPar);
    },
  );

  it("R1-a2: 기본값 {0,0} 상속과 스텝 {0,0}은 같은 실효값(undefined)이다", () => {
    const inherited = classifyThink(http(1, "a"), ZERO, false);
    const own = classifyThink(http(2, "b", ZERO), undefined, false);
    expect(inherited.state).toBe("inherited");
    expect(own.state).toBe("no_wait");
    expect(inherited.effective).toBeUndefined();
    expect(own.effective).toBeUndefined();
  });

  it("분기 안의 {0,0}은 parallel_unset이 아니라 no_wait다", () => {
    expect(classifyThink(http(1, "a", ZERO), T, true).state).toBe("no_wait");
  });
});

describe("buildThinkRows", () => {
  it("아웃라인과 같은 깊이우선 순서로 전 http leaf를 낸다", () => {
    const sc = scenario([
      http(1, "first"),
      {
        id: ID(2),
        name: "반복",
        type: "loop",
        repeat: 2,
        do: [http(3, "in-loop")],
      },
      {
        id: ID(4),
        name: "조건",
        type: "if",
        cond: { left: "{{x}}", op: "eq", right: "1" },
        then: [http(5, "then-step")],
        elif: [{ cond: { left: "{{y}}", op: "eq", right: "2" }, then: [http(6, "elif-step")] }],
        else: [http(7, "else-step")],
      },
      {
        id: ID(8),
        name: "동시",
        type: "parallel",
        branches: [
          { name: "b1", steps: [http(9, "par-a")] },
          { name: "b2", steps: [http(10, "par-b")] },
        ],
      },
    ] as unknown as Step[]);

    expect(buildThinkRows(sc).map((r) => r.name)).toEqual([
      "first",
      "in-loop",
      "then-step",
      "elif-step",
      "else-step",
      "par-a",
      "par-b",
    ]);
  });

  it("경로 라벨 — loop / if 3밴드(1-based elif) / parallel 분기", () => {
    const sc = scenario([
      http(1, "top"),
      { id: ID(2), name: "반복", type: "loop", repeat: 2, do: [http(3, "L")] },
      {
        id: ID(4),
        name: "조건",
        type: "if",
        cond: { left: "{{x}}", op: "eq", right: "1" },
        then: [http(5, "TH")],
        elif: [{ cond: { left: "{{y}}", op: "eq", right: "2" }, then: [http(6, "EL")] }],
        else: [http(7, "ES")],
      },
      { id: ID(8), name: "동시", type: "parallel", branches: [{ name: "b1", steps: [http(9, "P")] }] },
    ] as unknown as Step[]);

    const byName = Object.fromEntries(buildThinkRows(sc).map((r) => [r.name, r.path]));
    expect(byName["top"]).toBe("");
    expect(byName["L"]).toBe("반복");
    expect(byName["TH"]).toBe("조건·Then");
    expect(byName["EL"]).toBe("조건·Elif 1"); // 1-based
    expect(byName["ES"]).toBe("조건·Else");
    expect(byName["P"]).toBe("동시·b1");
  });

  it("parallel 분기 안 스텝만 parallel_unset이 된다", () => {
    const sc = scenario(
      [
        http(1, "seq"),
        { id: ID(2), name: "동시", type: "parallel", branches: [{ name: "b1", steps: [http(3, "par")] }] },
      ] as unknown as Step[],
      T,
    );
    const rows = buildThinkRows(sc);
    expect(rows.find((r) => r.name === "seq")?.state).toBe("inherited");
    expect(rows.find((r) => r.name === "par")?.state).toBe("parallel_unset");
    expect(rows.find((r) => r.name === "par")?.effective).toBeUndefined();
  });

  it("insideParallel 플래그 — 분기 안만 true (loop 안 if는 false)", () => {
    const sc = scenario([
      http(1, "seq"),
      {
        id: ID(2),
        name: "반복",
        type: "loop",
        repeat: 2,
        do: [
          {
            id: ID(3),
            name: "조건",
            type: "if",
            cond: { left: "{{x}}", op: "eq", right: "1" },
            then: [http(4, "nested")],
            elif: [],
            else: [],
          },
        ],
      },
      { id: ID(5), name: "동시", type: "parallel", branches: [{ name: "b1", steps: [http(6, "par")] }] },
    ] as unknown as Step[]);
    const by = Object.fromEntries(buildThinkRows(sc).map((r) => [r.name, r.insideParallel]));
    expect(by["seq"]).toBe(false);
    expect(by["nested"]).toBe(false); // loop 안 if — 경로에 구분자가 있지만 분기가 아니다
    expect(by["par"]).toBe(true);
  });

  it("configured는 정규화하지 않는다 (입력 시드는 원본 그대로)", () => {
    const sc = scenario([http(1, "z", ZERO)] as unknown as Step[]);
    expect(buildThinkRows(sc)[0].configured).toEqual(ZERO);
    expect(buildThinkRows(sc)[0].effective).toBeUndefined();
  });

  it("http leaf가 없으면 빈 배열", () => {
    expect(buildThinkRows(scenario([]))).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test thinkTime; echo exit=$?
```
Expected: FAIL — `Failed to resolve import "../thinkTime"` (모듈 없음).

- [ ] **Step 3: 모듈 구현**

Create `ui/src/scenario/thinkTime.ts`:

```ts
import { ko } from "../i18n/ko";
import type { HttpStep, Scenario, Step, ThinkTime } from "./model";

/** 스텝의 think-time 설정 상태 5종. 엔진(`runner.rs`/`trace.rs`)의 적용 규칙을 그대로
 *  미러한다 — 여기가 틀리면 현황판이 거짓 부하 정보를 보여준다.
 *  - inherited      : think_time 없음 · 분기 밖 · 기본값 있음   → 실효 = 기본값(0,0이면 대기없음)
 *  - inherited_none : think_time 없음 · 분기 밖 · 기본값 없음   → 실효 = 대기없음
 *  - override       : 값 있음 (0,0 아님)                        → 실효 = 그 값
 *  - no_wait        : 값 = {0,0}                                → 실효 = 대기없음
 *  - parallel_unset : think_time 없음 · 분기 안 (ADR-0033 기본값 미적용) → 실효 = 대기없음 */
export type ThinkState = "inherited" | "inherited_none" | "override" | "no_wait" | "parallel_unset";

export type ThinkRow = {
  stepId: string;
  name: string;
  method: string;
  url: string;
  /** 조상 경로 라벨(" / " 연결) — 최상위면 "". */
  path: string;
  state: ThinkState;
  /** min/max 입력 시드값 — 원본 그대로(정규화하지 않는다). 설정 열 배지는 `state`가 그린다. */
  configured: ThinkTime | undefined;
  /** 실효 대기 — undefined = 대기없음 (R1-a2 정규화 후). */
  effective: ThinkTime | undefined;
  /** parallel 분기 서브트리 안인가. 일괄 [상속으로]의 병렬 안내 카운트(R5)가 이걸 쓴다 —
   *  경로 문자열로 유추하면 안 된다(loop 안 if 경로에도 구분자가 들어간다). */
  insideParallel: boolean;
};

/** {0,0}은 출처와 무관하게 "대기없음"으로 정규화한다(R1-a2). 엔진의 `pace(0)`은
 *  즉시 `Slept`를 반환하므로(`pacing.rs:56-57`) 대기 자체가 없는 것과 구별 불가능하다.
 *  이걸 안 하면 스텝 {0,0}은 "대기없음", 상속된 {0,0}은 "0–0ms"로 같은 동작이 두 문자열이 된다. */
function normalizeEffective(t: ThinkTime): ThinkTime | undefined {
  return t.min_ms === 0 && t.max_ms === 0 ? undefined : t;
}

export function classifyThink(
  step: HttpStep,
  defaultThink: ThinkTime | undefined,
  insideParallel: boolean,
): { state: ThinkState; effective: ThinkTime | undefined; insideParallel: boolean } {
  const own = step.think_time;
  if (own !== undefined) {
    const state: ThinkState = own.min_ms === 0 && own.max_ms === 0 ? "no_wait" : "override";
    return { state, effective: normalizeEffective(own), insideParallel };
  }
  if (insideParallel) {
    return { state: "parallel_unset", effective: undefined, insideParallel };
  }
  if (defaultThink === undefined) {
    return { state: "inherited_none", effective: undefined, insideParallel };
  }
  return { state: "inherited", effective: normalizeEffective(defaultThink), insideParallel };
}

/** 전 http leaf를 아웃라인과 같은 깊이우선 순서로 낸다. `flattenHttpSteps`도 같은 순서를
 *  주지만 조상 경로를 잃으므로(그것만이 이 walker가 따로 있는 이유다) 여기서 다시 내려간다. */
export function buildThinkRows(sc: Scenario): ThinkRow[] {
  const out: ThinkRow[] = [];
  const visit = (steps: ReadonlyArray<Step>, path: ReadonlyArray<string>, insideParallel: boolean) => {
    for (const s of steps) {
      if (s.type === "http") {
        const c = classifyThink(s, sc.default_think_time, insideParallel);
        out.push({
          stepId: s.id,
          name: s.name,
          method: s.request.method,
          url: s.request.url,
          path: path.join(" / "),
          state: c.state,
          configured: s.think_time,
          effective: c.effective,
          insideParallel: c.insideParallel,
        });
      } else if (s.type === "loop") {
        visit(s.do, [...path, s.name], insideParallel);
      } else if (s.type === "parallel") {
        // 분기 서브트리에는 시나리오 기본값이 적용되지 않는다(ADR-0033) — insideParallel=true.
        for (const b of s.branches) visit(b.steps, [...path, `${s.name}·${b.name}`], true);
      } else {
        visit(s.then, [...path, `${s.name}·${ko.editor.condThen}`], insideParallel);
        s.elif.forEach((e, i) =>
          // elifLabel은 1-based (Inspector.tsx:1440/1452 · FlowOutline.tsx:206과 동일).
          visit(e.then, [...path, `${s.name}·${ko.editor.elifLabel(i + 1)}`], insideParallel),
        );
        visit(s.else, [...path, `${s.name}·${ko.editor.condElse}`], insideParallel);
      }
    }
  };
  visit(sc.steps, [], false);
  return out;
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test thinkTime; echo exit=$?
```
Expected: PASS (전 케이스 green, exit=0).

- [ ] **Step 5: 게이트 3종 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git add ui/src/scenario/thinkTime.ts ui/src/scenario/__tests__/thinkTime.test.ts
git commit -m "feat(ui): think-time 판정·행 모델 순수 모듈 (thinkTime.ts)"
```

---

### Task 2: 일괄 편집 와이어 — `setStepsThinkTime` Edit + store 액션

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts` (`Edit` 유니온 `:30-` 에 변형 추가, `applyEdit` `:133-` 에 case 추가)
- Modify: `ui/src/scenario/store.ts` (인터페이스 + 액션 + import 1개)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts` (기존 파일에 describe 추가)

**Interfaces:**
- Consumes: Task 1은 필요 없다(독립). 기존 `findStepPath`(`yamlDoc.ts:662`), `flattenHttpSteps`(`model.ts`), `dispatch`(store 모듈 private).
- Produces (Task 4가 쓴다): store 액션 `setStepsThinkTime(stepIds: ReadonlyArray<string>, value: ThinkTime | undefined): void`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`ui/src/scenario/__tests__/yamlDoc.test.ts` 파일 **끝에** 다음 describe를 추가한다. (파일 상단의 기존 `VALID_YAML`·import를 재사용하되, 이 describe는 자체 픽스처를 쓴다.)

```ts
describe("setStepsThinkTime (일괄 think-time)", () => {
  const MULTI = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
default_think_time:
  min_ms: 200
  max_ms: 500
steps:
  - id: "01HX0000000000000000000001"
    name: "a"
    type: http
    request:
      method: GET
      url: "/a"
  # keep-me: 형제 주석
  - id: "01HX0000000000000000000002"
    name: "b"
    type: http
    request:
      method: GET
      url: "/b"
  - id: "01HX0000000000000000000003"
    name: "loop"
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000004"
        name: "c"
        type: http
        request:
          method: GET
          url: "/c"
`;

  const parse = (yaml: string) => {
    const r = parseScenarioDoc(yaml);
    if ("error" in r) throw new Error(`fixture parse failed: ${r.error}`);
    return r;
  };

  const applyTo = (yaml: string, edit: Edit) => {
    const { doc } = parse(yaml);
    applyEdit(doc, edit);
    return serializeDoc(doc);
  };

  it("지정한 id만 바뀌고 나머지는 보존된다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000004"],
      value: { min_ms: 300, max_ms: 800 },
    });
    const sc = parse(out).model;
    const rows = sc.steps;
    expect(rows[0].type === "http" && rows[0].think_time).toEqual({ min_ms: 300, max_ms: 800 });
    expect(rows[1].type === "http" && rows[1].think_time).toBeUndefined();
    expect(rows[2].type === "loop" && rows[2].do[0].think_time).toEqual({ min_ms: 300, max_ms: 800 });
  });

  it("value undefined면 think_time 키가 사라진다", () => {
    const seeded = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000002"],
      value: { min_ms: 10, max_ms: 20 },
    });
    expect(seeded).toContain("think_time");

    const cleared = applyTo(seeded, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000002"],
      value: undefined,
    });
    expect(cleared).not.toContain("think_time:");
  });

  it("빈 stepIds는 문서를 바꾸지 않는다", () => {
    const out = applyTo(MULTI, { type: "setStepsThinkTime", stepIds: [], value: { min_ms: 1, max_ms: 2 } });
    expect(out).toBe(serializeDoc(parse(MULTI).doc));
  });

  it("존재하지 않는 id가 섞여도 나머지는 정상 적용된다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000009", "01HX0000000000000000000002"],
      value: { min_ms: 5, max_ms: 5 },
    });
    const sc = parse(out).model;
    expect(sc.steps[1].type === "http" && sc.steps[1].think_time).toEqual({ min_ms: 5, max_ms: 5 });
  });

  it("형제 주석을 보존한다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000002"],
      value: { min_ms: 7, max_ms: 9 },
    });
    expect(out).toContain("keep-me: 형제 주석");
  });
});

describe("store.setStepsThinkTime (http leaf 필터)", () => {
  const YAML_WITH_LOOP = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000003"
    name: "loop"
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000004"
        name: "c"
        type: http
        request:
          method: GET
          url: "/c"
`;

  it("컨테이너 id는 걸러져 doc/model divergence가 생기지 않는다", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    // 루프 컨테이너 id만 넘긴다 — 필터가 없으면 컨테이너에 think_time을 써서 Zod가 거부한다.
    useScenarioEditor.getState().setStepsThinkTime(["01HX0000000000000000000003"], { min_ms: 1, max_ms: 2 });
    const s = useScenarioEditor.getState();
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).not.toContain("think_time");
  });

  it("http leaf id는 정상 적용된다", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    useScenarioEditor.getState().setStepsThinkTime(["01HX0000000000000000000004"], { min_ms: 1, max_ms: 2 });
    const s = useScenarioEditor.getState();
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).toContain("think_time");
  });

  it("yamlError 상태에서는 무변이다 (편집 게이트)", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const before = useScenarioEditor.getState().yamlText;
    useScenarioEditor.getState().setStepsThinkTime(["01HX0000000000000000000004"], { min_ms: 1, max_ms: 2 });
    expect(useScenarioEditor.getState().yamlText).toBe(before);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test yamlDoc; echo exit=$?
```
Expected: FAIL — `setStepsThinkTime`이 `Edit` 유니온에 없어 타입/런타임 에러.

- [ ] **Step 3: `Edit` 유니온에 변형 추가**

`ui/src/scenario/yamlDoc.ts`의 `Edit` 유니온에서 `setDefaultThinkTime` 줄 **바로 아래**에 추가한다:

```ts
  | { type: "setDefaultThinkTime"; value: ThinkTime | undefined }
  | {
      type: "setStepsThinkTime";
      stepIds: ReadonlyArray<string>;
      value: ThinkTime | undefined;
    }
```

- [ ] **Step 4: `applyEdit`에 case 추가**

`ui/src/scenario/yamlDoc.ts`의 `case "setStepField"` 블록 **바로 뒤**에 추가한다:

```ts
    case "setStepsThinkTime": {
      // setStepField와 같은 경로 로직을 id마다 반복한다. 모든 mutation이 이 함수 안에서
      // 끝난 뒤 dispatch가 한 번만 재파싱·커밋하므로 관측 가능한 부분 적용 상태가 없다.
      for (const stepId of edit.stepIds) {
        const path = findStepPath(doc, stepId);
        if (path === null) continue; // 못 찾은 id는 조용히 건너뛴다
        const full: Array<string | number> = [...path, "think_time"];
        if (edit.value === undefined) {
          doc.deleteIn(full);
        } else {
          doc.setIn(full, doc.createNode(edit.value));
        }
      }
      return;
    }
```

- [ ] **Step 5: store 인터페이스에 액션 시그니처 추가**

`ui/src/scenario/store.ts`의 `ScenarioEditorState` 인터페이스에서 `setDefaultThinkTime` 줄 바로 아래에 추가한다:

```ts
  setDefaultThinkTime(value: ThinkTime | undefined): void;
  /** 여러 http 스텝의 think_time을 한 트랜잭션으로 설정/삭제(현황판 일괄 액션). */
  setStepsThinkTime(stepIds: ReadonlyArray<string>, value: ThinkTime | undefined): void;
```

- [ ] **Step 6: store 액션 구현 + import 추가**

`ui/src/scenario/store.ts`의 `./model` import 블록에 `flattenHttpSteps`를 추가한다:

```ts
import {
  type Extract,
  type Scenario,
  type Condition,
  type ThinkTime,
  findStepById,
  flattenHttpSteps,
  isParallelStep,
  topAncestorIndex,
} from "./model";
```

그리고 `setDefaultThinkTime` 액션 바로 아래에 구현을 추가한다:

```ts
  setStepsThinkTime(stepIds, value) {
    const model = get().model;
    if (!model) return; // 빈 교집합과 같은 결과(no-op)
    // http leaf 필터(필수 가드): findStepPath는 타입을 가리지 않으므로 컨테이너 id가
    // 섞이면 컨테이너 노드에 think_time을 써서 .strict() Zod가 거부하고,
    // dispatch는 doc을 이미 변형한 뒤라 doc-mutated/model-stale divergence가 남는다.
    const allowed = new Set(flattenHttpSteps(model.steps).map((s) => s.id));
    const filtered = stepIds.filter((id) => allowed.has(id));
    if (filtered.length === 0) return;
    dispatch(set, get, { type: "setStepsThinkTime", stepIds: filtered, value });
  },
```

- [ ] **Step 7: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test yamlDoc; echo exit=$?
```
Expected: PASS.

- [ ] **Step 8: 게이트 3종 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): setStepsThinkTime 일괄 Edit + http leaf 필터 store 액션"
```

---

### Task 3: 읽기 전용 현황판 모달 + 헤더 진입점

**Files:**
- Create: `ui/src/components/scenario/ThinkTimeBoard.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.editor.*` 키 추가)
- Modify: `ui/src/components/scenario/EditorShell.tsx` (헤더 버튼 1개 + 모달 마운트 1줄 + state 1개)
- Test: `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `buildThinkRows`·`ThinkRow`·`ThinkState`. 기존 `Modal`(`components/Modal.tsx`), `Badge`(`components/ui/Badge.tsx`), `METHOD_BADGE`(`components/scenario/methodBadge.ts`), `HelpTip`(`components/HelpTip.tsx`), `useScenarioEditor`.
- Produces (Task 4가 확장한다): `export function ThinkTimeBoard({ open, onClose }: { open: boolean; onClose: () => void })`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

Create `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`:

```tsx
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThinkTimeBoard } from "../ThinkTimeBoard";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
default_think_time:
  min_ms: 200
  max_ms: 500
steps:
  - id: "01HX0000000000000000000001"
    name: "로그인"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000002"
    name: "주문"
    type: http
    think_time:
      min_ms: 800
      max_ms: 900
    request:
      method: GET
      url: "/order"
  - id: "01HX0000000000000000000005"
    name: "즉시"
    type: http
    think_time:
      min_ms: 0
      max_ms: 0
    request:
      method: GET
      url: "/now"
  - id: "01HX0000000000000000000003"
    name: "동시"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000004"
            name: "이미지"
            type: http
            request:
              method: GET
              url: "/img"
`;

function table() {
  return screen.getByRole("table", { name: ko.editor.thinkBoardTableAria });
}
function row(name: string) {
  return within(table()).getByRole("row", { name: new RegExp(name) });
}

beforeEach(() => {
  useScenarioEditor.getState().loadFromString(YAML);
});

describe("ThinkTimeBoard — 읽기", () => {
  it("open=false면 아무것도 렌더하지 않는다", () => {
    render(<ThinkTimeBoard open={false} onClose={() => {}} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("전 http leaf가 아웃라인 순서로 행이 된다 (컨테이너는 행이 아니다)", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const bodyRows = within(table()).getAllByRole("row").slice(1); // 헤더 제외
    expect(bodyRows.map((r) => within(r).getByTestId("step-name").textContent)).toEqual([
      "로그인",
      "주문",
      "즉시",
      "이미지",
    ]);
  });

  it("상속 행 — 배지 '상속' + 실효 대기 200–500ms", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("로그인");
    expect(within(r).getByText(ko.editor.thinkStateInherited)).toBeInTheDocument();
    expect(within(r).getByTestId("effective")).toHaveTextContent("200–500ms");
  });

  it("지정 행 — 배지 '지정' + 실효 대기 800–900ms", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("주문");
    expect(within(r).getByText(ko.editor.thinkStateOverride)).toBeInTheDocument();
    expect(within(r).getByTestId("effective")).toHaveTextContent("800–900ms");
  });

  it("{0,0} 행 — 배지 '대기없음' + 실효 대기 '대기없음'", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("즉시");
    expect(within(r).getByText(ko.editor.thinkStateNoWait)).toBeInTheDocument();
    expect(within(r).getByTestId("effective")).toHaveTextContent(ko.editor.thinkNoWait);
  });

  it("US3: 병렬 분기 행은 '미적용' 배지 + 실효 '대기없음' (긍정 단언)", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("이미지");
    expect(within(r).getByText(ko.editor.thinkStateParallelUnset)).toBeInTheDocument();
    expect(within(r).getByTestId("effective")).toHaveTextContent(ko.editor.thinkNoWait);
    expect(within(r).queryByText(ko.editor.thinkStateInherited)).not.toBeInTheDocument();
    expect(within(r).getByTestId("step-path")).toHaveTextContent("동시·b1");
  });

  it("min === max여도 범위 형식을 유지한다 (별도 분기 없음, spec R2)", () => {
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000001", ["think_time"], { min_ms: 250, max_ms: 250 });
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(within(row("로그인")).getByTestId("effective")).toHaveTextContent("250–250ms");
  });

  it("기본값 요약 줄을 보여준다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.getByTestId("default-summary")).toHaveTextContent("200–500ms");
  });

  it("스텝이 없으면 빈 상태 문구", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: "e"
cookie_jar: auto
variables: {}
steps: []
`);
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.getByText(ko.editor.thinkBoardEmpty)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test ThinkTimeBoard; echo exit=$?
```
Expected: FAIL — `Failed to resolve import "../ThinkTimeBoard"`.

- [ ] **Step 3: ko 키 추가**

`ui/src/i18n/ko.ts`의 `parallelNoDefaultNote` 줄 **바로 아래**(Inspector think time 3상태 블록 뒤)에 추가한다:

```ts
    // ── think-time 현황판 (think-time-dashboard) ──
    thinkBoardOpen: "페이싱",
    thinkBoardOpenAria: "think time 현황판 열기",
    thinkBoardTitle: "페이싱 현황판",
    thinkBoardTableAria: "스텝별 think time",
    thinkBoardEmpty: "스텝이 없습니다. 스텝을 추가하면 여기에 페이싱 설정이 표시됩니다.",
    thinkBoardColStep: "스텝",
    thinkBoardColState: "설정",
    thinkBoardColMin: "min",
    thinkBoardColMax: "max",
    thinkBoardColReset: "되돌리기",
    thinkBoardColEffective: "실효 대기",
    thinkStateInherited: "상속",
    thinkStateInheritedNone: "기본값 없음",
    thinkStateOverride: "지정",
    thinkStateNoWait: "대기없음",
    thinkStateParallelUnset: "미적용",
    thinkNoWait: "대기없음",
    thinkRange: (min: number, max: number) => `${min}–${max}ms`,
    thinkBoardDefaultSummary: (min: number, max: number) => `시나리오 기본값 ${min}–${max}ms`,
    thinkBoardDefaultNone: "시나리오 기본값 없음",
    thinkBoardDefaultZero: "시나리오 기본값 대기없음",
```

- [ ] **Step 4: 모달 컴포넌트 구현 (읽기 전용)**

Create `ui/src/components/scenario/ThinkTimeBoard.tsx`:

```tsx
import { useMemo } from "react";
import { Modal } from "../Modal";
import { Badge } from "../ui/Badge";
import { HelpTip } from "../HelpTip";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { buildThinkRows, type ThinkRow, type ThinkState } from "../../scenario/thinkTime";
import { METHOD_BADGE } from "./methodBadge";
import type { ThinkTime } from "../../scenario/model";

const STATE_LABEL: Record<ThinkState, string> = {
  inherited: ko.editor.thinkStateInherited,
  inherited_none: ko.editor.thinkStateInheritedNone,
  override: ko.editor.thinkStateOverride,
  no_wait: ko.editor.thinkStateNoWait,
  parallel_unset: ko.editor.thinkStateParallelUnset,
};

const STATE_TONE: Record<ThinkState, "neutral" | "accent" | "optional" | "warn"> = {
  inherited: "neutral",
  inherited_none: "optional",
  override: "accent",
  no_wait: "optional",
  parallel_unset: "warn",
};

function effectiveText(t: ThinkTime | undefined): string {
  return t === undefined ? ko.editor.thinkNoWait : ko.editor.thinkRange(t.min_ms, t.max_ms);
}

function defaultSummary(def: ThinkTime | undefined): string {
  if (def === undefined) return ko.editor.thinkBoardDefaultNone;
  if (def.min_ms === 0 && def.max_ms === 0) return ko.editor.thinkBoardDefaultZero;
  return ko.editor.thinkBoardDefaultSummary(def.min_ms, def.max_ms);
}

function BoardRow({ row }: { row: ThinkRow }) {
  return (
    <tr className="border-t border-slate-100">
      <td className="min-w-0 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
              METHOD_BADGE[row.method] ?? METHOD_BADGE.HEAD
            }`}
          >
            {row.method}
          </span>
          <span className="min-w-0 truncate" title={`${row.path ? `${row.path} / ` : ""}${row.name}`}>
            {row.path && (
              <span data-testid="step-path" className="text-slate-400">
                {row.path}
                {" / "}
              </span>
            )}
            <span data-testid="step-name">{row.name}</span>
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-1">
        <span className="inline-flex items-center gap-1">
          <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
          {row.state === "parallel_unset" && (
            <HelpTip label={ko.editor.defaultThinkParallelHelpLabel}>
              {ko.editor.defaultThinkParallelHelp}
            </HelpTip>
          )}
        </span>
      </td>
      <td
        data-testid="effective"
        className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-600"
      >
        {effectiveText(row.effective)}
      </td>
    </tr>
  );
}

/** 스텝별 think-time 현황판(모달). 판정은 전부 `thinkTime.ts`가 소유한다 —
 *  이 컴포넌트는 표시만 한다. */
export function ThinkTimeBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const model = useScenarioEditor((s) => s.model);
  const rows = useMemo(() => (model ? buildThinkRows(model) : []), [model]);

  return (
    <Modal open={open} onClose={onClose} title={ko.editor.thinkBoardTitle}>
      <p data-testid="default-summary" className="mb-2 text-sm text-slate-600">
        {defaultSummary(model?.default_think_time)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.editor.thinkBoardEmpty}</p>
      ) : (
        <table
          aria-label={ko.editor.thinkBoardTableAria}
          className="w-full table-fixed text-sm"
        >
          <thead>
            <tr className="text-left text-xs font-semibold text-slate-500">
              <th className="px-2 py-1">{ko.editor.thinkBoardColStep}</th>
              <th className="w-32 px-2 py-1">{ko.editor.thinkBoardColState}</th>
              <th className="w-28 px-2 py-1 text-right">{ko.editor.thinkBoardColEffective}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <BoardRow key={r.stepId} row={r} />
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
```

- [ ] **Step 5: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test ThinkTimeBoard; echo exit=$?
```
Expected: PASS.

- [ ] **Step 6: EditorShell 헤더 진입점 배선**

`ui/src/components/scenario/EditorShell.tsx`:

(a) import 추가 — 기존 `import { ScenarioDefaults } from "./ScenarioDefaults";` 아래:

```tsx
import { ThinkTimeBoard } from "./ThinkTimeBoard";
```

(b) state 추가 — `const [yamlOpen, setYamlOpen] = useState(false);` 아래:

```tsx
  const [thinkBoardOpen, setThinkBoardOpen] = useState(false);
```

(c) 헤더 버튼 추가 — `◧ 변수 넓게` 버튼(`aria-pressed={varsWide}`인 버튼)의 닫는 `</button>` **바로 뒤**, 툴바 `</div>` 앞:

```tsx
        <button
          type="button"
          aria-label={ko.editor.thinkBoardOpenAria}
          onClick={() => setThinkBoardOpen(true)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">⏱</span> {ko.editor.thinkBoardOpen}
        </button>
```

(d) 모달 마운트 — 파일 끝의 스텝 디테일 `<Modal>` **바로 뒤**, 최상위 `</div>` 앞:

```tsx
      <ThinkTimeBoard open={thinkBoardOpen} onClose={() => setThinkBoardOpen(false)} />
```

**주의**: 그리드 분기(`className` 삼항 3종)와 `<aside>`/`<FlowOutline>`/`<Inspector>` 블록은 **한 글자도 건드리지 않는다**.

- [ ] **Step 7: EditorShell 진입점 테스트 추가**

`ui/src/components/scenario/__tests__/EditorShell.test.tsx`에 케이스를 추가한다(파일의 기존 render 헬퍼·import 패턴을 그대로 따를 것 — 파일을 먼저 읽고 그 관용구에 맞춘다):

```tsx
  it("헤더 툴바의 페이싱 버튼이 현황판을 연다", async () => {
    const user = userEvent.setup();
    // (이 파일의 기존 render 헬퍼로 EditorShell을 마운트한다)
    await user.click(screen.getByRole("button", { name: ko.editor.thinkBoardOpenAria }));
    expect(screen.getByRole("dialog", { name: ko.editor.thinkBoardTitle })).toBeInTheDocument();
  });
```

- [ ] **Step 8: 게이트 3종 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`. `ScenarioDefaults.test.tsx`는 **무변경**으로 통과해야 한다.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git add ui/src/components/scenario/ThinkTimeBoard.tsx ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): think-time 현황판 읽기 뷰 + 헤더 진입점"
```

---

### Task 4: 행별 편집 + 선택 + 일괄 3액션 + 병렬 안내 + yamlError 게이트

**Files:**
- Modify: `ui/src/components/scenario/ThinkTimeBoard.tsx` (편집 열·체크박스·액션 바 추가)
- Modify: `ui/src/i18n/ko.ts` (편집/일괄 키 추가)
- Test: `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx` (describe 추가)

**Interfaces:**
- Consumes: Task 2의 store 액션 `setStepsThinkTime`, 기존 `setStepField`, Task 3의 `ThinkTimeBoard`·`ThinkRow`.
- Produces: 없음(최종 UI).

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`ThinkTimeBoard.test.tsx`에 다음 describe를 추가한다(파일 상단의 `YAML`·`table()`·`row()` 헬퍼 재사용, `userEvent` import 추가):

```tsx
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";

function minInput(name: string) {
  return within(row(name)).getByLabelText(ko.editor.thinkBoardRowMinAria);
}
function maxInput(name: string) {
  return within(row(name)).getByLabelText(ko.editor.thinkBoardRowMaxAria);
}
function stepThink(id: string) {
  const m = useScenarioEditor.getState().model;
  const s = m?.steps.find((x) => x.id === id);
  return s && s.type === "http" ? s.think_time : undefined;
}

describe("ThinkTimeBoard — 행별 편집", () => {
  it("min/max를 채우고 blur하면 커밋된다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("로그인"));
    await user.type(minInput("로그인"), "300");
    await user.clear(maxInput("로그인"));
    await user.type(maxInput("로그인"), "800");
    fireEvent.blur(maxInput("로그인"));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 300, max_ms: 800 });
  });

  it("둘 다 비우면 상속으로 되돌아간다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("주문"));
    await user.clear(maxInput("주문"));
    fireEvent.blur(maxInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toBeUndefined();
  });

  it("정확히 한 칸만 비면 no-op — 모델이 안 바뀐다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("주문"));
    fireEvent.blur(minInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 800, max_ms: 900 });
  });

  it("R3 회귀: 다른 행의 커밋이 이 행에 반쯤 친 값을 지우지 않는다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // B행("로그인")에 min만 입력해 둔다
    await user.clear(minInput("로그인"));
    await user.type(minInput("로그인"), "123");
    // A행("주문")에서 값을 바꾸고 커밋
    await user.clear(maxInput("주문"));
    await user.type(maxInput("주문"), "950");
    fireEvent.blur(maxInput("주문"));
    // B행의 draft가 살아 있어야 한다
    expect(minInput("로그인")).toHaveValue(123);
  });

  it("× 버튼이 상속으로 되돌린다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.click(within(row("주문")).getByRole("button", { name: ko.editor.thinkBoardResetAria }));
    expect(stepThink("01HX0000000000000000000002")).toBeUndefined();
  });
});

describe("ThinkTimeBoard — 일괄", () => {
  const selectRow = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(within(row(name)).getByRole("checkbox"));

  it("선택이 0이면 액션 바가 없다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.queryByRole("group", { name: ko.editor.thinkBoardBulkAria })).not.toBeInTheDocument();
  });

  it("전체선택 → [대기없음으로] → 전 행이 {0,0}", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: ko.editor.thinkBoardSelectAllAria }));
    await user.click(screen.getByRole("button", { name: ko.editor.thinkBoardBulkNoWait }));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 0, max_ms: 0 });
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 0, max_ms: 0 });
  });

  it("US2: 선택 행만 적용되고 비선택 행은 무변화", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "300");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "800");
    await user.click(screen.getByRole("button", { name: ko.editor.thinkBoardBulkApply }));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 300, max_ms: 800 });
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 800, max_ms: 900 });
  });

  it("[적용]은 잘못된 입력에서 disabled (빈칸 / min>max / 600001)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    const apply = screen.getByRole("button", { name: ko.editor.thinkBoardBulkApply });
    expect(apply).toBeDisabled(); // 빈칸

    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "500");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "100");
    expect(apply).toBeDisabled(); // min > max

    await user.clear(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria));
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "600001");
    expect(apply).toBeDisabled(); // 상한 초과
  });

  it("US4: 값이 지정된 병렬 행을 포함해 선택하면 안내가 뜨고 [상속으로]는 활성", async () => {
    // 병렬 분기 스텝에 값을 넣어 n>=1을 만든다
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000004", ["think_time"], { min_ms: 50, max_ms: 60 });
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "이미지");
    await selectRow(user, "로그인");
    expect(screen.getByRole("status")).toHaveTextContent(ko.editor.thinkBoardParallelWarn(1));
    expect(screen.getByRole("button", { name: ko.editor.thinkBoardBulkInherit })).toBeEnabled();
  });

  it("US4: 순차 행만 선택하면 안내가 없다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("이미 미설정인 병렬 행은 n에 안 세진다 (no-op 행 제외)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "이미지"); // think_time 없음 = parallel_unset
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("R4: 부분 선택이면 전체선택 체크박스가 indeterminate다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const all = screen.getByRole("checkbox", {
      name: ko.editor.thinkBoardSelectAllAria,
    }) as HTMLInputElement;
    expect(all.indeterminate).toBe(false);
    await selectRow(user, "로그인");
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
    await user.click(all); // 전체선택
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);
  });

  it("R4: 모달을 닫으면 선택과 일괄 입력이 버려진다", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "300");
    expect(screen.getByRole("group", { name: ko.editor.thinkBoardBulkAria })).toBeInTheDocument();

    rerender(<ThinkTimeBoard open={false} onClose={() => {}} />);
    rerender(<ThinkTimeBoard open onClose={() => {}} />);

    expect(screen.queryByRole("group", { name: ko.editor.thinkBoardBulkAria })).not.toBeInTheDocument();
    expect(
      (screen.getByRole("checkbox", { name: ko.editor.thinkBoardSelectAllAria }) as HTMLInputElement)
        .indeterminate,
    ).toBe(false);
  });
});

describe("ThinkTimeBoard — R6 깨진 YAML 게이트", () => {
  it("yamlError면 입력·체크박스가 전부 disabled", () => {
    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(minInput("로그인")).toBeDisabled();
    expect(maxInput("로그인")).toBeDisabled();
    expect(within(row("로그인")).getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: ko.editor.thinkBoardSelectAllAria })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test ThinkTimeBoard; echo exit=$?
```
Expected: FAIL — 편집 열·체크박스·액션 바가 없어 쿼리 실패.

- [ ] **Step 3: ko 키 추가**

Task 3에서 추가한 블록 끝에 이어서 추가한다:

```ts
    thinkBoardRowMinAria: "이 스텝 think 최솟값 (ms)",
    thinkBoardRowMaxAria: "이 스텝 think 최댓값 (ms)",
    thinkBoardResetAria: "상속으로 되돌리기",
    thinkBoardSelectAllAria: "전체 선택",
    thinkBoardSelectRowAria: (name: string) => `${name} 선택`,
    thinkBoardBulkAria: "선택한 스텝 일괄 적용",
    thinkBoardBulkMinAria: "일괄 think 최솟값 (ms)",
    thinkBoardBulkMaxAria: "일괄 think 최댓값 (ms)",
    thinkBoardBulkApply: "적용",
    thinkBoardBulkInherit: "상속으로",
    thinkBoardBulkNoWait: "대기없음으로",
    thinkBoardSelectedCount: (n: number) => `${n}개 선택`,
    thinkBoardParallelWarn: (n: number) =>
      `선택에 병렬 분기 스텝 ${n}개 — 상속으로 되돌리면 대기없음이 됩니다.`,
```

- [ ] **Step 4: 행 편집 셀 구현**

`ThinkTimeBoard.tsx`의 `BoardRow`를 교체한다. **재시드 dep은 반드시 원시값**이다:

```tsx
function BoardRow({
  row,
  selected,
  onToggle,
  disabled,
}: {
  row: ThinkRow;
  selected: boolean;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [minDraft, setMinDraft] = useState(row.configured ? String(row.configured.min_ms) : "");
  const [maxDraft, setMaxDraft] = useState(row.configured ? String(row.configured.max_ms) : "");

  // dep은 원시값이어야 한다. `row.configured`(객체)를 쓰면 buildThinkRows가 useMemo([model])라
  // 표 어디서든 한 번 커밋될 때마다 모든 행이 재시드되어, 다른 행에 반쯤 친 값이 사라진다.
  const cfgMin = row.configured?.min_ms;
  const cfgMax = row.configured?.max_ms;
  useEffect(() => {
    setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
    setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
  }, [row.stepId, cfgMin, cfgMax]);

  // Inspector.commitThinkTime과 동일한 4분기 규칙.
  const commit = () => {
    const minR = minDraft.trim();
    const maxR = maxDraft.trim();
    if (minR === "" && maxR === "") {
      setStepField(row.stepId, ["think_time"], undefined);
      return;
    }
    if (minR === "" || maxR === "") return; // 미완성 쌍 — draft 보존
    const mn = Number(minR);
    const mx = Number(maxR);
    if (Number.isInteger(mn) && Number.isInteger(mx) && mn >= 0 && mx >= mn && mx <= 600_000) {
      setStepField(row.stepId, ["think_time"], { min_ms: mn, max_ms: mx });
    } else {
      setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
      setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
    }
  };

  return (
    <tr className="border-t border-slate-100">
      <td className="w-8 px-2 py-1">
        <input
          type="checkbox"
          aria-label={ko.editor.thinkBoardSelectRowAria(row.name)}
          checked={selected}
          disabled={disabled}
          onChange={() => onToggle(row.stepId)}
        />
      </td>
      <td className="min-w-0 px-2 py-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
              METHOD_BADGE[row.method] ?? METHOD_BADGE.HEAD
            }`}
          >
            {row.method}
          </span>
          <span className="min-w-0 truncate" title={`${row.path ? `${row.path} / ` : ""}${row.name}`}>
            {row.path && (
              <span data-testid="step-path" className="text-slate-400">
                {row.path}
                {" / "}
              </span>
            )}
            <span data-testid="step-name">{row.name}</span>
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-1">
        <span className="inline-flex items-center gap-1">
          <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
          {row.state === "parallel_unset" && (
            <HelpTip label={ko.editor.defaultThinkParallelHelpLabel}>
              {ko.editor.defaultThinkParallelHelp}
            </HelpTip>
          )}
        </span>
      </td>
      <td className="w-20 px-1 py-1">
        <Input
          numeric
          compact
          size="sm"
          type="number"
          min={0}
          max={600000}
          aria-label={ko.editor.thinkBoardRowMinAria}
          value={minDraft}
          disabled={disabled}
          onChange={(e) => setMinDraft(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="w-20 px-1 py-1">
        <Input
          numeric
          compact
          size="sm"
          type="number"
          min={0}
          max={600000}
          aria-label={ko.editor.thinkBoardRowMaxAria}
          value={maxDraft}
          disabled={disabled}
          onChange={(e) => setMaxDraft(e.target.value)}
          onBlur={commit}
        />
      </td>
      <td className="w-8 px-1 py-1">
        {row.configured !== undefined && (
          <button
            type="button"
            aria-label={ko.editor.thinkBoardResetAria}
            disabled={disabled}
            onClick={() => setStepField(row.stepId, ["think_time"], undefined)}
            className="rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
          >
            ×
          </button>
        )}
      </td>
      <td
        data-testid="effective"
        className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-600"
      >
        {effectiveText(row.effective)}
      </td>
    </tr>
  );
}
```

import를 보강한다(파일 상단):

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "../ui/Input";
```

- [ ] **Step 5: 선택 상태 + 액션 바 구현**

`ThinkTimeBoard` 본체를 교체한다:

```tsx
export function ThinkTimeBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setStepsThinkTime = useScenarioEditor((s) => s.setStepsThinkTime);
  const rows = useMemo(() => (model ? buildThinkRows(model) : []), [model]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMin, setBulkMin] = useState("");
  const [bulkMax, setBulkMax] = useState("");

  const disabled = yamlError !== null;
  const selectedIds = rows.filter((r) => selected.has(r.stepId)).map((r) => r.stepId);
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;

  // 부분 선택은 indeterminate(R4) — DOM 프로퍼티라 JSX 속성으로는 못 준다.
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.length > 0 && !allChecked;
    }
  }, [selectedIds.length, allChecked]);

  // 선택·일괄 입력은 모달을 닫으면 버린다(R4). ThinkTimeBoard 자신은 EditorShell이
  // 항상 마운트하므로(Modal만 null을 반환) 이 리셋이 없으면 재오픈 시 이전 선택이 살아 있다.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setBulkMin("");
      setBulkMax("");
    }
  }, [open]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.stepId))));

  // n = 분기 안이면서 현재 think_time이 있는 선택 행 수. 이미 parallel_unset인 행은
  // [상속으로]가 no-op이라 세지 않는다(안내가 안 바뀌는 행까지 세면 원칙이 무뎌진다).
  // 판정은 ThinkRow.insideParallel(thinkTime.ts 소유) — 경로 문자열로 유추 금지.
  const parallelWithValue = rows.filter(
    (r) => selected.has(r.stepId) && r.insideParallel && r.configured !== undefined,
  ).length;

  const mn = Number(bulkMin.trim());
  const mx = Number(bulkMax.trim());
  const bulkValid =
    bulkMin.trim() !== "" &&
    bulkMax.trim() !== "" &&
    Number.isInteger(mn) &&
    Number.isInteger(mx) &&
    mn >= 0 &&
    mx >= mn &&
    mx <= 600_000;

  const runBulk = (value: ThinkTime | undefined) => {
    setStepsThinkTime(selectedIds, value);
  };

  return (
    <Modal open={open} onClose={onClose} title={ko.editor.thinkBoardTitle}>
      <p data-testid="default-summary" className="mb-2 text-sm text-slate-600">
        {defaultSummary(model?.default_think_time)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{ko.editor.thinkBoardEmpty}</p>
      ) : (
        <>
          <table aria-label={ko.editor.thinkBoardTableAria} className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-slate-500">
                <th className="w-8 px-2 py-1">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label={ko.editor.thinkBoardSelectAllAria}
                    checked={allChecked}
                    disabled={disabled}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-2 py-1">{ko.editor.thinkBoardColStep}</th>
                <th className="w-32 px-2 py-1">{ko.editor.thinkBoardColState}</th>
                <th className="w-20 px-1 py-1">{ko.editor.thinkBoardColMin}</th>
                <th className="w-20 px-1 py-1">{ko.editor.thinkBoardColMax}</th>
                <th className="w-8 px-1 py-1">
                  <span className="sr-only">{ko.editor.thinkBoardColReset}</span>
                </th>
                <th className="w-28 px-2 py-1 text-right">{ko.editor.thinkBoardColEffective}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <BoardRow
                  key={r.stepId}
                  row={r}
                  selected={selected.has(r.stepId)}
                  onToggle={toggle}
                  disabled={disabled}
                />
              ))}
            </tbody>
          </table>
          {selectedIds.length > 0 && (
            <div
              role="group"
              aria-label={ko.editor.thinkBoardBulkAria}
              className="mt-3 border-t border-slate-200 pt-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-600">
                  {ko.editor.thinkBoardSelectedCount(selectedIds.length)}
                </span>
                <Input
                  numeric
                  compact
                  size="sm"
                  type="number"
                  min={0}
                  max={600000}
                  aria-label={ko.editor.thinkBoardBulkMinAria}
                  value={bulkMin}
                  disabled={disabled}
                  onChange={(e) => setBulkMin(e.target.value)}
                  className="w-20"
                />
                <span aria-hidden="true">–</span>
                <Input
                  numeric
                  compact
                  size="sm"
                  type="number"
                  min={0}
                  max={600000}
                  aria-label={ko.editor.thinkBoardBulkMaxAria}
                  value={bulkMax}
                  disabled={disabled}
                  onChange={(e) => setBulkMax(e.target.value)}
                  className="w-20"
                />
                <button
                  type="button"
                  disabled={disabled || !bulkValid}
                  onClick={() => runBulk({ min_ms: mn, max_ms: mx })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkApply}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => runBulk(undefined)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkInherit}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => runBulk({ min_ms: 0, max_ms: 0 })}
                  className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-40"
                >
                  {ko.editor.thinkBoardBulkNoWait}
                </button>
              </div>
              {parallelWithValue > 0 && (
                <p role="status" className="mt-2 text-xs text-amber-700">
                  {ko.editor.thinkBoardParallelWarn(parallelWithValue)}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 6: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test ThinkTimeBoard; echo exit=$?
pnpm test thinkTime; echo exit=$?
```
Expected: 둘 다 PASS.

- [ ] **Step 7: R3 회귀 테스트의 이빨을 실증한다**

`BoardRow`의 재시드 dep을 일시적으로 `[row.stepId, row.configured]`(객체)로 되돌리고 실행한다:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test ThinkTimeBoard; echo exit=$?
```
Expected: **"R3 회귀: 다른 행의 커밋이…" 케이스가 FAIL**. 이빨을 확인한 뒤 원시값 dep으로 되돌려 다시 PASS를 확인한다 — 프로덕션 diff는 최종적으로 비어 있어야 한다.

- [ ] **Step 8: 게이트 3종 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git add ui/src/components/scenario/ThinkTimeBoard.tsx \
        ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx \
        ui/src/components/scenario/EditorShell.tsx \
        ui/src/i18n/ko.ts
git diff --cached --name-only   # 스테이징 확인 — 빈 커밋은 full 게이트를 돌고 'nothing to commit'
git commit -m "feat(ui): 현황판 행별 편집·일괄 3액션·병렬 비차단 안내·yamlError 게이트"
```

---

### Task 5: Inspector 판정 수렴 (마지막 · **드롭 가능**)

> 이 task는 어느 US에도 매달리지 않는 리팩터다. 일정·리스크가 생기면 **잘라낸다** — 그 경우 `Inspector.tsx:190-193`에 `thinkTime.ts`를 가리키는 주석만 남기고 슬라이스를 마감한다.

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx:190-193`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (선행 케이스 1개 추가)

**Interfaces:**
- Consumes: Task 1의 `classifyThink`.
- Produces: 없음.

- [ ] **Step 1: 선행 회귀 케이스를 먼저 추가한다**

`Inspector.test.tsx`의 `describe("Inspector — ParallelInspector (P-b Task 8)")` 블록 **끝**에 추가한다. 이 케이스가 R1-c의 유일한 함정을 막는 그물이다 — **분기 안에 값이 지정된** 스텝은 `state`가 `override`라, `insideParallel`을 `state === "parallel_unset"`로 유도하면 amber 안내가 사라진다.

```tsx
  /** 분기 *자식*(컨테이너 아님)을 선택하고 그 자식에 think_time을 지정한다.
   *  기존 loadParallelAndSelect()는 parallel 컨테이너를 선택하므로 여기 못 쓴다. */
  function selectBranchChildWithThink() {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const pid = useScenarioEditor.getState().addParallelStep("Fan-out")!;
    const par = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (par.type !== "parallel") throw new Error("expected parallel step");
    const childId = par.branches[0].steps[0].id;
    // 값을 지정 → state는 override(=parallel_unset 아님). 이게 이 케이스의 요점이다.
    useScenarioEditor.getState().setStepField(childId, ["think_time"], { min_ms: 50, max_ms: 60 });
    useScenarioEditor.getState().select(childId);
    return childId;
  }

  it("분기 안에 think_time이 지정된 스텝도 병렬 미적용 안내를 보여준다", async () => {
    const user = userEvent.setup();
    selectBranchChildWithThink();
    render(<Inspector />);
    // 타이밍 섹션은 기본 접힘(editorPrefs.timing = false)이라 먼저 펼친다.
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    // 이빨: 값이 실제로 지정돼 있어야 state가 override가 되어 이 케이스가 의미를 갖는다.
    // (값이 없으면 parallel_unset이라 state 유도 구현도 통과해 버려 vacuous해진다.)
    expect(screen.getByLabelText(/think 최솟값/i)).toHaveValue(50);
    expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
  });
```

- [ ] **Step 2: 케이스가 현재(수렴 전) 통과하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test Inspector; echo exit=$?
```
Expected: PASS — 수렴 전이므로 기존 인라인 판정이 이미 이 동작을 한다. **FAIL이면 케이스 작성이 틀린 것**(분기 자식이 아니라 컨테이너를 골랐거나 섹션을 안 펼쳤거나)이니 고친 뒤 진행한다. `toHaveValue(50)` 단언이 실패하면 `setStepField`가 안 먹은 것이므로 arrange를 먼저 고친다.

- [ ] **Step 3: 판정을 `classifyThink`로 교체**

`ui/src/components/scenario/Inspector.tsx`에 import를 추가하고:

```tsx
import { classifyThink } from "../../scenario/thinkTime";
```

`:190-193`의 인라인 판정을 교체한다:

```tsx
  const model = useScenarioEditor((s) => s.model);
  const defaultThink = model?.default_think_time;
  const insideParallel = model ? isInsideParallelBranch(model.steps, step.id) : false;
  // 판정 단일 소스 = thinkTime.ts(엔진 규칙 미러). insideParallel은 state에서 유도하면
  // 안 된다 — 분기 안에 값이 지정된 스텝은 override/no_wait라 amber 안내가 사라진다.
  const think = classifyThink(step, defaultThink, insideParallel);
  const noWait = think.state === "no_wait";
  const inheriting = think.state === "inherited" || think.state === "inherited_none";
```

`:404` 부근의 렌더 삼항(`insideParallel ? … : inheriting && defaultThink ? … : null`)은 **그대로 둔다**.

- [ ] **Step 4: 기존 Inspector 테스트가 무수정으로 통과하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm test Inspector; echo exit=$?
```
Expected: PASS, **테스트 파일 수정 0**. 통과시키려고 기존 단언을 고쳐야 한다면 그것은 동작 변경 신호이므로 멈추고 구현을 고친다.

- [ ] **Step 5: 게이트 3종 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`.

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "refactor(ui): Inspector think-time 판정을 thinkTime.ts로 수렴"
```

---

## 최종 검증 (전 task 완료 후, orchestrator가 직접 실행)

- [ ] **전체 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard/ui
pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```

- [ ] **0-diff 스코프 게이트** (two-dot 금지 — merge-base 사용)

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/think-time-dashboard
git diff --name-only $(git merge-base master HEAD)..HEAD
```
Expected: `crates/`·`ui/src/api/`·`ui/src/components/Modal.tsx`·`ui/src/components/scenario/ScenarioDefaults.tsx` 경로가 **하나도 없어야** 한다.

- [ ] **EditorShell 최소 diff 확인**

```bash
git diff $(git merge-base master HEAD)..HEAD -- ui/src/components/scenario/EditorShell.tsx
```
Expected: import 1줄 + state 1줄 + 버튼 블록 1개 + 모달 마운트 1줄. 그리드 `className` 삼항·`<aside>`·`<FlowOutline>`·`<Inspector>` 블록에 변경이 있으면 되돌린다.

- [ ] **한국어 하드코딩 스윕** (따옴표 직후가 한글이 아닌 리터럴도 잡는 패턴)

```bash
grep -rn '"[^"]*[가-힣]' \
  ui/src/components/scenario/ThinkTimeBoard.tsx \
  ui/src/components/scenario/EditorShell.tsx \
  ui/src/scenario/thinkTime.ts \
  | grep -v ':[0-9]*: *//' | grep -v 'ko\.'
```
Expected: 출력 없음(주석 제외 전부 `ko.` 경유). 주석 필터는 `':[0-9]*: *//'` — `grep -rn` 출력이 `path:line:content`라 `'^\s*//'`는 파일명에 앵커돼 **절대 매치되지 않는다**(BSD grep은 `\s`도 미지원).

- [ ] **최종 리뷰** — `handicap-reviewer` APPROVE. 보안 게이트는 `finish-slice §0`의 grep을 **직접 실행**해 판정한다(plan의 "UI-only라 N/A 예상"을 신뢰하지 말 것 — grep이 지배한다).

- [ ] **라이브 검증** — spec의 "라이브 검증 (US 척추)" 표 5행을 `/scenarios/{id}`와 `/scenarios/new` **양쪽**에서 수행.

---

## Self-Review 결과

**1. Spec 커버리지**

| Spec 요구 | Task |
|---|---|
| R1 (thinkTime.ts, ThinkState/ThinkRow/classifyThink/buildThinkRows) | Task 1 |
| R1-a (엔진 미러 실효값) | Task 1 Step 3 + 테스트 3×3×2 |
| R1-a2 ({0,0} 정규화) | Task 1 `normalizeEffective` + 전용 케이스 2개 |
| R1-b (행 순서·경로 라벨·elifLabel 1-based) | Task 1 walker + 경로 테스트 |
| R1-c (Inspector 수렴, 마지막·드롭 가능) | Task 5 |
| R2 (모달·진입점·표 구조·truncate) | Task 3 (+ Task 4가 7열로 확장) |
| R3 (행별 편집 4분기·draft 격리·원시 dep) | Task 4 Step 4 + 이빨 실증 Step 7 |
| R4 (선택·3액션·새 Edit·http leaf 필터·indeterminate·닫으면 버림) | Task 2(와이어) + Task 4(UI, indeterminate ref-effect + open=false 리셋 effect) |
| R5 (병렬 비차단 안내·n 정의) | Task 4 Step 5 (`ThinkRow.insideParallel` 기반 — 경로 문자열 유추 금지) |
| R6 (yamlError 게이트) | Task 4 Step 4-5 + 전용 describe |
| R7 (ko 문구) | Task 3 Step 3 + Task 4 Step 3 |
| 테스트 계획 1~19 | Task 1~5 각 테스트 + 최종 검증 |

누락 없음.

**2. Placeholder 스캔** — "TBD"/"적절히 처리"/"Task N과 유사" 없음. 모든 코드 스텝에 실제 코드가 있다.

**3. 타입 일관성** — `ThinkRow`의 8개 필드(`insideParallel` 포함)는 **Task 1에서 완결**되고 이후 확장되지 않는다(초안은 Task 4에서 필드를 덧붙이게 돼 있었으나, 그러면 Task 4가 문자열 휴리스틱으로 분기를 유추하는 잘못된 중간 상태를 거치므로 Task 1로 앞당겼다). `classifyThink`의 반환 `{state, effective, insideParallel}`도 Task 1부터 고정이라 Task 5가 그대로 쓴다. store 액션 `setStepsThinkTime`은 Task 2가 정의하고 Task 4만 호출한다. Task 3의 `BoardRow`는 Task 4가 시그니처를 확장하지만(`selected`/`onToggle`/`disabled` 추가) 같은 파일 안이라 중간 상태가 없다.
