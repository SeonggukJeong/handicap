# Run 스케줄러 34c (UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run 스케줄러의 웹 UI(`/schedules` 페이지 + 생성/편집 폼 + 5모드 트리거 빌더 + 라이브 다음-발사 미리보기 + 이벤트 타임라인)를 추가해, 머지된 백엔드(34a/34b)를 사용자가 화면에서 예약/반복 run을 만들고 관리할 수 있게 한다.

**Architecture:** 순수 UI 슬라이스 — 엔진/워커/proto/migration/백엔드 **무변경**. (1) RunDialog의 인라인 `buildProfile`/`buildCriteria`/SLO 입력을 공유 모듈 `profileForm.ts` + 프레젠테이셔널 `<CriteriaFields>`로 **순수 추출**(RunDialog도 import, 제출 payload byte-identical)하고, (2) `ScheduleForm`이 그 공유 모듈 + 이미 추출된 `LoadModelFields`/`DataBindingPanel`/`EnvironmentPicker`를 조합해 profile을 편집하며, (3) `SchedulesPage`가 `EnvironmentsPage`를 미러한 목록+폼 패턴으로 CRUD를 제공한다. 트리거 프리셋(매일/매주/간격)은 클라에서 5-field cron으로 컴파일하고 cron *평가*(다음 발사·DST)는 전부 백엔드 `POST /api/schedules/preview-next` 서버 단일 소스에 위임한다.

**Tech Stack:** TypeScript + React + Vite + Zod + React Query(@tanstack) + Tailwind. 테스트는 vitest + @testing-library/react. 게이트는 `cd ui && pnpm lint && pnpm test && pnpm build`(tsc -b).

**Spec:** `docs/superpowers/specs/2026-06-06-run-scheduler-design.md` (§9 UI, §9.3 34c 결정 3종).

---

## 실행 노트 (모든 task 공통 — subagent 프롬프트에 박을 것)

- **작업 위치:** 이 슬라이스는 worktree 없이 `master`에서 진행해도 되나(순수 UI, 백엔드 완결), 격리를 원하면 `superpowers:using-git-worktrees`로 worktree 생성 후 `cd ui && pnpm install`부터. **새 worktree엔 `ui/node_modules`가 없다** — subagent 띄우기 전 깔 것.
- **TDD 가드:** 각 task는 `ui/src/**/__tests__/*.test.{ts,tsx}`(테스트 파일)를 **먼저** 만든다 → 그 디렉토리 src 편집이 unblock된다. 새 src 파일 Write 전에 같은 작업단위의 `__tests__` 테스트가 디스크에 있어야 한다(루트 CLAUDE.md C-1).
- **vitest 경로:** 테스트는 반드시 `src/<dir>/__tests__/`에. `__tests__/` 밖의 `*.test.ts`는 vitest `include`가 조용히 안 돈다(ui/CLAUDE.md). 단일 파일 반복은 `pnpm test <Name>`(`--` 붙이면 전체 스위트 돈다).
- **UI 게이트는 hook이 안 돈다:** pre-commit hook은 `cargo`만 돌린다. **각 task 커밋 전 `cd ui && pnpm test <해당파일>`로 GREEN 확인**, 마지막 task에서 `pnpm lint && pnpm test && pnpm build` 전체. `pnpm test`(esbuild)는 TS strict(`tsc -b`)를 안 잡으니 **Zod `.default()`/`.nullish()` 누출은 `pnpm build`로만** 드러난다.
- **cargo 게이트 우회 불가 + cold-build flake:** UI-only 커밋도 pre-commit이 전체 워크스페이스(`cargo build/clippy/test`)를 돌린다(수 분). 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 **warm**한 뒤 커밋하고, e2e flake(worker ENOENT/SIGKILL/sigterm)나면 동일 커밋 warm 재시도(루트 CLAUDE.md).
- **커밋은 FOREGROUND 단일 호출**(`run_in_background:false`, timeout 600000ms, 폴링 금지). `git add`는 **명시 경로만**(`-A` 금지 — 루트에 untracked 잔류물 있음). 파이프(`| tail`) 금지(exit code 마스킹) → 커밋 직후 `git log -1 --oneline`로 landed 확인.
- **서버-null 함정(S-D):** 응답 스키마 optional 필드는 `.optional()`이 아니라 **`.nullish()`**. RTL fixture는 필드를 *absent*가 아니라 **`null`**로 줘야 이 갭을 잡는다. 머지 전 **라이브 run 1회 필수**(Task 9).

---

## 파일 구조

### 신규
| 파일 | 책임 |
|---|---|
| `ui/src/components/profileForm.ts` | 순수 — `CriteriaState` 타입, `buildCriteria`/`buildProfile`(명시 인자), `criteriaStateFrom`/`criteriaHasValue`/`criteriaActiveCount` 헬퍼. RunDialog·ScheduleForm 공유 |
| `ui/src/components/CriteriaFields.tsx` | 프레젠테이셔널 — 11개 SLO 입력 그리드(label text 보존). `value`/`onChange`만 |
| `ui/src/components/triggerCron.ts` | 순수 — `compileTrigger`(프리셋→5-field cron), `describeTrigger`(목록 요약), 빌더 타입 |
| `ui/src/components/TriggerBuilder.tsx` | 5모드 라디오 UI + 라이브 preview-next 표시. `onChange(trigger)` emit |
| `ui/src/components/ScheduleForm.tsx` | 생성/편집 폼 — name·시나리오 피커·TriggerBuilder·profile(공유 컴포넌트)·env·enabled·submit |
| `ui/src/components/ScheduleEventTimeline.tsx` | 상세 뷰 이벤트 이력(`useScheduleEvents` → kind 배지·시각·run 링크·detail) |
| `ui/src/pages/SchedulesPage.tsx` | 목록 + 폼 + 삭제 + enable 토글 + 타임라인. `EnvironmentsPage` 미러 |
| `ui/src/api/schedules.ts` | 클라이언트 fetch 함수(list/get/create/update/delete/events/previewNext). `environments.ts` 미러 |

### 변경
| 파일 | 변경 |
|---|---|
| `ui/src/components/RunDialog.tsx` | **유일 기존-파일 리팩터** — 인라인 `buildProfile`/`buildCriteria`/SLO 그리드 JSX를 공유 모듈로 추출·import. payload byte-identical + 기존 RTL green 게이트 |
| `ui/src/api/schemas.ts` | `TriggerSchema`/`ScheduleSchema`/`ScheduleSummarySchema`/`ScheduleEventSchema` 추가 |
| `ui/src/api/hooks.ts` | `queryKeys.schedules`/`schedule`/`scheduleEvents` + `useSchedules`/`useSchedule`/`useCreateSchedule`/`useUpdateSchedule`/`useDeleteSchedule`/`useScheduleEvents`/`usePreviewNext` |
| `ui/src/routes.tsx` | `{ path: "schedules", element: <SchedulesPage /> }` |
| `ui/src/components/Layout.tsx` | 네비에 `<Link to="/schedules">Schedules</Link>` |

### 무변경
proto · 엔진 · 워커 · 컨트롤러(34a/34b 머지 완료) · migration.

---

## Task 1: `profileForm.ts` + `<CriteriaFields>` 순수 추출 (byte-identical 게이트)

RunDialog의 인라인 `buildCriteria`(`RunDialog.tsx:299-313`)·`buildProfile`(`:315-323`)·SLO 그리드 JSX(`:517-645`)를 공유 모듈로 추출하고, RunDialog가 그것을 import하게 한다. **RunDialog의 11개 SLO `useState`·`sloOpen`·`sloActiveCount`·`minWindowRps→rpsWarmup` cross-field seed는 그대로 남긴다** — 추출하는 건 *순수 빌더*와 *입력 그리드 JSX*뿐.

**Files:**
- Create: `ui/src/components/profileForm.ts`
- Create: `ui/src/components/CriteriaFields.tsx`
- Create test: `ui/src/components/__tests__/profileForm.test.ts`
- Modify: `ui/src/components/RunDialog.tsx` (buildCriteria/buildProfile 본문 + SLO 그리드 JSX)

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/profileForm.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  buildCriteria,
  buildProfile,
  criteriaHasValue,
  criteriaActiveCount,
  EMPTY_CRITERIA,
  type CriteriaState,
} from "../profileForm";
import type { LoadModelState } from "../loadModel";

const closedLoad: LoadModelState = {
  loadModel: "closed", rateMode: "fixed",
  vus: 4, duration: 30, rampUp: 0,
  targetRps: "", maxInFlight: "", stages: [],
  thinkMin: "", thinkMax: "", thinkSeed: "",
};

describe("buildCriteria", () => {
  it("returns undefined when all inputs empty", () => {
    expect(buildCriteria(EMPTY_CRITERIA)).toBeUndefined();
  });
  it("maps filled inputs and converts pct → fraction", () => {
    const s: CriteriaState = { ...EMPTY_CRITERIA, maxP95: "200", maxErrPct: "5", max4xxPct: "2.5" };
    expect(buildCriteria(s)).toEqual({
      max_p95_ms: 200,
      max_error_rate: 0.05,
      max_4xx_rate: 0.025,
    });
  });
});

describe("buildProfile", () => {
  it("composes load profile + criteria + loop/http/binding", () => {
    const p = buildProfile({
      hasLoop: false, loopCap: 256, httpTimeout: 30,
      binding: null, loadState: closedLoad, criteria: EMPTY_CRITERIA,
    });
    expect(p).toMatchObject({
      loop_breakdown_cap: 0, // hasLoop=false → 0
      http_timeout_seconds: 30,
      data_binding: undefined,
      criteria: undefined,
      vus: 4, duration_seconds: 30, // from buildLoadProfile
    });
  });
  it("uses loopCap only when hasLoop", () => {
    const p = buildProfile({
      hasLoop: true, loopCap: 99, httpTimeout: 30,
      binding: null, loadState: closedLoad, criteria: EMPTY_CRITERIA,
    });
    expect(p.loop_breakdown_cap).toBe(99);
  });
});

