# 짝(min/max) 입력 commit-on-blur 오커밋 수정 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** min/max 짝 입력에서 한 칸을 고치고 다른 칸으로 포커스를 옮길 때 중간 쌍이 `revert`로 떨어져 방금 친 값이 사라지는 결함을, 4개 커밋 사이트에서 한 번에 고친다.

**Architecture:** 공유 훅 `useThinkTimePair`가 4곳에 복제된 draft 상태기계(state·시드·재시드 effect·4분기 스위치)를 흡수하고, 각 입력의 `onBlur`에서 `relatedTarget`이 짝의 다른 칸이면 커밋을 보류한다(짝을 실제로 떠나는 blur가 커밋 경계). 모달 안 사이트(3·4)는 ESC가 blur 없이 언마운트하므로 닫기 직전 `activeElement.blur()`로 커밋을 flush한다. 유효성 규칙(`resolveThinkDraft`)은 0-diff.

**Tech Stack:** TypeScript / React 18 / Zustand / vitest + @testing-library/react + @testing-library/user-event

설계 문서: `docs/superpowers/specs/2026-07-20-pair-input-blur-commit-design.md` (spec-plan-reviewer clean APPROVE, 커밋 `a04ec2e`)

## Global Constraints

spec에서 그대로 옮긴 프로젝트 전역 요구 — **모든 task에 암묵 적용된다**.

- **`ui/src/scenario/thinkTime.ts`는 0-diff.** `resolveThinkDraft`의 4분기 규칙·경계값(`mx <= 600_000`, `mn >= 0`, `mx >= mn`, `Number.isInteger`)을 건드리지 않는다. 자동 swap·clamp·경계 완화 금지.
- **UI-only.** `crates/`·`proto/`·migration·서버 store 0-diff. 와이어 무변경.
- **신규 사용자 노출 문자열 0.** `ui/src/i18n/ko.ts` 무수정 → ADR-0035 표면 무접촉.
- **훅 위치는 `ui/src/components/scenario/useThinkTimePair.ts`.** `ui/src/scenario/`는 React-free 순수 로직 디렉토리라 훅을 두면 규약 위반(그 디렉토리의 어떤 파일도 React를 import하지 않는다).
- **마크업 무변경.** 래퍼 `<div>`를 새로 도입하지 않는다 — `Input`이 `forwardRef`(`ui/src/components/ui/Input.tsx:18`)이므로 ref만 꽂는다. 기존 `Field`/flex/`<td>` 레이아웃 클래스는 한 글자도 안 바뀐다.
- **`reseed`는 `useCallback`으로 identity-stable해야 한다.** 사이트 4의 effect deps가 `[open, defMin, defMax]`인데 매 렌더 새 클로저면 `react-hooks/exhaustive-deps`가 deps 추가를 요구하고 effect가 매 렌더 재발화한다. `pnpm lint`는 `--max-warnings=0`이라 이건 경고가 아니라 **실패**다.
- **게이트:** `pnpm lint && pnpm test && pnpm build` 3종 green. 파이프(`| tail`)로 종료코드를 마스킹하지 말 것 — `; echo exit=$?`로 명시 캡처.
- **커밋 규칙:** `git commit`에 `| tail`/`| head` 파이프 금지(git-guard가 deny), `--no-verify` 금지.
- **US1 경로 ③(창/탭 전환)은 이번 범위 밖.** spec §7.2가 수용된 한계로 명시한다 — 창 blur는 `relatedTarget`이 null이라 짝 내부/외부를 구분할 정보가 없다. 이걸 고치려 들지 말 것(범위 초과).

## 파일 구조

| 파일 | 책임 | 조치 |
|---|---|---|
| `ui/src/components/scenario/useThinkTimePair.ts` | 짝 입력 draft 상태기계 + 커밋 시점 판정 단일 소스 | **신규** |
| `ui/src/components/scenario/__tests__/useThinkTimePair.test.tsx` | 훅 단위 테스트(가드 경계·null 해저드) | **신규** |
| `ui/src/components/scenario/Inspector.tsx` | 사이트 1 — 스텝 think_time | 수정 (`:225`–`:263`, `:394`–`:408`) |
| `ui/src/components/scenario/ScenarioDefaults.tsx` | 사이트 2 — 시나리오 기본값(접이식) | 수정 (`:31`–`:58`, `:83`–`:97`) |
| `ui/src/components/scenario/ThinkTimeBoard.tsx` | 사이트 3·4 + R5 닫힘 flush | 수정 (`:46`–`:76`, `:131`–`:149`, `:191`–`:221`, `:283`, `:299`–`:318`) |
| 각 컴포넌트의 기존 `__tests__/*.test.tsx` | 회귀 가드 4종 + R5 가드 | 수정 |

## ⚠ 구현 전 필독 — 이 슬라이스 고유의 세 함정

**H0. 리팩터가 남기는 고아 import/const가 *그 task 자신의* 게이트를 깨뜨린다.**
`ui/eslint.config.js:23`이 `@typescript-eslint/no-unused-vars: "error"`, `ui/tsconfig.json:15`가 `noUnusedLocals: true`다. 상태기계를 훅으로 걷어내면 다음이 즉시 미사용이 된다 — **같은 스텝에서 함께 지운다**:

