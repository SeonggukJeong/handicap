# RunDialog 크기 프리셋 상대 배수 사이징 (Option C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog의 "빠른 입력" 크기 칩을 고정 10/50/200명 대신, 이 시나리오의 가장 최근 완료된 closed-loop(고정 VU) run 대비 0.5×/1×/2× 배수로 계산해 보여준다. 그런 run이 없으면(신규 시나리오, ScheduleForm) 기존 고정 3개 칩 그대로.

**Architecture:** `VuSizingHelper.tsx`의 기존 private hook `usePriorClosedRunAnchor`를 export+확장(`durationSeconds` 필드 추가)하고, `RunDialog.tsx`가 이를 직접 호출해 계산한 앵커를 새 optional prop `sizePresetAnchor`로 `LoadModelFields`에 내려준다. `LoadModelFields`는 순수 함수 `sizing.ts::sizePresetsFor(anchor)`로 칩 목록을 계산해 렌더 — hook을 직접 호출하지 않아 `LoadModelFields.test.tsx`(QueryClientProvider 없이 렌더)가 무변경으로 남는다.

**Tech Stack:** React + TypeScript, Vitest + React Testing Library, TanStack Query, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-09-rundialog-size-preset-relative-sizing-design.md` (spec-plan-reviewer clean APPROVE, R1–R11).

<!-- REVIEW-GATE: APPROVED -->

## Global Constraints

- 배수 집합은 정확히 `[0.5, 1, 2]`(고정, 확장 불가) — spec R3.
- 계산은 항상 `Math.max(1, Math.round(anchor.X * m))`(최소 1 클램프) — spec R3.
- 계산된 `(vus, durationSeconds)` 쌍이 배수 순서(0.5×→1×→2×)상 이전 항목과 완전히 같으면 그 칩을 건너뛴다 — spec R4.
- 라벨 형식은 정확히 `` `${vus}명 · ${formatDurationKo(durationSeconds)}` ``이고 `·`는 U+00B7 MIDDLE DOT(주변 공백 포함 ` · `) — `ko.ts`의 기존 프리셋 라벨에서 그대로 복사, 재입력 금지 — spec §4.2.
- `anchor===null`이면 `[...ko.loadModel.sizePresets]`(spread 복사, readonly tuple 그대로 반환 금지) — spec R2.
- `sizing.ts`는 React·`.tsx` 파일에 의존하지 않는다(순수 계산 전용, 타입도 리터럴로 인라인 — `VuSizingHelper.tsx`에서 타입 import 금지) — spec §4.2.
- `usePriorClosedRunAnchor` export 선언 바로 위에 `// eslint-disable-next-line react-refresh/only-export-components` 필수 — spec R11.
- `ui/src/components/__tests__/LoadModelFields.test.tsx`는 이 계획의 어떤 task에서도 **한 글자도 수정하지 않는다** — spec R9(성립 조건).
- 매 task 커밋 전 최소 `pnpm test <targeted file>`, 마지막 task에서 인자 없는 전체 `pnpm lint && pnpm test && pnpm build` 필수 — spec §6.
- `tdd-guard`는 워크트리에 pending(수정/untracked) test-path 파일이 있으면 어떤 src 편집도 허용한다(특정 파일과 매칭 안 함) — 그래서 각 task의 Step 1은 항상 test 파일 편집.

---

### Task 1: `sizePresetsFor` 순수 계산 + `usePriorClosedRunAnchor` export/확장

**Files:**
- Modify: `ui/src/components/sizing.ts`
- Modify: `ui/src/components/VuSizingHelper.tsx`
- Test: `ui/src/components/__tests__/sizing.test.ts`

**Interfaces:**
- Consumes: 없음(순수 신규).
- Produces: `sizing.ts`에서 `export function sizePresetsFor(anchor: { vus: number; durationSeconds: number } | null): { label: string; vus: number; durationSeconds: number }[]`. `VuSizingHelper.tsx`에서 `export type ClosedRunAnchor = { vus: number; rps: number; durationSeconds: number }` + `export function usePriorClosedRunAnchor(scenarioId: string | undefined): ClosedRunAnchor | null`(반환 타입에 `durationSeconds` 추가, 이전엔 `{vus,rps}`뿐). Task 2가 이 세 가지를 그대로 가져다 씀.