describe("criteria helpers", () => {
  it("criteriaHasValue / criteriaActiveCount count filled inputs", () => {
    const s: CriteriaState = { ...EMPTY_CRITERIA, maxP50: "100", rpsWarmup: "3" };
    expect(criteriaHasValue(s)).toBe(true);
    // activeCount excludes rps_warmup_seconds (modifier, not a criterion) — 1
    expect(criteriaActiveCount(s)).toBe(1);
    expect(criteriaHasValue(EMPTY_CRITERIA)).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test profileForm`
Expected: FAIL — `Cannot find module "../profileForm"`.

- [ ] **Step 3: `profileForm.ts` 구현**

```ts
import type { Criteria, DataBinding, Profile } from "../api/schemas";
import { buildLoadProfile, type LoadModelState } from "./loadModel";

/** 11개 SLO 입력의 string draft 상태(RunDialog/ScheduleForm 공유). */
export type CriteriaState = {
  maxP50: string;
  maxP95: string;
  maxP99: string;
  maxErrPct: string; // % (wire는 분수)
  minRps: string;
  max4xxPct: string; // %
  max5xxPct: string; // %
  max4xxCount: string;
  max5xxCount: string;
  minWindowRps: string;
  rpsWarmup: string; // 수식자(criterion 아님)
};

export const EMPTY_CRITERIA: CriteriaState = {
  maxP50: "", maxP95: "", maxP99: "", maxErrPct: "", minRps: "",
  max4xxPct: "", max5xxPct: "", max4xxCount: "", max5xxCount: "",
  minWindowRps: "", rpsWarmup: "",
};

const numToStr = (n?: number | null) => (n == null ? "" : String(n));

/** 저장된 Criteria(분수) → 입력 string 상태(%). prefill/edit용. */
export function criteriaStateFrom(c?: Criteria | null): CriteriaState {
  return {
    maxP50: numToStr(c?.max_p50_ms),
    maxP95: numToStr(c?.max_p95_ms),
    maxP99: numToStr(c?.max_p99_ms),
    maxErrPct: c?.max_error_rate != null ? String(c.max_error_rate * 100) : "",
    minRps: numToStr(c?.min_rps),
    max4xxPct: c?.max_4xx_rate != null ? String(c.max_4xx_rate * 100) : "",
    max5xxPct: c?.max_5xx_rate != null ? String(c.max_5xx_rate * 100) : "",
    max4xxCount: numToStr(c?.max_4xx_count),
    max5xxCount: numToStr(c?.max_5xx_count),
    minWindowRps: numToStr(c?.min_window_rps),
    rpsWarmup: numToStr(c?.rps_warmup_seconds),
  };
}

export function criteriaHasValue(s: CriteriaState): boolean {
  return Object.values(s).some((v) => v.trim() !== "");
}

/** 토글 hint용 — rps_warmup_seconds(수식자)는 제외, 실제 기준 10개만 카운트. */
export function criteriaActiveCount(s: CriteriaState): number {
  return [
    s.maxP50, s.maxP95, s.maxP99, s.maxErrPct, s.minRps,
    s.max4xxPct, s.max5xxPct, s.max4xxCount, s.max5xxCount, s.minWindowRps,
  ].filter((v) => v.trim() !== "").length;
}

export function buildCriteria(s: CriteriaState): Criteria | undefined {
  const c: Criteria = {};
  if (s.maxP50.trim() !== "") c.max_p50_ms = Number(s.maxP50);
  if (s.maxP95.trim() !== "") c.max_p95_ms = Number(s.maxP95);
  if (s.maxP99.trim() !== "") c.max_p99_ms = Number(s.maxP99);
  if (s.maxErrPct.trim() !== "") c.max_error_rate = Number(s.maxErrPct) / 100;
  if (s.minRps.trim() !== "") c.min_rps = Number(s.minRps);
  if (s.max4xxPct.trim() !== "") c.max_4xx_rate = Number(s.max4xxPct) / 100;
  if (s.max5xxPct.trim() !== "") c.max_5xx_rate = Number(s.max5xxPct) / 100;
  if (s.max4xxCount.trim() !== "") c.max_4xx_count = Number(s.max4xxCount);
  if (s.max5xxCount.trim() !== "") c.max_5xx_count = Number(s.max5xxCount);
  if (s.minWindowRps.trim() !== "") c.min_window_rps = Number(s.minWindowRps);
  if (s.rpsWarmup.trim() !== "") c.rps_warmup_seconds = Number(s.rpsWarmup);
  return Object.keys(c).length > 0 ? c : undefined;
}

export type ProfileFormInput = {
  hasLoop: boolean;
  loopCap: number;
  httpTimeout: number;
  binding: DataBinding | null;
  loadState: LoadModelState;
  criteria: CriteriaState;
};

export function buildProfile(i: ProfileFormInput): Profile {
  return {
    loop_breakdown_cap: i.hasLoop ? i.loopCap : 0,
    http_timeout_seconds: i.httpTimeout,
    data_binding: i.binding ?? undefined,
    criteria: buildCriteria(i.criteria),
    ...buildLoadProfile(i.loadState),
  };
}
```

> **주의:** `buildCriteria`의 11줄·`buildProfile`의 본문은 RunDialog의 현재 인라인(`:301-312`, `:316-322`)과 **문자-동일**해야 byte-identical이 성립한다. `criteriaActiveCount`는 RunDialog `sloActiveCount`(`:234-245`, 10개·rpsWarmup 제외)와 일치.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test profileForm`
Expected: PASS (8 assertions).

- [ ] **Step 5: `CriteriaFields.tsx` 구현** — RunDialog `:517-645`의 그리드를 그대로 옮기되 11쌍의 `value`/`onChange`를 props로. **label `<span>` 텍스트(`Max p50 (ms)` 등)·`type="number"`·`min`/`max`/`step` 속성을 정확히 보존**(기존 RunDialog 테스트가 `getByLabelText(/Max p95/)`로 잡으므로). minWindowRps 입력의 onChange도 다른 입력과 동일하게 `onChange("minWindowRps", e.target.value)`만 — cross-field seed는 부모가.

```tsx
import type { CriteriaState } from "./profileForm";

type Field = { key: keyof CriteriaState; label: string; max?: string; step?: string };

const FIELDS: Field[] = [
  { key: "maxP50", label: "Max p50 (ms)" },
  { key: "maxP95", label: "Max p95 (ms)" },
  { key: "maxP99", label: "Max p99 (ms)" },
  { key: "maxErrPct", label: "Max error rate (%)", max: "100", step: "any" },
  { key: "minRps", label: "Min RPS", step: "any" },
  { key: "max4xxPct", label: "Max 4xx rate (%)", max: "100", step: "any" },
  { key: "max5xxPct", label: "Max 5xx rate (%)", max: "100", step: "any" },
  { key: "max4xxCount", label: "Max 4xx count" },
  { key: "max5xxCount", label: "Max 5xx count" },
  { key: "minWindowRps", label: "Min window RPS", step: "any" },
  { key: "rpsWarmup", label: "RPS warmup (s)" },
];

type Props = {
  value: CriteriaState;
  onChange: (key: keyof CriteriaState, val: string) => void;
};

/** SLO 기준 입력 그리드(프레젠테이셔널). collapsible wrapper는 부모 소유. */
export function CriteriaFields({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {FIELDS.map((f) => (
        <label key={f.key} className="block text-sm">
          <span className="text-slate-600">{f.label}</span>
          <input
            type="number"
            min="0"
            {...(f.max ? { max: f.max } : {})}
            {...(f.step ? { step: f.step } : {})}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={value[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: RunDialog 배선 변경** — 다음 4개를 수정(11 useState·sloOpen·sloActiveCount·`criteriaHasValue(initC)` 초기화는 **그대로 둠**):

  **(a)** import 추가(파일 상단 import 블록):
  ```ts
  import { buildProfile as buildProfileShared } from "./profileForm";
  import { CriteriaFields } from "./CriteriaFields";
  ```

  **(b)** `buildProfile` 직전(혹은 `env` const 아래)에 `criteriaState` const + `setCriteria` 라우터 추가 — cross-field seed를 여기로:
  ```ts
  const criteriaState = {
    maxP50, maxP95, maxP99, maxErrPct, minRps,
    max4xxPct, max5xxPct, max4xxCount, max5xxCount, minWindowRps, rpsWarmup,
  };
  const criteriaSetters: Record<keyof typeof criteriaState, (v: string) => void> = {
    maxP50: setMaxP50, maxP95: setMaxP95, maxP99: setMaxP99, maxErrPct: setMaxErrPct,
    minRps: setMinRps, max4xxPct: setMax4xxPct, max5xxPct: setMax5xxPct,
    max4xxCount: setMax4xxCount, max5xxCount: setMax5xxCount,
    minWindowRps: setMinWindowRps, rpsWarmup: setRpsWarmup,
  };
  const setCriteria = (key: keyof typeof criteriaState, val: string) => {
    criteriaSetters[key](val);
    // cross-field: minWindowRps 채우면 closed-loop에선 rpsWarmup을 rampUp으로 seed (기존 :623-632).
    if (key === "minWindowRps" && val.trim() !== "" && rpsWarmup.trim() === "" && loadModel === "closed") {
      setRpsWarmup(String(rampUp));
    }
  };
  ```

  **(c)** `buildCriteria`/`buildProfile` 인라인 함수(`:299-323`) **삭제**하고, `buildProfile` 호출부가 쓰도록 단일 함수로 교체:
  ```ts
  function buildProfile(): Profile {
    return buildProfileShared({
      hasLoop, loopCap, httpTimeout, binding, loadState, criteria: criteriaState,
    });
  }
  ```
  (`currentInput`/savePreset/submit은 `buildProfile()`을 그대로 호출하므로 무변경.)

  **(d)** SLO 그리드 JSX(`:516-646`의 `{sloOpen && (<div className="grid grid-cols-2 gap-2">…</div>)}`) 교체:
  ```tsx
  {sloOpen && <CriteriaFields value={criteriaState} onChange={setCriteria} />}
  ```
  (`<fieldset>`/`<legend>`/토글 `<button>`·`sloActiveCount` hint는 **그대로**.)

- [ ] **Step 7: byte-identical 회귀 게이트** — 기존 RunDialog 테스트 + 신규 profileForm 테스트 + 타입 빌드:

Run: `cd ui && pnpm test RunDialog && pnpm test profileForm && pnpm build`
Expected: **RunDialog 테스트 전부 GREEN(무수정)** + profileForm GREEN + `tsc -b` 0 에러. RunDialog 테스트가 SLO 입력(`getByLabelText(/Max p95/)`)·cross-field seed·제출 payload를 검증하므로 byte-identical의 1차 증거.

> **함정:** RunDialog 테스트 중 SLO 섹션을 만지는 건 먼저 `▸ SLO 기준` 토글을 펼친다(collapse-by-default, ui/CLAUDE.md). 추출이 이 토글 동작을 안 바꾸므로 기존 테스트 그대로 통과해야 한다 — 안 통과하면 추출이 byte-identical이 아닌 것.

- [ ] **Step 8: 커밋** (warm 먼저)

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/profileForm.ts ui/src/components/CriteriaFields.tsx \
        ui/src/components/__tests__/profileForm.test.ts ui/src/components/RunDialog.tsx
git commit -m "refactor(ui): RunDialog buildProfile/buildCriteria/SLO 입력을 profileForm.ts+<CriteriaFields>로 순수 추출 (34c, payload byte-identical)"
git log -1 --oneline
```

---

## Task 2: 와이어 스키마 — `TriggerSchema`/`ScheduleSchema`/`ScheduleSummarySchema`/`ScheduleEventSchema`

백엔드 `crates/controller/src/api/schedules.rs`의 응답 타입과 1:1. `TriggerResponse`는 internally-tagged(`{"kind":"once","run_at":..}`/`{"kind":"cron","cron_expr":..}`) → `z.discriminatedUnion("kind")`. Option 필드는 **`.nullish()`**(서버 `null` 직렬화).

**Files:**
- Modify: `ui/src/api/schemas.ts` (CriteriaSchema/ProfileSchema 뒤에 추가)
- Create test: `ui/src/api/__tests__/scheduleSchema.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/api/__tests__/scheduleSchema.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  ScheduleSchema,
  ScheduleSummarySchema,
  TriggerSchema,
  ScheduleEventSchema,
} from "../schemas";

describe("TriggerSchema", () => {
  it("parses once + cron variants by kind", () => {
    expect(TriggerSchema.parse({ kind: "once", run_at: 1_700_000_000_000 })).toEqual({
      kind: "once",
      run_at: 1_700_000_000_000,
    });
    expect(TriggerSchema.parse({ kind: "cron", cron_expr: "0 2 * * *" })).toEqual({
      kind: "cron",
      cron_expr: "0 2 * * *",
    });
  });
});

describe("ScheduleSchema", () => {
  it("accepts server null for optional fields (.nullish, S-D trap)", () => {
    // 서버가 보내는 실제 shape: Option<T> → null (absent 아님).
    const wire = {
      id: "01J",
      name: "nightly",
      scenario_id: "01S",
      profile: { vus: 4, duration_seconds: 30 },
      env: { BASE_URL: "https://x" },
      trigger: { kind: "cron", cron_expr: "0 2 * * *" },
      enabled: true,
      next_run_at: 1_700_000_000_000,
      last_run_id: null,
      last_fired_at: null,
      last_status: null,
      last_error: null,
      created_at: 1,
      updated_at: 2,
    };
    const s = ScheduleSchema.parse(wire);
    expect(s.trigger.kind).toBe("cron");
    expect(s.last_run_id).toBeNull();
  });
});

describe("ScheduleSummarySchema", () => {
  it("has no profile/env/last_run_id (목록 요약)", () => {
    const wire = {
      id: "01J", name: "n", scenario_id: "01S",
      trigger: { kind: "once", run_at: 1 },
      enabled: false,
      next_run_at: null, last_status: "fired", last_fired_at: 1,
    };
    expect(ScheduleSummarySchema.parse(wire).enabled).toBe(false);
  });
});

describe("ScheduleEventSchema", () => {
  it("parses event with null run_id/detail", () => {
    expect(
      ScheduleEventSchema.parse({ id: "e1", at: 5, kind: "skipped_overlap", run_id: null, detail: "overlap" }).kind,
    ).toBe("skipped_overlap");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test scheduleSchema`
Expected: FAIL — `ScheduleSchema` export 없음.

- [ ] **Step 3: `schemas.ts`에 스키마 추가** (`export type Profile = ...` 뒤, `RunSchema` 앞 근처)

```ts
export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), run_at: z.number() }),
  z.object({ kind: z.literal("cron"), cron_expr: z.string() }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const ScheduleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  scenario_id: z.string(),
  trigger: TriggerSchema,
  enabled: z.boolean(),
  next_run_at: z.number().nullish(),
  last_status: z.string().nullish(),
  last_fired_at: z.number().nullish(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  scenario_id: z.string(),
  profile: ProfileSchema,
  env: z.record(z.string(), z.string()),
  trigger: TriggerSchema,
  enabled: z.boolean(),
  next_run_at: z.number().nullish(),
  last_run_id: z.string().nullish(),
  last_fired_at: z.number().nullish(),
  last_status: z.string().nullish(),
  last_error: z.string().nullish(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleEventSchema = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.string(),
  run_id: z.string().nullish(),
  detail: z.string().nullish(),
});
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;

export const ScheduleListSchema = z.object({ schedules: z.array(ScheduleSummarySchema) });
export const ScheduleEventsSchema = z.object({ events: z.array(ScheduleEventSchema) });
export const PreviewNextSchema = z.object({ next: z.array(z.number()) });
```

> **주의:** `env`는 **two-arg** `z.record(z.string(), z.string())`(코드베이스 컨벤션, ui/CLAUDE.md). `ProfileSchema`를 그대로 재사용 — 별도 Input 타입 불요(`Schedule`은 응답이라 `.default()` 누출은 `request<T>`를 안 거치고 직접 `.parse`라 무관하나, 소비처는 `profile`을 `normalizeProfile`로 정규화해 prefill 누출을 막는다).

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test scheduleSchema && pnpm build`
Expected: PASS + `tsc -b` 0 에러.

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/api/schemas.ts ui/src/api/__tests__/scheduleSchema.test.ts
git commit -m "feat(ui): schedule 와이어 스키마(Trigger/Schedule/Summary/Event, .nullish) (34c)"
git log -1 --oneline
```

---

## Task 3: `api/schedules.ts` 클라이언트 + React Query 훅

`environments.ts`를 미러. 추가로 `TriggerInput`(요청 트리거)·`ScheduleInput`(생성/수정 본문) 타입과 preview-next.

**Files:**
- Create: `ui/src/api/schedules.ts`
- Modify: `ui/src/api/hooks.ts` (queryKeys + 훅 7종)
- Create test: `ui/src/api/__tests__/schedulesClient.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/api/__tests__/schedulesClient.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { listSchedules, previewNext, type ScheduleInput } from "../schedules";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("listSchedules", () => {
  it("unwraps {schedules:[...]} and parses summaries", async () => {
    mockFetchOnce({
      schedules: [
        {
          id: "01", name: "n", scenario_id: "s",
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true, next_run_at: 1, last_status: null, last_fired_at: null,
        },
      ],
    });
    const rows = await listSchedules();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger.kind).toBe("cron");
  });
});

describe("previewNext", () => {
  it("posts trigger+count and returns next[]", async () => {
    mockFetchOnce({ next: [100, 200, 300] });
    const r = await previewNext({ kind: "cron", cron_expr: "*/15 * * * *" }, 3);
    expect(r).toEqual([100, 200, 300]);
  });
});

describe("ScheduleInput type", () => {
  it("compiles with once + cron triggers", () => {
    const a: ScheduleInput = {
      name: "x", scenario_id: "s",
      profile: { vus: 1, duration_seconds: 1 },
      env: {}, trigger: { kind: "once", run_at: 1 }, enabled: true,
    };
    const b: ScheduleInput = { ...a, trigger: { kind: "cron", cron_expr: "0 2 * * *" } };
    expect(a.trigger.kind).toBe("once");
    expect(b.trigger.kind).toBe("cron");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test schedulesClient`
Expected: FAIL — `../schedules` 없음.

- [ ] **Step 3: `api/schedules.ts` 구현** (environments.ts 미러)

```ts
import {
  ScheduleSchema,
  ScheduleListSchema,
  ScheduleEventsSchema,
  PreviewNextSchema,
  type Schedule,
  type ScheduleSummary,
  type ScheduleEvent,
  type Trigger,
  type Profile,
} from "./schemas";

const BASE = "/api";

/** 요청 트리거(응답 Trigger와 동형 — discriminated union). */
export type TriggerInput = Trigger;

export type ScheduleInput = {
  name: string;
  scenario_id: string;
  profile: Profile;
  env: Record<string, string>;
  trigger: TriggerInput;
  enabled: boolean;
};

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // non-JSON body
  }
  return `HTTP ${res.status}`;
}

export async function listSchedules(): Promise<ScheduleSummary[]> {
  const res = await fetch(`${BASE}/schedules`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleListSchema.parse(await res.json()).schedules;
}

export async function getSchedule(id: string): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function createSchedule(input: ScheduleInput): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function updateSchedule(id: string, input: ScheduleInput): Promise<Schedule> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleSchema.parse(await res.json());
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function scheduleEvents(id: string): Promise<ScheduleEvent[]> {
  const res = await fetch(`${BASE}/schedules/${encodeURIComponent(id)}/events`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return ScheduleEventsSchema.parse(await res.json()).events;
}

export async function previewNext(trigger: TriggerInput, count: number): Promise<number[]> {
  const res = await fetch(`${BASE}/schedules/preview-next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trigger, count }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PreviewNextSchema.parse(await res.json()).next;
}
```

- [ ] **Step 4: `hooks.ts`에 queryKeys + 훅 추가** — `queryKeys` 객체에:
```ts
  schedules: () => ["schedules"] as const,
  schedule: (id: string) => ["schedules", id] as const,
  scheduleEvents: (id: string) => ["schedules", id, "events"] as const,
```
파일 하단(environments 훅 뒤)에 import + 훅(environments 패턴 미러):
```ts
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  scheduleEvents,
  type ScheduleInput,
} from "./schedules";

export function useSchedules() {
  return useQuery({ queryKey: queryKeys.schedules(), queryFn: listSchedules });
}
export function useSchedule(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.schedule(id) : ["schedules", "missing"],
    queryFn: () => getSchedule(id as string),
    enabled: !!id,
  });
}
export function useScheduleEvents(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.scheduleEvents(id) : ["schedules", "missing", "events"],
    queryFn: () => scheduleEvents(id as string),
    enabled: !!id,
  });
}
export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => createSchedule(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.schedules() }),
  });
}
export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: ScheduleInput }) => updateSchedule(vars.id, vars.input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.schedules() });
      qc.invalidateQueries({ queryKey: queryKeys.schedule(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.scheduleEvents(vars.id) });
    },
  });
}
export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.schedules() }),
  });
}
```
> `usePreviewNext`는 ephemeral·debounce라 React Query 훅이 아니라 `TriggerBuilder`가 `previewNext()`를 직접 호출(Task 5). 여기선 추가 안 함.

- [ ] **Step 5: 통과 확인**

Run: `cd ui && pnpm test schedulesClient && pnpm build`
Expected: PASS + 0 타입 에러.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/api/schedules.ts ui/src/api/hooks.ts ui/src/api/__tests__/schedulesClient.test.ts
git commit -m "feat(ui): schedules API 클라이언트 + React Query 훅 (34c)"
git log -1 --oneline
```