| 파일 | 지울 것 |
|---|---|
| `Inspector.tsx` | `:24` import의 `resolveThinkDraft` (`classifyThink`·`formatThink`는 계속 쓰이므로 **그 둘은 남긴다**) |
| `ScenarioDefaults.tsx` | `:6` import의 `resolveThinkDraft`, **그리고 `:1`의 `useEffect`**(이 파일의 유일한 `useEffect`가 `:34`의 재시드였다 → `import { useState } from "react";`만 남는다) |
| `ThinkTimeBoard.tsx` | `:11` import의 `resolveThinkDraft`, `:193`–`:194`의 `defMin`/`defMax` |

각 task의 Step 3/4를 끝낸 뒤 `pnpm lint`가 아니라 **`pnpm build`까지** 돌려야 `noUnusedLocals`가 드러난다.

**H1. `partner.current`가 null일 때 가드가 커밋을 통째로 삼킨다.**
가드를 `if (e.relatedTarget === partner.current) return;`으로 쓰면, **둘 다 `null`인 경우**(짝 입력이 아직 마운트 안 됐거나 ref 미부착 + 바깥 빈 영역 클릭)에 `null === null`이 참이 되어 **모든 커밋이 사라진다**. 반드시 non-null을 먼저 확인한다:

```ts
if (partner.current !== null && e.relatedTarget === partner.current) return;
```

이건 이 슬라이스에서 가장 위험한 단일 지점이다 — Task 1 Step 1의 테스트가 이걸 직접 고정한다.

**H2. `tdd-guard`는 각 task의 *첫* 편집이 production 파일이면 차단한다.**
직전 task 커밋 직후 작업트리가 clean이면 `ui/src/**` 비-테스트 파일 편집이 `exit 2`로 막힌다(훅은 파일 *내용*이 아니라 modified/untracked 테스트 파일의 *존재*만 본다 — `tdd-guard.sh:92`). **모든 task가 테스트 파일 편집으로 시작하도록 순서를 짰다** — 순서를 바꾸지 말 것.

---

### Task 1: 공유 훅 `useThinkTimePair`

**Files:**
- Create: `ui/src/components/scenario/useThinkTimePair.ts`
- Test: `ui/src/components/scenario/__tests__/useThinkTimePair.test.tsx`

**Interfaces:**
- Consumes: `resolveThinkDraft`, `ThinkTime` (`ui/src/scenario/thinkTime.ts`, `ui/src/scenario/model.ts`) — 둘 다 무수정.
- Produces (Task 2–5가 의존하는 정확한 시그니처):

```ts
export type ThinkPairFieldProps = {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
  ref: React.RefObject<HTMLInputElement | null>;
};

export function useThinkTimePair(args: {
  value: ThinkTime | undefined;
  resetKey?: string;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}): {
  minProps: ThinkPairFieldProps;
  maxProps: ThinkPairFieldProps;
  reseed: () => void;
};
```

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/components/scenario/__tests__/useThinkTimePair.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useThinkTimePair } from "../useThinkTimePair";
import type { ThinkTime } from "../../../scenario/model";

function Harness({
  value,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}) {
  const { minProps, maxProps } = useThinkTimePair({ value, onCommit, onClear });
  return (
    <div>
      <input aria-label="min" {...minProps} />
      <input aria-label="max" {...maxProps} />
      <button type="button">outside</button>
    </div>
  );
}

/** H1 전용 하니스: max에 **ref를 붙이지 않아** partner.current가 null인 상태를 만든다.
 *  `const { ref, ...rest } = maxProps`로 빼면 eslint `no-unused-vars`에 걸린다
 *  (`ignoreRestSiblings` 미설정 — `ui/eslint.config.js:23`) → 필드를 명시 나열한다. */
function DetachedPartnerHarness({
  value,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}) {
  const { minProps, maxProps } = useThinkTimePair({ value, onCommit, onClear });
  return (
    <div>
      <input aria-label="min" {...minProps} />
      <input
        aria-label="max"
        value={maxProps.value}
        onChange={maxProps.onChange}
        onBlur={maxProps.onBlur}
      />
    </div>
  );
}

const min = () => screen.getByLabelText("min");
const max = () => screen.getByLabelText("max");

