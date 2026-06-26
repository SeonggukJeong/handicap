# 설정 화면 환경별 그룹핑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/settings`(운영 상한) 페이지를 배포 환경 적용 범위("모든 배포 공통" / "분산 워커 풀(LAN) 전용")로 1차 그룹핑하고, 풀 전용 그룹에 설명·현재 모드 배너를, 환경별 의미가 다른 설정에 환경 주석을 단다.

**Architecture:** 순수 UI 슬라이스. 설정→그룹 분류는 신규 UI 정적 sparse 맵(`settingsEnv.ts`)이 단일 소스(미매핑 key는 `"common"`으로 그래이스풀 폴백 → 거짓 배지 불가). `SettingsPage.tsx`를 환경 그룹 2개(각 그룹 안에 조정 가능/읽기 전용 서브섹션)로 재구성하고, 기존 `usePoolWorkers().pool_mode`를 읽어 현재 컨트롤러 모드 배너를 표시. 백엔드·proto·migration·`schemas.ts`·`api/settings.ts`는 0-diff.

**Tech Stack:** React + TypeScript + Tailwind + vitest/RTL. 기존 React Query 훅(`useSettings`/`usePutSetting`/`useResetSetting`/`usePoolWorkers`).

## Global Constraints

- **백엔드·와이어 0-diff** (spec R8): `crates/**`·`proto`·`*.sql`(migration)·`ui/src/api/settings.ts`(`SettingSchema`)·`ui/src/api/schemas.ts` 무변경. 설정 동작·범위·검증·기본값 불변.
- **전 사용자-노출 문구는 `ko.opsSettings.*` 카탈로그 경유** (spec R7, ADR-0035): 신규 인라인 영어/한국어 문자열 0. `aria-label`도 사용자-노출 문구라 ko 경유.
- **분류 단일 소스 = `settingsEnv.ts`** (spec R2): pool scope는 `is_pool_mode()`-게이트 reaper 2종(`pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds`)만. `pool_keepalive_seconds`는 전 모드 적용이라 **공통**(spec F1). 미매핑 key = `"common"`.
- **행 동작 byte-identical** (spec R9): `MutableRow`·저장/복원 mutation·`clearDraft`-on-success·`aria-invalid`/`aria-describedby`·`변경됨` 배지·하트비트 margin-hint 로직은 재배치만, 로직 무변경.
- **테스트 위치**: vitest `include`=`src/**/__tests__/**` — `__tests__/` 밖 테스트는 조용히 미실행(ui/CLAUDE.md). 신규 테스트는 `src/<dir>/__tests__/`.
- **UI 게이트**: 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 전체 green (`pnpm lint`은 `--max-warnings=0`, `pnpm build`=`tsc -b`가 strict 타입 잡음).
- **tdd-guard**: src(`ui/src/**` non-test) 편집 전 pending test-path 파일 필요 → **테스트 파일을 항상 먼저** 편집(ui/CLAUDE.md).

---

## File Structure

- **Create** `ui/src/settings/settingsEnv.ts` — 순수 분류 맵: `scopeOf(key)`, `ENV_NOTE_KEY`. React/ko 의존 없음.
- **Create** `ui/src/settings/__tests__/settingsEnv.test.ts` — 분류 단위 테스트.
- **Modify** `ui/src/i18n/ko.ts` — `opsSettings`에 그룹/서브/배너/풀설명/envNote 신규 키 추가(Task 1); `mutableSection`·`readonlySection` 삭제(Task 2).
- **Modify** `ui/src/pages/SettingsPage.tsx` — 환경 그룹 재구성 + 모드 배너 + envNote 렌더(Task 2).
- **Modify** `ui/src/pages/__tests__/SettingsPage.test.tsx` — `usePoolWorkers` 파일-모킹 + sentinel/within 갱신 + 신규 그룹/배너/envNote 테스트(Task 2).

---

## Task 1: 분류 맵 + ko 신규 키(추가만)

**Files:**
- Create: `ui/src/settings/settingsEnv.ts`
- Test: `ui/src/settings/__tests__/settingsEnv.test.ts`
- Modify: `ui/src/i18n/ko.ts` (opsSettings에 신규 키 **추가만** — 기존 키 삭제 없음)