---

## Task 4: `triggerCron.ts` — 프리셋→5-field cron 컴파일 + 목록 요약 (순수)

UI 프리셋(매일/매주/간격)을 5-field cron으로 컴파일하고, 목록 표시용 `describeTrigger`를 제공. **cron 평가는 서버(preview-next)** — 여기선 *문자열 생성*과 *best-effort 요약*만.

**Files:**
- Create: `ui/src/components/triggerCron.ts`
- Create test: `ui/src/components/__tests__/triggerCron.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/triggerCron.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { compileTrigger, describeTrigger, type BuilderState } from "../triggerCron";

describe("compileTrigger", () => {
  it("daily → 'M H * * *'", () => {
    const s: BuilderState = { mode: "daily", time: "02:05", days: [], everyN: 15, unit: "minutes", raw: "", runAtLocal: "" };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "5 2 * * *" });
  });
  it("weekly → 'M H * * d,d' (sorted)", () => {
    const s: BuilderState = { mode: "weekly", time: "02:00", days: [3, 1], everyN: 1, unit: "minutes", raw: "", runAtLocal: "" };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "0 2 * * 1,3" });
  });
  it("interval minutes → '*/N * * * *'", () => {
    const s: BuilderState = { mode: "interval", time: "", days: [], everyN: 15, unit: "minutes", raw: "", runAtLocal: "" };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "*/15 * * * *" });
  });
  it("interval hours → '0 */N * * *'", () => {
    const s: BuilderState = { mode: "interval", time: "", days: [], everyN: 6, unit: "hours", raw: "", runAtLocal: "" };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "0 */6 * * *" });
  });
  it("advanced → raw passthrough", () => {
    const s: BuilderState = { mode: "advanced", time: "", days: [], everyN: 1, unit: "minutes", raw: "30 3 1 * *", runAtLocal: "" };
    expect(compileTrigger(s)).toEqual({ kind: "cron", cron_expr: "30 3 1 * *" });
  });
  it("once → epoch ms from local datetime", () => {
    const s: BuilderState = { mode: "once", time: "", days: [], everyN: 1, unit: "minutes", raw: "", runAtLocal: "2030-01-02T03:04" };
    const t = compileTrigger(s);
    expect(t.kind).toBe("once");
    if (t.kind === "once") expect(t.run_at).toBe(new Date("2030-01-02T03:04").getTime());
  });
  it("returns null for incomplete input (empty daily time / no weekly days / empty raw)", () => {
    expect(compileTrigger({ mode: "daily", time: "", days: [], everyN: 1, unit: "minutes", raw: "", runAtLocal: "" })).toBeNull();
    expect(compileTrigger({ mode: "weekly", time: "02:00", days: [], everyN: 1, unit: "minutes", raw: "", runAtLocal: "" })).toBeNull();
    expect(compileTrigger({ mode: "advanced", time: "", days: [], everyN: 1, unit: "minutes", raw: "  ", runAtLocal: "" })).toBeNull();
  });
});

describe("describeTrigger", () => {
  it("friendly summaries for preset shapes, raw fallback", () => {
    expect(describeTrigger({ kind: "cron", cron_expr: "0 2 * * *" })).toBe("매일 02:00");
    expect(describeTrigger({ kind: "cron", cron_expr: "*/15 * * * *" })).toBe("15분마다");
    expect(describeTrigger({ kind: "cron", cron_expr: "0 */6 * * *" })).toBe("6시간마다");
    expect(describeTrigger({ kind: "cron", cron_expr: "5 2 * * 1,3" })).toBe("매주 월,수 02:05");
    expect(describeTrigger({ kind: "cron", cron_expr: "30 3 1 * *" })).toBe("cron: 30 3 1 * *");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test triggerCron`