describe("useThinkTimePair", () => {
  it("짝 내부로 포커스가 이동할 땐 커밋하지 않고 draft를 보존한다 (핵심 회귀 가드)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);

    await user.clear(min());
    await user.type(min(), "1000");
    await user.click(max()); // min이 blur되지만 짝 내부라 보류돼야 한다

    expect(onCommit).not.toHaveBeenCalled();
    // ↓ 이 단언이 이 테스트의 이빨이다. 가드가 없으면 중간 쌍 {1000,500}이
    //   min>max라 `revert`로 떨어져 draft가 "200"으로 되돌아간다 — 그런데 revert는
    //   onCommit을 부르지 않으므로 위의 not.toHaveBeenCalled()는 **가드가 없어도
    //   통과한다**(공허). 사라진 값을 직접 관찰해야 RED가 뜬다.
    expect((min() as HTMLInputElement).value).toBe("1000");
  });

  it("짝을 떠날 때 최종 쌍으로 커밋한다 (상향 편집)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);

    await user.clear(min());
    await user.type(min(), "1000");
    await user.click(max());
    await user.clear(max());
    await user.type(max(), "2000");
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ min_ms: 1000, max_ms: 2000 });
  });

  it("H1: partner ref가 미부착이고 relatedTarget도 null이면 그래도 커밋한다", () => {
    const onCommit = vi.fn();
    render(
      <DetachedPartnerHarness
        value={{ min_ms: 200, max_ms: 500 }}
        onCommit={onCommit}
        onClear={vi.fn()}
      />,
    );

    // max에 ref가 안 붙어 있으므로 maxRef.current === null이고, fireEvent.blur는
    // relatedTarget === null이다. 가드가 non-null 확인 없이 `===`만 쓰면
    // null === null이 참이 되어 **모든 커밋이 조용히 사라진다**.
    fireEvent.change(min(), { target: { value: "100" } });
    fireEvent.change(max(), { target: { value: "300" } });
    fireEvent.blur(min()); // partner = maxRef(=null), relatedTarget = null

    expect(onCommit).toHaveBeenCalledWith({ min_ms: 100, max_ms: 300 });
  });

  it("둘 다 비우면 onClear", () => {
    const onClear = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={vi.fn()} onClear={onClear} />);
    fireEvent.change(min(), { target: { value: "" } });
    fireEvent.change(max(), { target: { value: "" } });
    fireEvent.blur(max());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("정확히 한 칸만 비면 noop — 커밋도 클리어도 없고 draft가 보존된다", () => {
    const onCommit = vi.fn();
    const onClear = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={onClear} />);
    fireEvent.change(min(), { target: { value: "" } });
    fireEvent.blur(min());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect((min() as HTMLInputElement).value).toBe("");
  });

  it("min>max로 짝을 떠나면 revert — 마지막 커밋값으로 draft 복귀 (US2)", () => {
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);
    fireEvent.change(min(), { target: { value: "900" } });
    fireEvent.change(max(), { target: { value: "100" } });
    fireEvent.blur(max());
    expect(onCommit).not.toHaveBeenCalled();
    expect((min() as HTMLInputElement).value).toBe("200");
    expect((max() as HTMLInputElement).value).toBe("500");
  });

  it("경계값 600000은 커밋되고 600001은 revert된다 (규칙 0-diff 확인)", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <Harness value={{ min_ms: 0, max_ms: 1 }} onCommit={onCommit} onClear={vi.fn()} />,
    );
    fireEvent.change(min(), { target: { value: "0" } });
    fireEvent.change(max(), { target: { value: "600000" } });
    fireEvent.blur(max());
    expect(onCommit).toHaveBeenCalledWith({ min_ms: 0, max_ms: 600000 });

    onCommit.mockClear();
    rerender(<Harness value={{ min_ms: 0, max_ms: 1 }} onCommit={onCommit} onClear={vi.fn()} />);
    fireEvent.change(min(), { target: { value: "0" } });
    fireEvent.change(max(), { target: { value: "600001" } });
    fireEvent.blur(max());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("value가 {0,0}이면 빈 칸이 아니라 '0'으로 시드된다 (키 삭제 방지)", () => {
    render(<Harness value={{ min_ms: 0, max_ms: 0 }} onCommit={vi.fn()} onClear={vi.fn()} />);
    expect((min() as HTMLInputElement).value).toBe("0");
    expect((max() as HTMLInputElement).value).toBe("0");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test useThinkTimePair`
Expected: FAIL — `Failed to resolve import "../useThinkTimePair"`

- [ ] **Step 3: 훅 구현**

`ui/src/components/scenario/useThinkTimePair.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent, RefObject } from "react";
import { resolveThinkDraft } from "../../scenario/thinkTime";
import type { ThinkTime } from "../../scenario/model";

export type ThinkPairFieldProps = {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
  ref: RefObject<HTMLInputElement | null>;
};

/** min/max 짝 입력의 draft 상태기계 + 커밋 시점 판정 단일 소스.
 *
 *  4분기 *규칙*은 thinkTime.ts::resolveThinkDraft가 소유하고(0-diff), 여기선
 *  ① 규칙을 언제 돌릴지 ② outcome에 따른 setState/콜백 호출만 한다.
 *
 *  커밋 경계는 "입력을 떠날 때"가 아니라 "**짝**을 떠날 때"다. min→max 포커스
 *  이동의 암묵 blur를 커밋으로 취급하면 중간 쌍({new_min, old_max})이 min>max로
 *  판정돼 revert로 떨어지고, 사용자가 방금 친 값이 사라진다(범위를 올릴 때만
 *  발현 — 내릴 땐 중간 쌍이 유효해서 조용히 부분 커밋된다).
 *
 *  재시드 dep은 반드시 **원시값**이다. 객체 dep을 쓰면 표(ThinkTimeBoard)에서
 *  한 행을 커밋할 때 모든 행이 재생성돼 다른 행에 반쯤 친 값이 날아간다. */
export function useThinkTimePair({
  value,
  resetKey,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  resetKey?: string;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}): {
  minProps: ThinkPairFieldProps;
  maxProps: ThinkPairFieldProps;
  reseed: () => void;
} {
  // 시드는 `=== undefined` 비교다. truthy 검사로 원시값을 쓰면 0이 falsy라
  // {0,0}이 빈 칸으로 시드되고 다음 blur가 clear로 떨어져 키를 지운다.
  const cfgMin = value?.min_ms;
  const cfgMax = value?.max_ms;

  const [minDraft, setMinDraft] = useState(cfgMin === undefined ? "" : String(cfgMin));
  const [maxDraft, setMaxDraft] = useState(cfgMax === undefined ? "" : String(cfgMax));

  const minRef = useRef<HTMLInputElement | null>(null);
  const maxRef = useRef<HTMLInputElement | null>(null);

  // identity-stable해야 한다 — 소비처(ThinkTimeBoard 기본값 행)가 effect dep으로
  // 쓰는데, 매 렌더 새 클로저면 exhaustive-deps가 dep 추가를 요구하고 effect가
  // 매 렌더 재발화한다(lint는 --max-warnings=0).
  const reseed = useCallback(() => {
    setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
    setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
  }, [cfgMin, cfgMax]);

  useEffect(() => {
    reseed();
  }, [resetKey, reseed]);

  const commit = () => {
    const outcome = resolveThinkDraft(minDraft, maxDraft);
    switch (outcome.kind) {
      case "clear":
        onClear();
        return;
      case "noop":
        // 정확히 한 칸만 빈 미완성 쌍 — draft 보존.
        return;
      case "commit":
        onCommit(outcome.value);
        return;
      case "revert":
        reseed();
        return;
    }
  };

  const blurHandler =
    (partner: RefObject<HTMLInputElement | null>) => (e: FocusEvent<HTMLInputElement>) => {
      // `partner.current !== null`이 필수다. 빼면 relatedTarget과 partner가 둘 다
      // null일 때 null === null이 참이 되어 모든 커밋이 조용히 사라진다.
      if (partner.current !== null && e.relatedTarget === partner.current) return;
      commit();
    };

  return {
    minProps: {
      value: minDraft,
      onChange: (e) => setMinDraft(e.target.value),
      onBlur: blurHandler(maxRef),
      ref: minRef,
    },
    maxProps: {
      value: maxDraft,
      onChange: (e) => setMaxDraft(e.target.value),
      onBlur: blurHandler(minRef),
      ref: maxRef,
    },
    reseed,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test useThinkTimePair`
Expected: PASS — 8 tests

- [ ] **Step 5: 가드의 이빨 실증 (의무)**

`useThinkTimePair.ts`의 가드 줄을 일시적으로 지운다:

```ts
      // if (partner.current !== null && e.relatedTarget === partner.current) return;
      commit();
```

Run: `cd ui && pnpm test useThinkTimePair`
Expected: **FAIL 2건**
- "짝 내부로 포커스가 이동할 땐 커밋하지 않고 draft를 보존한다" → `min` 값이 `"1000"`이 아니라 `"200"`(중간 쌍 `{1000,500}`이 revert로 떨어져 사라진다). **`not.toHaveBeenCalled()` 단언은 이때도 통과한다 — revert는 `onCommit`을 부르지 않기 때문**이며, 그래서 draft 단언이 이 테스트의 유일한 이빨이다.
- "짝을 떠날 때 최종 쌍으로 커밋한다" → `{1000,2000}`을 못 받는다.

다음으로 non-null 확인만 지워 H1을 실증한다:

```ts
      if (e.relatedTarget === partner.current) return;
```

Run: `cd ui && pnpm test useThinkTimePair`
Expected: **FAIL** — H1 케이스가 red(`onCommit`이 아예 안 불린다 — `null === null`이 참이 되어 커밋이 삼켜진다).

> 이 두 주입이 각각 **정확히 예상한 케이스만** red로 만드는지 확인할 것. 주입했는데 아무것도 red가 안 되면 그 테스트는 공허한 것이고, 그대로 두면 회귀를 못 잡는다 — 이 계획의 초안이 실제로 그 상태였고 리뷰에서 걸렸다.

원복 후 재실행하여 8 tests PASS 확인. (원복 안 하고 다음 스텝으로 가지 말 것.)

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
git add ui/src/components/scenario/useThinkTimePair.ts ui/src/components/scenario/__tests__/useThinkTimePair.test.tsx
git commit -m "feat(ui): 짝 입력 draft 상태기계 공유 훅 useThinkTimePair

min→max 포커스 이동의 암묵 blur를 커밋으로 취급하지 않는다 — 짝을
떠나는 blur만 커밋 경계다. 4분기 규칙(resolveThinkDraft)은 0-diff."
```

---

### Task 2: 사이트 1 — `Inspector` 스텝 think_time

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (`:225`–`:263` 상태기계, `:394`–`:408` 입력)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx`

**Interfaces:**
- Consumes: `useThinkTimePair` (Task 1).
- Produces: 없음(소비처 전용).

- [ ] **Step 1: 회귀 가드 테스트 추가**

`Inspector.test.tsx`의 `Inspector — think_time (S-B)` describe(`:796`)에 추가한다(그 안의 `loadAndSelect()` `beforeEach` `:797`–`:800`에 의존한다). think 입력은 기본-접힘 disclosure 안이라 **먼저 펼쳐야** 한다(`:805` 패턴).

```tsx
  it("min→max 포커스 이동 중 중간 쌍이 커밋되지 않는다 (상향 편집)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    const maxInput = screen.getByLabelText(/think 최댓값/i) as HTMLInputElement;

    // 베이스라인 {200,500}을 먼저 커밋한다.
    await user.clear(minInput);
    await user.type(minInput, "200");
    await user.clear(maxInput);
    await user.type(maxInput, "500");
    fireEvent.blur(maxInput);

    // 범위를 올린다: min을 먼저 고치고 max로 포커스를 옮긴다.
    await user.clear(minInput);
    await user.type(minInput, "1000");
    await user.click(maxInput); // 여기서 중간 쌍 {1000,500}이 커밋되면 안 된다
    await user.clear(maxInput);
    await user.type(maxInput, "2000");
    fireEvent.blur(maxInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.think_time).toEqual({ min_ms: 1000, max_ms: 2000 });
    }
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test Inspector`
Expected: FAIL — 받은 값이 `{min_ms: 200, max_ms: 2000}`(min에 친 1000이 revert로 사라짐). 이 실패 메시지가 곧 결함의 재현이다.

- [ ] **Step 3: 훅으로 교체**

`Inspector.tsx` 상단 import에 추가:

```ts
import { useThinkTimePair } from "./useThinkTimePair";
```

`:225`–`:263`의 두 `useState` + `useEffect` + `commitThinkTime`을 **통째로** 다음으로 대체한다:

```ts
  // 짝 입력의 draft/커밋 규칙은 useThinkTimePair가 단일 소스(4 사이트 공용).
  // 여기선 store 배선만 한다.
  const {
    minProps: thinkMinProps,
    maxProps: thinkMaxProps,
  } = useThinkTimePair({
    value: step.think_time,
    resetKey: step.id,
    onCommit: (v) => setStepField(step.id, ["think_time"], v),
    onClear: () => setStepField(step.id, ["think_time"], undefined),
  });
```

min 입력(`<Input>` 블록 `:388`–`:397`)에서 `value`(`:394`)·`onChange`(`:395`)·`onBlur`(`:396`) **세 줄을 지우고** 스프레드를 넣는다:

```tsx
          <Input
            numeric
            type="number"
            min={0}
            max={600000}
            disabled={noWait}
            {...thinkMinProps}
          />
```

max 입력(`<Input>` 블록 `:400`–`:409`)도 동일하게 `value`(`:406`)·`onChange`(`:407`)·`onBlur`(`:408`)를 지우고 `{...thinkMaxProps}`로.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test Inspector`
Expected: PASS — 신규 가드 + `Inspector — think_time (S-B)` describe의 기존 4건(`:802`, `:823`, `:848`, `:869`) 전부 green

- [ ] **Step 5: 이빨 실증**

`useThinkTimePair.ts`의 가드 줄을 일시 주석 처리 → `pnpm test Inspector` → 신규 가드가 **FAIL**(`{200,2000}`) → 원복 → PASS 재확인.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "fix(ui): Inspector 스텝 think_time 짝 입력 오커밋 수정"
```

---

### Task 3: 사이트 2 — `ScenarioDefaults` 시나리오 기본값

**Files:**
- Modify: `ui/src/components/scenario/ScenarioDefaults.tsx` (`:31`–`:58`, `:83`–`:97`)
- Test: `ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx`

**Interfaces:**
- Consumes: `useThinkTimePair` (Task 1).
- Produces: 없음.

- [ ] **Step 1: 회귀 가드 테스트 추가**

`ScenarioDefaults.test.tsx`에 추가한다(`DEFAULTS_YAML`이 이미 `{500,1000}` 기본값을 준다):

```tsx
  it("min→max 포커스 이동 중 중간 쌍이 커밋되지 않는다 (상향 편집)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    render(<ScenarioDefaults />);
    await user.click(
      screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }),
    );

    const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
    const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);

    // {500,1000} → {2000,3000}: min을 먼저 올리면 중간 쌍이 {2000,1000}이 된다.
    await user.clear(min);
    await user.type(min, "2000");
    await user.click(max);
    await user.clear(max);
    await user.type(max, "3000");
    fireEvent.blur(max);

    expect(useScenarioEditor.getState().model!.default_think_time).toEqual({
      min_ms: 2000,
      max_ms: 3000,
    });
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test ScenarioDefaults`
Expected: FAIL — `{min_ms: 500, max_ms: 3000}`

- [ ] **Step 3: 훅으로 교체**

import 추가:

```ts
import { useThinkTimePair } from "./useThinkTimePair";
```

`:31`–`:58`의 두 `useState` + `useEffect` + `commit`을 대체:

```ts
  const { minProps, maxProps } = useThinkTimePair({
    value: defaultThink,
    onCommit: (v) => setDefaultThinkTime(v),
    onClear: () => setDefaultThinkTime(undefined),
  });
```

(`resetKey` 없음 — 편집 대상이 시나리오 하나뿐이라 identity가 없다.)

min 입력(`<Input>` `:78`–`:87`)의 `value`(`:83`)·`onChange`(`:84`)·`onBlur`(`:85`)를 `{...minProps}`로, max 입력(`<Input>` `:90`–`:99`)의 `value`(`:95`)·`onChange`(`:96`)·`onBlur`(`:97`)를 `{...maxProps}`로 교체한다. **`disabled={yamlError !== null}`는 반드시 유지** — 깨진 YAML 버퍼에서 dispatch가 no-op이라 입력을 열어두면 사용자가 친 값이 조용히 삼켜진다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test ScenarioDefaults`
Expected: PASS — 신규 가드 + 기존 7건 green

- [ ] **Step 5: 이빨 실증**

가드 줄 주석 처리 → FAIL 확인 → 원복 → PASS.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
git add ui/src/components/scenario/ScenarioDefaults.tsx ui/src/components/scenario/__tests__/ScenarioDefaults.test.tsx
git commit -m "fix(ui): ScenarioDefaults 기본값 짝 입력 오커밋 수정"
```

---

### Task 4: 사이트 3·4 — `ThinkTimeBoard` 행별 편집 + 현황판 기본값

**Files:**
- Modify: `ui/src/components/scenario/ThinkTimeBoard.tsx` (`:46`–`:76` BoardRow, `:131`–`:149` 행 입력, `:191`–`:221` 기본값 행, `:299`–`:318` 기본값 입력)
- Test: `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`

**Interfaces:**
- Consumes: `useThinkTimePair` (Task 1) — 이 task는 `reseed`도 쓴다.
- Produces: 없음.

- [ ] **Step 1: 회귀 가드 테스트 2건 추가**

```tsx
  it("행별 편집: min→max 포커스 이동 중 중간 쌍이 커밋되지 않는다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);

    // "주문" 행의 베이스라인은 {800,900} — 올리면 중간 쌍이 {2000,900}이 된다.
    await user.clear(minInput("주문"));
    await user.type(minInput("주문"), "2000");
    await user.click(maxInput("주문"));
    await user.clear(maxInput("주문"));
    await user.type(maxInput("주문"), "3000");
    fireEvent.blur(maxInput("주문"));

    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 2000, max_ms: 3000 });
  });

  it("현황판 기본값: min→max 포커스 이동 중 중간 쌍이 커밋되지 않는다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);

    await user.clear(defMinInput());
    await user.type(defMinInput(), "2000");
    await user.click(defMaxInput());
    await user.clear(defMaxInput());
    await user.type(defMaxInput(), "3000");
    fireEvent.blur(defMaxInput());

    expect(useScenarioEditor.getState().model!.default_think_time).toEqual({
      min_ms: 2000,
      max_ms: 3000,
    });
  });
