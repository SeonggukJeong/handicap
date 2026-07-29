# 사용중인 변수 삭제 확인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 에디터 변수 패널에서 **참조가 있는** 선언 변수를 `×`로 지울 때, 참조 스텝 목록을 보여주는 확인 모달을 띄워 실수 삭제를 막는다.

**Architecture:** 순수 헬퍼(`describeStepRef`) → 프레젠테이셔널 모달(`DeleteVariableDialog`) → 패널 배선(`VariablesPanel`) 순으로 아래에서 위로 쌓는다. 사용처 항목의 배지/라벨은 기존 `VarUsagePopover`에서 헬퍼로 추출해 두 표면이 **한 소스**를 공유한다. 서버·proto·store·migration·모델·와이어 **0-diff**.

**Tech Stack:** TypeScript + React 18 + Zustand + Tailwind + vitest/RTL(jsdom) + `@testing-library/user-event` v14.

**Spec:** `docs/superpowers/specs/2026-07-29-var-delete-confirm-design.md` (spec-plan-reviewer 3라운드 clean `APPROVE`, 커밋 `74e45d2`)

## Global Constraints

- **문구는 전부 `ko.ts` 경유**(ADR-0035). 하드코딩 한국어 금지 — `aria-label`도 사용자 노출 문구다.
- **신규 ko 값 3개는 spec R6이 정한 문자열을 그대로**(변경 시 부분문자열 충돌 스윕 재실행 필요):
  - `varDeleteTitle`: `"변수 삭제"`
  - `varDeleteBody`: `` (name: string, n: number) => `${name} 변수를 참조하는 스텝이 ${n}개 있습니다. 삭제하면 그 참조가 미정의(⚠)로 남아 실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다.` ``
  - `varDeleteUsageListAria`: `"삭제할 변수를 참조하는 스텝"`
- **모달 단언 규칙(예외 없음)**: 반드시 `within(screen.getByRole("dialog"))` 스코프 안에서, **전체 문자열 exact 매칭**으로 한다 — role+name 매처 또는 `getByText(전체 문구)`. 부분문자열 매칭(`toHaveTextContent(짧은 공용어)`)은 금지 — `변수`/`삭제`/`스텝`/`개` 등은 카탈로그 전역에 존재한다. (숫자 하드닝용 `body.textContent`.`toContain` 은 이미 exact로 잡은 노드 *안*을 보는 것이라 이 규칙과 충돌하지 않는다.) **스코프 예외 1건**: 다이얼로그만 렌더하는 컴포넌트 테스트(Task 3)는 `screen.getBy…` 를 써도 된다(페이지에 다른 것이 없다) — 패널 전체를 렌더하는 Task 4·5·6은 `within(dialog)` 필수.
- **테스트 파일은 반드시 `ui/src/components/scenario/__tests__/` 아래** — `ui/vitest.config.ts:60`의 `include`가 `src/**/__tests__/**`라 소스 옆에 두면 **조용히 안 돈다**.
- **className 단언은 `className.split(/\s+/)` 토큰 멤버십**으로. raw 문자열 `toContain` 금지(`max-h-`⊃`h-` false-green 클래스).
- **tdd-guard**: 각 task의 **첫 편집은 반드시 테스트 파일**(`__tests__/`). production(`ui/src/**` non-test) 먼저 건드리면 `exit 2`로 차단된다.
- **lint**: `pnpm lint`는 `--max-warnings=0`. `any` 금지(`no-explicit-any`), 미사용 `eslint-disable` directive도 에러.
- **커밋**: `git commit`에 파이프(`| tail`) 금지·`--no-verify` 금지(git-guard가 deny). 커밋 후 `git log -1`로 확인.
- **`pnpm test <name>`에 `--`를 붙이지 말 것** — `pnpm test -- Foo`는 필터가 안 먹어 전체 스위트가 돈다.

### 셸 cwd 규칙 (이 계획의 모든 명령에 적용)

**Bash 툴의 cwd는 호출 간 유지된다.** 그래서 `cd ui && …`를 연달아 쓰면 두 번째부터 `cd`가 실패하고 `&&`가 단락되며, 더 나쁘게는 **git pathspec이 cwd 상대라 `git diff -- crates/`가 `ui/crates/`를 보고 조용히 빈 출력**을 낸다(= 0-diff 불변식이 거짓 통과). 규칙:

- 워크트리 루트(리터럴로 쓴다 — **셸 변수는 Bash 호출 간 유지되지 않는다**): `/Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm`
- **UI 명령은 절대경로 cd**: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
- **git 명령은 `git -C <위 절대경로>`**: `git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add …` 처럼.
- 아래 각 스텝의 명령은 **이미 전개돼 있으니 그대로 복사**해 쓴다.

### 테스트 배치 (Task 4·5·6 공통 — 단일 홈)

`VariablesPanel.test.tsx`에는 `"VariablesPanel"`로 시작하는 top-level describe가 **10개**(그중 9개는 `— …` 접미 형태, 첫 `:18`만 bare `describe("VariablesPanel", …)` — 구 지시가 가리키던 그 모호한 대상이다) 있고 `const MIXED`는 **`:243`**(2번째 describe가 `:241`에서 닫힌 **뒤**)에 있다. 따라서 "describe 안 끝에"·"파일 끝에" 같은 지시는 모호하거나 **store reset 없는 root 스코프**로 떨어진다. Task 4·5·6의 신규 `it(...)`은 **예외 없이 아래 한 블록 안**에 넣는다:

- `REFERENCED` 픽스처는 `MIXED`(`:243`) 선언 **바로 뒤 module scope**에 둔다(describe 안이 아니다 — Task 5·6도 같은 상수를 쓴다).
- 그 아래에 신규 describe 하나를 만들고, `beforeEach`는 같은 파일 `:277`의 검증된 이디엄을 그대로 쓴다:

```tsx
describe("VariablesPanel — 사용중인 변수 삭제 확인 (var-delete-confirm)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  // Task 4 · Task 5 · Task 6의 it(...)이 전부 여기에 들어간다
});
```

### 이빨 실증(회귀 주입) 규칙

- **원복은 반드시 `Edit` 툴로** — `git checkout`/`git stash`는 `git-guard.sh`가 ask-gate하고 워크트리 attached HEAD를 위협하므로 쓰지 않는다.
- 원복 확인은 `git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm diff --stat -- <파일>`이 **빈 출력**인지로 한다(위 cwd 규칙 필수).

### 커밋 비용

`.githooks/pre-commit`은 `ui/` non-`.md`가 staged면 **매번** `pnpm lint && pnpm test && pnpm build`를 돌린다. 즉 **6개 커밋 각각이 전체 UI 게이트를 한 번씩 치른다**(수십 초~분). Task 3·4·5가 `pnpm build`를 스텝으로 나열하지 않아도 커밋 시점에 빌드 게이트를 통과하므로 별도 실행은 불필요하다.

---

### Task 1: `VarUsagePopover` 배지·라벨 회귀 그물 (test-only, 전환 **전**)

Task 2가 이 컴포넌트의 렌더 로직을 헬퍼로 교체한다. 기존 `VarUsagePopover.test.tsx`가 **이미 덮는 것**은 portal/jump/`aria-current`/close 경로 **+ http 라벨 경로**(`:46` `getByText("로그인")`, `:52` `getByText("주문")` = `s.name`)다. **덮이지 않은 것**은 ① 메서드 배지 텍스트 ② 배지 className ③ `if` 라벨(`summarizeCondition`) — 픽스처에 `if` 스텝 자체가 없다. 그 세 축에 대해서는 "무수정 통과 = 회귀 없음"이 **무이빨**이므로(spec R2), 먼저 그물을 치고 GREEN을 확인한 뒤 Task 2에서 교체한다.

**Files:**
- Test: `ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx` (수정 — 픽스처 1개 + 테스트 3개 추가)

**Interfaces:**
- Consumes: 없음(기존 `VarUsagePopover` props 그대로)
- Produces: Task 2가 GREEN을 유지해야 하는 회귀 그물

- [ ] **Step 1: `if` 픽스처를 파일 상단 기존 `s2` 선언 바로 뒤에 추가**

기존 `s1`(GET "로그인")·`s2`(POST "주문") 아래에 붙인다:

```tsx
const sIf: Step = {
  id: "s3",
  type: "if",
  name: "분기",
  cond: { left: "{{token}}", op: "eq", right: "ok" },
  then: [
    {
      id: "s4",
      type: "http",
      name: "확인",
      request: { method: "GET", url: "/ok", headers: {} },
      assert: [],
      extract: [],
    },
  ],
  elif: [],
  else: [],
};
```

- [ ] **Step 2: 렌더 테스트 3개를 `describe("VarUsagePopover", ...)` 안 맨 끝에 추가**

```tsx
  it("http 참조는 메서드 배지+스텝 이름, if 참조는 IF 배지+조건 요약으로 렌더한다", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <VarUsagePopover
        anchor={anchor}
        refIds={["s1", "s2", "s3"]}
        steps={[s1, s2, sIf]}
        selectedStepId={null}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("GET")).toBeInTheDocument();
    expect(within(menu).getByText("POST")).toBeInTheDocument();
    expect(within(menu).getByText("로그인")).toBeInTheDocument();
    expect(within(menu).getByText("IF")).toBeInTheDocument();
    expect(within(menu).getByText("{{token}} eq ok")).toBeInTheDocument();
  });

  it("배지 className이 공유 레이아웃 토큰과 종류별 색 토큰을 함께 갖는다", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <VarUsagePopover
        anchor={anchor}
        refIds={["s1", "s3"]}
        steps={[s1, sIf]}
        selectedStepId={null}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    const httpTokens = within(menu).getByText("GET").className.split(/\s+/);
    expect(httpTokens).toContain("shrink-0");
    expect(httpTokens).toContain("font-mono");
    expect(httpTokens).toContain("text-[10px]");
    expect(httpTokens).toContain("bg-emerald-100");
    expect(httpTokens).toContain("text-emerald-700");
    const ifTokens = within(menu).getByText("IF").className.split(/\s+/);
    expect(ifTokens).toContain("shrink-0");
    expect(ifTokens).toContain("font-mono");
    expect(ifTokens).toContain("text-[10px]");
    expect(ifTokens).toContain("bg-slate-100");
    expect(ifTokens).toContain("text-slate-500");
  });

  it("스텝을 못 찾으면 raw id를 라벨로 쓰고 배지는 렌더하지 않는다", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <VarUsagePopover
        anchor={anchor}
        refIds={["ghost"]}
        steps={[s1]}
        selectedStepId={null}
        onJump={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("ghost")).toBeInTheDocument();
    expect(within(menu).queryByText("GET")).toBeNull();
  });
```