Expected: FAIL — `../triggerCron` 없음.

- [ ] **Step 3: `triggerCron.ts` 구현**

```ts
import type { TriggerInput } from "../api/schedules";

export type TriggerMode = "once" | "daily" | "weekly" | "interval" | "advanced";
export type IntervalUnit = "minutes" | "hours";

export type BuilderState = {
  mode: TriggerMode;
  time: string; // "HH:mm" (daily/weekly)
  days: number[]; // 0=Sun..6=Sat (weekly)
  everyN: number; // interval
  unit: IntervalUnit;
  raw: string; // advanced raw cron
  runAtLocal: string; // datetime-local "YYYY-MM-DDTHH:mm" (once)
};

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** 빌더 상태 → 제출용 TriggerInput. 미완성(빈 time·요일 없음·빈 raw 등)이면 null. */
export function compileTrigger(s: BuilderState): TriggerInput | null {
  switch (s.mode) {
    case "once": {
      if (!s.runAtLocal) return null;
      const ms = new Date(s.runAtLocal).getTime();
      return Number.isFinite(ms) ? { kind: "once", run_at: ms } : null;
    }
    case "daily": {
      const hm = parseTime(s.time);
      if (!hm) return null;
      return { kind: "cron", cron_expr: `${hm.m} ${hm.h} * * *` };
    }
    case "weekly": {
      const hm = parseTime(s.time);
      if (!hm || s.days.length === 0) return null;
      const days = [...s.days].sort((a, b) => a - b).join(",");
      return { kind: "cron", cron_expr: `${hm.m} ${hm.h} * * ${days}` };
    }
    case "interval": {
      if (!Number.isInteger(s.everyN) || s.everyN < 1) return null;
      const expr = s.unit === "minutes" ? `*/${s.everyN} * * * *` : `0 */${s.everyN} * * *`;
      return { kind: "cron", cron_expr: expr };
    }
    case "advanced": {
      const raw = s.raw.trim();
      return raw === "" ? null : { kind: "cron", cron_expr: raw };
    }
  }
}

function parseTime(t: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** 목록 요약(best-effort). 프리셋 모양은 친근하게, 나머지는 raw cron. */
export function describeTrigger(t: TriggerInput): string {
  if (t.kind === "once") return `1회: ${new Date(t.run_at).toLocaleString()}`;
  const e = t.cron_expr.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d+) (\d+) \* \* \*$/.exec(e))) return `매일 ${pad(m[2])}:${pad(m[1])}`;
  if ((m = /^(\d+) (\d+) \* \* ([\d,]+)$/.exec(e))) {
    const labels = m[3]
      .split(",")
      .map((d) => DAY_LABELS[Number(d) % 7] ?? d)
      .join(",");
    return `매주 ${labels} ${pad(m[2])}:${pad(m[1])}`;
  }
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(e))) return `${m[1]}분마다`;
  if ((m = /^0 \*\/(\d+) \* \* \*$/.exec(e))) return `${m[1]}시간마다`;
  return `cron: ${e}`;
}

function pad(n: string): string {
  return n.padStart(2, "0");
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test triggerCron && pnpm build`
Expected: PASS (13 assertions) + 0 타입 에러.

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/triggerCron.ts ui/src/components/__tests__/triggerCron.test.ts
git commit -m "feat(ui): 트리거 cron 컴파일러 + 목록 요약 헬퍼 (5모드, 34c)"
git log -1 --oneline
```

---

## Task 5: `TriggerBuilder.tsx` — 5모드 라디오 UI + 라이브 preview-next

`BuilderState`를 내부 소유, `compileTrigger`로 `TriggerInput`을 만들어 `onChange(trigger | null)`로 부모에 emit. 컴파일된 트리거가 있으면 debounce 후 `previewNext`로 다음 3개 발사 시각을 표시.

**Files:**
- Create: `ui/src/components/TriggerBuilder.tsx`
- Create test: `ui/src/components/__tests__/TriggerBuilder.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/TriggerBuilder.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriggerBuilder } from "../TriggerBuilder";
import * as api from "../../api/schedules";

beforeEach(() => {
  vi.spyOn(api, "previewNext").mockResolvedValue([1_700_000_000_000]);
});