- [ ] **Step 1: `sizing.test.ts`에 실패하는 테스트 작성**

`ui/src/components/__tests__/sizing.test.ts`의 import 블록을 다음으로 교체(기존 import에 `sizePresetsFor` + `ko` 추가):

```ts
import { describe, it, expect } from "vitest";
import {
  recommendVus,
  pickLatestClosedRun,
  recommendSlots,
  pickLatestOpenRun,
  peakStageTarget,
  peakThroughput,
  recommendWorkers,
  sizePresetsFor,
} from "../sizing";
import type { Run } from "../../api/schemas";
import { ko } from "../../i18n/ko";
```

파일 맨 끝(`describe("recommendWorkers", ...)` 블록 뒤)에 새 블록을 추가:

```ts
describe("sizePresetsFor", () => {
  it("anchor null → 기존 고정 3개(ko.loadModel.sizePresets)와 deep-equal", () => {
    expect(sizePresetsFor(null)).toEqual(ko.loadModel.sizePresets);
  });

  it("anchor null → 반환값은 원본과 별개의 배열(참조 동일 아님, mutable 복사본)", () => {
    const result = sizePresetsFor(null);
    expect(result).not.toBe(ko.loadModel.sizePresets);
  });

  it("anchor 있음 → 0.5×/1×/2× 계산 (VU 20·60초 기준)", () => {
    expect(sizePresetsFor({ vus: 20, durationSeconds: 60 })).toEqual([
      { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
      { label: "20명 · 1분", vus: 20, durationSeconds: 60 },
      { label: "40명 · 2분", vus: 40, durationSeconds: 120 },
    ]);
  });

  it("최소 1 클램프 + 중복 collapse (VU 1·1초 기준 → 0.5×/1× 모두 1로 겹쳐 2개만)", () => {
    expect(sizePresetsFor({ vus: 1, durationSeconds: 1 })).toEqual([
      { label: "1명 · 1초", vus: 1, durationSeconds: 1 },
      { label: "2명 · 2초", vus: 2, durationSeconds: 2 },
    ]);
  });

  it("반올림 (VU 7·13초 기준 → 0.5×=3.5→4명/6.5→7초, 2×=14명/26초)", () => {
    expect(sizePresetsFor({ vus: 7, durationSeconds: 13 })).toEqual([
      { label: "4명 · 7초", vus: 4, durationSeconds: 7 },
      { label: "7명 · 13초", vus: 7, durationSeconds: 13 },
      { label: "14명 · 26초", vus: 14, durationSeconds: 26 },
    ]);
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test sizing`
Expected: FAIL — `sizePresetsFor` is not exported from `../sizing`(import 에러 또는 `TypeError: sizePresetsFor is not a function`).

- [ ] **Step 3: `sizing.ts`에 `sizePresetsFor` 구현**

`ui/src/components/sizing.ts` 맨 위 import 블록을 다음으로 교체:

```ts
import type { Run } from "../api/schemas";
import { formatDurationKo } from "../i18n/duration";
import { ko } from "../i18n/ko";
```

`pickLatestClosedRun` 함수(현재 파일의 36-47번째 줄) 바로 뒤, 열린 루프 슬롯 사이징 섹션(`/** 열린 루프 슬롯...`) 앞에 다음을 삽입:

```ts
const SIZE_PRESET_MULTIPLIERS = [0.5, 1, 2] as const;

/** "빠른 입력" 크기 칩 3개. anchor 있으면 그 VU·duration의 0.5×/1×/2×(최소 1 클램프,
 *  반올림)로 계산 — 계산된 (vus,durationSeconds) 쌍이 배수 순서상 이전 항목과 완전히
 *  같으면 그 칩은 건너뛴다(예: anchor.vus=1이면 0.5×/1× 모두 1로 collapse). anchor
 *  없으면 ko.ts 고정 3개(spread 복사 — `ko`가 `as const`라 원본은 readonly tuple,
 *  그대로 반환하면 mutable 반환타입과 안 맞아 tsc -b가 거부한다). */
export function sizePresetsFor(
  anchor: { vus: number; durationSeconds: number } | null,
): { label: string; vus: number; durationSeconds: number }[] {
  if (anchor === null) return [...ko.loadModel.sizePresets];
  const seen = new Set<string>();
  const presets: { label: string; vus: number; durationSeconds: number }[] = [];
  for (const m of SIZE_PRESET_MULTIPLIERS) {
    const vus = Math.max(1, Math.round(anchor.vus * m));
    const durationSeconds = Math.max(1, Math.round(anchor.durationSeconds * m));
    const key = `${vus}:${durationSeconds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({
      label: `${vus}명 · ${formatDurationKo(durationSeconds)}`,
      vus,
      durationSeconds,
    });
  }
  return presets;
}
```

- [ ] **Step 4: `VuSizingHelper.tsx`의 hook export + 타입 확장**

`ui/src/components/VuSizingHelper.tsx`에서 다음 블록:

```ts
/** 최근 종료 균등-VU run에서 처리량 앵커(VU·달성RPS)를 도출. 없으면 null.
 *  반환값은 useMemo로 안정화 — 소비처 useEffect([anchor])가 값 변화에만 발화. */