```

> **픽스처 베이스라인(확인 완료 — 추측 아님)**: `YAML` 상단의 `default_think_time`은 `{min_ms:200, max_ms:500}`(`:13`–`:15`), "주문" 행은 `{min_ms:800, max_ms:900}`(`:27`–`:28`). 그래서 위 두 테스트의 중간 쌍은 각각 `{2000,900}`·`{2000,500}`으로 **둘 다 `min>max`** 라 가드에 이빨이 있다. 헬퍼 `minInput`/`maxInput`(`:77`–`:82`)·`stepThink`(`:86`)·`defMinInput`/`defMaxInput`(`:385`–`:389`)는 이미 존재하므로 새로 만들지 말 것.
>
> 입력값을 바꾸게 되면 **중간 쌍이 반드시 `min>max`가 되도록** 유지할 것 — 중간 쌍이 유효하면 수정 전에도 통과해 가드가 이빨을 잃는다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test ThinkTimeBoard`
Expected: FAIL — 두 건 모두 min이 베이스라인 값으로 남는다

- [ ] **Step 3: BoardRow(사이트 3) 교체**

import 추가 후, `:46`–`:76`의 두 `useState` + `useEffect` + `commit`을 대체:

```ts
  const { minProps, maxProps } = useThinkTimePair({
    value: row.configured,
    resetKey: row.stepId,
    onCommit: (v) => setStepField(row.stepId, ["think_time"], v),
    onClear: () => setStepField(row.stepId, ["think_time"], undefined),
  });
```