- [ ] **Step 3: GREEN 확인 (변환 전 기준선)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VarUsagePopover`
Expected: PASS — 기존 테스트 + 신규 3개 모두 통과. **여기서 실패하면 픽스처 타입이 틀린 것**(`Step` union은 `assert`/`extract`/`elif`/`else`가 `.default([])`라 **출력 타입에선 required**).

- [ ] **Step 4: 이빨 실증 — 배지 토큰 하나를 일시 제거해 RED 확인**

`ui/src/components/scenario/VarUsagePopover.tsx:103`의 http 배지 className에서 `font-mono`를 지운다 → `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VarUsagePopover` → **FAIL**(`배지 className이 …` 케이스). 확인 후 **원복**하고 다시 PASS 확인. production diff가 비었는지 `git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm diff --stat -- ui/src/components/scenario/VarUsagePopover.tsx`로 확인(빈 출력이어야 함).

- [ ] **Step 5: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/components/scenario/__tests__/VarUsagePopover.test.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "test(ui): VarUsagePopover 배지·라벨 회귀 그물 — stepRefLabel 추출 전 기준선 (var-delete-confirm T1)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

### Task 2: `stepRefLabel` 헬퍼 추출 + `VarUsagePopover` 전환

**Files:**
- Create: `ui/src/components/scenario/stepRefLabel.ts`
- Test: `ui/src/components/scenario/__tests__/stepRefLabel.test.ts` (신규)
- Modify: `ui/src/components/scenario/VarUsagePopover.tsx` (89–118 영역의 렌더 조립)

**Interfaces:**
- Consumes: `findStepById`·`summarizeCondition`·`Step`(`../../scenario/model`), `METHOD_BADGE`(`./methodBadge`)
- Produces: Task 3이 쓰는 `describeStepRef(steps: Step[], id: string): StepRefDesc`, `STEP_REF_BADGE_CLASS: string`, `interface StepRefDesc { badge: { text: string; colorClass: string } | null; label: string }`

> **spec §8 테스트 목록에서 1건 의도적 드롭**: "http 미지 메서드의 폴백 색"은 **타입 모델을 통해 도달 불가**다 — `HttpMethod` enum 7개(GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, `model.ts:7`)가 `METHOD_BADGE`(`methodBadge.ts:3-11`)의 키와 **정확히 일치**하므로 `?? "bg-slate-100 text-slate-600"`는 by-construction 죽은 가지다. 캐스트로 죽은 코드를 단언하는 테스트는 이빨이 없으므로 쓰지 않고, 폴백은 코드에 방어로만 남긴다.

- [ ] **Step 1: 헬퍼 단위 테스트를 먼저 작성**(tdd-guard 언블록 겸용)

Create `ui/src/components/scenario/__tests__/stepRefLabel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeStepRef, STEP_REF_BADGE_CLASS } from "../stepRefLabel";
import type { Step } from "../../../scenario/model";

const http: Step = {
  id: "h1",
  type: "http",
  name: "로그인",
  request: { method: "POST", url: "/login", headers: {} },
  assert: [],
  extract: [],
};
const child: Step = {
  id: "h2",
  type: "http",
  name: "확인",
  request: { method: "GET", url: "/ok", headers: {} },
  assert: [],
  extract: [],
};
const ifStep: Step = {
  id: "i1",
  type: "if",
  name: "분기",
  cond: { left: "{{token}}", op: "eq", right: "ok" },
  then: [child],
  elif: [],
  else: [],
};
const loop: Step = { id: "l1", type: "loop", name: "반복", repeat: 2, do: [child] };

describe("describeStepRef", () => {
  it("http 스텝은 메서드 배지 + 스텝 이름", () => {
    expect(describeStepRef([http], "h1")).toEqual({
      badge: { text: "POST", colorClass: "bg-blue-100 text-blue-700" },
      label: "로그인",
    });
  });

  it("if 스텝은 IF 배지 + 조건 요약", () => {
    // summarizeCondition(model.ts:323-328)은 `${left || "?"} ${op}` 뒤에
    // exists/empty가 아니면 ` ${right ?? ""}`를 붙인다 → 여기선 "{{token}} eq ok".
    expect(describeStepRef([ifStep], "i1")).toEqual({
      badge: { text: "IF", colorClass: "bg-slate-100 text-slate-500" },
      label: "{{token}} eq ok",
    });
  });

  it("찾았지만 http/if가 아니면 배지 없이 스텝 이름을 쓴다(현재 refIds 구성상 도달 불가한 방어 가지)", () => {
    expect(describeStepRef([loop], "l1")).toEqual({ badge: null, label: "반복" });
  });

  it("못 찾으면 배지 없이 raw id", () => {
    expect(describeStepRef([http], "ghost")).toEqual({ badge: null, label: "ghost" });
  });

  it("중첩 컨테이너 안의 http도 찾는다(findStepById 재귀 위임)", () => {
    expect(describeStepRef([ifStep], "h2").label).toBe("확인");
  });

  it("공유 배지 레이아웃 클래스는 색 토큰을 포함하지 않는다", () => {
    const tokens = STEP_REF_BADGE_CLASS.split(/\s+/);
    expect(tokens).toContain("shrink-0");
    expect(tokens).toContain("font-mono");
    expect(tokens.some((t) => t.startsWith("bg-") || t.startsWith("text-slate"))).toBe(false);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test stepRefLabel`
Expected: FAIL — `Failed to resolve import "../stepRefLabel"`.

- [ ] **Step 3: 헬퍼 구현**

Create `ui/src/components/scenario/stepRefLabel.ts`:

```ts
import { findStepById, summarizeCondition, type Step } from "../../scenario/model";
import { METHOD_BADGE } from "./methodBadge";

/** 사용처 목록 한 항목의 표시 정보. */
export interface StepRefDesc {
  /** 배지 — http=메서드, if="IF", 그 외/미발견=null */
  badge: { text: string; colorClass: string } | null;
  /** 라벨 — http=스텝 이름, if=조건 요약, 그 외=스텝 이름, 미발견=raw id */
  label: string;
}

/** 배지의 **레이아웃** 토큰(색 제외) — 소비처가 `${STEP_REF_BADGE_CLASS} ${colorClass}`로 조립한다.
 *  VarUsagePopover와 DeleteVariableDialog가 공유하는 단일 소스라, 여기만 바꾸면 두 표면이 함께 움직인다. */
export const STEP_REF_BADGE_CLASS = "shrink-0 rounded px-1 font-mono text-[10px]";

/** 변수 사용처 항목(`refIds`의 한 원소)을 배지+라벨로 서술한다.
 *  규칙의 정본은 추출 이전 `VarUsagePopover`의 렌더 코드였다 — 바꾸지 말 것. */
export function describeStepRef(steps: Step[], id: string): StepRefDesc {
  const s = findStepById(steps, id);
  if (!s) return { badge: null, label: id };
  if (s.type === "http")
    return {
      badge: {
        text: s.request.method,
        // 폴백은 방어용 — HttpMethod enum 7종이 모두 METHOD_BADGE의 키라 현재 도달 불가.
        colorClass: METHOD_BADGE[s.request.method] ?? "bg-slate-100 text-slate-600",
      },
      label: s.name,
    };
  if (s.type === "if")
    return {
      badge: { text: "IF", colorClass: "bg-slate-100 text-slate-500" },
      label: summarizeCondition(s.cond),
    };
  // loop/parallel — buildVarRefIndex가 http/if의 id만 기록하므로 현재 도달 불가하지만,
  // 이 헬퍼가 두 표면의 정본이므로 id 노출 대신 이름을 쓰는 규칙을 명시해 둔다.
  return { badge: null, label: s.name };
}
```

- [ ] **Step 4: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test stepRefLabel`
Expected: PASS (6 tests)

- [ ] **Step 5: `VarUsagePopover`를 헬퍼로 전환**

`ui/src/components/scenario/VarUsagePopover.tsx` — import 3줄을 교체한다:

```tsx
// 삭제
import { findStepById, summarizeCondition, type Step } from "../../scenario/model";
import { METHOD_BADGE } from "./methodBadge";
// 추가
import { type Step } from "../../scenario/model";
import { describeStepRef, STEP_REF_BADGE_CLASS } from "./stepRefLabel";
```

`refIds.map` 콜백 본문(현재 89–118)을 아래로 교체:

```tsx
      {refIds.map((id) => {
        const d = describeStepRef(steps, id);
        const active = id === selectedStepId;
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            aria-current={active ? "true" : undefined}
            onClick={() => onJump(id)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-slate-100 ${active ? "bg-accent-50 text-accent-700" : "text-slate-700"}`}
          >
            {d.badge && (
              <span className={`${STEP_REF_BADGE_CLASS} ${d.badge.colorClass}`}>{d.badge.text}</span>
            )}
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
          </button>
        );
      })}