describe("TriggerBuilder", () => {
  it("daily mode emits compiled cron trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TriggerBuilder onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /매일/ }));
    const time = screen.getByLabelText(/시각/);
    await user.clear(time);
    await user.type(time, "02:00");
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ kind: "cron", cron_expr: "0 2 * * *" }),
    );
  });

  it("shows preview-next results", async () => {
    const user = userEvent.setup();
    render(<TriggerBuilder onChange={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: /간격/ }));
    await waitFor(() => expect(api.previewNext).toHaveBeenCalled());
    expect(await screen.findByText(/다음 발사/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test TriggerBuilder`
Expected: FAIL — `../TriggerBuilder` 없음.

- [ ] **Step 3: `TriggerBuilder.tsx` 구현**

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  compileTrigger,
  type BuilderState,
  type TriggerMode,
  type IntervalUnit,
} from "./triggerCron";
import { previewNext, type TriggerInput } from "../api/schedules";

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const INITIAL: BuilderState = {
  mode: "daily",
  time: "02:00",
  days: [],
  everyN: 15,
  unit: "minutes",
  raw: "",
  runAtLocal: "",
};

type Props = {
  /** 컴파일된 트리거(또는 미완성이면 null)를 부모에 통지. */
  onChange: (trigger: TriggerInput | null) => void;
  /** 편집 진입 시 초기 빌더 상태(없으면 daily 02:00). */
  initial?: Partial<BuilderState>;
};

export function TriggerBuilder({ onChange, initial }: Props) {
  const [state, setState] = useState<BuilderState>({ ...INITIAL, ...initial });
  const [preview, setPreview] = useState<number[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const trigger = useMemo(() => compileTrigger(state), [state]);

  // 컴파일된 트리거를 부모에 통지.
  useEffect(() => {
    onChange(trigger);
    // onChange는 부모가 매 렌더 새로 만들 수 있으므로 deps에서 제외(trigger 변화에만 반응).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  // 라이브 미리보기(debounce 400ms, 서버 cron 평가 단일 소스).
  useEffect(() => {
    if (!trigger) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    const handle = setTimeout(() => {
      previewNext(trigger, 3)
        .then((next) => {
          setPreview(next);
          setPreviewErr(null);
        })
        .catch((e: Error) => {
          setPreview(null);
          setPreviewErr(e.message);
        });
    }, 400);
    return () => clearTimeout(handle);
  }, [trigger]);

  const set = (patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch }));
  const toggleDay = (d: number) =>
    set({ days: state.days.includes(d) ? state.days.filter((x) => x !== d) : [...state.days, d] });

  const MODES: { value: TriggerMode; label: string }[] = [
    { value: "once", label: "1회" },
    { value: "daily", label: "매일" },
    { value: "weekly", label: "매주" },
    { value: "interval", label: "간격" },
    { value: "advanced", label: "고급(cron)" },
  ];

  return (
    <fieldset className="mb-4 border-t pt-3">
      <legend className="text-sm font-medium">트리거</legend>
      <div className="flex flex-wrap gap-3 mb-3">
        {MODES.map((m) => (
          <label key={m.value} className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name="trigger-mode"
              checked={state.mode === m.value}
              onChange={() => set({ mode: m.value })}
            />
            {m.label}
          </label>
        ))}
      </div>

      {state.mode === "once" && (
        <label className="block text-sm max-w-xs">
          <span className="text-slate-600">실행 일시</span>
          <input
            type="datetime-local"
            aria-label="실행 일시"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={state.runAtLocal}
            onChange={(e) => set({ runAtLocal: e.target.value })}
          />
        </label>
      )}

      {(state.mode === "daily" || state.mode === "weekly") && (
        <label className="block text-sm max-w-xs">
          <span className="text-slate-600">시각</span>
          <input
            type="time"
            aria-label="시각"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={state.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      )}

      {state.mode === "weekly" && (
        <div className="mt-2 flex gap-1" role="group" aria-label="요일 선택">
          {DAY_LABELS.map((label, d) => (
            <button
              key={d}
              type="button"
              aria-pressed={state.days.includes(d)}
              onClick={() => toggleDay(d)}
              className={`w-8 h-8 rounded text-sm border ${
                state.days.includes(d)
                  ? "bg-slate-800 text-white border-slate-800"
                  : "border-slate-300 text-slate-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {state.mode === "interval" && (
        <div className="flex items-end gap-2">
          <label className="block text-sm">
            <span className="text-slate-600">간격</span>
            <input
              type="number"
              min={1}
              aria-label="간격 N"
              className="mt-1 block w-24 rounded border border-slate-300 px-2 py-1"
              value={state.everyN}
              onChange={(e) => set({ everyN: Number(e.target.value) })}
            />
          </label>
          <select
            aria-label="간격 단위"
            className="mb-1 rounded border border-slate-300 px-2 py-1 text-sm"
            value={state.unit}
            onChange={(e) => set({ unit: e.target.value as IntervalUnit })}
          >
            <option value="minutes">분마다</option>
            <option value="hours">시간마다</option>
          </select>
        </div>
      )}

      {state.mode === "advanced" && (
        <label className="block text-sm max-w-md">
          <span className="text-slate-600">cron (5-field: 분 시 일 월 요일)</span>
          <input
            type="text"
            aria-label="cron expression"
            placeholder="0 2 * * *"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 font-mono"
            value={state.raw}
            onChange={(e) => set({ raw: e.target.value })}
          />
        </label>
      )}

      <div className="mt-3 text-sm">
        {previewErr ? (
          <p role="alert" className="text-red-600">
            미리보기 오류: {previewErr}
          </p>
        ) : preview && preview.length > 0 ? (
          <div>
            <span className="text-slate-600">다음 발사:</span>
            <ul className="mt-1 list-disc list-inside text-slate-700">
              {preview.map((ms, i) => (
                <li key={i}>{new Date(ms).toLocaleString()}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-slate-400">다음 발사 시각을 보려면 트리거를 완성하세요.</p>
        )}
      </div>
    </fieldset>
  );
}
```

> **함정:** `onChange` effect deps에서 `onChange`를 제외하고 `trigger`만 둔다(부모가 매 렌더 새 함수를 줄 수 있어 무한 루프 방지) — `eslint-disable-next-line react-hooks/exhaustive-deps` 1줄 필요(ui/CLAUDE.md lint 게이트가 `--max-warnings=0`이라 주석 없으면 실패). `radio` 접근명은 label 텍스트(`매일`)로 매치.

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test TriggerBuilder && pnpm build`
Expected: PASS + 0 타입 에러.

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/TriggerBuilder.tsx ui/src/components/__tests__/TriggerBuilder.test.tsx
git commit -m "feat(ui): TriggerBuilder 5모드 라디오 + 라이브 preview-next (34c)"
git log -1 --oneline
```

---

## Task 6: `ScheduleForm.tsx` — 생성/편집 폼 (profile 공유 컴포넌트 조합)

name + 시나리오 피커 + `TriggerBuilder` + profile(공유 컴포넌트) + env + enabled를 조합해 `ScheduleInput`을 제출. 시나리오를 고르면 `useScenario`로 YAML을 fetch·parse해 `scenario`(DataBindingPanel용)·`hasLoop`를 도출. **RunDialog의 profile 상태 변수를 미러**(loadModel/rateMode/vus/.../criteria/binding/env)하고 동일 추출 컴포넌트를 같은 props로 렌더.

**Files:**
- Create: `ui/src/components/ScheduleForm.tsx`
- Create test: `ui/src/components/__tests__/ScheduleForm.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/ScheduleForm.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleForm } from "../ScheduleForm";
import * as schedApi from "../../api/schedules";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.spyOn(schedApi, "previewNext").mockResolvedValue([1]);
  // 시나리오 목록(피커)·단건(YAML) fetch는 빈 응답으로 충분(폼 제출 본문만 검증).
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ scenarios: [] }) }),
  );
});

