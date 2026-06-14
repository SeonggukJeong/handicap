# open+curve 슬롯(max_in_flight) 사이징 힌트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog의 열린 루프 **곡선**(open+curve, stages) 모드에서 run을 돌리기 전에 "권장 max_in_flight"를 미리 답한다 — 기존 open+fixed 슬롯 헬퍼를 stages의 **피크 단계 목표**(`max(stage.target)`) 기준으로 확장.

**Architecture:** 순수 UI 슬라이스. 기존 `SlotSizingHelper`(open+fixed에서 쓰던 그 컴포넌트)를 재사용하고, (a) stages→피크 도출 순수 함수 `peakStageTarget`(`sizing.ts`)과 (b) 피크 기준 문구 변형(`peakBased` prop + `ko` 2문자열)만 가산한다. open 브랜치의 `rateMode==="curve"` 케이스에 헬퍼를 렌더해 closed+curve(VU 곡선)와 구조적으로 분리한다. 권장 수식 `ceil(peak × p50/1000).max(1)`은 사후 `load_gen_saturated` 인사이트(`report.rs:616-621` stages-peak + `insights.rs:224` required)와 1:1 parity. **엔진·워커·proto·controller·migration·Zod 와이어 무변경, run 페이로드 byte-identical — 머지 diff는 `ui/` 한정.**

**Tech Stack:** TypeScript/React, Vitest + React Testing Library, `ko.ts` 메시지 카탈로그(ADR-0035).

**Spec:** `docs/superpowers/specs/2026-06-15-open-curve-slot-sizing-hint-design.md`

**커밋 경계 주의(루트 CLAUDE.md):** UI-only 커밋이라 pre-commit은 cargo 게이트를 skip하고 **UI 게이트(`pnpm lint && pnpm test && pnpm build`)** 만 돈다(`ui/node_modules` 있을 때). 각 Task는 **green 단일 커밋**으로 fold(RED 테스트만 단독 커밋하면 `pnpm test` 게이트가 막는다). 커밋은 파이프(`| tail`) 없이 — git exit code 마스킹 방지. TDD-guard: src(`ui/src/*.ts(x)`) 편집 전 워크트리에 pending 테스트 파일이 있어야 하므로 **각 Task는 테스트 파일을 먼저 수정**(test-path 파일이라 자동 unblock).

**작업 디렉터리:** `/Users/sgj/develop/handicap/.claude/worktrees/open-curve-slot-hint` (worktree). 모든 명령은 여기서.

---

## File Structure

- **Modify** `ui/src/components/sizing.ts` — 순수 함수 `peakStageTarget(stages)` 추가(기존 `targetRpsValid` 재사용). `recommendSlots`/`pickLatestOpenRun`/`recommendVus` 무변경.
- **Modify** `ui/src/components/__tests__/sizing.test.ts` — `peakStageTarget` describe 블록 추가.
- **Modify** `ui/src/i18n/ko.ts` — `ko.slotSizing`에 `formulaPeak`·`needTargetCurve` 2문자열 추가.
- **Modify** `ui/src/components/SlotSizingHelper.tsx` — `peakBased?: boolean` prop 추가, `formula`/`needTarget` 두 문구만 분기, `targetRps` JSDoc 일반화.
- **Modify** `ui/src/components/__tests__/SlotSizingHelper.test.tsx` — `peakBased` 문구 변형 2케이스 추가.
- **Modify** `ui/src/components/LoadModelFields.tsx` — `peakStageTarget` import + `peakStr` useMemo + open+curve arm에 `<SlotSizingHelper … peakBased>` 렌더.
- **Modify** `ui/src/components/__tests__/LoadModelFields.test.tsx` — 슬롯 헬퍼 락인을 "open+curve도 렌더"로 flip(closed 모드는 미렌더 유지).

**무변경(명시)**: `RunDialog.tsx`(이미 `onApplyMaxInFlight`/`sizingScenarioId`/`sizingEnv` 전달 중), `ScheduleForm.tsx`(미전달 → 부재), `loadModel.ts`, `schemas.ts`, 엔진/워커/proto/controller/migration.

---

## Task 1: `peakStageTarget` 순수 함수 (`sizing.ts`)

**Files:**
- Modify: `ui/src/components/sizing.ts` (끝에 추가)
- Test: `ui/src/components/__tests__/sizing.test.ts` (끝에 describe 추가)

- [ ] **Step 1: 실패 테스트 작성**

`ui/src/components/__tests__/sizing.test.ts` 끝(파일 마지막 `});` 다음 줄)에 추가. import 줄(line 2)에 `peakStageTarget`을 더한다:

```ts
// line 2를 아래로 교체:
import {
  recommendVus,
  pickLatestClosedRun,
  recommendSlots,
  pickLatestOpenRun,
  peakStageTarget,
} from "../sizing";
```

파일 끝에 추가:

```ts
describe("peakStageTarget", () => {
  it("빈 배열 → null", () => {
    expect(peakStageTarget([])).toBeNull();
  });

  it("전부 무효(빈/문자/0/소수/범위초과) → null", () => {
    expect(
      peakStageTarget([
        { target: "" },
        { target: "abc" },
        { target: "0" },
        { target: "1.5" },
        { target: "2000000" },
      ]),
    ).toBeNull();
  });

  it("혼합(유효+무효) → 유효 후보 중 최대", () => {
    expect(
      peakStageTarget([
        { target: "50" },
        { target: "abc" },
        { target: "200" },
        { target: "100" },
      ]),
    ).toBe(200);
  });

  it("단일 유효 → 그 값", () => {
    expect(peakStageTarget([{ target: "120" }])).toBe(120);
  });

  it("정렬 무관(내림차순도 동일 결과)", () => {
    expect(peakStageTarget([{ target: "300" }, { target: "10" }])).toBe(300);
  });

  it("경계: 1 / 1000000 포함, 1000001 제외", () => {
    expect(peakStageTarget([{ target: "1" }])).toBe(1);
    expect(peakStageTarget([{ target: "1000000" }])).toBe(1000000);
    expect(peakStageTarget([{ target: "1000001" }])).toBeNull();
  });

  it("parity: peak → recommendSlots가 insight 수식(ceil(target×p50/1000))과 동일", () => {
    // 단계 목표 50→200 → peak 200; insights.rs:224 required = ceil(200×250/1000)=50.
    const peak = peakStageTarget([{ target: "50" }, { target: "200" }]);
    expect(peak).toBe(200);
    expect(recommendSlots(peak as number, 250)?.recommendedSlots).toBe(50);
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test sizing` (worktree 루트에서; `--` 붙이지 말 것 — ui/CLAUDE.md 단일파일 필터 함정)
Expected: FAIL — `peakStageTarget is not a function` (또는 import 에러).

- [ ] **Step 3: 구현**

`ui/src/components/sizing.ts` 끝(파일 마지막 `}` = `pickLatestOpenRun` 닫는 중괄호 다음)에 추가:

```ts
/** open+curve(stages)에서 권장 슬롯 기준이 되는 '최고 단계 목표'(peak).
 *  max_in_flight는 run 전체 단일값이라 도착률이 가장 높은 단계 기준으로 사이징해야
 *  어느 단계에서도 drop이 없다. 사후 load_gen_saturated의 곡선 유효목표 도출
 *  (controller report.rs:616-621 `stages.iter().map(|st| st.target).max()`)과 동일 수식.
 *  stages는 문자열 드래프트라 유효 정수(targetRpsValid, 1..=1_000_000)만 후보; 없으면 null. */
export function peakStageTarget(stages: { target: string }[]): number | null {
  let peak: number | null = null;
  for (const s of stages) {
    const n = Number(s.target);
    if (!targetRpsValid(n)) continue;
    if (peak === null || n > peak) peak = n;
  }
  return peak;
}
```

(`targetRpsValid`는 `sizing.ts:18`의 기존 모듈-private 함수 — 같은 파일이라 그대로 호출.)

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test sizing`
Expected: PASS (peakStageTarget describe 전부 + 기존 recommendSlots/pickLatestOpenRun 회귀 없음).

- [ ] **Step 5: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: lint 0 warning, `tsc -b` clean (exported 함수라 dead-code 경고 없음).

```bash
git add ui/src/components/sizing.ts ui/src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): peakStageTarget 순수 함수 (open+curve 슬롯 힌트 기준 peak)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

직후 `git log -1`로 landed 확인(파이프 금지).

---

## Task 2: `peakBased` 문구 변형 (`SlotSizingHelper.tsx` + `ko.ts`)

**Files:**
- Modify: `ui/src/i18n/ko.ts:329-350` (`ko.slotSizing`에 2문자열 추가)
- Modify: `ui/src/components/SlotSizingHelper.tsx` (Props + 2문구 분기 + JSDoc)
- Test: `ui/src/components/__tests__/SlotSizingHelper.test.tsx` (2케이스 추가)

- [ ] **Step 1: 실패 테스트 작성**

`ui/src/components/__tests__/SlotSizingHelper.test.tsx`의 마지막 `it(...)` 다음, `describe`의 닫는 `});` **전에** 추가:

```ts
  it("peakBased + 앵커: '최고 단계 목표' 문구로 계산식 표시", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(
      <SlotSizingHelper scenarioId="s1" env={{}} targetRps="1000" peakBased onApply={vi.fn()} />,
    );
    // formulaPeak: 최고 단계 목표 1000 RPS × 지연 50ms ≈ 동시 50슬롯
    expect(screen.getByText(/최고 단계 목표 1000 RPS/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 동시 50슬롯/)).toBeInTheDocument();
  });

  it("peakBased + 목표 빈 문자열 → '단계 목표를 먼저 입력' (곡선 변형)", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="" peakBased onApply={vi.fn()} />);
    expect(screen.getByText(/단계 목표를 먼저 입력/)).toBeInTheDocument();
    // fixed 변형 문구는 안 떠야 함(회귀 가드)
    expect(screen.queryByText(/목표 RPS를 먼저 입력/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test SlotSizingHelper`
Expected: FAIL — `peakBased`가 아직 prop이 아니라 `formulaPeak` 미정의(여전히 기존 `formula`가 "목표 1000 RPS"로 렌더 → "최고 단계 목표" 미발견) + targetRps="" 케이스가 기존 "목표 RPS를 먼저 입력"을 띄워 단언 실패.

- [ ] **Step 3: ko.ts 문자열 추가**

`ui/src/i18n/ko.ts`의 `ko.slotSizing` 블록 안, `overCapacity` 항목 **다음**(닫는 `},` 전, 즉 `sizing:` 주석 직전)에 추가:

```ts
    formulaPeak: (targetRps: number, latencyMs: number, n: number) =>
      `최고 단계 목표 ${targetRps} RPS × 지연 ${latencyMs}ms ≈ 동시 ${n}슬롯`,
    needTargetCurve: "단계 목표를 먼저 입력하세요.",
```

(`formulaPeak` 시그니처는 기존 `formula(targetRps, latencyMs, n)`와 동일 — 컴포넌트가 swap. `needTargetCurve`는 변수 치환 없는 고정 문자열 → 조사 병기 불요.)

- [ ] **Step 4: SlotSizingHelper.tsx 변경**

(4a) Props에 `peakBased` 추가. `SlotSizingHelper.tsx:27-34`의 `type Props`에서 `targetRps` JSDoc을 일반화하고 `peakBased` 1개 추가:

```ts
type Props = {
  scenarioId: string;
  env: Record<string, string>;
  /** 유효 목표 RPS 문자열(읽기 전용 — 자체 입력칸 없음). fixed=폼 목표 RPS, curve=stages 피크(상위 도출). */
  targetRps: string;
  /** true면 곡선 변형 문구(formulaPeak/needTargetCurve) 사용 — open+curve에서 LoadModelFields가 전달. */
  peakBased?: boolean;
  /** 적용 → RunDialog의 setMaxInFlight(String(n)). */
  onApply: (n: number) => void;
};
```

(4b) 구조분해(`SlotSizingHelper.tsx:36`)에 `peakBased = false` 추가:

```ts
export function SlotSizingHelper({ scenarioId, env, targetRps, peakBased = false, onApply }: Props) {
```

(4c) 계산식 문구(`SlotSizingHelper.tsx:134-140`) — `formula`를 분기:

```tsx
          <p className="text-xs text-slate-500 mt-1">
            {(peakBased ? ko.slotSizing.formulaPeak : ko.slotSizing.formula)(
              targetNum,
              Math.round(latencyMs as number),
              result.recommendedSlots,
            )}
          </p>
```

(4d) needTarget 문구(`SlotSizingHelper.tsx:148-149`) — 분기:

```tsx
      ) : targetRps.trim() === "" ? (
        <p className="text-xs text-slate-500">
          {peakBased ? ko.slotSizing.needTargetCurve : ko.slotSizing.needTarget}
        </p>
```

- [ ] **Step 5: GREEN 확인**

Run: `cd ui && pnpm test SlotSizingHelper`
Expected: PASS (신규 2케이스 + 기존 10케이스 = 12 회귀 없음 — 기존 케이스는 `peakBased` 미지정=false라 기존 문구 유지).

- [ ] **Step 6: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: clean(`peakBased?` optional이라 기존 호출부 무영향).