```

- [ ] **Step 6: 그물이 여전히 GREEN인지 확인 (Task 1의 목적)**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VarUsagePopover`
Expected: PASS — Task 1의 3개 포함 전부. **하나라도 깨지면 전환이 동작을 바꾼 것이므로 되돌려서 원인을 찾을 것**(이게 Task 1을 먼저 한 이유다).

- [ ] **Step 7: 타입·lint 게이트**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm lint && pnpm build`
Expected: 둘 다 성공. (`Step`을 `import { type Step }`로만 쓰므로 미사용 import가 남지 않았는지 lint가 확인한다.)

- [ ] **Step 8: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/components/scenario/stepRefLabel.ts ui/src/components/scenario/__tests__/stepRefLabel.test.ts ui/src/components/scenario/VarUsagePopover.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "refactor(ui): 사용처 배지·라벨을 describeStepRef로 추출하고 VarUsagePopover 전환 (var-delete-confirm T2)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

### Task 3: ko 3키 + `DeleteVariableDialog` 컴포넌트

**Files:**
- Modify: `ui/src/i18n/ko.ts` (Variables 패널 블록 `:499`–`:531` 안, `varExpandAria` 다음 줄)
- Create: `ui/src/components/scenario/DeleteVariableDialog.tsx`
- Test: `ui/src/components/scenario/__tests__/DeleteVariableDialog.test.tsx` (신규)

**Interfaces:**
- Consumes: `describeStepRef`·`STEP_REF_BADGE_CLASS`(Task 2), `Modal`(`../Modal`), `Button`(`../Button`), `ko`(`../../i18n/ko`)
- Produces: Task 4가 마운트하는
  `DeleteVariableDialog(props: { open: boolean; name: string; refIds: string[]; steps: Step[]; onCancel: () => void; onConfirm: () => void })`

- [ ] **Step 1: 컴포넌트 테스트를 먼저 작성**

Create `ui/src/components/scenario/__tests__/DeleteVariableDialog.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteVariableDialog } from "../DeleteVariableDialog";
import { ko } from "../../../i18n/ko";
import type { Step } from "../../../scenario/model";

const http: Step = {
  id: "h1",
  type: "http",
  name: "로그인",
  request: { method: "POST", url: "/login", headers: {} },
  assert: [],
  extract: [],
};
const ifStep: Step = {
  id: "i1",
  type: "if",
  name: "분기",
  cond: { left: "{{token}}", op: "eq", right: "ok" },
  then: [
    {
      id: "h2",
      type: "http",
      name: "확인",
      request: { method: "GET", url: "/ok", headers: {} },
      assert: [],
      extract: [],
    },
  ],
  elif: [],
  else: [],
};

const setup = (over: Partial<Parameters<typeof DeleteVariableDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <DeleteVariableDialog
      open
      name="token"
      refIds={["h1", "i1"]}
      steps={[http, ifStep]}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onCancel, onConfirm };
};

