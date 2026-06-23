# Run mid-run stall advisory (G1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDetailPage가 running 중인 run의 메트릭이 임계값(120초)간 끊기면 "⚠ 진행 없음 — 워커가 멈췄을 수 있어요" advisory 배너 + [중단] 버튼을 띄운다.

**Architecture:** 순수 클라이언트. `ts_second`는 wall-clock unix 초로 raw 전달되므로 `silence = floor(now/1000) − max(ts_second)`를 클라에서 계산한다. stall 판정(기존 startup + 신규 midrun)을 순수 헬퍼 `computeRunStall`로 추출해 단위테스트하고, RunDetailPage는 그 결과로 단일 `stall.kind` 스위치를 렌더한다. 백엔드(`crates/**`)·proto·migration·Zod 스키마·API **0 변경**.

**Tech Stack:** TypeScript/React, Vitest + React Testing Library, Zod(읽기만), Tailwind.

**참조 spec:** `docs/superpowers/specs/2026-06-23-run-stall-advisory-design.md`.

## Global Constraints

- **백엔드 byte-identical**: `crates/**`·proto·migration·DB·`ui/src/api/schemas.ts` 무변경. production diff는 `ui/src`-only(테스트 제외 시 `runStall.ts` + `RunDetailPage.tsx` + `ko.ts`).
- **run status 불변**: advisory만 — run status를 절대 안 바꾼다.
- **ko.ts 단일 소스(ADR-0035)**: 모든 신규 사용자노출 문구는 `ko.runDetail.*` 경유. 배너 [중단] 버튼은 **새 키 없이** 기존 `ko.common.abort`("중단")/`ko.common.aborting`("중단 중…") 재사용(헤더 버튼과 동일 라벨).
- **임계값**: `MIDRUN_STALL_MS = 120_000`, `STARTUP_STALL_MS = 15_000`(기존 인라인 `15_000` 상수화). 런타임 가변 안 함(B2 연기).
- **TDD 순서(tdd-guard, ui/CLAUDE.md)**: 각 task에서 **test-path 파일(`__tests__/*.test.ts(x)`)을 먼저** 편집해 pending RED diff를 만든 뒤 `ui/src` non-test 파일(`runStall.ts`/`RunDetailPage.tsx`/`ko.ts`)을 편집한다.
- **REVIEW-GATE(spec-review-guard)**: 이 plan은 `REVIEW-GATE: APPROVED` 마커를 EOL에 달아야 `ui/src` 편집(테스트 포함)이 허용된다. 마커는 reviewer clean APPROVE 후에만.
- **게이트**: 각 task 커밋 전 `pnpm lint && pnpm test && pnpm build`(UI 3종 — `pnpm test`(esbuild)는 타입 에러를 못 잡으니 `pnpm build`/`tsc -b` 필수). pre-commit이 `ui/` 커밋에 같은 게이트를 자동 실행하나, 커밋 전 수동 1회로 RED→GREEN 확인.
- **커밋 1회/task**: RED 테스트 단독 커밋 금지(UI 게이트의 `pnpm test`가 실패) — 각 task는 test+impl을 묶어 **하나의 green 커밋**.

---

### Task 1: `computeRunStall` 순수 헬퍼 + 단위테스트

stall 판정 로직을 React 밖 순수 함수로 추출(repo 관용구: `runPrefill`/`sizing`/`loadModel`). startup(메트릭 0)·midrun(메트릭 흐른 뒤 침묵) 두 케이스를 한곳에 모으고 임계값을 상수화한다.

**Files:**
- Create: `ui/src/api/runStall.ts`
- Test: `ui/src/api/__tests__/runStall.test.ts`

**Interfaces:**
- Consumes: `Run`(`ui/src/api/schemas.ts` — `status: RunStatus`, `started_at: number | null`, `created_at: number`), `WindowSummary`(`ts_second`, `count`, …).
- Produces:
  - `computeRunStall(run: Pick<Run,"status"|"started_at"|"created_at">, windows: readonly WindowSummary[] | undefined, nowMs: number): RunStall`
  - `interface RunStall { kind: "none" | "startup" | "midrun"; silentSeconds: number }`
  - `const STARTUP_STALL_MS = 15_000`, `const MIDRUN_STALL_MS = 120_000`
  - `type RunStallKind = "none" | "startup" | "midrun"`