**Interfaces:**
- Produces:
  - `scopeOf(key: string): "common" | "pool"` — reaper 2종만 `"pool"`, 그 외(미매핑 포함) `"common"`.
  - `type SettingScope = "common" | "pool"`
  - `type EnvNoteKey = "workerCapacityPoolIgnored" | "poolKeepaliveAllModes"`
  - `ENV_NOTE_KEY: Record<string, EnvNoteKey>` — `worker_capacity_vus`→`"workerCapacityPoolIgnored"`, `pool_keepalive_seconds`→`"poolKeepaliveAllModes"`.
  - ko keys (Task 2가 소비): `ko.opsSettings.{groupCommon,groupPool,subMutable,subReadonly,poolGroupNote,modeActivePool,modeInactive}` (string) + `ko.opsSettings.envNote.{workerCapacityPoolIgnored,poolKeepaliveAllModes}` (string).

- [ ] **Step 1: Write the failing test** `ui/src/settings/__tests__/settingsEnv.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { scopeOf, ENV_NOTE_KEY } from "../settingsEnv";

describe("settingsEnv.scopeOf", () => {
  it("classifies is_pool_mode-gated reaper knobs as pool", () => {
    expect(scopeOf("pool_heartbeat_interval_seconds")).toBe("pool");
    expect(scopeOf("pool_stale_timeout_seconds")).toBe("pool");
  });

  it("classifies pool_keepalive_seconds as common (gRPC keepalive applies in all modes, not reaper-gated)", () => {
    expect(scopeOf("pool_keepalive_seconds")).toBe("common");
  });

  it("classifies non-pool settings as common", () => {
    expect(scopeOf("worker_capacity_vus")).toBe("common");
    expect(scopeOf("dataset_max_rows")).toBe("common");
    expect(scopeOf("scheduler_tick_seconds")).toBe("common");
    expect(scopeOf("run_startup_grace_seconds")).toBe("common");
  });

  it("falls back to common for unmapped keys (a future knob never gets a false pool badge)", () => {
    expect(scopeOf("some_future_unknown_knob")).toBe("common");
  });
});

describe("settingsEnv.ENV_NOTE_KEY", () => {
  it("maps env-divergent common settings to a note key", () => {
    expect(ENV_NOTE_KEY.worker_capacity_vus).toBe("workerCapacityPoolIgnored");
    expect(ENV_NOTE_KEY.pool_keepalive_seconds).toBe("poolKeepaliveAllModes");
  });

  it("has no note for plain common settings", () => {
    expect(ENV_NOTE_KEY.dataset_max_rows).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test settingsEnv`
Expected: FAIL — `Cannot find module "../settingsEnv"` (file not created yet).

- [ ] **Step 3: Create `ui/src/settings/settingsEnv.ts`**

```ts
// 설정 key → 배포 환경 적용 범위 분류 (UI 정적 단일 소스).
// pool scope = is_pool_mode() 게이트로 비-풀 배포에서 무효인 reaper 2종만.
// pool_keepalive_seconds는 전 모드 gRPC 서버 keepalive라 공통(spec F1).
// 미매핑 key는 "common"으로 폴백 → 새 knob이 추가돼도 거짓 "풀 전용" 배지 불가.
export type SettingScope = "common" | "pool";

const POOL_KEYS = new Set<string>([
  "pool_heartbeat_interval_seconds",
  "pool_stale_timeout_seconds",
]);

export function scopeOf(key: string): SettingScope {
  return POOL_KEYS.has(key) ? "pool" : "common";
}

// 환경별로 의미가 다른 설정 → ko.opsSettings.envNote.* 키.
export type EnvNoteKey = "workerCapacityPoolIgnored" | "poolKeepaliveAllModes";

export const ENV_NOTE_KEY: Record<string, EnvNoteKey> = {
  worker_capacity_vus: "workerCapacityPoolIgnored",
  pool_keepalive_seconds: "poolKeepaliveAllModes",
};
```

- [ ] **Step 4: Add new ko keys (do NOT delete `mutableSection`/`readonlySection` yet)**