describe("DeleteVariableDialog", () => {
  it("변수명과 참조 개수를 담은 본문을 렌더한다", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    const body = within(dialog).getByText(ko.editor.varDeleteBody("token", 2));
    expect(body).toBeInTheDocument();
    // ko 포맷터 자기참조 단언 하드닝(ui/CLAUDE.md 공허-11호) — 렌더된 숫자를 따로 확인.
    expect(body.textContent).toContain("token");
    expect(body.textContent).toContain("2");
  });

  it("사용처 목록을 배지+라벨로 렌더한다(http=메서드/이름, if=IF/조건 요약)", () => {
    setup();
    const list = screen.getByRole("list", { name: ko.editor.varDeleteUsageListAria });
    expect(within(list).getByText("POST")).toBeInTheDocument();
    expect(within(list).getByText("로그인")).toBeInTheDocument();
    expect(within(list).getByText("IF")).toBeInTheDocument();
    expect(within(list).getByText("{{token}} eq ok")).toBeInTheDocument();
  });

  it("목록 항목은 클릭 대상이 아니다(점프 어포던스 없음)", () => {
    setup();
    const list = screen.getByRole("list", { name: ko.editor.varDeleteUsageListAria });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
  });

  it("[삭제]는 onConfirm만, [취소]는 onCancel만 부른다", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.delete }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("[취소] 클릭과 ESC 모두 onCancel을 부른다", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("열자마자 포커스가 [삭제] 버튼에 있지 않다(오타 Enter로 삭제되지 않게)", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    expect(within(dialog).getByRole("button", { name: ko.common.delete })).not.toHaveFocus();
  });

  it("open=false면 아무것도 렌더하지 않는다", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test DeleteVariableDialog`
Expected: FAIL — `Failed to resolve import "../DeleteVariableDialog"`.

- [ ] **Step 3: ko 3키 추가**

`ui/src/i18n/ko.ts`의 `varExpandAria: (name: string) => \`${name} 펼치기/접기\`,` **다음 줄**에 삽입(Variables 패널 블록 유지):

```ts
    // ── 사용중인 변수 삭제 확인 (var-delete-confirm) ──
    varDeleteTitle: "변수 삭제",
    varDeleteBody: (name: string, n: number) =>
      `${name} 변수를 참조하는 스텝이 ${n}개 있습니다. 삭제하면 그 참조가 미정의(⚠)로 남아 실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다.`,
    varDeleteUsageListAria: "삭제할 변수를 참조하는 스텝",
```

- [ ] **Step 4: 컴포넌트 구현**

Create `ui/src/components/scenario/DeleteVariableDialog.tsx`:

```tsx
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ko } from "../../i18n/ko";
import { type Step } from "../../scenario/model";
import { describeStepRef, STEP_REF_BADGE_CLASS } from "./stepRefLabel";

/**
 * 사용중(참조 ≥ 1)인 선언 변수의 삭제 확인 다이얼로그.
 * 목록 항목은 **비대화형**이다 — 여기서 스텝으로 점프하면 삭제 흐름이 끊기고,
 * 점프는 이미 변수 행의 "N개 스텝에서 사용" 팝오버가 담당한다.
 * 초기 포커스는 Modal 기본(패널)을 그대로 둔다 — 파괴적 액션이라 [삭제] autofocus 금지.
 */
export function DeleteVariableDialog({
  open,
  name,
  refIds,
  steps,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
  refIds: string[];
  steps: Step[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={ko.editor.varDeleteTitle}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-700">{ko.editor.varDeleteBody(name, refIds.length)}</p>
        <ul
          aria-label={ko.editor.varDeleteUsageListAria}
          className="max-h-64 overflow-auto rounded-md border border-slate-200 p-1 text-xs"
        >
          {refIds.map((id) => {
            const d = describeStepRef(steps, id);
            return (
              <li key={id} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-slate-700">
                {d.badge && (
                  <span className={`${STEP_REF_BADGE_CLASS} ${d.badge.colorClass}`}>
                    {d.badge.text}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{d.label}</span>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {ko.common.cancel}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {ko.common.delete}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test DeleteVariableDialog`
Expected: PASS (7 tests)

- [ ] **Step 6: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/i18n/ko.ts ui/src/components/scenario/DeleteVariableDialog.tsx ui/src/components/scenario/__tests__/DeleteVariableDialog.test.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "feat(ui): 변수 삭제 확인 다이얼로그 + ko 3키 (var-delete-confirm T3)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

### Task 4: `VariablesPanel` 배선 — 트리거 분기·확정·취소 (US1·US2·US3 + A1)

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (import·state·`×` onClick `:249`·다이얼로그 마운트)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (수정)

**Interfaces:**
- Consumes: `DeleteVariableDialog`(Task 3)
- Produces: 로컬 state `pendingDelete: { name: string; refIds: string[] } | null`(Task 5가 확정 경로에 포커스 이동을 얹는다)

- [ ] **Step 1: 픽스처와 테스트를 먼저 작성** (배치는 Global Constraints §"테스트 배치" 규칙을 따른다)

`ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`의 `const MIXED`(`:243`) 선언 **바로 뒤 module scope**에 픽스처를 추가한다(describe 안이 아니다 — Task 5·6도 이 상수를 쓴다):

```tsx
// token: http 1곳(요청 표면) + if 1곳(조건 오퍼랜드)에서 참조 → refIds 2개.
// if의 then 자식은 token을 참조하지 않아 N이 2로 고정된다(spec 테스트 §4 픽스처 주의).
const REFERENCED = `version: 1
name: t
variables:
  token: seed
  unused: x
steps:
  - id: 01HX0000000000000000000001
    name: 로그인
    type: http
    request:
      method: POST
      url: "/login?t={{token}}"
      headers: {}
  - id: 01HX0000000000000000000002
    name: 분기
    type: if
    cond:
      left: "{{token}}"
      op: eq
      right: ok
    then:
      - id: 01HX0000000000000000000003
        name: 확인
        type: http
        request:
          method: GET
          url: "/ok"
          headers: {}
`;
```

그 아래에 **신규 describe 블록을 만들고**(Global Constraints §"테스트 배치"의 코드 그대로) 그 안에 아래 테스트를 넣는다. Task 5·6도 같은 블록에 추가한다:

```tsx
  it("US1-a: 참조가 있는 변수의 × 는 즉시 지우지 않고 확인 다이얼로그를 연다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.removeVariableAria("token") }));
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });

    const body = within(dialog).getByText(ko.editor.varDeleteBody("token", 2));
    expect(body).toBeInTheDocument();
    // ko 포맷터 자기참조 단언 하드닝(ui/CLAUDE.md 공허-11호): 렌더된 숫자를 따로 본다.
    expect(body.textContent).toContain("2");

    // US2 — steps={model.steps} 배선 커버(이 단언이 없으면 steps=[]로 잘못 배선해도
    // 다이얼로그가 ULID를 나열한 채 모든 테스트가 통과한다).
    expect(within(dialog).getByText("로그인")).toBeInTheDocument();
    expect(within(dialog).getByText("POST")).toBeInTheDocument();
    expect(within(dialog).getByText("{{token}} eq ok")).toBeInTheDocument();

    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("token");
  });

  it("US1-b: 다이얼로그 [삭제]가 변수를 지우고 다이얼로그를 닫는다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.removeVariableAria("token") }));
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.delete }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("token");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("US1-c: [취소]와 ESC는 변수를 남긴다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    const remove = screen.getByRole("button", { name: ko.editor.removeVariableAria("token") });

    await user.click(remove);
    await user.click(
      within(screen.getByRole("dialog", { name: ko.editor.varDeleteTitle })).getByRole("button", {
        name: ko.common.cancel,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("token");

    await user.click(remove);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("token");
  });

  it("US3: 미사용 변수의 × 는 다이얼로그 없이 즉시 지운다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.removeVariableAria("unused") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("unused");
  });

  it("A1: 사용처 팝오버가 열린 채 × 를 키보드로 눌러도 팝오버가 남지 않는다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableUsageNavAria("token") }),
    );
    expect(screen.getByRole("menu", { name: ko.editor.varUsageListAria })).toBeInTheDocument();

    // 반드시 키보드로 활성화한다: user.click은 pointerdown을 쏘고, 그 이벤트가
    // VarUsagePopover의 outside-close 리스너를 발화시켜 수정이 없어도 팝오버가 닫힌다
    // (= 이 테스트가 공허해진다).
    screen.getByRole("button", { name: ko.editor.removeVariableAria("token") }).focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: ko.editor.varDeleteTitle })).toBeInTheDocument();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: **신규 5개 중 4개 FAIL**(`Unable to find an accessible element with the role "dialog"` 등) + **US3는 이미 PASS**. US3(`unused`는 `refIds: []`)는 *현행* 즉시-삭제 경로를 그대로 타므로 배선 전에도 통과한다 — 이건 회귀 락인이지 RED 대상이 아니다. 기존 `"removes a variable"` 테스트도 같은 이유로 계속 PASS여야 한다.

- [ ] **Step 3: import·state 추가**

`ui/src/components/scenario/VariablesPanel.tsx` 최상단 import를 수정하고 컴포넌트에 state를 더한다:

```tsx
// 1행 교체
import { useMemo, useState } from "react";
// ↓
import { useMemo, useRef, useState } from "react";

// 기존 import 목록 끝(GenSampleLine/GenVarEditor 줄 뒤)에 추가
import { DeleteVariableDialog } from "./DeleteVariableDialog";
```

`const [usageNav, setUsageNav] = useState<…>(null);` 선언 **뒤**에 추가:

```tsx
  // 사용중인 변수 삭제 확인(US1) — 열 때 refIds를 스냅샷으로 동결한다(행 객체를 들지 않음).
  const [pendingDelete, setPendingDelete] = useState<{ name: string; refIds: string[] } | null>(
    null,
  );
  // 확정 삭제일 때만 검색 입력으로 포커스를 옮기기 위한 1회성 플래그(Task 5에서 소비).
  // 취소는 Modal의 기본 복원(× 버튼)을 그대로 둬야 하므로 양 경로 공통 구현을 만들지 않는다.
  const refocusSearchRef = useRef(false);
```

> `refocusSearchRef`는 Task 5에서 소비하지만 **여기서 함께 선언**한다 — 확정 경로가 플래그를 세우는 코드가 Task 4에 들어가므로, 그것을 내리는 코드도 같은 커밋에 있어야 짝이 맞는다.
>
> **시점별 사실(주석과 어긋나지 않게 정확히)**: Task 4 커밋 시점엔 소비자가 없어 확정 후 플래그가 `true`로 남고, 다음 트리거의 리셋이 그것을 내린다 — 읽는 쪽이 없으니 동작 영향은 없다. Task 5의 effect가 들어오면 `pendingDelete→null`마다 플래그가 비워지므로 트리거의 리셋은 **방어로 격하**된다. 위 소스 주석은 두 시점 모두에서 참이도록 **effect를 언급하지 않게** 썼다(존재하지 않는 코드를 참조하는 주석을 커밋하지 않기 위해).

- [ ] **Step 4: `×` onClick 분기 + 다이얼로그 마운트**

`VariablesPanel.tsx:247-254`의 `×` 버튼을 교체:

```tsx
                    <button
                      type="button"
                      onClick={() => {
                        if (row.refIds.length === 0) {
                          removeVariable(row.name); // 미사용 — 현행 그대로 즉시 삭제(US3)
                          return;
                        }
                        setUsageNav(null); // 팝오버가 모달 뒤에 남지 않게(A1, 키보드 활성화 경로)
                        // 확정 경로만 이 플래그를 세운다 — 여는 시점에 반드시 내려서 이전 확정의
                        // 잔여 true가 다음 세션으로 새지 않게 한다(dangling-ref 가드).
                        refocusSearchRef.current = false;
                        setPendingDelete({ name: row.name, refIds: row.refIds });
                      }}
                      aria-label={ko.editor.removeVariableAria(row.name)}
                      className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                    >
                      ×
                    </button>
```

파일 끝의 `{usageNav && model && ( … )}` 블록 **뒤**, `</section>` **앞**에 마운트:

```tsx
      {pendingDelete && model && (
        <DeleteVariableDialog
          open
          name={pendingDelete.name}
          refIds={pendingDelete.refIds}
          steps={model.steps}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            removeVariable(pendingDelete.name);
            setUsageNav(null); // 방어 전용 — R1 트리거가 이미 비웠고 모달 중엔 다시 열 경로가 없다
            refocusSearchRef.current = true;
            setPendingDelete(null);
          }}
        />
      )}