min 입력(`<Input>` `:123`–`:135`)의 `value`(`:131`)·`onChange`(`:133`)·`onBlur`(`:134`)를 `{...minProps}`로, max 입력(`<Input>` `:138`–`:150`)의 `value`(`:146`)·`onChange`(`:148`)·`onBlur`(`:149`)를 `{...maxProps}`로. `disabled={disabled}`와 `aria-label`은 유지.

- [ ] **Step 4: 기본값 행(사이트 4) 교체**

`:191`–`:221`(원시값 dep 주석 + `defMin`/`defMax` const + 시드 주석 + 두 `useState` + 재시드 `useEffect` + `commitDefault`)를 대체한다.

> **⚠ 범위 경계 주의**: `:222`는 `const selectedIds = rows.filter(…)`로 **살아 있는 코드**다(`:223`·`:279`·`:363`에서 소비). `:222`까지 지우면 `tsc -b`/`vite build`가 깨진다. `commitDefault`의 닫는 `};`는 `:221`이다.
>
> `:193`–`:194`의 `defMin`/`defMax`도 함께 지운다 — Step 4에서 재시드 effect의 dep이 `[open, reseedDefault]`로 바뀌면 두 const가 미사용이 되어 `no-unused-vars`(error) + `noUnusedLocals`로 게이트가 깨진다.