function usePriorClosedRunAnchor(
  scenarioId: string | undefined,
): { vus: number; rps: number } | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestClosedRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const vus = latest?.profile.vus ?? 0;
  const rps = report.data?.summary.rps ?? 0;
  return useMemo(() => (vus > 0 && rps > 0 ? { vus, rps } : null), [vus, rps]);
}
```

를 다음으로 교체:

```ts
/** RunDialog의 크기 프리셋 상대배수 사이징(Option C, sizing.ts::sizePresetsFor)에도
 *  재사용하는 앵커 타입. */
export type ClosedRunAnchor = { vus: number; rps: number; durationSeconds: number };

/** 최근 종료 균등-VU run에서 처리량 앵커(VU·달성RPS·duration)를 도출. 없으면 null.
 *  반환값은 useMemo로 안정화 — 소비처 useEffect([anchor])가 값 변화에만 발화. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePriorClosedRunAnchor(
  scenarioId: string | undefined,
): ClosedRunAnchor | null {
  const runs = useScenarioRuns(scenarioId);
  // Cast: Zod parses defaults at runtime so the data is truly Run[], but tsc sees
  // nested-default input-type leak (ProfileSchema.ramp_up_seconds?.default → optional).
  const latest = useMemo(() => pickLatestClosedRun((runs.data?.runs ?? []) as Run[]), [runs.data]);
  const report = useRunReport(latest?.id, Boolean(latest));
  const vus = latest?.profile.vus ?? 0;
  const rps = report.data?.summary.rps ?? 0;
  const durationSeconds = latest?.profile.duration_seconds ?? 0;
  return useMemo(
    () => (vus > 0 && rps > 0 ? { vus, rps, durationSeconds } : null),
    [vus, rps, durationSeconds],
  );
}
```

(파일의 나머지 — `VuSizingHelper` 컴포넌트 본체 — 는 무변경. 이 컴포넌트는 여전히 `anchor.vus`/`anchor.rps`만 읽으므로 신규 `durationSeconds` 필드는 안 건드림.)

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `cd ui && pnpm test sizing`
Expected: PASS (전체 `sizePresetsFor` 5개 테스트 + 기존 `sizing.test.ts` 테스트 전부 green).

Run: `cd ui && pnpm test VuSizingHelper`
Expected: PASS (기존 `VuSizingHelper.test.tsx` 스위트 무변경 통과 — `durationSeconds` 필드 추가는 그 파일이 안 읽으므로 무해).

- [ ] **Step 6: eslint 확인**

Run: `cd ui && pnpm exec eslint src/components/VuSizingHelper.tsx src/components/sizing.ts`
Expected: 0 problems(warning 포함 0 — `--max-warnings=0`이 프로젝트 게이트이므로 이 시점에 바로 확인).

- [ ] **Step 7: Commit**

```bash
cd ui
git add src/components/sizing.ts src/components/VuSizingHelper.tsx src/components/__tests__/sizing.test.ts
git commit -m "feat(ui): sizePresetsFor 순수계산 + usePriorClosedRunAnchor export/durationSeconds 확장"
```

---

### Task 2: RunDialog 연결 — ko 캡션 키 + LoadModelFields prop/렌더 + RunDialog 배선 + 테스트 mock 교정

**Files:**
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/LoadModelFields.tsx`
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`
- **하지 않음**: `ui/src/components/__tests__/LoadModelFields.test.tsx` — 이 파일은 절대 수정하지 않는다(Global Constraints, spec R9).

**Interfaces:**
- Consumes: Task 1의 `sizePresetsFor`(from `./sizing`), `ClosedRunAnchor`/`usePriorClosedRunAnchor`(from `./VuSizingHelper`).
- Produces: `LoadModelFields`의 새 optional prop `sizePresetAnchor?: ClosedRunAnchor | null`. `RunDialog.tsx`가 이 prop을 채워 전달. `ko.loadModel.sizePresetsCaptionFromPrior(vus: number, durationLabel: string): string`.

- [ ] **Step 1: `RunDialog.test.tsx`에 실패하는 테스트 작성 + mock을 factory-spread로 교정**

`ui/src/components/__tests__/RunDialog.test.tsx`의 다음 줄(파일 9번째 줄):

```ts
vi.mock("../VuSizingHelper", () => ({ VuSizingHelper: () => null }));
```

를 다음으로 교체(`usePriorClosedRunAnchor`의 실제 구현을 보존 — 안 하면 Step 4에서 `RunDialog.tsx`가 이 hook을 호출하는 순간 `undefined(...)` TypeError로 전체 스위트가 깨진다):

```ts
vi.mock("../VuSizingHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../VuSizingHelper")>()),
  VuSizingHelper: () => null,
}));
```

파일 맨 끝에 새 `describe` 블록을 추가:

```ts
// ─── Option C: 크기 프리셋 상대배수 사이징 ──────────────────────────────────
describe("RunDialog — 크기 프리셋 상대배수 사이징 (Option C)", () => {
  const RUN_PRIOR = {
    id: "R-PRIOR",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "completed",
    profile: { vus: 20, duration_seconds: 60 },
    env: {},
    started_at: 1,
    ended_at: 2,
    created_at: 1,
  };

  const REPORT_PRIOR = {
    run: {
      id: "R-PRIOR",
      scenario_id: "S1",
      status: "completed",
      profile: null,
      env: null,
      started_at: 1,
      ended_at: 2,
      created_at: 1,
    },
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    summary: {
      count: 600,
      errors: 0,
      rps: 10,
      duration_seconds: 60,
      mean_ms: 5,
      p50_ms: 5,
      p95_ms: 5,
      p99_ms: 5,
    },
    windows: [],
    steps: [],
    status_distribution: {},
    dropped: 0,
  };

  it("직전 completed closed-loop run이 있으면 빠른 입력 칩이 그 값의 0.5×/1×/2×로 계산된다", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (
        u.endsWith("/api/scenarios/S1/runs") &&
        (!init || !init.method || init.method === "GET")
      ) {
        return Promise.resolve(jsonResponse({ runs: [RUN_PRIOR] }));
      }
      if (u.endsWith("/api/runs/R-PRIOR/report")) {
        return Promise.resolve(jsonResponse(REPORT_PRIOR));
      }
      return Promise.resolve(jsonResponse({ presets: [] }));
    });

    renderDialog();

    // "20명 · 1분"은 고정 폴백 3개(10/50/200명)엔 없는 값이라, 이게 뜨면 앵커 계산이
    // 실제로 반영됐다는 뜨거운 증거다(고정 폴백만으로는 절대 나올 수 없는 라벨).
    expect(await screen.findByRole("button", { name: "20명 · 1분" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10명 · 30초" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "40명 · 2분" })).toBeInTheDocument();
    expect(
      screen.getByText(ko.loadModel.sizePresetsCaptionFromPrior(20, "1분")),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — `ko.loadModel.sizePresetsCaptionFromPrior`가 아직 없어 `TypeError: ko.loadModel.sizePresetsCaptionFromPrior is not a function`(테스트 본문의 그 호출에서 에러) — 또는(그 줄 도달 전) `findByRole("button", { name: "20명 · 1분" })`가 타임아웃(RunDialog가 아직 앵커를 계산 안 해 여전히 고정폴백만 보여줌).

- [ ] **Step 3: `ko.ts`에 캡션 함수 키 추가**

`ui/src/i18n/ko.ts`에서 다음 블록(178-213번째 줄 `loadModel` 섹션 내):

```ts
    sizePresets: [
      { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
      { label: "50명 · 1분", vus: 50, durationSeconds: 60 },
      { label: "200명 · 3분", vus: 200, durationSeconds: 180 },
    ],
    tileClosedTitle: "동시 사용자 (VU)",
```

를 다음으로 교체(`sizePresetsCaptionFromPrior` 키 삽입):

```ts
    sizePresets: [
      { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
      { label: "50명 · 1분", vus: 50, durationSeconds: 60 },
      { label: "200명 · 3분", vus: 200, durationSeconds: 180 },
    ],
    sizePresetsCaptionFromPrior: (vus: number, durationLabel: string) =>
      `직전 run(${vus}명 · ${durationLabel}) 기준입니다`,
    tileClosedTitle: "동시 사용자 (VU)",
```

- [ ] **Step 4: `LoadModelFields.tsx`에 `sizePresetAnchor` prop + 렌더 로직 교체**

`ui/src/components/LoadModelFields.tsx`의 import 블록에서 다음 줄:

```ts
import { peakStageTarget } from "./sizing";
```

를 다음으로 교체:

```ts
import { peakStageTarget, sizePresetsFor } from "./sizing";
import type { ClosedRunAnchor } from "./VuSizingHelper";
import { formatDurationKo } from "../i18n/duration";
```

`Props` 타입에서 다음 줄(주석 "// 닫힌 루프 사이징 헬퍼(RunDialog 전용..." 바로 아래, `onApplyVus?: (n: number) => void;` 다음):

```ts
  onApplyVus?: (n: number) => void;
```

바로 뒤에 새 줄을 삽입:

```ts
  onApplyVus?: (n: number) => void;
  // "빠른 입력" 크기 칩 상대배수 사이징(Option C, RunDialog 전용 — ScheduleForm 미전달=undefined
  // →기존 고정 3개). RunDialog가 usePriorClosedRunAnchor로 계산해 내려준다.
  sizePresetAnchor?: ClosedRunAnchor | null;
```

함수 파라미터 destructure 블록에서 다음 줄:

```ts
  onApplyVus,
```

바로 뒤에 추가:

```ts
  onApplyVus,
  sizePresetAnchor,
```

렌더 로직에서 다음 블록(closed+fixed 분기 안, "부하 크기 프리셋 chips" 주석 바로 아래):

```tsx
            {/* 부하 크기 프리셋 chips */}
            <div
              role="group"
              aria-label={ko.loadModel.sizePresetsLabel}
              className="mb-2 flex flex-wrap gap-2"
            >
              {ko.loadModel.sizePresets.map((p) => {
                const active = vus === p.vus && duration === p.durationSeconds;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setVus(p.vus);
                      setDuration(p.durationSeconds);
                    }}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      active
                        ? "border-accent-500 bg-accent-50 text-accent-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="mb-3 text-xs text-slate-500">{ko.loadModel.sizePresetsCaption}</p>
```

를 다음으로 교체:

```tsx
            {/* 부하 크기 프리셋 chips — sizePresetAnchor 있으면 그 직전 run의 0.5×/1×/2×,
                없으면(ScheduleForm 미전달 등) ko.ts 고정 3개(sizePresetsFor(null) 폴백). */}
            <div
              role="group"
              aria-label={ko.loadModel.sizePresetsLabel}
              className="mb-2 flex flex-wrap gap-2"
            >
              {sizePresetsFor(sizePresetAnchor ?? null).map((p) => {
                const active = vus === p.vus && duration === p.durationSeconds;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setVus(p.vus);
                      setDuration(p.durationSeconds);
                    }}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      active
                        ? "border-accent-500 bg-accent-50 text-accent-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="mb-3 text-xs text-slate-500">
              {sizePresetAnchor
                ? ko.loadModel.sizePresetsCaptionFromPrior(
                    sizePresetAnchor.vus,
                    formatDurationKo(sizePresetAnchor.durationSeconds),
                  )
                : ko.loadModel.sizePresetsCaption}
            </p>
```

- [ ] **Step 5: `RunDialog.tsx` 배선**

`ui/src/components/RunDialog.tsx`의 import 블록에서 다음 줄:

```ts
import { scaleVuStages, peakStageTarget } from "./sizing";
```

바로 뒤에 추가:

```ts
import { usePriorClosedRunAnchor } from "./VuSizingHelper";
```

컴포넌트 본문에서 다음 줄(현재 202-204번째 줄):

```ts
  const presets = usePresets(scenarioId);
  const pool = usePoolWorkers();
```

를 다음으로 교체:

```ts
  const presets = usePresets(scenarioId);
  const sizePresetAnchor = usePriorClosedRunAnchor(scenarioId);
  const pool = usePoolWorkers();
```

`<LoadModelFields>` JSX(현재 614-647번째 줄)에서 다음 줄:

```tsx
          sizingScenarioId={scenarioId}
          sizingScenario={scenario}
          sizingEnv={env}
```

바로 뒤에 추가:

```tsx
          sizingScenarioId={scenarioId}
          sizingScenario={scenario}
          sizingEnv={env}
          sizePresetAnchor={sizePresetAnchor}
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: PASS — 신규 테스트 포함, 기존 `RunDialog.test.tsx` 전 테스트 green(모킹 교정이 다른 테스트의 동작을 안 바꿈).

Run: `cd ui && pnpm test LoadModelFields`
Expected: PASS — 기존 "closed 모드에서 빠른 입력 chips" 등 전 테스트 무변경 통과(`sizePresetAnchor` prop 미전달 → `undefined ?? null` → `sizePresetsFor(null)` → 기존 고정 3개와 동일).

- [ ] **Step 7: `LoadModelFields.test.tsx` 0-diff 확인**

Run: `git status --porcelain -- ui/src/components/__tests__/LoadModelFields.test.tsx`
Expected: 출력 없음(빈 문자열) — 이 파일이 전혀 안 건드려졌음을 확인.

- [ ] **Step 8: eslint 확인**

Run: `cd ui && pnpm exec eslint src/components/RunDialog.tsx src/components/LoadModelFields.tsx src/i18n/ko.ts src/components/__tests__/RunDialog.test.tsx`
Expected: 0 problems.

- [ ] **Step 9: Commit**

```bash
cd ui
git add src/i18n/ko.ts src/components/LoadModelFields.tsx src/components/RunDialog.tsx src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog 크기 프리셋 칩을 직전 run 대비 상대배수로 계산 (Option C)"
```

---

### Task 3: 최종 전체 게이트 + 계약 확인

**Files:**
- 없음(변경 없음 — 검증 전용 task).

**Interfaces:**
- Consumes: Task 1+2의 전체 결과물.
- Produces: 없음 — merge 준비 확인.

- [ ] **Step 1: 전체 lint**

Run: `cd ui && pnpm lint`
Expected: 0 problems(`--max-warnings=0`).

- [ ] **Step 2: 전체 테스트 (인자 없이)**

Run: `cd ui && pnpm test`
Expected: 전체 스위트 PASS(신규 테스트 포함, 회귀 0). `ScenarioRunsPage.test.tsx`도 이 전체 실행에 포함됨 — 실제 `RunDialog`를 렌더하고 `QueryClientProvider`로 감싸져 있어 새 `usePriorClosedRunAnchor` 호출이 있어도 green이어야 한다(spec §6 근거: 쿼리키가 페이지의 기존 `useScenarioRuns` fetch와 공유되고, URL-라우팅 fetchMock이라 매칭 안 되는 URL은 안전한 폴백 응답을 받는다). 만약 이 파일에서만 실패가 나면 그 응답 라우팅이 새 fetch를 못 커버하는 경우이니 원인을 확인할 것(회귀로 간주하고 fix — 이 파일은 수정 대상이 아니므로 원인이 있다면 Task 1/2 구현 쪽 문제).

- [ ] **Step 3: 전체 빌드**

Run: `cd ui && pnpm build`
Expected: 성공(`tsc -b && vite build`, 0 타입 에러).

- [ ] **Step 4: 계약 grep 확인 (R5, R9)**

Run: `grep -n "usePriorClosedRunAnchor\|useScenarioRuns\|useRunReport" ui/src/components/LoadModelFields.tsx`
Expected: 출력 없음(`LoadModelFields.tsx`가 query hook을 직접 import/호출하지 않음 — R5).

Run: `git diff --stat master -- ui/src/components/__tests__/LoadModelFields.test.tsx`
Expected: 출력 없음(R9, 0-diff).

- [ ] **Step 5: 최종 확인 — 커밋 불필요**

이 task는 검증만 수행하며 코드 변경이 없으므로 커밋할 것이 없다(Step 1-4가 전부 PASS면 이 슬라이스는 최종 리뷰[`handicap-reviewer`] 단계로 진행 가능).