In `ui/src/i18n/ko.ts`, inside the `opsSettings: { ... }` object, add these keys after the existing `readonlyNote` line (keep `mutableSection`/`readonlySection` for now — Task 2 deletes them once SettingsPage + tests stop referencing them):

```ts
    groupCommon: "모든 배포 공통",
    groupPool: "분산 워커 풀(LAN) 전용",
    subMutable: "조정 가능",
    subReadonly: "읽기 전용",
    poolGroupNote:
      "풀(LAN 분산 워커) 모드에서만 효과가 있습니다 — Windows 단일 exe·로컬 실행에서는 무시됩니다.",
    modeActivePool: "● 현재 풀 모드로 실행 중 — 이 그룹 설정이 적용됩니다.",
    modeInactive: "○ 현재 풀 모드가 아님 — 이 그룹 설정은 효과가 없습니다.",
    envNote: {
      workerCapacityPoolIgnored:
        "풀 모드에서는 이 값을 쓰지 않습니다 — 유휴 워커 수와 부하에 맞춰 워커 수를 정합니다.",
      poolKeepaliveAllModes:
        "풀 전용이 아닙니다 — 모든 배포의 gRPC 워커 연결에 적용되며, 특히 LAN 풀 워커의 끊긴 연결 감지·복구에 중요합니다.",
    },
```

(`ko.ts` ends the object with `} as const;` — these stay inside `opsSettings`. New keys are unused until Task 2; unused object keys are not a lint error.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm test settingsEnv`
Expected: PASS (both describe blocks green).

- [ ] **Step 6: Typecheck (the ko object is `as const` — confirm no syntax error)**

Run: `cd ui && pnpm build`
Expected: `tsc -b && vite build` succeed (no type errors).

- [ ] **Step 7: Commit**

```bash
git add ui/src/settings/settingsEnv.ts ui/src/settings/__tests__/settingsEnv.test.ts ui/src/i18n/ko.ts
git commit -m "feat(settings-env): 분류 맵 settingsEnv.ts + ko 그룹/배너/envNote 키 (Task 1)"
```

(Commit may run the UI pre-commit gate `pnpm lint && pnpm test && pnpm build` — all green from Steps 5-6.)

---

## Task 2: SettingsPage 환경 그룹 재구성 + 모드 배너 + envNote

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx`
- Modify: `ui/src/pages/__tests__/SettingsPage.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (delete `mutableSection`·`readonlySection`)

**Interfaces:**
- Consumes (Task 1): `scopeOf`, `ENV_NOTE_KEY` from `../settings/settingsEnv`; `ko.opsSettings.{groupCommon,groupPool,subMutable,subReadonly,poolGroupNote,modeActivePool,modeInactive,envNote}`.
- Consumes (existing): `usePoolWorkers` from `../api/hooks` (returns `{ isSuccess, data?: { pool_mode: boolean, workers: [...] } }`).

- [ ] **Step 1: Update the test file FIRST (pending RED diff unblocks tdd-guard)**

Make these edits to `ui/src/pages/__tests__/SettingsPage.test.tsx`:

**1a — Add a file-wide `usePoolWorkers` mock** (after the imports at the top, before `const fetchMock`). This prevents the new unconditional `usePoolWorkers()` from firing a second `fetch("/api/pool/workers")` that would disturb the one-shot `fetchMock` queue (spec R-A). Factory-spread keeps the real `useSettings`/`usePutSetting`/`useResetSetting`. Use a bare `vi.fn()` in the factory (a default-returning impl would have to satisfy the full `UseQueryResult` type — instead set the default in `beforeEach` via a casting helper):

```ts
import { usePoolWorkers } from "../../api/hooks";

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  usePoolWorkers: vi.fn(),
}));