```ts
  const {
    minProps: defMinProps,
    maxProps: defMaxProps,
    reseed: reseedDefault,
  } = useThinkTimePair({
    value: defaultThink,
    onCommit: (v) => setDefaultThinkTime(v),
    onClear: () => setDefaultThinkTime(undefined),
  });
```

`:235`–`:245`의 `!open` 재시드 effect에서 draft setter 두 줄을 `reseedDefault()` 호출로 교체하고 dep을 갱신한다:

```ts
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setBulkMin("");
      setBulkMax("");
      // blur 없이 ESC/백드롭으로 닫으면 draft가 모델과 어긋난 채 남는다.
      reseedDefault();
    }
  }, [open, reseedDefault]);
```

`:299`–`:318`의 두 입력을 `{...defMinProps}` / `{...defMaxProps}`로 교체(`aria-label`·`disabled`·`w-20` 래퍼 유지).

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd ui && pnpm test ThinkTimeBoard`
Expected: PASS — 신규 2건 + 기존 전부 green

- [ ] **Step 6: 이빨 실증**

가드 줄 주석 처리 → 신규 2건 **FAIL** 확인 → 원복 → PASS.

- [ ] **Step 7: 게이트 + 커밋**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
git add ui/src/components/scenario/ThinkTimeBoard.tsx ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx
git commit -m "fix(ui): 현황판 행별·기본값 짝 입력 오커밋 수정"
```