- [ ] **Step 1: Write the failing test**

Create `ui/src/api/__tests__/runStall.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeRunStall, MIDRUN_STALL_MS, STARTUP_STALL_MS } from "../runStall";
import type { WindowSummary } from "../schemas";

const NOW = 1_000_000_000_000; // 고정 ms (nowSec = 1_000_000_000)
const NOW_SEC = Math.floor(NOW / 1000);

const win = (ts_second: number, count = 5): WindowSummary => ({
  ts_second,
  step_id: "s1",
  count,
  error_count: 0,
  status_counts: { "200": count },
});

const running = { status: "running" as const, started_at: NOW - 1_000, created_at: NOW - 1_000 };

describe("computeRunStall", () => {
  it("비-running run은 none", () => {
    expect(
      computeRunStall({ status: "completed", started_at: 1, created_at: 1 }, [win(1)], NOW),
    ).toEqual({ kind: "none", silentSeconds: 0 });
  });

  it("metrics 미도착(windows undefined)이면 none (플래시 가드)", () => {
    expect(computeRunStall(running, undefined, NOW)).toEqual({ kind: "none", silentSeconds: 0 });
  });

  it("running + 요청 0건 + STARTUP 임계 초과 → startup", () => {
    const run = { status: "running" as const, started_at: NOW - 20_000, created_at: NOW - 20_000 };
    expect(computeRunStall(run, [], NOW).kind).toBe("startup");
  });

  it("running + 요청 0건 + STARTUP 임계 미만 → none", () => {
    const run = { status: "running" as const, started_at: NOW - 3_000, created_at: NOW - 3_000 };
    expect(computeRunStall(run, [], NOW).kind).toBe("none");
  });

  it("started_at null이면 created_at으로 폴백", () => {
    const run = { status: "running" as const, started_at: null, created_at: NOW - 20_000 };
    expect(computeRunStall(run, [], NOW).kind).toBe("startup");
  });

  it("running + 요청 있음 + 최근 메트릭(침묵 2초) → none", () => {
    expect(computeRunStall(running, [win(NOW_SEC - 2)], NOW).kind).toBe("none");
  });

  it("MIDRUN 경계: 침묵 120초는 none, 121초는 midrun", () => {
    expect(computeRunStall(running, [win(NOW_SEC - 120)], NOW).kind).toBe("none");
    const r = computeRunStall(running, [win(NOW_SEC - 121)], NOW);
    expect(r.kind).toBe("midrun");
    expect(r.silentSeconds).toBe(121);
  });

  it("running + 요청 있음 + 침묵 130초 → midrun, silentSeconds=130", () => {
    // 여러 윈도 중 max(ts_second) 사용
    const windows = [win(NOW_SEC - 200), win(NOW_SEC - 130), win(NOW_SEC - 180)];
    expect(computeRunStall(running, windows, NOW)).toEqual({ kind: "midrun", silentSeconds: 130 });
  });

  it("메트릭 재개(maxTs 최근) → midrun에서 none으로 회복", () => {
    expect(computeRunStall(running, [win(NOW_SEC - 1)], NOW).kind).toBe("none");
  });

  it("임계 상수값", () => {
    expect(STARTUP_STALL_MS).toBe(15_000);
    expect(MIDRUN_STALL_MS).toBe(120_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test runStall`
Expected: FAIL — `Failed to resolve import "../runStall"` (파일 미존재).

- [ ] **Step 3: Write the helper**

Create `ui/src/api/runStall.ts`:

```ts
import type { Run, WindowSummary } from "./schemas";

/** startup(메트릭 0)·midrun(메트릭 흐른 뒤 침묵) stall 임계값(ms). 런타임 가변 아님(B2 연기). */
export const STARTUP_STALL_MS = 15_000;
export const MIDRUN_STALL_MS = 120_000;

export type RunStallKind = "none" | "startup" | "midrun";

export interface RunStall {
  kind: RunStallKind;
  /** midrun일 때 마지막 메트릭 이후 침묵 초; 그 외 0. 배너 문구용. */
  silentSeconds: number;
}

const NONE: RunStall = { kind: "none", silentSeconds: 0 };

/**
 * run의 진행 stall 상태를 순수 계산한다(백엔드 무관).
 * - startup: running·메트릭 도착·요청 0건·시작 후 STARTUP_STALL_MS 초과.
 * - midrun: running·요청>0·마지막 메트릭(ts_second, wall-clock unix초) 이후 MIDRUN_STALL_MS 초과 침묵.
 * 두 케이스는 totalCount(0 vs >0)로 상호배제. 메트릭 미도착(windows===undefined)이면
 * 판정하지 않는다(정상 진입 시 첫 RTT 배너 플래시 방지).
 */
export function computeRunStall(
  run: Pick<Run, "status" | "started_at" | "created_at">,
  windows: readonly WindowSummary[] | undefined,
  nowMs: number,
): RunStall {
  if (run.status !== "running") return NONE;
  if (windows === undefined) return NONE;

  const totalCount = windows.reduce((acc, w) => acc + w.count, 0);

  if (totalCount === 0) {
    const startedMs = run.started_at ?? run.created_at;
    return nowMs - startedMs > STARTUP_STALL_MS ? { kind: "startup", silentSeconds: 0 } : NONE;
  }

  let maxTs = 0;
  for (const w of windows) if (w.ts_second > maxTs) maxTs = w.ts_second;
  const silence = Math.floor(nowMs / 1000) - maxTs;
  return silence * 1000 > MIDRUN_STALL_MS ? { kind: "midrun", silentSeconds: silence } : NONE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test runStall`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint + typecheck**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 0 errors (특히 `tsc -b`가 `Pick<Run,...>`/`WindowSummary` 타입을 확인).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/runStall.ts ui/src/api/__tests__/runStall.test.ts
git commit -m "feat(ui): computeRunStall 순수 헬퍼 (startup+midrun stall 판정, G1b)"
```

---

### Task 2: RunDetailPage midrun 배너 + [중단] 버튼 + ko 문구

인라인 `stalledRunning`을 `computeRunStall`로 교체하고, 단일 `stall.kind` 스위치로 startup(기존)·midrun(신규) 배너를 렌더한다. midrun 배너엔 기존 `abort.mutate()`를 호출하는 [중단] 버튼을 둔다.

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`runDetail` 블록에 `midRunStall` 추가)
- Modify: `ui/src/pages/RunDetailPage.tsx` (import 2개, `:89` 영역 `stalledRunning`→`stall`, `:197` 영역 배너 2-arm)
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx` (midrun describe 블록 추가)

**Interfaces:**
- Consumes: `computeRunStall`/`RunStall`(Task 1), `formatDurationKo`(`ui/src/i18n/duration.ts`, 초 입력), `ko.common.abort`/`ko.common.aborting`, `ko.runDetail.midRunStall`(이 task), 기존 `abort = useAbortRun(...)`(`RunDetailPage.tsx:33`).
- Produces: `ko.runDetail.midRunStall(d: string): string`.

- [ ] **Step 1a: Fix the existing `mockRunningApi` fixture to use a recent `ts_second`**

기존 `mockRunningApi`(`ui/src/pages/__tests__/RunDetailPage.test.tsx:512-534`)는 윈도에 `ts_second: 1`(고대 unix초)을 쓴다. midrun 로직 도입 후 `windowsCount=1` 케이스(`:544`)는 `totalCount>0`+`ts_second:1` → 침묵 ≈ 거대 → **의도치 않게 midrun 배너가 뜬다**(그 테스트는 startup 텍스트 부재만 단언해 통과는 하지만 비현실적·의미 혼탁). 윈도 `ts_second`를 최근 값으로 바꿔 healthy running run을 표현:

`:522`의 `ts_second: 1,`을 다음으로 교체:

```ts
                ts_second: Math.floor(Date.now() / 1000),
```