// `usePoolWorkers` returns a full React-Query result; we only need isSuccess/data.
// `as unknown as` avoids tsc-b "conversion may be a mistake" on the partial.
function mockPool(data: { pool_mode: boolean } | null) {
  vi.mocked(usePoolWorkers).mockReturnValue(
    (data
      ? { isSuccess: true, data: { ...data, workers: [] } }
      : { isSuccess: false, data: undefined }) as unknown as ReturnType<typeof usePoolWorkers>,
  );
}
```

Set the default (unresolved → no banner) in `beforeEach` so per-test overrides don't leak:

```ts
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockPool(null);
});
```

**1b — Add a keepalive readonly fixture** (next to the other fixtures, e.g. after `READONLY_ROW`):

```ts
const KEEPALIVE_ROW = {
  key: "pool_keepalive_seconds",
  label: "풀 gRPC keepalive (서버측)",
  group: "limits",
  value: 20,
  default: 20,
  min: 0,
  max: 0,
  unit: "초",
  mutable: false,
  source: "readonly",
};
```

**1c — Replace the mount sentinel `ko.opsSettings.mutableSection` → `ko.opsSettings.groupCommon`** at every `findByText(ko.opsSettings.mutableSection)` / `screen.findByText(ko.opsSettings.mutableSection)` site. Every fixture used by those tests includes at least one common setting, so the common group always renders. Affected lines (original numbering): 84, 115, 143, 155, 174, 206, 233, 302. Example:

```ts
// before:  await screen.findByText(ko.opsSettings.mutableSection);
// after:
await screen.findByText(ko.opsSettings.groupCommon);
```

**1d — Rewrite the first test** ("renders both sections...") to assert the new group structure instead of the deleted section keys:

```ts
it("renders env groups, sub-headers, mutable desc, and readonly note", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
  renderPage();

  // env group header
  expect(await screen.findByText(ko.opsSettings.groupCommon)).toBeInTheDocument();
  // sub-section headers within the common group (SETTINGS_RESPONSE has mutable + readonly commons)
  expect(screen.getByText(ko.opsSettings.subMutable)).toBeInTheDocument();
  expect(screen.getByText(ko.opsSettings.subReadonly)).toBeInTheDocument();
  // mutable row desc is always visible
  expect(screen.getByText(ko.opsSettings.desc.worker_capacity_vus)).toBeInTheDocument();
  // readonly row shows readonlyNote
  expect(screen.getAllByText(ko.opsSettings.readonlyNote).length).toBeGreaterThan(0);
  // applyNote banner
  expect(screen.getByText(ko.opsSettings.applyNote)).toBeInTheDocument();
});
```

**1e — Add new tests** (append inside the `describe("SettingsPage", …)` block). These lock R1/R3/R4/R5/R6:

```ts
it("places reaper knobs in the pool group and common settings in the common group (R3)", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30, KEEPALIVE_ROW],
    }),
  );
  renderPage();
  await screen.findByText(ko.opsSettings.groupCommon);

  const poolRegion = screen.getByRole("region", { name: ko.opsSettings.groupPool });
  const commonRegion = screen.getByRole("region", { name: ko.opsSettings.groupCommon });

  // reaper 2종 → pool group
  expect(within(poolRegion).getByText(HEARTBEAT_INTERVAL_ROW.label)).toBeInTheDocument();
  expect(within(poolRegion).getByText(HEARTBEAT_STALE_ROW_30.label)).toBeInTheDocument();

  // worker_capacity_vus + pool_keepalive_seconds → common group (keepalive is NOT pool-only)
  expect(within(commonRegion).getByText(MUTABLE_ROW.label)).toBeInTheDocument();
  expect(within(commonRegion).getByText(KEEPALIVE_ROW.label)).toBeInTheDocument();

  // keepalive must NOT be in the pool group
  expect(within(poolRegion).queryByText(KEEPALIVE_ROW.label)).not.toBeInTheDocument();

  // R1: common group is rendered before the pool group (DOM order)
  const regions = screen.getAllByRole("region");
  expect(regions[0]).toBe(commonRegion);
  expect(regions[1]).toBe(poolRegion);
});

it("shows the pool group note (R4)", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
  );
  renderPage();
  const poolRegion = await screen.findByRole("region", { name: ko.opsSettings.groupPool });
  expect(within(poolRegion).getByText(ko.opsSettings.poolGroupNote)).toBeInTheDocument();
});

it("shows the env note on worker_capacity_vus and pool_keepalive_seconds (R6)", async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [MUTABLE_ROW, KEEPALIVE_ROW] }),
  );
  renderPage();
  await screen.findByText(ko.opsSettings.groupCommon);
  expect(screen.getByText(ko.opsSettings.envNote.workerCapacityPoolIgnored)).toBeInTheDocument();
  expect(screen.getByText(ko.opsSettings.envNote.poolKeepaliveAllModes)).toBeInTheDocument();
});