```bash
git add ui/src/i18n/ko.ts ui/src/components/SlotSizingHelper.tsx ui/src/components/__tests__/SlotSizingHelper.test.tsx
git commit -m "feat(ui): SlotSizingHelper peakBased 문구 변형 + ko.slotSizing.{formulaPeak,needTargetCurve}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`git log -1` 확인.

---

## Task 3: open+curve arm 배선 + 락인 flip (`LoadModelFields.tsx`)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx` (import + peakStr useMemo + open+curve arm)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx:216-229` (락인 flip)

- [ ] **Step 1: 락인 테스트 flip (RED 유도)**

`ui/src/components/__tests__/LoadModelFields.test.tsx`의 슬롯-헬퍼 "미렌더" it.each(현재 `:216-229`)를 **아래로 교체** — open+curve를 렌더 케이스로 빼고, closed 2모드만 미렌더로 남긴다:

```ts
  it("open+curve + onApplyMaxInFlight 주어지면 슬롯 헬퍼 렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "curve",
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
  });

  // 슬롯 헬퍼는 open(fixed/curve) 전용 — prop이 다 있어도 closed 모드(VU 기반)에선 미렌더.
  it.each([
    { loadModel: "closed", rateMode: "fixed" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)("$loadModel+$rateMode 모드에선 슬롯 헬퍼 미렌더 (prop 있어도)", (mode) => {
    renderFields({
      ...mode,
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test LoadModelFields`
Expected: FAIL — "open+curve … 슬롯 헬퍼 렌더"가 미렌더(현재 prod는 open+curve에서 `curveEditor`만)라 `getByTestId("slot-sizing-helper")`가 못 찾음.

- [ ] **Step 3: import 추가**

`ui/src/components/LoadModelFields.tsx:1`의 React import에 `useMemo` 추가, line 8 다음에 `peakStageTarget` import 추가:

```ts
import { useId, useMemo, type Dispatch, type SetStateAction } from "react";
```
```ts
import { SlotSizingHelper } from "./SlotSizingHelper";
import { peakStageTarget } from "./sizing";
```

- [ ] **Step 4: peakStr useMemo 추가**

`ui/src/components/LoadModelFields.tsx`의 `ids` 객체 정의 직후(`maxInFlight: useId(), };` 다음 = 현 `:78` 아래)에 추가:

```ts
  // open+curve 슬롯 힌트의 기준 = 최고 단계 목표(peak). stages는 문자열 드래프트라
  // 유효 정수만 후보(peakStageTarget). 없으면 "" → 헬퍼가 needTargetCurve 표시.
  const peakStr = useMemo(() => {
    const p = peakStageTarget(stages);
    return p != null ? String(p) : "";
  }, [stages]);
```

- [ ] **Step 5: open+curve arm에 헬퍼 렌더**

`ui/src/components/LoadModelFields.tsx`의 open 브랜치 `rateMode === "fixed" ? (...) : ( curveEditor )` 중 **else 분기**(현 `:491-493` = `) : (\n  curveEditor\n)}`)를 교체:

```tsx
          ) : (
            <>
              {curveEditor}
              {onApplyMaxInFlight && sizingScenarioId !== undefined && (
                <SlotSizingHelper
                  scenarioId={sizingScenarioId}
                  env={sizingEnv ?? {}}
                  targetRps={peakStr}
                  peakBased
                  onApply={onApplyMaxInFlight}
                />
              )}
            </>
          )}
```

(게이트 `onApplyMaxInFlight && sizingScenarioId !== undefined`는 open+fixed arm `:482`와 동형 → RunDialog만 전달, ScheduleForm 부재. closed+curve는 `loadModel==="closed"` 브랜치라 도달 불가.)

- [ ] **Step 6: GREEN 확인**

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS — open+curve 렌더 + closed 2모드 미렌더 + 기존 open+fixed 렌더/반쪽가드/VU 락인 회귀 없음.

- [ ] **Step 7: 게이트 + 커밋**

Run: `cd ui && pnpm lint && pnpm build`
Expected: clean (`useMemo`/`peakStageTarget` 사용처 생김 — unused 없음).

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(ui): open+curve RunDialog에 SlotSizingHelper 배선 (peak 기준 슬롯 힌트)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

`git log -1` 확인.

---

## Task 4: 전체 게이트 + 라이브 검증 + 문서

**Files:** (코드 무변경 — 검증·문서만)

- [ ] **Step 1: 전체 UI 스위트 (S-D 함정 — 인자 없는 전체 1회)**

Run: `cd ui && pnpm test` (인자 없이 전체 — `RunDialog`/`LoadModelFields` 외 파일 잠복 red 차단)
Expected: 전체 PASS.

Run: `cd ui && pnpm lint && pnpm build`
Expected: lint 0 warning, build clean.

- [ ] **Step 2: 라이브 검증 (`/live-verify` + Playwright)**

`/live-verify` 스킬로 워크트리-자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`) + **≥50ms 지연 responder**(localhost sub-ms는 `p50_ms==0`이라 앵커 null — engine CLAUDE.md) + 격리 DB로 스택을 띄운다. UI는 `pnpm dev`(5173) 또는 `ui/dist` 단일포트(8080, dist stale 주의 — `just ui-build` 후). 검증:

- (a) **앵커 경로**: 최근 종료 open-loop run(≥50ms 지연) 있는 시나리오 → RunDialog 열린+곡선 → stages 입력(예 50→200→100, peak 200) → 권장 슬롯 `ceil(200×p50/1000)` + **"최고 단계 목표 200 RPS"** 문구 확인. stage target 바꿔(예 peak 300) 재계산 확인. "적용" → `동시 요청 상한` 칸이 권장값으로 채워짐 확인. React controlled input은 native setter(루트 CLAUDE.md), click과 단언은 별도 `browser_evaluate`.
- (b) **측정 경로**: prior run 없는 시나리오 → 곡선 모드 → test-run 측정 버튼 → 권장값 + "부하 없는 1회 실행" 한계 문구.
- (c) **수식 parity (핵심)**: 권장 슬롯으로 open+curve run 생성 → 별도로 피크보다 **낮게** max_in_flight 잡은 대조 run 생성 → 그 리포트 인사이트 `load_gen_saturated`의 `recommended`/`required`가 **같은 수식(stages-peak × p50)** 으로 나오는지 = UI 헬퍼 권장과 산술 일치(`report.rs:616-621` 곡선 유효목표 경로 라이브 확인). open+fixed 헬퍼 검증한 parity의 곡선판.
- (d) 콘솔 Zod 에러 0. `.playwright-mcp/` + 루트 png 정리(머지 전 `rm -rf .playwright-mcp`).

- [ ] **Step 3: handicap-reviewer 최종 리뷰**

`handicap-reviewer` 에이전트로 전체 diff 리뷰(repo-trap-aware): UI Zod↔엔진 와이어 무변경 확인(run 페이로드 byte-identical), peak parity(`peakStageTarget` ↔ `report.rs:620` `.max()` ↔ `insights.rs:224`), 게이팅(ScheduleForm 누수 없음), `tsc -b`/lint/test green. READY-TO-MERGE까지.

- [ ] **Step 4: 문서 갱신 (별도 docs 커밋)**

- `docs/build-log.md`에 한 단락 append(파이프라인·peak parity·게이팅·라이브 검증 결과).
- `docs/roadmap.md` §A9: "open+curve 슬롯 힌트" 연기 항목을 ✅ 완료로(spec §10 첫 항목 해소).
- 루트 `CLAUDE.md` 상태 줄 한 줄 *교체*(append 금지) — open+curve 슬롯 힌트 완결 반영.
- `ui/CLAUDE.md`: 필요 시 함정 한 줄(peak 도출 = `report.rs` `.max()`와 lockstep, 게이트 패턴 3회 검증 등).
- 자동메모리 `MEMORY.md` "활성 작업" 갱신.

```bash
git add docs/build-log.md docs/roadmap.md CLAUDE.md ui/CLAUDE.md
git commit -m "docs(a9): open+curve 슬롯 사이징 힌트 완결 — build-log·roadmap §A9·상태줄·ui 함정

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: 머지 (루트 CLAUDE.md git 토폴로지)**

master ff 가능 확인 후 `git -C /Users/sgj/develop/handicap merge --ff-only worktree-open-curve-slot-hint`(세션이 길어 master 전진했으면 rebase 후 ff). 머지 확인 후 `ExitWorktree(remove, discard_changes: true)`로 정리.

---

## Self-Review (작성자 체크)

- **Spec coverage**: §5.1 peakStageTarget → Task 1. §5.2/§7.4 peakBased 문구 → Task 2. §3.1/§6/§8 배선 → Task 3. §9 락인 flip → Task 3 Step 1. §9 라이브/게이트 → Task 4. 누락 없음.
- **Placeholder scan**: 모든 코드 스텝에 실제 코드. TBD 없음.
- **Type consistency**: `peakStageTarget(stages: { target: string }[]): number | null`(Task 1) = LoadModelFields `StageRow[]`(`{target,duration_seconds}`) 구조 충족(Task 3). `peakBased?: boolean`(Task 2 Props) = Task 3 `peakBased` JSX prop. `formulaPeak(targetRps, latencyMs, n)`(Task 2 ko) = 기존 `formula` 시그니처 동일 → swap 안전. `recommendSlots`/`targetRpsValid` 무변경 재사용.
- **커밋 경계**: 각 Task는 test-first→impl→green 단일 커밋(RED 단독 커밋 없음 — UI 게이트 통과). UI-only라 cargo skip.