---

### Task 5: R5 — 모달 닫힘 시 커밋 flush

**Files:**
- Modify: `ui/src/components/scenario/ThinkTimeBoard.tsx` (`:283` Modal 배선)
- Test: `ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx`

**Interfaces:**
- Consumes: Task 4의 훅 배선.
- Produces: 없음.

**배경:** `Modal`의 ESC 경로(`Modal.tsx:34`–`:36`)는 포커스 이벤트 없이 언마운트한다 → blur가 안 뜨므로 커밋도 없다. Task 1–4가 min의 커밋을 *보류*하게 만들었으므로, flush가 없으면 ESC에서 **두 칸 모두** 유실된다(수정 전엔 min이 우연히 살아남는 경우가 있었다). 백드롭·✕는 mousedown이 포커스를 옮기며 이미 `relatedTarget: null` blur를 일으켜 스스로 커밋하므로 **ESC만이 이빨 있는 경로**다.

- [ ] **Step 1: 실패하는 테스트 추가**

```tsx
  it("ESC로 닫아도 마지막으로 친 쌍이 저장된다 (R5)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);

    await user.clear(defMinInput());
    await user.type(defMinInput(), "200");
    await user.click(defMaxInput());
    await user.clear(defMaxInput());
    await user.type(defMaxInput(), "400");
    // blur 없이 ESC — Modal은 document에 keydown 리스너를 건다(Modal.tsx:55).
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useScenarioEditor.getState().model!.default_think_time).toEqual({
      min_ms: 200,
      max_ms: 400,
    });
  });

  it("ESC로 닫을 때 min>max면 커밋하지 않는다 (US2가 닫힘 경로에서도 성립)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const before = useScenarioEditor.getState().model!.default_think_time;

    await user.clear(defMinInput());
    await user.type(defMinInput(), "9000");
    await user.click(defMaxInput());
    await user.clear(defMaxInput());
    await user.type(defMaxInput(), "100");
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useScenarioEditor.getState().model!.default_think_time).toEqual(before);
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd ui && pnpm test ThinkTimeBoard`
Expected: 첫 번째가 FAIL — 아무것도 커밋되지 않아 기본값이 그대로다. (두 번째는 이 시점에도 통과할 수 있다 — 그건 정상이며, 그 케이스는 R5가 *과잉 커밋*하지 않는지를 지키는 반대 방향 가드다.)

- [ ] **Step 3: flush 구현**

`ThinkTimeBoard.tsx`에서 `Modal`에 넘기는 `onClose`를 감싼다. `EditorShell.tsx:61`–`:64`의 `closeDetail`과 같은 이디엄이다:

```ts
  // ESC는 blur 없이 언마운트하므로 onBlur-커밋 draft가 버려진다 — 동기 blur로
  // 커밋을 flush한 뒤 닫는다(EditorShell.closeDetail과 같은 이디엄).
  // 백드롭/✕는 mousedown이 이미 포커스를 옮겨 스스로 커밋하므로, 이 blur는
  // 그 경로에선 입력이 이미 커밋된 뒤라 no-op이다.
  const closeWithFlush = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    onClose();
  };
```

`:283`의 `<Modal open={open} onClose={onClose} …>`를 `onClose={closeWithFlush}`로 바꾼다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test ThinkTimeBoard`
Expected: PASS — 신규 2건 + 기존 전부 green

- [ ] **Step 5: 이빨 실증**

`onClose={closeWithFlush}`를 `onClose={onClose}`로 되돌린다 → `pnpm test ThinkTimeBoard` → "ESC로 닫아도 …" **FAIL** 확인 → 원복 → PASS.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
git add ui/src/components/scenario/ThinkTimeBoard.tsx ui/src/components/scenario/__tests__/ThinkTimeBoard.test.tsx
git commit -m "fix(ui): 현황판 모달 닫힘 시 think time 커밋 flush (R5)

ESC는 blur 없이 언마운트해 draft를 버린다. 짝 가드가 min 커밋을 보류하게
됐으므로 flush가 없으면 ESC에서 두 칸 모두 유실된다."
```