it("shows the active-pool mode banner when pool_mode is true (R5)", async () => {
  mockPool({ pool_mode: true });
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
  );
  renderPage();
  expect(await screen.findByText(ko.opsSettings.modeActivePool)).toBeInTheDocument();
  expect(screen.queryByText(ko.opsSettings.modeInactive)).not.toBeInTheDocument();
});

it("shows the inactive mode banner when pool_mode is false (R5)", async () => {
  mockPool({ pool_mode: false });
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
  );
  renderPage();
  expect(await screen.findByText(ko.opsSettings.modeInactive)).toBeInTheDocument();
  expect(screen.queryByText(ko.opsSettings.modeActivePool)).not.toBeInTheDocument();
});

it("omits the mode banner while the pool query is unresolved/errored (R5 graceful)", async () => {
  // default beforeEach mock: { isSuccess: false } → no banner
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
  );
  renderPage();
  await screen.findByText(ko.opsSettings.groupPool);
  expect(screen.queryByText(ko.opsSettings.modeActivePool)).not.toBeInTheDocument();
  expect(screen.queryByText(ko.opsSettings.modeInactive)).not.toBeInTheDocument();
});
```

Add `within` to the RTL import: `import { render, screen, waitFor, within } from "@testing-library/react";`

> Note (region role): a `<section aria-label="…">` maps to ARIA role `region`. If `getByRole("region", {name})` ever fails to resolve in this jsdom, fall back to `screen.getByText(groupPool).closest("section")!` and `within(that)`. Prefer the region query.

- [ ] **Step 2: Run the test file to confirm it fails (new tests RED, sentinel/structure changes RED)**

Run: `cd ui && pnpm test SettingsPage`
Expected: FAIL — new tests can't find groups/banners (page not yet regrouped); some existing tests fail on the sentinel/structure change.

- [ ] **Step 3: Rewrite `ui/src/pages/SettingsPage.tsx`**

Replace the file with the regrouped version. Keep `effectBlocks`, `invalid`, and the `MutableRow` component as-is **except** add the env-note line inside `MutableRow` (after the desc `<p>`), and rewrite the `SettingsPage` render. Full file:

```tsx
import { useState } from "react";
import { useSettings, usePutSetting, useResetSetting, usePoolWorkers } from "../api/hooks";
import { Button } from "../components/Button";
import { HelpTip } from "../components/HelpTip";
import { ko } from "../i18n/ko";
import type { Setting } from "../api/settings";
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../api/runStall";
import { scopeOf, ENV_NOTE_KEY } from "../settings/settingsEnv";

/** Split the effect string on \n and render each line as a block span (multiline HelpTip). */
const effectBlocks = (key: string) => {
  const effect = ko.opsSettings.effect[key as keyof typeof ko.opsSettings.effect];
  if (!effect) return null;
  return effect.split("\n").map((line, i) => (
    <span key={i} className="block">
      {line}
    </span>
  ));
};

/** Env-specific note for settings whose effect differs by deployment. */
const EnvNote = ({ settingKey }: { settingKey: string }) => {
  const noteKey = ENV_NOTE_KEY[settingKey];
  if (!noteKey) return null;
  return <p className="text-xs text-slate-500">{ko.opsSettings.envNote[noteKey]}</p>;
};

function invalid(s: Setting, draft: string): boolean {
  const n = Number(draft);
  return draft === "" || !Number.isInteger(n) || n < s.min || n > s.max;
}