```

- [ ] **Step 5: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: PASS — 신규 5개 + 기존 전부.

> 이 시점에 `refocusSearchRef`는 세팅만 되고 읽히지 않는다. **이건 lint를 통과한다**(검증 완료 — `@typescript-eslint/no-unused-vars`와 `noUnusedLocals` 둘 다 프로퍼티 쓰기를 "사용"으로 센다). Task 4를 Task 5와 합치지 말 것.

- [ ] **Step 6: 이빨 실증 3건**

각각 주입 → 해당 테스트 FAIL 확인 → **원복** → PASS 확인:

1. `if (row.refIds.length === 0)` 가드를 지우고 항상 `setPendingDelete(...)` → `US3` FAIL.
2. 가드를 `if (true)`로 → `US1-a` FAIL(다이얼로그 안 뜸).
3. 트리거의 `setUsageNav(null)` 줄 제거 → `A1` FAIL(팝오버가 남음).

3번이 FAIL하지 않으면 테스트가 `user.click`을 쓰고 있다는 뜻이다 — Step 1의 키보드 활성화로 되돌릴 것.

- [ ] **Step 7: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "feat(ui): 사용중인 변수 × 는 확인 다이얼로그 경유 — 미사용은 즉시 삭제 유지 (var-delete-confirm T4)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

### Task 5: 포커스 2경로 (R4)

확정 시점의 `activeElement`는 모달의 `[삭제]` 버튼이고, 그것은 모달과 함께 언마운트된다. `Modal`은 열 때 기억해 둔 `previouslyFocused`(=`×` 버튼, `Modal.tsx:29/58`)로 되돌리려 하지만 **확정 경로에서는 그 `×`도 함께 사라져** 복원 대상이 없어지고 포커스가 `<body>`로 떨어진다. 그래서 확정은 변수 검색 입력으로 옮기고, **취소는 `Modal`의 기본 복원(`×`)을 그대로 둔다** — 양 경로 공통 구현은 취소에서도 발화해 정당한 복원을 이기므로 금지.

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (검색 `Input`에 ref, 소비 effect)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (수정)

**Interfaces:**
- Consumes: Task 4의 `pendingDelete`·`refocusSearchRef`
- Produces: 없음(마지막 소비자)

- [ ] **Step 1: 테스트 2개 작성**

Task 4가 만든 `describe("VariablesPanel — 사용중인 변수 삭제 확인 (var-delete-confirm)", …)` 블록 **안에** 추가한다(파일 끝 root 스코프에 두면 store reset `beforeEach`가 없어 앞 테스트의 상태를 물려받는다):

```tsx
  it("R4①: 확정 삭제 후 포커스가 body가 아니라 변수 검색 입력으로 간다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.removeVariableAria("token") }));
    await user.click(
      within(screen.getByRole("dialog", { name: ko.editor.varDeleteTitle })).getByRole("button", {
        name: ko.common.delete,
      }),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByPlaceholderText(ko.editor.varSearchPlaceholder)).toHaveFocus();
  });

  it("R4②: 취소 후 포커스는 Modal 기본 복원대로 × 버튼으로 돌아간다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(REFERENCED);
    render(<VariablesPanel />);
    // 다이얼로그는 반드시 user.click(또는 focus()+{Enter})으로 열 것 — fireEvent.click은
    // 포커스를 옮기지 않아 Modal의 previouslyFocused가 <body>가 되고, 그러면 이 단언은
    // 구현과 무관하게 실패한다(Modal.tsx:29).
    const remove = screen.getByRole("button", { name: ko.editor.removeVariableAria("token") });
    await user.click(remove);
    await user.click(
      within(screen.getByRole("dialog", { name: ko.editor.varDeleteTitle })).getByRole("button", {
        name: ko.common.cancel,
      }),
    );
    expect(remove).toHaveFocus();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: `R4①` FAIL(포커스가 `<body>`). `R4②`는 이미 PASS일 수 있다(Modal 기본 동작) — 그래도 다음 스텝의 회귀 가드로 남긴다.

- [ ] **Step 3: 검색 입력에 ref 부착**

`VariablesPanel.tsx`의 검색 `<Input …>`(현재 `:201-209`)에 `ref`를 더한다:

```tsx
        <Input
          ref={searchRef}
          className="mt-1"
          placeholder={ko.editor.varSearchPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setUsageNav(null); // 검색으로 앵커 행이 필터링되면 detached-anchor 팝오버 방지
          }}
        />
```

Task 4에서 만든 `refocusSearchRef` 선언 옆에 ref를 추가:

```tsx
  const searchRef = useRef<HTMLInputElement>(null);
```

(`Input`은 `forwardRef<HTMLInputElement, Props>` — `ui/src/components/ui/Input.tsx:18`.)

- [ ] **Step 4: 소비 effect 추가**

`import { useMemo, useRef, useState }` → `import { useEffect, useMemo, useRef, useState }` 로 바꾸고, `rows` memo 선언 뒤에 추가:

```tsx
  // 확정 삭제로 × 가 언마운트되면 포커스가 <body>로 유실된다 → 검색 입력으로 옮긴다.
  // 플래그가 선 경우에만 돌므로 **취소 경로는 건드리지 않는다**(Modal이 × 로 복원).
  // React 18은 한 passive flush에서 unmount(Modal 복원)를 mount보다 먼저 돌리므로
  // 이 effect가 나중에 실행된다 — setTimeout/rAF 불필요.
  useEffect(() => {
    if (pendingDelete !== null || !refocusSearchRef.current) return;
    refocusSearchRef.current = false;
    searchRef.current?.focus();
  }, [pendingDelete]);
```

- [ ] **Step 5: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: PASS — `R4①`·`R4②` 포함 전부.

- [ ] **Step 6: 이빨 실증 2건**

1. effect 본문의 `searchRef.current?.focus();`를 주석 처리 → `R4①` FAIL → 원복 → PASS.
2. 가드를 `if (pendingDelete !== null) return;`로 바꿔(플래그 무시 = 양 경로 공통 구현) → `R4②` FAIL → 원복 → PASS. **2번이 FAIL하지 않으면 R4②는 무이빨이니 리뷰에 보고할 것.**

- [ ] **Step 7: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "fix(ui): 변수 삭제 확정 후 포커스를 검색 입력으로 — 취소는 Modal 기본 복원 유지 (var-delete-confirm T5)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

### Task 6: `×` yamlError 게이트 (US4·R5) + 전체 게이트

`removeVariable` → `dispatch`는 `store.ts:462`에서 `yamlError !== null`이면 early-return하는 **선재 silent no-op**이다. 확인 모달이 붙은 지금은 그 침묵이 "확인까지 눌렀는데 아무 일 없음"으로 더 기만적이 되므로 ✎(`:175`)·"선언 추가"(`:404`)와 같은 게이트를 건다.

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (`×` 버튼 1곳)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` (수정)

**Interfaces:**
- Consumes: Task 4의 `×` 버튼
- Produces: 없음

- [ ] **Step 1: 테스트 작성** — Task 4가 만든 `describe("VariablesPanel — 사용중인 변수 삭제 확인 (var-delete-confirm)", …)` 블록 **안에** 추가한다

```tsx
  it("US4: yamlError 동안 × 가 비활성이다(확인 후 no-op 방지)", () => {
    useScenarioEditor.getState().loadFromString(REFERENCED);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    useScenarioEditor.getState().commitPendingYaml(); // model은 보존되므로 행은 그대로 렌더된다
    render(<VariablesPanel />);
    expect(
      screen.getByRole("button", { name: ko.editor.removeVariableAria("token") }),
    ).toBeDisabled();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: FAIL — `expect(element).toBeDisabled()` 실패(현재 게이트 없음).

- [ ] **Step 3: 게이트 추가**

Task 4에서 만든 `×` 버튼에 두 속성을 더한다(다른 줄은 그대로):

```tsx
                      disabled={yamlError !== null}
                      className="shrink-0 text-slate-500 hover:text-red-600 text-sm disabled:opacity-40"
```

- [ ] **Step 4: GREEN 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test VariablesPanel`
Expected: PASS

- [ ] **Step 5: 이빨 실증**

`disabled={yamlError !== null}`를 제거 → `US4` FAIL 확인 → 원복 → PASS.

- [ ] **Step 6: 전체 게이트 (파이프 없이 종료코드 명시 캡처)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm lint; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm test; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm/ui && pnpm build; echo "build=$?"
```

Expected: 셋 다 `=0`. `pnpm test`는 **인자 없이 전체**를 돌린다(targeted green ≠ full green — 다른 파일의 잠복 red를 잡는다).

- [ ] **Step 7: 0-diff 불변식 확인**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm diff --stat $(git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm merge-base master HEAD)..HEAD -- crates/ deploy/ desktop/
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm diff --stat $(git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm merge-base master HEAD)..HEAD -- ui/src/scenario/ ui/src/api/
```

Expected: 둘 다 **빈 출력**(서버·proto·store·migration·모델 0-diff). 출력이 있으면 스코프 이탈이므로 되돌릴 것.

- [ ] **Step 8: 커밋**

```bash
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm commit -m "fix(ui): 변수 × 에 yamlError 게이트 — 선재 silent no-op 수정 (var-delete-confirm T6, US4)"
git -C /Users/sgj/develop/handicap/.claude/worktrees/var-delete-confirm log -1 --oneline
```

---

## 구현 후 (orchestrator)

1. **최종 whole-branch 리뷰**: `handicap-reviewer`(BASE = Task 1 디스패치 직전 커밋 = `74e45d2`, `HEAD~1` 금지).
2. **보안 게이트**: `finish-slice §0`의 grep을 **직접 실행**해 판정(diff가 요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드파싱·trace/body 뷰어를 건드리는지). 무매치여도 판단으로 재검토([[security-gate-judgment-override]]).
3. **라이브 검증**: spec의 표대로 `/scenarios/new` **와** `/scenarios/{id}` **양쪽**에서(한 화면만 보면 false-PASS — [[live-verify-all-mount-paths]]). A1 행은 반드시 **키보드**로 `×`를 활성화할 것.
4. `/finish-slice`.

---

<!-- spec-plan-reviewer 3라운드 (must-fix 7 + 권고 3 + N1~N5, 기각 0) 후 clean APPROVE. -->
REVIEW-GATE: APPROVED