describe("ScheduleForm", () => {
  it("submits a ScheduleInput with name + trigger + profile + enabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(<ScheduleForm scenarioOptions={[{ id: "s1", name: "scn" }]} onSubmit={onSubmit} submitting={false} />);

    await user.type(screen.getByLabelText(/이름/), "nightly");
    await user.selectOptions(screen.getByLabelText(/시나리오/), "s1");
    // 트리거: daily 02:00 (기본 모드 daily, 기본 time 02:00)
    await user.click(screen.getByRole("button", { name: /저장/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const input = onSubmit.mock.calls[0][0];
    expect(input.name).toBe("nightly");
    expect(input.scenario_id).toBe("s1");
    expect(input.trigger).toEqual({ kind: "cron", cron_expr: "0 2 * * *" });
    expect(input.enabled).toBe(true);
    expect(input.profile.vus).toBeGreaterThanOrEqual(1);
  });

  it("disables 저장 until name + scenario + valid trigger are set", () => {
    wrap(<ScheduleForm scenarioOptions={[{ id: "s1", name: "scn" }]} onSubmit={vi.fn()} submitting={false} />);
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScheduleForm`
Expected: FAIL — `../ScheduleForm` 없음.

- [ ] **Step 3: `ScheduleForm.tsx` 구현** — 아래 골격. profile 상태/컴포넌트는 **RunDialog와 동일 props**로(참조: `RunDialog.tsx:428-446` LoadModelFields, `:716-722` EnvironmentPicker, `:762-770` DataBindingPanel, `:256-268` loadState, Task 1의 `<CriteriaFields>`). `scenario`/`hasLoop` 도출은 `ScenarioRunsPage`가 `<RunDialog>`에 `scenario`/`hasLoop`를 넘기는 방식을 미러(`useScenario(id)` → `parseScenarioDoc(yaml)` → `"model" in parsed ? parsed.model : null`, `hasLoop = model?.steps.some(isLoopStep) ?? false`).

```tsx
import { useMemo, useState } from "react";
import type { DataBinding, Profile } from "../api/schemas";
import type { ScheduleInput, TriggerInput } from "../api/schedules";
import { useScenario } from "../api/hooks";
import { parseScenarioDoc } from "../scenario/yamlDoc"; // (정확 경로는 ScenarioRunsPage import를 미러)
import { isLoopStep } from "../scenario/model";
import { LoadModelFields } from "./LoadModelFields";
import { buildLoadProfile, loadModelErrors, type LoadModelState } from "./loadModel";
import { CriteriaFields } from "./CriteriaFields";
import {
  buildProfile as buildProfileShared,
  criteriaStateFrom,
  criteriaHasValue,
  criteriaActiveCount,
  type CriteriaState,
} from "./profileForm";
import { DataBindingPanel } from "./DataBindingPanel";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { useEnvironment } from "../api/hooks";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { TriggerBuilder } from "./TriggerBuilder";
import type { BuilderState } from "./triggerCron";
import { normalizeProfile } from "../api/runPrefill";
import { Button } from "./Button";

export type ScenarioOption = { id: string; name: string };

type Props = {
  scenarioOptions: ScenarioOption[];
  onSubmit: (input: ScheduleInput) => void;
  submitting: boolean;
  /** 편집 모드 초기값(없으면 신규). */
  initial?: {
    name: string;
    scenario_id: string;
    profile: Profile;
    env: Record<string, string>;
    trigger: TriggerInput;
    enabled: boolean;
  };
  onCancel?: () => void;
};

export function ScheduleForm({ scenarioOptions, onSubmit, submitting, initial, onCancel }: Props) {
  const init = initial ? normalizeProfile(initial.profile) : undefined;
  const [name, setName] = useState(initial?.name ?? "");
  const [scenarioId, setScenarioId] = useState(initial?.scenario_id ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<TriggerInput | null>(initial?.trigger ?? null);

  // 시나리오 모델 도출(DataBindingPanel + hasLoop). ScenarioRunsPage 미러.
  const scenarioQuery = useScenario(scenarioId || undefined);
  const scenario = useMemo(() => {
    const yaml = scenarioQuery.data?.yaml;
    if (!yaml) return null;
    const parsed = parseScenarioDoc(yaml);
    return parsed && "model" in parsed ? parsed.model : null;
  }, [scenarioQuery.data?.yaml]);
  const hasLoop = scenario?.steps.some(isLoopStep) ?? false;

  // --- profile 상태 (RunDialog 미러) ---
  const [loadModel, setLoadModel] = useState<"closed" | "open">(init?.target_rps != null || (init?.stages?.length ?? 0) > 0 ? "open" : "closed");
  const [rateMode, setRateMode] = useState<"fixed" | "curve">((init?.stages?.length ?? 0) > 0 ? "curve" : "fixed");
  const [vus, setVus] = useState(init?.vus ?? 2);
  const [duration, setDuration] = useState(init?.duration_seconds ?? 5);
  const [rampUp, setRampUp] = useState(init?.ramp_up_seconds ?? 0);
  const [targetRps, setTargetRps] = useState(init?.target_rps != null ? String(init.target_rps) : "");
  const [maxInFlight, setMaxInFlight] = useState(init?.max_in_flight != null ? String(init.max_in_flight) : "200");
  const [stages, setStages] = useState<{ target: string; duration_seconds: string }[]>(
    init?.stages?.map((s) => ({ target: String(s.target), duration_seconds: String(s.duration_seconds) })) ?? [
      { target: "100", duration_seconds: "30" },
    ],
  );
  const [thinkMin, setThinkMin] = useState(init?.think_time?.min_ms != null ? String(init.think_time.min_ms) : "");
  const [thinkMax, setThinkMax] = useState(init?.think_time?.max_ms != null ? String(init.think_time.max_ms) : "");
  const [thinkSeed, setThinkSeed] = useState(init?.think_seed != null ? String(init.think_seed) : "");
  const [httpTimeout, setHttpTimeout] = useState(init?.http_timeout_seconds ?? 30);
  const [loopCap, setLoopCap] = useState(init?.loop_breakdown_cap ?? 256);

  const [criteria, setCriteriaState] = useState<CriteriaState>(criteriaStateFrom(init?.criteria));
  const [sloOpen, setSloOpen] = useState(() => criteriaHasValue(criteriaStateFrom(init?.criteria)));
  const setCriteria = (key: keyof CriteriaState, val: string) => {
    setCriteriaState((prev) => {
      const next = { ...prev, [key]: val };
      // cross-field: minWindowRps 채우면 closed-loop에서 rpsWarmup을 rampUp으로 seed (RunDialog 미러).
      if (key === "minWindowRps" && val.trim() !== "" && prev.rpsWarmup.trim() === "" && loadModel === "closed") {
        next.rpsWarmup = String(rampUp);
      }
      return next;
    });
  };

  const [binding, setBinding] = useState<DataBinding | null>(init?.data_binding ?? null);
  const [bindingValid, setBindingValid] = useState(true);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(
    initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );

  const loadState: LoadModelState = {
    loadModel, rateMode, vus, duration, rampUp, targetRps, maxInFlight, stages, thinkMin, thinkMax, thinkSeed,
  };
  const loadErrs = loadModelErrors(loadState);
  const env = resolveEnv(baseVars, envEntries);

  function buildProfile(): Profile {
    return buildProfileShared({ hasLoop, loopCap, httpTimeout, binding, loadState, criteria });
  }

  // 제출 가드: name·scenario·트리거 완성·profile 유효.
  const canSubmit =
    name.trim() !== "" &&
    scenarioId !== "" &&
    trigger != null &&
    bindingValid &&
    !loadErrs.targetRpsInvalid &&
    !loadErrs.maxInFlightInvalid &&
    !loadErrs.stagesInvalid &&
    !loadErrs.rampInvalid &&
    httpTimeout >= 1 &&
    httpTimeout <= 600 &&
    !submitting;

  function submit() {
    if (!canSubmit || !trigger) return;
    onSubmit({ name: name.trim(), scenario_id: scenarioId, profile: buildProfile(), env, trigger, enabled });
  }

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      <div className="grid grid-cols-2 gap-3 mb-3 max-w-2xl">
        <label className="block text-sm">
          <span className="text-slate-600">이름</span>
          <input
            aria-label="이름"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">시나리오</span>
          <select
            aria-label="시나리오"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
          >
            <option value="">선택…</option>
            {scenarioOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <TriggerBuilder
        onChange={setTrigger}
        initial={triggerInitial(initial?.trigger)}
      />

      <LoadModelFields
        loadModel={loadModel}
        setLoadModel={setLoadModel}
        rateMode={rateMode}
        setRateMode={setRateMode}
        vus={vus}
        setVus={setVus}
        duration={duration}
        setDuration={setDuration}
        rampUp={rampUp}
        setRampUp={setRampUp}
        targetRps={targetRps}
        setTargetRps={setTargetRps}
        maxInFlight={maxInFlight}
        setMaxInFlight={setMaxInFlight}
        stages={stages}
        setStages={setStages}
        errs={loadErrs}
      />

      <div className="mb-3 max-w-xs">
        <label className="block text-sm">
          <span className="text-slate-600">HTTP timeout (s)</span>
          <input
            type="number"
            min={1}
            max={600}
            aria-label="HTTP timeout (s)"
            value={httpTimeout}
            onChange={(e) => setHttpTimeout(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>

      <fieldset className="mt-3 mb-4 border-t pt-3">
        <legend className="text-sm font-medium">
          <button
            type="button"
            onClick={() => setSloOpen((v) => !v)}
            className="font-medium text-slate-700 hover:underline"
            aria-expanded={sloOpen}
          >
            {sloOpen ? "▾" : "▸"} SLO 기준 (선택)
            {!sloOpen && criteriaActiveCount(criteria) > 0 ? (
              <span className="ml-1 text-xs font-normal text-slate-500">
                · {criteriaActiveCount(criteria)}개 설정됨
              </span>
            ) : null}
          </button>
        </legend>
        {sloOpen && <CriteriaFields value={criteria} onChange={setCriteria} />}
      </fieldset>

      <EnvironmentPicker
        selectedEnvId={selectedEnvId}
        onSelect={setSelectedEnvId}
        baseVars={baseVars}
        overrides={envEntries}
        onOverridesChange={setEnvEntries}
      />

      {scenario && (
        <DataBindingPanel
          scenario={scenario}
          initialBinding={binding}
          onChange={setBinding}
          onValidityChange={setBindingValid}
        />
      )}

      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        활성화 (체크 해제 시 발사 안 함)
      </label>

      <div className="flex gap-2">
        <Button onClick={submit} disabled={!canSubmit}>
          {submitting ? "저장 중…" : "저장"}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
        )}
      </div>
    </div>
  );
}

/** 저장된 once/cron 트리거 → TriggerBuilder 초기 빌더 상태(편집 모드). */
function triggerInitial(t?: TriggerInput): Partial<BuilderState> | undefined {
  if (!t) return undefined;
  if (t.kind === "once") {
    return { mode: "once", runAtLocal: toLocalDatetime(t.run_at) };
  }
  // cron은 고급 탭에 raw로 채워 안전하게 편집(프리셋 역파싱은 describeTrigger 표시로 충분).
  return { mode: "advanced", raw: t.cron_expr };
}

function toLocalDatetime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

> **주의:**
> - **`loadModel.ts`는 `LoadModel`/`RateMode` 타입을 export하지 않는다**(리뷰 확인) — 위 `useState`는 리터럴 유니온 `"closed"|"open"`/`"fixed"|"curve"`을 직접 쓴다(`LoadModelState.loadModel`/`rateMode`가 이 리터럴). `parseScenarioDoc`(`../scenario/yamlDoc`)·`isLoopStep`(`../scenario/model`)·`normalizeProfile`(`../api/runPrefill`)·`resolveEnv`/`EnvEntry`(`../api/envOverlay`)는 `ScenarioRunsPage.tsx`(RunDialog 호출부) 미러로 경로 확인됨.
> - 편집 모드 cron 트리거는 **고급(raw) 탭으로 로드**한다(프리셋 역파싱 생략 — 사용자가 그대로 저장하면 동일 cron, describeTrigger가 목록에 친근 요약 표시). once는 datetime-local로 복원.
> - DataBindingPanel은 RunDialog와 달리 `key`/`seedBinding` 재시드가 불필요(폼이 매번 새로 마운트 — Task 8의 `key`로). `normalizeProfile`로 prefill Zod 누출 차단(ui/CLAUDE.md "reseed-by-key" 패턴 — 리뷰 OK).
> - **연기(34c 범위 밖):** Pacing(think time) 섹션은 ScheduleForm에 배선하지 않는다 — `LoadModelFields`엔 think-time이 없고(RunDialog의 별도 fieldset) 스케줄은 closed-loop think-time을 v1에서 노출 안 한다(`thinkMin/Max/Seed`는 항상 `""` → `buildLoadProfile`이 `think_time`/`think_seed` omit). 필요 시 후속.

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScheduleForm && pnpm build`
Expected: PASS + 0 타입 에러. (실패 시 import 경로/타입명을 RunDialog·loadModel.ts와 대조해 정정.)

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/ScheduleForm.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "feat(ui): ScheduleForm — 트리거 빌더 + 공유 profile 컴포넌트 조합 (34c)"
git log -1 --oneline
```

---

## Task 7: `ScheduleEventTimeline.tsx` — 상세 뷰 이벤트 이력

`useScheduleEvents(id)`로 이벤트를 가져와 kind 배지·시각·`fired`면 run 리포트 링크·`error`/skip이면 detail을 타임라인으로.

**Files:**
- Create: `ui/src/components/ScheduleEventTimeline.tsx`
- Create test: `ui/src/components/__tests__/ScheduleEventTimeline.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/ScheduleEventTimeline.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleEventTimeline } from "../ScheduleEventTimeline";
import * as schedApi from "../../api/schedules";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(schedApi, "scheduleEvents").mockResolvedValue([
    { id: "e1", at: 1_700_000_000_000, kind: "fired", run_id: "run123", detail: null },
    { id: "e2", at: 1_700_000_100_000, kind: "skipped_overlap", run_id: null, detail: "previous run still running" },
  ]);
});

describe("ScheduleEventTimeline", () => {
  it("renders events with kind badges, run link, and detail", async () => {
    wrap(<ScheduleEventTimeline scheduleId="sch1" />);
    expect(await screen.findByText("fired")).toBeInTheDocument();
    expect(screen.getByText("skipped_overlap")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run123|리포트/ })).toHaveAttribute("href", "/runs/run123");
    expect(screen.getByText(/previous run still running/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScheduleEventTimeline`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: `ScheduleEventTimeline.tsx` 구현**

```tsx
import { Link } from "react-router-dom";
import { useScheduleEvents } from "../api/hooks";

const KIND_STYLE: Record<string, string> = {
  fired: "bg-green-100 text-green-800",
  skipped_overlap: "bg-amber-100 text-amber-800",
  missed: "bg-orange-100 text-orange-800",
  error: "bg-red-100 text-red-800",
};

type Props = { scheduleId: string };

export function ScheduleEventTimeline({ scheduleId }: Props) {
  const events = useScheduleEvents(scheduleId);

  return (
    <section aria-label="schedule events" className="mt-4">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">이벤트 이력</h4>
      {events.isLoading && <p className="text-slate-500 text-sm">Loading…</p>}
      {events.error && (
        <p role="alert" className="text-red-600 text-sm">
          이벤트 로드 실패: {(events.error as Error).message}
        </p>
      )}
      {events.data && events.data.length === 0 && (
        <p className="text-slate-400 text-sm">아직 발사 이력이 없습니다.</p>
      )}
      {events.data && events.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {events.data.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-sm">
              <span className={`rounded px-1.5 py-0.5 text-xs ${KIND_STYLE[e.kind] ?? "bg-slate-100 text-slate-700"}`}>
                {e.kind}
              </span>
              <span className="text-slate-500 whitespace-nowrap">{new Date(e.at).toLocaleString()}</span>
              {e.run_id && (
                <Link to={`/runs/${e.run_id}`} className="text-blue-600 hover:underline">
                  리포트 →
                </Link>
              )}
              {e.detail && <span className="text-slate-600">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test ScheduleEventTimeline && pnpm build`
Expected: PASS + 0 타입 에러.

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/components/ScheduleEventTimeline.tsx ui/src/components/__tests__/ScheduleEventTimeline.test.tsx
git commit -m "feat(ui): ScheduleEventTimeline — 상세 뷰 이벤트 이력(kind 배지/run 링크) (34c)"
git log -1 --oneline
```

---

## Task 8: `SchedulesPage.tsx` — 목록 + 폼 + 삭제 + enable 토글 + 타임라인

`EnvironmentsPage`를 미러: `mode` 상태("none"|"new"|"edit"), 목록 테이블(name·시나리오·트리거 요약·next_run_at·last_status 배지·enabled 토글·편집/삭제), 편집 시 `ScheduleForm` + `ScheduleEventTimeline`. **enable 토글은 summary에 profile/env가 없으므로 `getSchedule(id)` 임퍼러티브 fetch 후 `enabled` 뒤집어 PUT**.

**Files:**
- Create: `ui/src/pages/SchedulesPage.tsx`
- Create test: `ui/src/pages/__tests__/SchedulesPage.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/pages/__tests__/SchedulesPage.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SchedulesPage } from "../SchedulesPage";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/schedules")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () =>
            Promise.resolve({
              schedules: [
                {
                  id: "sch1", name: "nightly", scenario_id: "s1",
                  trigger: { kind: "cron", cron_expr: "0 2 * * *" },
                  enabled: true, next_run_at: 1_700_000_000_000, last_status: "fired", last_fired_at: 1,
                },
              ],
            }),
        });
      }
      if (url.endsWith("/api/scenarios")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ scenarios: [] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("SchedulesPage", () => {
  it("renders schedule list with trigger summary + last_status badge", async () => {
    wrap(<SchedulesPage />);
    expect(await screen.findByText("nightly")).toBeInTheDocument();
    expect(screen.getByText("매일 02:00")).toBeInTheDocument(); // describeTrigger
    expect(screen.getByText("fired")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test SchedulesPage`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: `SchedulesPage.tsx` 구현** — `EnvironmentsPage.tsx` 구조를 미러하되 폼은 `ScheduleForm`, 목록 열은 schedule 필드. 핵심 동작:
  - `useSchedules()`(목록), `useScenarios()`(폼 피커 옵션), `useCreateSchedule`/`useUpdateSchedule`/`useDeleteSchedule`, `useQueryClient`(임퍼러티브 fetch).
  - `startEdit(id)`: `qc.fetchQuery({ queryKey: queryKeys.schedule(id), queryFn: () => getSchedule(id) })` → ScheduleForm `initial`로(EnvironmentsPage.startEdit 미러).
  - `toggleEnabled(row)`: `const full = await qc.fetchQuery(getSchedule(row.id))` → `updateSchedule.mutate({ id: row.id, input: { name, scenario_id, profile, env, trigger, enabled: !full.enabled } })`. (summary엔 profile/env 없음 → full fetch 필수.)
  - 목록 행: `describeTrigger(row.trigger)`(triggerCron.ts) + `next_run_at` `new Date().toLocaleString()` + `last_status` 배지(ScheduleEventTimeline의 `KIND_STYLE` 재사용 — 작은 `statusBadge` 헬퍼로 추출하거나 인라인) + enabled 토글 버튼 + 편집/삭제.
  - 편집 패널 하단에 `<ScheduleEventTimeline scheduleId={editingId} />`.
  - 삭제: `window.confirm` 후 `useDeleteSchedule`(EnvironmentsPage.handleDelete 미러).

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useSchedules,
  useScenarios,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../api/hooks";
import { getSchedule, type ScheduleInput } from "../api/schedules";
import { describeTrigger } from "../components/triggerCron";
import { ScheduleForm, type ScenarioOption } from "../components/ScheduleForm";
import { ScheduleEventTimeline } from "../components/ScheduleEventTimeline";
import { Button } from "../components/Button";

const STATUS_STYLE: Record<string, string> = {
  fired: "bg-green-100 text-green-800",
  skipped_overlap: "bg-amber-100 text-amber-800",
  missed: "bg-orange-100 text-orange-800",
  error: "bg-red-100 text-red-800",
};

export function SchedulesPage() {
  const list = useSchedules();
  const scenarios = useScenarios();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const qc = useQueryClient();

  const [mode, setMode] = useState<"none" | "new" | "edit">("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editInitial, setEditInitial] = useState<ScheduleForm_Initial | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  // useScenarios()는 {scenarios:[…]} 래퍼를 반환(ScenarioListSchema) — .scenarios로 언랩(리뷰 CRITICAL).
  const scenarioOptions: ScenarioOption[] = (scenarios.data?.scenarios ?? []).map((s) => ({ id: s.id, name: s.name }));

  function startNew() {
    setMode("new");
    setEditingId(null);
    setEditInitial(null);
    setFormError(null);
  }

  async function startEdit(id: string) {
    setFormError(null);
    try {
      const s = await qc.fetchQuery({ queryKey: queryKeys.schedule(id), queryFn: () => getSchedule(id) });
      setEditInitial({
        name: s.name, scenario_id: s.scenario_id, profile: s.profile, env: s.env,
        trigger: s.trigger, enabled: s.enabled,
      });
      setEditingId(id);
      setMode("edit");
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  function handleSubmit(input: ScheduleInput) {
    setFormError(null);
    const done = {
      onSuccess: () => setMode("none"),
      onError: (e: Error) => setFormError(e.message),
    };
    if (mode === "edit" && editingId) {
      updateSchedule.mutate({ id: editingId, input }, done);
    } else {
      createSchedule.mutate(input, done);
    }
  }

  async function toggleEnabled(id: string) {
    setDelError(null);
    try {
      const full = await qc.fetchQuery({ queryKey: queryKeys.schedule(id), queryFn: () => getSchedule(id) });
      const input: ScheduleInput = {
        name: full.name, scenario_id: full.scenario_id, profile: full.profile, env: full.env,
        trigger: full.trigger, enabled: !full.enabled,
      };
      updateSchedule.mutate({ id, input }, { onError: (e) => setDelError(e.message) });
    } catch (e) {
      setDelError((e as Error).message);
    }
  }

  function handleDelete(id: string) {
    setDelError(null);
    if (!window.confirm("이 스케줄을 삭제할까요? (예약/반복 발사가 중단됩니다)")) return;
    deleteSchedule.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  }

  const submitting = createSchedule.isPending || updateSchedule.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Schedules</h2>
        {mode === "none" && <Button onClick={startNew}>New schedule</Button>}
      </div>

      {mode !== "none" && (
        <section aria-label="schedule form" className="mb-8">
          <h3 className="text-md font-semibold mb-3">{mode === "edit" ? "Edit schedule" : "New schedule"}</h3>
          {formError && (
            <p role="alert" className="mb-2 text-sm text-red-600">
              {formError}
            </p>
          )}
          <ScheduleForm
            key={editingId ?? "new"}
            scenarioOptions={scenarioOptions}
            onSubmit={handleSubmit}
            submitting={submitting}
            initial={mode === "edit" && editInitial ? editInitial : undefined}
            onCancel={() => setMode("none")}
          />
          {mode === "edit" && editingId && <ScheduleEventTimeline scheduleId={editingId} />}
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {delError}
        </p>
      )}

      <section aria-label="schedule list">
        {list.isLoading && <p className="text-slate-500">Loading…</p>}
        {list.error && <p className="text-red-600">Failed to load: {(list.error as Error).message}</p>}
        {list.data && list.data.length === 0 && mode === "none" && (
          <p className="text-slate-500">No schedules yet.</p>
        )}
        {list.data && list.data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Trigger</th>
                <th className="py-2 pr-4">Next run</th>
                <th className="py-2 pr-4">Last status</th>
                <th className="py-2 pr-4">Enabled</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{s.name}</td>
                  <td className="py-2 pr-4">{describeTrigger(s.trigger)}</td>
                  <td className="py-2 pr-4 text-slate-500">
                    {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "—"}
                  </td>
                  <td className="py-2 pr-4">
                    {s.last_status ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.last_status] ?? "bg-slate-100 text-slate-700"}`}
                      >
                        {s.last_status}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <button
                      type="button"
                      aria-label={`toggle enabled ${s.name}`}
                      onClick={() => void toggleEnabled(s.id)}
                      className="text-slate-700 hover:underline"
                      disabled={updateSchedule.isPending}
                    >
                      {s.enabled ? "✓ 켜짐" : "꺼짐"}
                    </button>
                  </td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(s.id)}>
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => handleDelete(s.id)} disabled={deleteSchedule.isPending}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

type ScheduleForm_Initial = NonNullable<React.ComponentProps<typeof ScheduleForm>["initial"]>;
```

> **함정:** `useScenarios().data`는 **`{scenarios: Scenario[]}` 래퍼**(`ScenarioListSchema`, 리뷰 CRITICAL) — `.scenarios`로 언랩해야 `.map`이 동작(bare 배열 아님). 항목엔 `id`/`name`/`yaml` 있음(`ScenarioSchema` 확인됨). `ScheduleForm`을 `key={editingId ?? "new"}`로 remount해 편집↔신규 전환 시 폼 상태가 새 `initial`로 재시드(RunDialog prefill reseed-by-key 패턴, ui/CLAUDE.md). enable 토글이 두 fetch(get→put)라 약간 느림은 v1 수용.

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test SchedulesPage && pnpm build`
Expected: PASS + 0 타입 에러.

- [ ] **Step 5: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/pages/SchedulesPage.tsx ui/src/pages/__tests__/SchedulesPage.test.tsx
git commit -m "feat(ui): SchedulesPage — 목록/폼/삭제/enable 토글/타임라인 (34c)"
git log -1 --oneline
```

---

## Task 9: 라우팅 + 네비 + 전체 게이트 + 라이브 검증

**Files:**
- Modify: `ui/src/routes.tsx`
- Modify: `ui/src/components/Layout.tsx`

- [ ] **Step 1: 라우트 추가** — `routes.tsx` import + children에:
```tsx
import { SchedulesPage } from "./pages/SchedulesPage";
// children 배열에:
      { path: "schedules", element: <SchedulesPage /> },
```

- [ ] **Step 2: 네비 링크 추가** — `Layout.tsx` `<nav>`에 Environments 옆:
```tsx
            <Link to="/schedules" className="hover:text-slate-900">
              Schedules
            </Link>
```

- [ ] **Step 3: 전체 UI 게이트** (타깃 아닌 전체 — S-D 잠복 red 차단)

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고(`--max-warnings=0`) + 전체 vitest GREEN + `tsc -b` 0 에러. (라우트는 RTL로 안 잡히는 게 정상 — 통합은 라이브에서.)

- [ ] **Step 4: 커밋**

```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add ui/src/routes.tsx ui/src/components/Layout.tsx
git commit -m "feat(ui): /schedules 라우트 + 네비 링크 (34c)"
git log -1 --oneline
```

- [ ] **Step 5: 라이브 검증 (머지 전 필수 — S-D 응답파싱 갭 차단)**

`dev-doctor` 스킬로 stale 프로세스/포트 정리 후:
```bash
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker --bin worker   # subprocess가 spawn하는 바이너리
just ui-build                                  # 또는 cd ui && pnpm build (dist 갱신)
./target/debug/controller --db /tmp/sched-34c.db --ui-dir ui/dist \
  --scheduler-tick-seconds 5 --scheduler-timezone Asia/Seoul &
```
브라우저(또는 Playwright)로 `http://127.0.0.1:8080/schedules`:
1. 시나리오 1개 미리 생성(`POST /api/scenarios`, 루트 CLAUDE.md curl 예).
2. **New schedule** → 이름 + 시나리오 선택 + 트리거 `간격`/`1분마다`(또는 `1회` = 1~2분 뒤) → "다음 발사" 미리보기 3개 표시되는지(서버 preview-next 동작) → 저장.
3. 목록에 행 표시(트리거 요약·next_run·last_status) 확인 → 브라우저 콘솔 **Zod 에러 0**(실 `/api/schedules` 응답이 `ScheduleSchema.parse` 통과 = S-D 갭 차단).
4. 틱(≤5s) 후 새로고침 → cron이면 `last_status=fired` + 편집 뷰 **이벤트 타임라인에 `fired` + run 리포트 링크**, once면 `enabled` 자동 off. 리포트 링크 클릭 → run 상세 도달.
5. enable 토글 → 행 상태 바뀌고 재조회.

> 라이브 PASS 못 하면(특히 응답 파싱) 머지 금지 — S-D에서 `.optional()`↔서버-null 미스매치가 전 슬라이스 잠복했었다. RTL fixture는 `null`을 줬으니 1차 방어는 됐지만 라이브가 최종 게이트.

- [ ] **Step 6: 최종 머지** (handicap-reviewer READY-TO-MERGE 확인 후) — worktree에서 작업했다면 루트 CLAUDE.md "git 토폴로지"대로 master에 rebase→ff-merge→`ExitWorktree`. master에서 직접 작업했다면 커밋들이 이미 master에 있음.

---

## Self-Review (작성자 체크)

**1. Spec 커버리지:**
- §9.1 와이어 스키마 → Task 2 ✓ (`.nullish()`, discriminated trigger)
- §9.2 페이지(목록·폼·트리거 빌더·preview·profile 재사용·enable·삭제) → Task 5/6/8 ✓
- §9.3 #1 profile 공유 추출(byte-identical) → Task 1 ✓
- §9.3 #2 트리거 5모드 + 클라 cron 컴파일 + 서버 preview → Task 4/5 ✓
- §9.3 #3 이벤트 타임라인(상세 뷰, per-event run 링크, 목록은 last_status만) → Task 7/8 ✓
- §9.2 React Query 훅(environments 패턴) → Task 3 ✓
- §11 테스트(스키마 round-trip·프리셋→cron·preview 표시·폼 제출·목록·null fixture·라이브) → 각 Task 테스트 + Task 9 라이브 ✓
- §12 무변경(proto/엔진/워커/migration) → 전 Task UI-only ✓

**2. 플레이스홀더 스캔:** 없음 — 순수 로직(profileForm/triggerCron/schemas/schedules.ts)은 전체 코드, 조합부(ScheduleForm/SchedulesPage)는 RunDialog/EnvironmentsPage의 정확한 라인 참조 + 골격 코드. import 경로 한 곳(`parseScenarioDoc`/`LoadModel` 타입)만 "RunDialog 호출부와 대조" 지시(실측 경로는 실행 시 확정 — 가이드 명시).

**3. 타입 일관성:** `TriggerInput`(schedules.ts) = `Trigger`(schemas.ts) = TriggerBuilder onChange 타입 = compileTrigger 반환 ✓. `CriteriaState`(profileForm.ts)를 CriteriaFields/RunDialog/ScheduleForm 공유 ✓. `ScheduleInput` create/update/toggle 공통 ✓. `buildProfile`(profileForm) 시그니처 = RunDialog·ScheduleForm 호출 1:1 ✓.

**알려진 실행 리스크(implementer 주의 — spec-plan-reviewer 반영 완료):** (a) Task 1 byte-identical은 기존 RunDialog 테스트 무수정 GREEN이 게이트 — 특히 cross-field seed 테스트(`RunDialog.test.tsx` min_window_rps→rps_warmup)·SLO `getByLabelText`가 깨지면 추출이 동작을 바꾼 것이니 진단. (b) Task 6 `loadModel`/`rateMode` useState는 리터럴 유니온(loadModel.ts에 `LoadModel`/`RateMode` 타입 없음 — 리뷰 확인, 반영됨). (c) Task 8 `scenarios.data`는 `{scenarios:[…]}` 래퍼 → `scenarios.data?.scenarios`로 언랩(반영됨). (d) Pacing(think-time)은 34c 범위 밖(연기, Task 6 주의 참조).