function MutableRow({
  s,
  draft,
  rowError,
  onDraftChange,
  onSave,
  onReset,
  saving,
  resetting,
}: {
  s: Setting;
  draft: string;
  rowError: string | null;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
  resetting: boolean;
}) {
  const isInvalid = invalid(s, draft);
  const effectKey = s.key as keyof typeof ko.opsSettings.effect;
  const hasEffect = effectKey in ko.opsSettings.effect;
  const inputId = `setting-${s.key}`;
  const rangeHintId = `setting-range-${s.key}`;
  const outOfRangeHintId = `setting-hint-${s.key}`;

  return (
    <li className="flex flex-col gap-1 py-4 border-b border-slate-100 last:border-0">
      <div className="flex items-center gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-slate-800">
          {s.label}
        </label>
        {hasEffect && <HelpTip label={`${s.label} 도움말`}>{effectBlocks(s.key)}</HelpTip>}
        {s.source === "override" && (
          <span className="ml-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">
            변경됨
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {ko.opsSettings.desc[s.key as keyof typeof ko.opsSettings.desc]}
      </p>
      <EnvNote settingKey={s.key} />
      <div className="flex items-center gap-2 mt-1">
        <input
          id={inputId}
          type="number"
          className="w-40 rounded border border-slate-300 px-2 py-1 text-sm"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          min={s.min}
          max={s.max}
          aria-invalid={isInvalid ? true : undefined}
          aria-describedby={isInvalid ? `${rangeHintId} ${outOfRangeHintId}` : rangeHintId}
        />
        <span className="text-xs text-slate-500">{s.unit}</span>
        <Button variant="primary" onClick={onSave} disabled={isInvalid || saving || resetting}>
          {saving ? "저장 중…" : ko.opsSettings.save}
        </Button>
        {s.source === "override" && (
          <Button variant="secondary" onClick={onReset} disabled={resetting || saving}>
            {ko.opsSettings.reset}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-3 mt-0.5">
        <span id={rangeHintId} className="text-xs text-slate-400">
          {ko.opsSettings.defaultHint(s.default)} · {ko.opsSettings.rangeHint(s.min, s.max)}
        </span>
        {isInvalid && draft !== String(s.value) && (
          <span id={outOfRangeHintId} role="alert" className="text-xs text-red-600">
            {ko.opsSettings.outOfRange}
          </span>
        )}
      </div>
      {rowError && (
        <p role="alert" className="text-xs text-red-600 mt-0.5">
          {rowError}
        </p>
      )}
    </li>
  );
}

export function SettingsPage() {
  const { data: settings, isLoading, error } = useSettings();
  const putM = usePutSetting();
  const resetM = useResetSetting();
  const poolQ = usePoolWorkers();

  // Per-row draft state keyed by setting key; initialised on first render from server value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Per-row mutation error state keyed by setting key.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const getDraft = (s: Setting) => (s.key in drafts ? drafts[s.key] : String(s.value));
  const setDraft = (key: string, v: string) => setDrafts((prev) => ({ ...prev, [key]: v }));
  const clearDraft = (key: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  const setRowError = (key: string, msg: string) =>
    setRowErrors((prev) => ({ ...prev, [key]: msg }));
  const clearRowError = (key: string) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const mutable = settings?.filter((s) => s.mutable) ?? [];
  // C(클라 stall advisory) 임계값 — 단일소스 = runStall.ts. /settings엔 읽기전용 표시만.
  const clientReadonly: Setting[] = [
    {
      key: "run_midrun_stall_seconds",
      label: ko.opsSettings.runMidrunStallLabel,
      group: "limits",
      value: MIDRUN_STALL_MS / 1000,
      default: MIDRUN_STALL_MS / 1000,
      min: 0,
      max: MIDRUN_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
    {
      key: "run_startup_stall_seconds",
      label: ko.opsSettings.runStartupStallLabel,
      group: "limits",
      value: STARTUP_STALL_MS / 1000,
      default: STARTUP_STALL_MS / 1000,
      min: 0,
      max: STARTUP_STALL_MS / 1000,
      unit: "초",
      mutable: false,
      source: "readonly",
    },
  ];
  const readonly = [...(settings?.filter((s) => !s.mutable) ?? []), ...clientReadonly];

  const groupMutable = (g: "common" | "pool") => mutable.filter((s) => scopeOf(s.key) === g);
  const groupReadonly = (g: "common" | "pool") => readonly.filter((s) => scopeOf(s.key) === g);

  const renderMutableList = (rows: Setting[]) => (
    <ul className="border border-slate-200 rounded-md bg-white px-4">
      {rows.map((s) => {
        const draft = getDraft(s);
        const isSaving = putM.isPending && putM.variables?.key === s.key;
        const isResetting = resetM.isPending && resetM.variables === s.key;
        return (
          <MutableRow
            key={s.key}
            s={s}
            draft={draft}
            rowError={rowErrors[s.key] ?? null}
            onDraftChange={(v) => setDraft(s.key, v)}
            onSave={() => {
              const n = Number(draft);
              if (!invalid(s, draft)) {
                clearRowError(s.key);
                putM.mutate(
                  { key: s.key, value: n },
                  {
                    onSuccess: () => clearDraft(s.key),
                    onError: (e: Error) => setRowError(s.key, e.message),
                  },
                );
              }
            }}
            onReset={() => {
              clearRowError(s.key);
              resetM.mutate(s.key, {
                onSuccess: () => clearDraft(s.key),
                onError: (e: Error) => setRowError(s.key, e.message),
              });
            }}
            saving={isSaving}
            resetting={isResetting}
          />
        );
      })}
    </ul>
  );

  const renderReadonlyList = (rows: Setting[]) => (
    <ul className="border border-slate-200 rounded-md bg-white px-4">
      {rows.map((s) => (
        <li
          key={s.key}
          className="flex flex-col gap-1 py-4 border-b border-slate-100 last:border-0"
        >
          <span className="text-sm font-medium text-slate-800">{s.label}</span>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-mono text-slate-700">
              {s.value} {s.unit}
            </span>
            <span className="text-xs text-slate-400">{ko.opsSettings.readonlyNote}</span>
          </div>
          <EnvNote settingKey={s.key} />
        </li>
      ))}
    </ul>
  );

  // 하트비트 ping/stale 적용 안내 + 2x margin 경고 (pool 전용 — pool 그룹 안에 렌더).
  const heartbeatNote = () => {
    const find = (k: string) => settings?.find((s) => s.key === k);
    const intervalRow = find("pool_heartbeat_interval_seconds");
    const staleRow = find("pool_stale_timeout_seconds");
    if (!intervalRow || !staleRow) return null;
    const num = (s: Setting) => {
      const d = s.key in drafts ? drafts[s.key] : String(s.value);
      const n = d.trim() === "" ? NaN : Number(d);
      return Number.isInteger(n) ? n : s.value;
    };
    const interval = num(intervalRow);
    const stale = num(staleRow);
    return (
      <div className="mt-3 space-y-1">
        <p className="text-xs text-slate-500">{ko.opsSettings.heartbeatApplyNote}</p>
        {stale < 2 * interval && (
          <p className="text-xs text-amber-700">{ko.opsSettings.heartbeatMarginHint}</p>
        )}
      </div>
    );
  };

  // 현재 컨트롤러 실행 모드 배너 (graceful: 쿼리 미해결/에러면 미렌더).
  const modeBanner = () => {
    if (!poolQ.isSuccess || !poolQ.data) return null;
    const active = poolQ.data.pool_mode;
    return (
      <p
        className={`mb-3 text-sm rounded px-3 py-2 border ${
          active
            ? "text-green-800 bg-green-50 border-green-200"
            : "text-slate-600 bg-slate-50 border-slate-200"
        }`}
      >
        {active ? ko.opsSettings.modeActivePool : ko.opsSettings.modeInactive}
      </p>
    );
  };

  const subHeader = (text: string) => (
    <h4 className="text-sm font-semibold text-slate-600 mb-2 mt-4 first:mt-0">{text}</h4>
  );

  const commonMutable = groupMutable("common");
  const commonReadonly = groupReadonly("common");
  const poolMutable = groupMutable("pool");
  const poolReadonly = groupReadonly("pool");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.opsSettings.title}</h2>
      </div>

      {/* apply-note banner */}
      <p className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        {ko.opsSettings.applyNote}
      </p>

      {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
      {error && (
        <p role="alert" className="text-red-600">
          불러오기 실패: {(error as Error).message}
        </p>
      )}

      {settings && (
        <>
          {/* 모든 배포 공통 */}
          {(commonMutable.length > 0 || commonReadonly.length > 0) && (
            <section aria-label={ko.opsSettings.groupCommon} className="mb-8">
              <h3 className="text-md font-semibold text-slate-700 mb-3">
                {ko.opsSettings.groupCommon}
              </h3>
              {commonMutable.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subMutable)}
                  {renderMutableList(commonMutable)}
                </>
              )}
              {commonReadonly.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subReadonly)}
                  {renderReadonlyList(commonReadonly)}
                </>
              )}
            </section>
          )}

          {/* 분산 워커 풀(LAN) 전용 */}
          {(poolMutable.length > 0 || poolReadonly.length > 0) && (
            <section aria-label={ko.opsSettings.groupPool} className="mb-8">
              <h3 className="text-md font-semibold text-slate-700 mb-1">
                {ko.opsSettings.groupPool}
              </h3>
              <p className="text-xs text-slate-500 mb-2">{ko.opsSettings.poolGroupNote}</p>
              {modeBanner()}
              {poolMutable.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subMutable)}
                  {renderMutableList(poolMutable)}
                  {heartbeatNote()}
                </>
              )}
              {poolReadonly.length > 0 && (
                <>
                  {subHeader(ko.opsSettings.subReadonly)}
                  {renderReadonlyList(poolReadonly)}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Delete the orphaned ko keys**

In `ui/src/i18n/ko.ts`, remove these two lines from `opsSettings` (now unreferenced — SettingsPage uses `groupCommon`/`subMutable`/etc., tests use `groupCommon`):

```ts
    mutableSection: "조정 가능한 운영 상한",
    readonlySection: "배포 설정 (읽기 전용)",
```

- [ ] **Step 5: Run the SettingsPage test file to verify it passes**

Run: `cd ui && pnpm test SettingsPage`
Expected: PASS (all existing + new tests). If `getByRole("region", …)` fails, apply the closest-section fallback noted in Step 1e.

- [ ] **Step 6: Full UI gate**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 warnings, all tests pass, `tsc -b && vite build` succeed.

- [ ] **Step 7: Confirm orphan keys are gone and backend/wire 0-diff**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/settings-env-grouping
grep -rn "mutableSection\|readonlySection" ui/src    # expect 0 (orphan keys gone)
git diff --stat -- crates proto 'ui/src/api/settings.ts' 'ui/src/api/schemas.ts' '**/*.sql'   # expect empty
```
Expected: grep returns nothing; git diff --stat shows no changes to those paths.

R7 new-inline-string check: the SettingsPage rewrite introduces **no new** inline user-facing literals — every new string goes through `ko.opsSettings.*`. The only inline Korean literals in `SettingsPage.tsx` are pre-existing and R9-preserved: `불러오기 실패:` (load-error prefix), `변경됨` (override badge), `저장 중…` (saving label). Confirm no *additional* bare Korean/English string was added in the JSX (visual scan of the diff + `git diff ui/src/pages/SettingsPage.tsx`); these three are intentionally retained (out of this slice's scope).

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx ui/src/pages/__tests__/SettingsPage.test.tsx ui/src/i18n/ko.ts
git commit -m "feat(settings-env): SettingsPage 환경 그룹 재구성 + 모드 배너 + envNote (Task 2)"
```

---

## Done-criteria (post-implementation, orchestrator)

- **handicap-reviewer** APPROVE (UI-only·wire 0-diff 1:1 대조·repo-trap). 1M 세션이면 `model: opus` 명시.
- **security-reviewer**: path-gate(요청실행/템플릿/env·dataset 바인딩/업로드/trace) 무매치 → **N/A**.
- **라이브 검증**: run-생성/리포트-파싱/엔진 경로 무관·`pool_mode`는 기존 스키마 재사용(신규 응답파싱 0=S-D 갭 부재) → 필수 아님. 시각 슬라이스라 Playwright 헤드리스 sanity 1회 권장(컨트롤러 띄워 `/settings`: ① 두 그룹 렌더·reaper 2종 풀 그룹·keepalive 공통 그룹 ② pool 모드 vs 비-pool 배너 분기 ③ console Zod 0). 생략 시 build-log에 근거.
- **finish-slice**: build-log·roadmap shortlist 갱신·CLAUDE 상태줄·메모리 → ff-merge.

---

<!-- spec-plan-reviewer(Opus): spec 2-round clean APPROVE + plan clean APPROVE (F1/F2 folded). -->
REVIEW-GATE: APPROVED