---

### Task 6: 수렴 확인 + 전체 게이트

**Files:** 없음(검증 전용).

> **tdd-guard 주의**: 이 task는 clean 트리에서 시작하므로 `ui/src` 비-테스트 파일을 편집하려 하면 `tdd-guard.sh`가 pending 테스트 파일 0건을 보고 `exit 2`로 막는다. **원칙적으로 이 task에서 production 수정이 필요해선 안 된다** — H0의 고아 import 정리는 Task 2·3·4 안에서 이미 끝났어야 한다(그게 각 task의 게이트 통과 조건이었다).
>
> 그럼에도 수정이 필요해지면: 해당 컴포넌트의 `__tests__` 파일에 `it.todo("<사유>")` 한 줄을 먼저 넣어 언블록 → 수정 → **커밋 전에 `it.todo` 제거**(아래 Step 5의 체크박스). `it.todo`는 vitest에서 실패가 아니라 게이트가 green이므로, 제거를 산문에 묻으면 아무도 못 잡는다.

- [ ] **Step 1: 사본 0 확인 (spec §6.5)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pair-input-blur-commit
grep -n "resolveThinkDraft" ui/src/components/scenario/*.tsx
```
Expected: **출력 없음**(4 사이트 모두 훅 경유). `useThinkTimePair.ts`만 `ui/src/scenario/thinkTime.ts`에서 import한다.

```bash
grep -rn "minDraft\|maxDraft\|defMinDraft\|thinkMinDraft" ui/src/components/scenario/*.tsx
```
Expected: **출력 없음**(드래프트 state가 훅 안에만 있다).

- [ ] **Step 2: 규칙 0-diff 확인 (Global Constraint)**

```bash
git diff $(git merge-base master HEAD)..HEAD --stat -- ui/src/scenario/thinkTime.ts ui/src/i18n/ko.ts crates/ proto/
```
Expected: **출력 없음**

- [ ] **Step 3: 스코프 확인**

```bash
git diff $(git merge-base master HEAD)..HEAD --stat
```
Expected: `ui/src/components/scenario/` + `docs/` 만. `crates/`·migration·서버 store 0-diff.

- [ ] **Step 4: 전체 게이트**

```bash
cd ui && pnpm lint; echo lint=$?
pnpm test; echo test=$?
pnpm build; echo build=$?
```
Expected: 셋 다 `=0`. **전체** `pnpm test`(인자 없이)를 돌릴 것 — 타깃 실행만으론 다른 파일의 red를 놓친다.

> full-suite가 간헐 red면(`ScenarioEditPage.name` 등) 해당 파일을 격리 실행해 green이면 알려진 flake다 — 커밋 재시도. 실제 회귀와 혼동하지 말 것.

- [ ] **Step 5: `it.todo` 잔여 확인 후 커밋(변경이 있었을 때만)**

먼저 언블록용 `it.todo`가 남아 있지 않은지 확인한다:

```bash
git diff $(git merge-base master HEAD)..HEAD -- ui/ | grep -n "it.todo"
```
Expected: **출력 없음**

```bash
git add -A ui/
git commit -m "chore(ui): 짝 입력 수렴 확인 후속 정리"
```

---

## 라이브 검증 (구현 후, 머지 전 — 별도 단계)

`/live-verify` 레시피로 진행한다. **UI 슬라이스지만 생략 불가** — 이 결함은 RTL 이디엄이 원리적으로 못 보는 경로에서 실측됐고 최초 발견도 Playwright였다.

- 진입 화면 **양쪽 모두**: `/scenarios/new` **와** `/scenarios/{id}`. 한 화면만 보면 그 화면이 우연히 정상인 버그를 놓친다.
- 4 표면 각각에서 B1 절차(`200/500` → `1000`·`2000`) → `1000–2000` 저장 확인.
- **사이트 3·4는 ESC 닫힘 경로를 반드시 실행**(R5). 포커스 이동만 검증하면 R5를 전혀 건드리지 않은 채 PASS가 나온다.
- YAML 반영은 Monaco DOM이 아니라 저장 후 `GET /api/scenarios/{id}`의 **`yaml` 필드**가 권위.
- 결과는 US 앵커 표(`US | 절차 | 통과 신호`)로 기록.

## 자기 점검 결과

- **spec 커버리지**: R1→Task 1, R2→Task 1, R3(원시값 dep)→Task 1, R4(시드)→Task 1 Step 1의 `{0,0}` 케이스, R5→Task 5, §4.1(기존 green)→각 task Step 4 + Task 6 Step 4, §4.2→Task 2–4, §4.3(이빨)→각 task 전용 스텝, §4.4→Task 1의 revert 케이스, §4.5→Task 5, §6.5→Task 6 Step 1. 누락 없음.
- **플레이스홀더 스캔**: 없음. 모든 코드 스텝에 실제 코드가 있다.
- **타입 일관성**: `ThinkPairFieldProps`/`useThinkTimePair` 시그니처가 Task 1에서 정의되고 Task 2–5가 그 이름(`minProps`/`maxProps`/`reseed`)만 쓴다. `onCommit(v: ThinkTime)`/`onClear()`는 4 사이트 모두 동일 형태.

REVIEW-GATE: APPROVED