그리고 기존 "요청이 있으면 진단 배너가 안 뜬다" 테스트(`:543-549`)에 midrun 배너 부재 단언을 추가해 강화(`await` 줄 뒤):

```ts
    expect(screen.queryByText(/진행 없음/)).toBeNull();
```

- [ ] **Step 1b: Write the failing RTL tests**

`ui/src/pages/__tests__/RunDetailPage.test.tsx`의 `stalled running banner` describe 블록 끝(현 `:573` 근처, 마지막 `it` 뒤) 또는 파일 끝에 새 describe 추가. `within`/`userEvent`는 이미 import됨(`:1-2`):

```ts
describe("RunDetailPage — mid-run stall banner (G1b)", () => {
  // 요청이 흘렀는데 마지막 메트릭이 오래된(ts_second stale) running run을 mock.
  function mockMidRunApi(lastTsSecond: number) {
    let phase = "running";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/MR1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "MR1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: phase,
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 600 },
            env: {},
            started_at: Date.now() - 300_000,
            ended_at: null,
            created_at: Date.now() - 300_000,
          }),
        );
      }
      if (url.endsWith("/api/runs/MR1/metrics")) {
        return Promise.resolve(
          jsonResponse({
            run_id: "MR1",
            windows: [
              { ts_second: lastTsSecond, step_id: "step1", count: 5, error_count: 0, status_counts: { "200": 5 } },
            ],
          }),
        );
      }
      if (url.endsWith("/api/runs/MR1/abort") && init?.method === "POST") {
        phase = "aborted";
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  it("마지막 메트릭이 임계 초과로 오래되면 정지-의심 배너가 뜬다", async () => {
    mockMidRunApi(Math.floor(Date.now() / 1000) - 130); // 침묵 ~130초 > 120
    renderWithRouter("MR1");
    expect(await screen.findByText(/진행 없음/)).toBeInTheDocument();
  });

  it("최근 메트릭이면 정지-의심 배너가 안 뜬다", async () => {
    mockMidRunApi(Math.floor(Date.now() / 1000) - 2); // 침묵 ~2초 < 120
    renderWithRouter("MR1");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/진행 없음/)).toBeNull();
  });

  it("배너의 [중단] 버튼이 abort를 호출한다", async () => {
    const user = userEvent.setup();
    mockMidRunApi(Math.floor(Date.now() / 1000) - 130);
    renderWithRouter("MR1");
    const text = await screen.findByText(/진행 없음/);
    // 헤더에도 "중단" 버튼이 있으므로 배너 영역 안에서만 스코프(R1).
    const banner = text.closest('[role="status"]') as HTMLElement;
    const stopBtn = within(banner).getByRole("button", { name: ko.common.abort });
    await user.click(stopBtn);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            typeof url === "string" &&
            url.endsWith("/api/runs/MR1/abort") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test RunDetailPage`
Expected: 새 3개 중 최소 "배너가 뜬다"/"abort 호출"이 FAIL(`진행 없음` 텍스트 미존재 → `findByText` timeout, 또는 `ko.runDetail.midRunStall` 미정의로 `pnpm build` 실패). "최근 메트릭이면 안 뜬다"는 우연히 통과 가능(아직 배너 자체가 없음).

- [ ] **Step 3: Add the ko string**

`ui/src/i18n/ko.ts`의 `runDetail` 블록에서 기존 `stalledRunning`/`elapsed` 옆에 추가:

```ts
    midRunStall: (d: string) => `⚠ ${d} 진행 없음 — 워커가 멈췄을 수 있어요`,
```

- [ ] **Step 4: Wire RunDetailPage — imports**

`ui/src/pages/RunDetailPage.tsx` 상단 import 블록(`:1-23`)에 추가:

```ts
import { computeRunStall } from "../api/runStall";
import { formatDurationKo } from "../i18n/duration";
```

- [ ] **Step 5: Wire RunDetailPage — replace `stalledRunning` with `stall`**

`:90-96`의 기존 블록:

```ts
  // "요청 0건"은 *기록된* 0건 — metrics 응답 도착 전(undefined)에는 판정하지 않는다
  // (정상 run 진입 시 첫 RTT 동안 배너가 플래시하는 false-positive 방지).
  const stalledRunning =
    r.status === "running" &&
    metrics.data !== undefined &&
    totalCount === 0 &&
    now - (r.started_at ?? r.created_at) > 15_000;
```

을 다음으로 교체(바로 위 `:89` `const totalCount = …`는 카드·RPS에서 쓰므로 **유지**):

```ts
  // startup(메트릭 0)·midrun(메트릭 흐른 뒤 침묵) stall 판정을 단일 헬퍼로(상호배제, 플래시 가드 포함).
  const stall = computeRunStall(r, metrics.data?.windows, now);
```

- [ ] **Step 6: Wire RunDetailPage — banner 2-arm**

`:197-204`의 기존 블록:

```tsx
      {stalledRunning && (
        <div
          role="status"
          className="mb-4 p-3 border border-amber-300 bg-amber-50 text-sm text-amber-800 rounded"
        >
          {ko.runDetail.stalledRunning}
        </div>
      )}
```

을 다음으로 교체(단일 `stall.kind` 소스 → 두 arm 동시 표시 불가):

```tsx
      {stall.kind === "startup" && (
        <div
          role="status"
          className="mb-4 p-3 border border-amber-300 bg-amber-50 text-sm text-amber-800 rounded"
        >
          {ko.runDetail.stalledRunning}
        </div>
      )}
      {stall.kind === "midrun" && (
        <div
          role="status"
          className="mb-4 p-3 border border-amber-300 bg-amber-50 text-sm text-amber-800 rounded flex items-center justify-between gap-3"
        >
          <span>{ko.runDetail.midRunStall(formatDurationKo(stall.silentSeconds))}</span>
          <button
            type="button"
            onClick={() => abort.mutate()}
            disabled={abort.isPending}
            className="shrink-0 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {abort.isPending ? ko.common.aborting : ko.common.abort}
          </button>
        </div>
      )}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd ui && pnpm test RunDetailPage`
Expected: PASS(기존 stalled/abort/retry/preset/report 테스트 + 신규 midrun 3개 전부). 특히 기존 startup 배너 테스트(`:536-573`)가 그대로 green(헬퍼 교체가 startup 의미 보존).

- [ ] **Step 8: Full UI gate**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고, 전체 test green, `tsc -b` + vite build 0 에러.

- [ ] **Step 9: Commit**

```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/i18n/ko.ts ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): mid-run stall advisory 배너 + 중단 버튼 (RunDetailPage, G1b)"
```

---

## Self-Review (작성자 체크)

**Spec coverage:**
- §3/§5 클라 계산 + 헬퍼 → Task 1. ✓
- §4 임계값 120초 상수 → Task 1(`MIDRUN_STALL_MS`). ✓
- §6 단일 `stall.kind` 슬롯 + startup/midrun 배너 + [중단] 버튼(R1 within 스코프) → Task 2 Step 5-6, 테스트 Step 1. ✓
- §7 `ko.runDetail.midRunStall` + abort 라벨 재사용 → Task 2 Step 3. ✓
- §8 단위(분기/경계/회복) + RTL(배너/abort within) + 게이트 → Task 1 Step 1, Task 2 Step 1·8. ✓
- §11 불변식: 백엔드 0(파일 목록 ui/src-only)·status 불변(abort만)·startup 보존(Task 2 Step 7)·상호배제(단일 kind)·플래시 가드(헬퍼 windows===undefined). ✓
- §9 라이브 검증 생략(ui-only) — finish 단계 build-log 기록(이 plan 범위 밖).

**Placeholder scan:** 모든 step에 실제 코드/명령/기대출력 포함. TBD 없음. ✓

**Type consistency:** `computeRunStall`/`RunStall`/`STARTUP_STALL_MS`/`MIDRUN_STALL_MS` 시그니처가 Task 1 정의와 Task 2 소비처(`stall.kind`/`stall.silentSeconds`)에서 일치. `ko.runDetail.midRunStall(d:string)` 정의(Step 3)와 호출(Step 6) 일치. ✓

<!-- REVIEW-GATE: APPROVED -->
