# Run 목록 필터/정렬 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오 run 목록(`ScenarioRunsPage`)을 결과·상태·부하모드·날짜로 거르고 다중키 명시-우선순위로 정렬하며, 상태를 URL 쿼리파라미터에 보관한다.

**Architecture:** 순수 클라이언트 UI-only. run 목록은 이미 전량 클라 로드(`useScenarioRuns`)이므로 메모리 배열에 대한 순수 필터/정렬만 한다. 순수 로직은 `ui/src/runs/runFilterSort.ts`(필터 술어·다중키 comparator·정렬값 도출·URL parse/serialize)로 분리해 단위 테스트하고, 프레젠테이셔널 toolbar(`RunListControls`)가 controlled로 그것을 노출하며, `ScenarioRunsPage`가 URL ↔ 상태를 배선한다. controller/store/proto/migration/엔진 **0-diff**.

**Tech Stack:** TypeScript · React · react-router-dom `useSearchParams` · vitest + @testing-library/react. 신규 의존성 0.

**spec:** `docs/superpowers/specs/2026-06-25-run-list-filter-sort-design.md` (spec-plan-reviewer clean APPROVE). 모든 task는 그 R-id를 참조.

## Global Constraints

- **UI-only**: `ui/` 외 파일 무변경(controller/store/proto/migration/engine 0-diff). 머지 diff = `ui/`(+docs).
- **신규 사용자 노출 문구는 전부 `ko.ts` 경유**(ADR-0035) — 라벨·옵션·`aria-label`·`title`·빈상태 포함. 인라인 영어/한국어 금지(R17).
- **기본 URL(파라미터 0) = byte-identical**: 필터 빈·정렬 `[created desc]`이면 목록 행·순서·비교 흐름이 슬라이스 전과 동일. 기존 *행/셀/비교* 테스트는 무수정 통과(R18).
- **`Pick<>` leak-free 헬퍼 재사용**: `deriveLoadMode`(`components/loadModel.ts`)·`profileDurationSeconds`(`api/runPrefill.ts`)를 재사용해 모드/Duration/VU 정렬값 도출(`normalizeProfile` 재파싱 없이 `Run.profile` 수용). `profileVuDisplay().peak`는 **읽지 않는다**(빈 곡선 `Math.max(...[])=-Infinity` 회피, FR1).
- **tdd-guard**(ui/CLAUDE.md): `ui/src/**` non-test 편집 전 pending test 파일 필요 → **각 task는 테스트 파일을 먼저(RED) 작성**한 뒤 src. test-path 파일(`__tests__/*.test.tsx`)은 항상 허용.
- **빌드 게이트**: `pnpm test`(esbuild)는 TS strict를 못 잡으니 commit 전 `pnpm lint && pnpm test && pnpm build` 셋 다. `pnpm lint`는 `--max-warnings=0`(exhaustive-deps 누락 잡힘).
- **Zod 누출**: `Run.profile`은 nested-default 누출(`number|undefined`)이라 `Pick<>` 헬퍼로만 읽고, 정렬값 헬퍼는 leak-free 필드만 Pick.

---

## File Structure

- **Create** `ui/src/runs/runFilterSort.ts` — 순수 로직(타입·필터·정렬·정렬값 도출·URL parse/serialize·헤더 승격). 단일 소스(R19).
- **Create** `ui/src/runs/__tests__/runFilterSort.test.ts` — 순수 로직 단위 테스트. **⚠ vitest `include`는 `src/**/__tests__/**`만** — 반드시 `__tests__/` 아래(ui/CLAUDE.md).
- **Create** `ui/src/components/RunListControls.tsx` — controlled 프레젠테이셔널 toolbar(필터 4 + 정렬 빌더 + 카운트/초기화).
- **Create** `ui/src/components/__tests__/RunListControls.test.tsx` — toolbar RTL.
- **Modify** `ui/src/i18n/ko.ts` — `runFilter`/`runSort` 네임스페이스 신설(R17).
- **Modify** `ui/src/pages/ScenarioRunsPage.tsx` — URL ↔ 필터/정렬 배선, 가시 행, 헤더 클릭 정렬, 전용 빈상태.
- **Modify** `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` — 필터/정렬/헤더/빈상태/선택독립 RTL 추가(기존 케이스 무수정).

---

## Task 1: 순수 모듈 `runFilterSort.ts` + 단위 테스트

**충족 R**: R1–R11, R13, R19.

**Files:**
- Create: `ui/src/runs/runFilterSort.ts`
- Test: `ui/src/runs/__tests__/runFilterSort.test.ts`

**Interfaces (Produces — 후속 task가 의존):**
```ts
export type VerdictKey = "pass" | "fail" | "none";
export type ModeKey = "closed_fixed" | "closed_curve" | "open_fixed" | "open_curve";
export type StatusKey = "pending" | "running" | "completed" | "failed" | "aborted";
export type DatePreset = "all" | "today" | "7d" | "30d";
export type SortField = "created" | "duration" | "vu" | "verdict" | "status";
export type SortDir = "asc" | "desc";
export type SortKey = { field: SortField; dir: SortDir };
export type RunFilter = {
  verdicts: VerdictKey[]; statuses: StatusKey[]; modes: ModeKey[];
  datePreset: DatePreset; dateFrom: string | null; dateTo: string | null;
};
export const EMPTY_FILTER: RunFilter;
export const DEFAULT_SORT: SortKey[];               // [{field:"created",dir:"desc"}]
export const VERDICT_KEYS: VerdictKey[]; export const STATUS_KEYS: StatusKey[];
export const MODE_KEYS: ModeKey[]; export const DATE_PRESETS: DatePreset[];
export const SORT_FIELDS: SortField[];
export function filterRuns(runs: Run[], f: RunFilter, now: number): Run[];
export function sortRuns(runs: Run[], keys: SortKey[]): Run[];
export function promoteSort(keys: SortKey[], field: SortField): SortKey[];
export function parseRunControls(sp: URLSearchParams): { filter: RunFilter; sort: SortKey[] };
export function serializeRunControls(filter: RunFilter, sort: SortKey[]): URLSearchParams;
export function hasActiveControls(filter: RunFilter, sort: SortKey[]): boolean;
export function verdictKey(v: Verdict | null | undefined): VerdictKey;
export function modeKey(p: Pick<Profile, "target_rps" | "stages" | "vu_stages">): ModeKey;
```

- [ ] **Step 1: Write the failing test**

Create `ui/src/runs/__tests__/runFilterSort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Run } from "../../api/schemas";
import {
  EMPTY_FILTER,
  DEFAULT_SORT,
  filterRuns,
  sortRuns,
  promoteSort,
  parseRunControls,
  serializeRunControls,
  hasActiveControls,
  verdictKey,
  modeKey,
  type RunFilter,
  type SortKey,
} from "../runFilterSort";

// 최소 Run fixture. profile은 모드별로 다르게 준다.
function mkRun(over: Partial<Run> & { id: string }): Run {
  return {
    id: over.id,
    scenario_id: "S1",
    scenario_yaml: "",
    status: "completed",
    profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 0, loop_breakdown_cap: 256,
      http_timeout_seconds: 30, measure_phases: false },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 0,
    verdict: null,
    last_metric_ts: null,
    ...over,
  } as Run;
}
const closedFixed = (vus: number) => ({ vus, ramp_up_seconds: 0, duration_seconds: 60,
  loop_breakdown_cap: 256, http_timeout_seconds: 30, measure_phases: false });
const closedCurve = (peak: number) => ({ vus: 0, ramp_up_seconds: 0, duration_seconds: 0,
  loop_breakdown_cap: 256, http_timeout_seconds: 30, measure_phases: false,
  vu_stages: [{ target: 1, duration_seconds: 10 }, { target: peak, duration_seconds: 10 }] });
const openFixed = (rps: number) => ({ vus: 0, ramp_up_seconds: 0, duration_seconds: 60,
  loop_breakdown_cap: 256, http_timeout_seconds: 30, measure_phases: false, target_rps: rps,
  max_in_flight: 100 });

const PASS = { passed: true, criteria: [] };
const FAIL = { passed: false, criteria: [{ metric: "p95_ms", direction: "max" as const,
  threshold: 1, actual: 9, passed: false }] };

describe("verdictKey / modeKey", () => {
  it("verdictKey maps null→none, passed→pass, else fail", () => {
    expect(verdictKey(null)).toBe("none");
    expect(verdictKey(undefined)).toBe("none");
    expect(verdictKey(PASS)).toBe("pass");
    expect(verdictKey(FAIL)).toBe("fail");
  });
  it("modeKey covers 4 modes", () => {
    expect(modeKey(closedFixed(5))).toBe("closed_fixed");
    expect(modeKey(closedCurve(50))).toBe("closed_curve");
    expect(modeKey(openFixed(100))).toBe("open_fixed");
    expect(modeKey({ vus: 0, ramp_up_seconds: 0, duration_seconds: 0, loop_breakdown_cap: 256,
      http_timeout_seconds: 30, measure_phases: false,
      stages: [{ target: 10, duration_seconds: 5 }] } as never)).toBe("open_curve");
  });
});

describe("filterRuns (R1–R5)", () => {
  const runs = [
    mkRun({ id: "a", verdict: PASS, status: "completed", profile: closedFixed(5), created_at: 1000 }),
    mkRun({ id: "b", verdict: FAIL, status: "failed", profile: openFixed(100), created_at: 2000 }),
    mkRun({ id: "c", verdict: null, status: "running", profile: closedCurve(50), created_at: 3000 }),
    mkRun({ id: "d", verdict: null, status: "pending", profile: closedFixed(8), created_at: 4000 }),
  ];
  const now = 10_000;
  it("empty filter passes all (R5)", () => {
    expect(filterRuns(runs, EMPTY_FILTER, now).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("verdict OR within dimension (R1)", () => {
    const f: RunFilter = { ...EMPTY_FILTER, verdicts: ["fail", "none"] };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["b", "c", "d"]);
  });
  it("status includes pending (R2)", () => {
    const f: RunFilter = { ...EMPTY_FILTER, statuses: ["pending"] };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["d"]);
  });
  it("mode filter via deriveLoadMode (R3)", () => {
    const f: RunFilter = { ...EMPTY_FILTER, modes: ["closed_curve"] };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["c"]);
  });
  it("AND across dimensions (R5)", () => {
    const f: RunFilter = { ...EMPTY_FILTER, verdicts: ["none"], statuses: ["running"] };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("filterRuns date (R4)", () => {
  const day = 86_400_000;
  const now = 100 * day; // 충분히 큰 기준
  const runs = [
    mkRun({ id: "old", created_at: now - 8 * day }),
    mkRun({ id: "recent", created_at: now - 1 * day }),
  ];
  it("preset 7d excludes >7일 (rolling)", () => {
    const f: RunFilter = { ...EMPTY_FILTER, datePreset: "7d" };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["recent"]);
  });
  it("custom from/to inclusive local-day, overrides preset", () => {
    // recent의 로컬 날짜로 from/to를 만들어 그 하루만 포함
    const d = new Date(now - 1 * day);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const f: RunFilter = { ...EMPTY_FILTER, datePreset: "30d", dateFrom: ymd, dateTo: ymd };
    expect(filterRuns(runs, f, now).map((r) => r.id)).toEqual(["recent"]);
  });
});

describe("sortRuns (R6–R11)", () => {
  it("no keys → default created desc (R8)", () => {
    const runs = [mkRun({ id: "a", created_at: 1 }), mkRun({ id: "b", created_at: 3 }),
      mkRun({ id: "c", created_at: 2 })];
    expect(sortRuns(runs, []).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("multi-key [verdict asc, created desc] keeps priority order (R6, R11)", () => {
    const runs = [
      mkRun({ id: "p1", verdict: PASS, created_at: 1 }),
      mkRun({ id: "f1", verdict: FAIL, created_at: 2 }),
      mkRun({ id: "f2", verdict: FAIL, created_at: 5 }),
      mkRun({ id: "n1", verdict: null, created_at: 9 }),
    ];
    const keys: SortKey[] = [{ field: "verdict", dir: "asc" }, { field: "created", dir: "desc" }];
    // fail(rank0) first, within fail newest-first(5>2), then pass, then none
    expect(sortRuns(runs, keys).map((r) => r.id)).toEqual(["f2", "f1", "p1", "n1"]);
  });
  it("vu nulls-last regardless of dir (R10)", () => {
    const runs = [
      mkRun({ id: "open", profile: openFixed(100) }),
      mkRun({ id: "c5", profile: closedFixed(5) }),
      mkRun({ id: "c8", profile: closedFixed(8) }),
    ];
    expect(sortRuns(runs, [{ field: "vu", dir: "asc" }]).map((r) => r.id)).toEqual(["c5", "c8", "open"]);
    expect(sortRuns(runs, [{ field: "vu", dir: "desc" }]).map((r) => r.id)).toEqual(["c8", "c5", "open"]);
  });
  it("vu sort: closed+curve uses peak (R10)", () => {
    const runs = [mkRun({ id: "c50", profile: closedCurve(50) }), mkRun({ id: "c5", profile: closedFixed(5) })];
    expect(sortRuns(runs, [{ field: "vu", dir: "desc" }]).map((r) => r.id)).toEqual(["c50", "c5"]);
  });
  it("status rank running<pending<failed<aborted<completed (R11)", () => {
    const runs = [
      mkRun({ id: "comp", status: "completed", created_at: 1 }),
      mkRun({ id: "run", status: "running", created_at: 1 }),
      mkRun({ id: "pend", status: "pending", created_at: 1 }),
    ];
    expect(sortRuns(runs, [{ field: "status", dir: "asc" }]).map((r) => r.id)).toEqual(["run", "pend", "comp"]);
  });
  it("tiebreaker created desc → id when all keys tie (R9)", () => {
    const runs = [
      mkRun({ id: "z", verdict: PASS, created_at: 5 }),
      mkRun({ id: "a", verdict: PASS, created_at: 5 }),
    ];
    // verdict ties, created ties → id asc (a<z)
    expect(sortRuns(runs, [{ field: "verdict", dir: "asc" }]).map((r) => r.id)).toEqual(["a", "z"]);
  });
});

describe("promoteSort (R12)", () => {
  it("prepends a new field with default dir, dedup", () => {
    const keys: SortKey[] = [{ field: "created", dir: "desc" }];
    expect(promoteSort(keys, "verdict")).toEqual([{ field: "verdict", dir: "asc" }, { field: "created", dir: "desc" }]);
  });
  it("moves an existing non-primary field to front (no dup)", () => {
    const keys: SortKey[] = [{ field: "created", dir: "desc" }, { field: "verdict", dir: "asc" }];
    expect(promoteSort(keys, "verdict")).toEqual([{ field: "verdict", dir: "asc" }, { field: "created", dir: "desc" }]);
  });
  it("toggles dir when already primary", () => {
    const keys: SortKey[] = [{ field: "created", dir: "desc" }];
    expect(promoteSort(keys, "created")).toEqual([{ field: "created", dir: "asc" }]);
  });
});

describe("parse/serialize round-trip (R13)", () => {
  it("default round-trips to empty params", () => {
    const sp = serializeRunControls(EMPTY_FILTER, DEFAULT_SORT);
    expect(sp.toString()).toBe("");
    const back = parseRunControls(sp);
    expect(back.filter).toEqual(EMPTY_FILTER);
    expect(back.sort).toEqual([]); // empty → caller uses DEFAULT_SORT
  });
  it("round-trips a full filter+sort", () => {
    const f: RunFilter = { verdicts: ["fail"], statuses: ["running", "pending"], modes: ["closed_curve"],
      datePreset: "all", dateFrom: "2026-06-01", dateTo: "2026-06-25" };
    const keys: SortKey[] = [{ field: "verdict", dir: "asc" }, { field: "created", dir: "desc" }];
    const back = parseRunControls(serializeRunControls(f, keys));
    expect(back.filter).toEqual(f);
    expect(back.sort).toEqual(keys);
  });
  it("ignores unknown tokens (robust)", () => {
    const sp = new URLSearchParams("status=bogus,running&verdict=xx&mode=nope&sort=zzz:asc,created:up");
    const back = parseRunControls(sp);
    expect(back.filter.statuses).toEqual(["running"]);
    expect(back.filter.verdicts).toEqual([]);
    expect(back.filter.modes).toEqual([]);
    expect(back.sort).toEqual([]); // both sort tokens invalid
  });
  it("custom date overrides preset in serialization", () => {
    const f: RunFilter = { ...EMPTY_FILTER, datePreset: "7d", dateFrom: "2026-06-01", dateTo: null };
    const sp = serializeRunControls(f, DEFAULT_SORT);
    expect(sp.get("from")).toBe("2026-06-01");
    expect(sp.get("date")).toBeNull();
  });
});

describe("hasActiveControls (R14)", () => {
  it("false for defaults", () => {
    expect(hasActiveControls(EMPTY_FILTER, DEFAULT_SORT)).toBe(false);
    expect(hasActiveControls(EMPTY_FILTER, [])).toBe(false);
  });
  it("true when any filter or non-default sort", () => {
    expect(hasActiveControls({ ...EMPTY_FILTER, statuses: ["running"] }, DEFAULT_SORT)).toBe(true);
    expect(hasActiveControls(EMPTY_FILTER, [{ field: "verdict", dir: "asc" }])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test runFilterSort`
Expected: FAIL — `Cannot find module '../runFilterSort'`.

- [ ] **Step 3: Write the module**

Create `ui/src/runs/runFilterSort.ts`:

```ts
import type { Profile, Run, Verdict } from "../api/schemas";
import { deriveLoadMode } from "../components/loadModel";
import { profileDurationSeconds } from "../api/runPrefill";

export type VerdictKey = "pass" | "fail" | "none";
export type ModeKey = "closed_fixed" | "closed_curve" | "open_fixed" | "open_curve";
export type StatusKey = "pending" | "running" | "completed" | "failed" | "aborted";
export type DatePreset = "all" | "today" | "7d" | "30d";
export type SortField = "created" | "duration" | "vu" | "verdict" | "status";
export type SortDir = "asc" | "desc";
export type SortKey = { field: SortField; dir: SortDir };

export type RunFilter = {
  verdicts: VerdictKey[]; // 빈 = 전체
  statuses: StatusKey[];
  modes: ModeKey[];
  datePreset: DatePreset; // "all" 기본
  dateFrom: string | null; // YYYY-MM-DD
  dateTo: string | null;
};

export const VERDICT_KEYS: VerdictKey[] = ["pass", "fail", "none"];
export const STATUS_KEYS: StatusKey[] = ["pending", "running", "completed", "failed", "aborted"];
export const MODE_KEYS: ModeKey[] = ["closed_fixed", "closed_curve", "open_fixed", "open_curve"];
export const DATE_PRESETS: DatePreset[] = ["all", "today", "7d", "30d"];
export const SORT_FIELDS: SortField[] = ["created", "duration", "vu", "verdict", "status"];

export const EMPTY_FILTER: RunFilter = {
  verdicts: [], statuses: [], modes: [], datePreset: "all", dateFrom: null, dateTo: null,
};
export const DEFAULT_SORT: SortKey[] = [{ field: "created", dir: "desc" }];

// 헤더 클릭 시 새 1차 키의 기본 방향 (R12): 크기/시간은 큰 것 먼저(desc), 랭크는 asc.
const DEFAULT_DIR: Record<SortField, SortDir> = {
  created: "desc", duration: "desc", vu: "desc", verdict: "asc", status: "asc",
};
// 서수 랭크 (R11). asc 기준 — 작은 rank가 먼저.
const VERDICT_RANK: Record<VerdictKey, number> = { fail: 0, pass: 1, none: 2 };
const STATUS_RANK: Record<StatusKey, number> = {
  running: 0, pending: 1, failed: 2, aborted: 3, completed: 4,
};

export function verdictKey(v: Verdict | null | undefined): VerdictKey {
  if (v == null) return "none";
  return v.passed ? "pass" : "fail";
}

export function modeKey(p: Pick<Profile, "target_rps" | "stages" | "vu_stages">): ModeKey {
  const { loadModel, rateMode } = deriveLoadMode(p);
  return `${loadModel}_${rateMode}` as ModeKey;
}

/** VU/peak 정렬값 — 닫힌+고정=vus, 닫힌+곡선=max(vu_stages.target), 열린루프=null(nulls-last). R10.
 *  deriveLoadMode로 분기해 도출 — profileVuDisplay().peak를 읽지 않아 빈 곡선 -Infinity 회피(FR1). */
function vuSortValue(p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">): number | null {
  const { loadModel, rateMode } = deriveLoadMode(p);
  if (loadModel === "open") return null;
  if (rateMode === "curve") return Math.max(...(p.vu_stages ?? []).map((s) => s.target));
  return p.vus;
}

// ── 날짜 경계 (R4) ──────────────────────────────────────────────────────────
const DAY = 86_400_000;
function localDayStart(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
function localDayEnd(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}
function startOfDayMs(ms: number): number {
  const dt = new Date(ms);
  dt.setHours(0, 0, 0, 0);
  return dt.getTime();
}
/** [from, to] (ms, inclusive). null = 무경계. custom(from|to) 있으면 프리셋 무시(R4). */
function dateBounds(f: RunFilter, now: number): [number | null, number | null] {
  if (f.dateFrom || f.dateTo) {
    return [f.dateFrom ? localDayStart(f.dateFrom) : null, f.dateTo ? localDayEnd(f.dateTo) : null];
  }
  switch (f.datePreset) {
    case "today": return [startOfDayMs(now), null];
    case "7d": return [now - 7 * DAY, null];
    case "30d": return [now - 30 * DAY, null];
    default: return [null, null]; // all
  }
}

export function filterRuns(runs: Run[], f: RunFilter, now: number): Run[] {
  const [from, to] = dateBounds(f, now);
  return runs.filter((r) => {
    if (f.verdicts.length && !f.verdicts.includes(verdictKey(r.verdict))) return false;
    if (f.statuses.length && !f.statuses.includes(r.status as StatusKey)) return false;
    if (f.modes.length && !f.modes.includes(modeKey(r.profile))) return false;
    if (from != null && r.created_at < from) return false;
    if (to != null && r.created_at > to) return false;
    return true;
  });
}

// ── 정렬 (R6–R11) ───────────────────────────────────────────────────────────
function compareKey(a: Run, b: Run, k: SortKey): number {
  const sign = k.dir === "asc" ? 1 : -1;
  switch (k.field) {
    case "created":
      return sign * (a.created_at - b.created_at);
    case "duration":
      return sign * (profileDurationSeconds(a.profile) - profileDurationSeconds(b.profile));
    case "vu": {
      const va = vuSortValue(a.profile);
      const vb = vuSortValue(b.profile);
      if (va == null && vb == null) return 0; // 둘 다 null → 다음 키/tiebreaker
      if (va == null) return 1; // nulls-last (방향 무관)
      if (vb == null) return -1;
      return sign * (va - vb);
    }
    case "verdict":
      return sign * (VERDICT_RANK[verdictKey(a.verdict)] - VERDICT_RANK[verdictKey(b.verdict)]);
    case "status":
      return sign * (STATUS_RANK[a.status as StatusKey] - STATUS_RANK[b.status as StatusKey]);
  }
}

export function sortRuns(runs: Run[], keys: SortKey[]): Run[] {
  const effective = keys.length ? keys : DEFAULT_SORT;
  return [...runs].sort((a, b) => {
    for (const k of effective) {
      const c = compareKey(a, b, k);
      if (c !== 0) return c;
    }
    // 안정 tiebreaker: created desc → id (R9)
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 헤더 클릭: field를 1차로 승격(있으면 이동·없으면 prepend·필드 dedup·이미 1차면 방향 토글). R12. */
export function promoteSort(keys: SortKey[], field: SortField): SortKey[] {
  const existing = keys.find((k) => k.field === field);
  if (keys[0]?.field === field) {
    const toggled: SortKey = { field, dir: keys[0].dir === "asc" ? "desc" : "asc" };
    return [toggled, ...keys.slice(1)];
  }
  const rest = keys.filter((k) => k.field !== field);
  return [{ field, dir: existing?.dir ?? DEFAULT_DIR[field] }, ...rest];
}

// ── URL parse / serialize (R13) ─────────────────────────────────────────────
function parseCsv<T extends string>(value: string | null, allowed: readonly T[]): T[] {
  if (!value) return [];
  const seen = new Set<T>();
  for (const tok of value.split(",")) {
    const t = tok.trim() as T;
    if (allowed.includes(t)) seen.add(t);
  }
  return [...seen];
}
function parseDateParam(v: string | null): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function parseSort(value: string | null): SortKey[] {
  if (!value) return [];
  const out: SortKey[] = [];
  const seen = new Set<SortField>();
  for (const tok of value.split(",")) {
    const [f, d] = tok.split(":");
    if (SORT_FIELDS.includes(f as SortField) && (d === "asc" || d === "desc") && !seen.has(f as SortField)) {
      seen.add(f as SortField);
      out.push({ field: f as SortField, dir: d });
    }
  }
  return out;
}
function isDefaultSort(sort: SortKey[]): boolean {
  return sort.length === 0 || (sort.length === 1 && sort[0].field === "created" && sort[0].dir === "desc");
}

export function parseRunControls(sp: URLSearchParams): { filter: RunFilter; sort: SortKey[] } {
  const dateRaw = sp.get("date");
  const datePreset: DatePreset = DATE_PRESETS.includes(dateRaw as DatePreset)
    ? (dateRaw as DatePreset)
    : "all";
  return {
    filter: {
      verdicts: parseCsv(sp.get("verdict"), VERDICT_KEYS),
      statuses: parseCsv(sp.get("status"), STATUS_KEYS),
      modes: parseCsv(sp.get("mode"), MODE_KEYS),
      datePreset,
      dateFrom: parseDateParam(sp.get("from")),
      dateTo: parseDateParam(sp.get("to")),
    },
    sort: parseSort(sp.get("sort")),
  };
}

export function serializeRunControls(filter: RunFilter, sort: SortKey[]): URLSearchParams {
  const sp = new URLSearchParams();
  if (filter.verdicts.length) sp.set("verdict", filter.verdicts.join(","));
  if (filter.statuses.length) sp.set("status", filter.statuses.join(","));
  if (filter.modes.length) sp.set("mode", filter.modes.join(","));
  if (filter.dateFrom || filter.dateTo) {
    if (filter.dateFrom) sp.set("from", filter.dateFrom);
    if (filter.dateTo) sp.set("to", filter.dateTo);
  } else if (filter.datePreset !== "all") {
    sp.set("date", filter.datePreset);
  }
  if (!isDefaultSort(sort)) sp.set("sort", sort.map((k) => `${k.field}:${k.dir}`).join(","));
  return sp;
}

export function hasActiveControls(filter: RunFilter, sort: SortKey[]): boolean {
  return (
    filter.verdicts.length > 0 ||
    filter.statuses.length > 0 ||
    filter.modes.length > 0 ||
    filter.datePreset !== "all" ||
    !!filter.dateFrom ||
    !!filter.dateTo ||
    !isDefaultSort(sort)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test runFilterSort`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Lint + typecheck**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 0 errors/warnings. (`pnpm build`가 `tsc -b`로 `as never` 외 타입 누출을 잡는다.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/runs/runFilterSort.ts ui/src/runs/__tests__/runFilterSort.test.ts
git commit -m "feat(ui): run 목록 필터/정렬 순수 모듈 runFilterSort.ts (R1-R11,R13,R19)"
```

---

## Task 2: `ko.ts` 문구 + `RunListControls` toolbar + RTL

**충족 R**: R1–R4, R6, R12(빌더 측), R14, R17.

**Files:**
- Modify: `ui/src/i18n/ko.ts` (신규 `runFilter`/`runSort` 네임스페이스)
- Create: `ui/src/components/RunListControls.tsx`
- Create: `ui/src/components/__tests__/RunListControls.test.tsx`

**Interfaces:**
- Consumes (Task 1): `RunFilter`, `SortKey`, `SortField`, `VerdictKey`, `StatusKey`, `ModeKey`, `DatePreset`, `VERDICT_KEYS`, `STATUS_KEYS`, `MODE_KEYS`, `DATE_PRESETS`, `SORT_FIELDS`, `EMPTY_FILTER`, `DEFAULT_SORT`, `hasActiveControls`.
- Produces:
```ts
// 구현은 `Props` 타입 별칭 사용 + 명시 반환타입 없음(repo 컨벤션 — `JSX.Element` 미사용, React-jsx runtime).
export function RunListControls(props: {
  filter: RunFilter; sort: SortKey[];
  total: number; shown: number;
  onChange: (next: { filter: RunFilter; sort: SortKey[] }) => void;
}); // toolbar 요소 반환
```

> **⚠ tdd-guard 순서(ui/CLAUDE.md)**: `ko.ts`·컴포넌트(src) 편집 전 pending test 파일이 있어야 한다 → **Step 1에서 테스트 파일을 먼저** 작성(import 미해결로 RED여도 무방 — tdd-guard는 test-path 파일 존재만 본다). 그 뒤 ko·컴포넌트.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/__tests__/RunListControls.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunListControls } from "../RunListControls";
import { EMPTY_FILTER, DEFAULT_SORT, type RunFilter, type SortKey } from "../../runs/runFilterSort";
import { ko } from "../../i18n/ko";

function setup(filter: RunFilter = EMPTY_FILTER, sort: SortKey[] = DEFAULT_SORT) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<RunListControls filter={filter} sort={sort} total={10} shown={4} onChange={onChange} />);
  return { onChange, user };
}

describe("RunListControls — filters", () => {
  it("toggling a verdict filter emits OR membership (R1)", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: ko.runFilter.verdictFail, pressed: false }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ verdicts: ["fail"] }) }),
    );
  });

  it("status filter exposes all 5 incl. pending (R2)", () => {
    setup();
    for (const label of [ko.runFilter.statusPending, ko.runFilter.statusRunning,
      ko.runFilter.statusCompleted, ko.runFilter.statusFailed, ko.runFilter.statusAborted]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("date preset select emits datePreset (R4)", async () => {
    const { onChange, user } = setup();
    await user.selectOptions(screen.getByLabelText(ko.runFilter.dateLabel), "7d");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ datePreset: "7d" }) }),
    );
  });

  it("count + reset show when active (R14)", async () => {
    const { onChange, user } = setup({ ...EMPTY_FILTER, statuses: ["running"] }, DEFAULT_SORT);
    expect(screen.getByText(ko.runFilter.count(4, 10))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.runFilter.reset }));
    expect(onChange).toHaveBeenCalledWith({ filter: EMPTY_FILTER, sort: DEFAULT_SORT });
  });

  it("no count/reset when defaults", () => {
    setup(EMPTY_FILTER, DEFAULT_SORT);
    expect(screen.queryByRole("button", { name: ko.runFilter.reset })).not.toBeInTheDocument();
  });
});

describe("RunListControls — sort builder (R6, R12)", () => {
  it("adds a sort key for the first unused field", async () => {
    const { onChange, user } = setup(EMPTY_FILTER, DEFAULT_SORT);
    // 버튼 텍스트는 "+ 정렬 추가"(컴포넌트가 "+ " 접두) → 정확매치 대신 regex(ui/CLAUDE.md 다중매치 함정과 별개·exact name 실패 회피)
    await user.click(screen.getByRole("button", { name: /정렬 추가/ }));
    // created already used → next add picks first unused (duration)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [{ field: "created", dir: "desc" }, { field: "duration", dir: "desc" }],
      }),
    );
  });

  it("removes a sort key", async () => {
    const sort: SortKey[] = [{ field: "created", dir: "desc" }, { field: "verdict", dir: "asc" }];
    const { onChange, user } = setup(EMPTY_FILTER, sort);
    await user.click(screen.getByRole("button", { name: ko.runSort.removeKeyAria(ko.runSort.fieldVerdict) }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ field: "created", dir: "desc" }] }),
    );
  });

  it("toggles a key direction", async () => {
    const { onChange, user } = setup(EMPTY_FILTER, [{ field: "created", dir: "desc" }]);
    await user.click(screen.getByRole("button", { name: ko.runSort.toggleDirAria(ko.runSort.fieldCreated) }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ field: "created", dir: "asc" }] }),
    );
  });

  it("moves a key up to raise priority", async () => {
    const sort: SortKey[] = [{ field: "created", dir: "desc" }, { field: "verdict", dir: "asc" }];
    const { onChange, user } = setup(EMPTY_FILTER, sort);
    await user.click(screen.getByRole("button", { name: ko.runSort.moveUpAria(ko.runSort.fieldVerdict) }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [{ field: "verdict", dir: "asc" }, { field: "created", dir: "desc" }],
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test RunListControls`
Expected: FAIL — `Cannot find module '../RunListControls'` (component·ko 미존재; import 해결 실패가 먼저 터진다).

- [ ] **Step 3: Add ko strings**

In `ui/src/i18n/ko.ts`, add two namespaces inside the `ko` object (place after the `runStall` block, before `insightCompare` — alphabetical isn't enforced, group by topic):

```ts
  runFilter: {
    verdictLabel: "결과",
    statusLabel: "상태",
    modeLabel: "부하모드",
    dateLabel: "기간",
    verdictPass: "합격",
    verdictFail: "불합격",
    verdictNone: "기준없음",
    statusPending: "대기중",
    statusRunning: "실행중",
    statusCompleted: "완료",
    statusFailed: "실패",
    statusAborted: "중단",
    modeClosedFixed: "닫힌+고정",
    modeClosedCurve: "닫힌+곡선",
    modeOpenFixed: "열린+고정",
    modeOpenCurve: "열린+곡선",
    dateAll: "전체",
    dateToday: "오늘",
    date7d: "최근 7일",
    date30d: "최근 30일",
    dateFromAria: "시작일",
    dateToAria: "종료일",
    count: (shown: number, total: number) => `전체 ${total}개 중 ${shown}개 표시`,
    reset: "필터 초기화",
    emptyFiltered: "조건에 맞는 run이 없습니다.",
  },
  runSort: {
    label: "정렬",
    add: "정렬 추가",
    fieldCreated: "생성 시각",
    fieldDuration: "테스트 시간",
    fieldVu: "VU/peak",
    fieldVerdict: "결과",
    fieldStatus: "상태",
    dirAsc: "오름차순",
    dirDesc: "내림차순",
    removeKeyAria: (field: string) => `${field} 정렬 제거`,
    toggleDirAria: (field: string) => `${field} 정렬 방향 전환`,
    moveUpAria: (field: string) => `${field} 정렬 우선순위 올리기`,
    moveDownAria: (field: string) => `${field} 정렬 우선순위 내리기`,
    fieldSelectAria: (n: number) => `${n}차 정렬 기준`,
    sortByHeaderAria: (field: string) => `${field}(으)로 정렬`,
  },
```

- [ ] **Step 4: Write the component**

Create `ui/src/components/RunListControls.tsx`:

```tsx
import { ko } from "../i18n/ko";
import {
  DATE_PRESETS,
  EMPTY_FILTER,
  DEFAULT_SORT,
  MODE_KEYS,
  STATUS_KEYS,
  VERDICT_KEYS,
  SORT_FIELDS,
  hasActiveControls,
  type DatePreset,
  type ModeKey,
  type RunFilter,
  type SortField,
  type SortKey,
  type StatusKey,
  type VerdictKey,
} from "../runs/runFilterSort";

const VERDICT_LABEL: Record<VerdictKey, string> = {
  pass: ko.runFilter.verdictPass, fail: ko.runFilter.verdictFail, none: ko.runFilter.verdictNone,
};
const STATUS_LABEL: Record<StatusKey, string> = {
  pending: ko.runFilter.statusPending, running: ko.runFilter.statusRunning,
  completed: ko.runFilter.statusCompleted, failed: ko.runFilter.statusFailed,
  aborted: ko.runFilter.statusAborted,
};
const MODE_LABEL: Record<ModeKey, string> = {
  closed_fixed: ko.runFilter.modeClosedFixed, closed_curve: ko.runFilter.modeClosedCurve,
  open_fixed: ko.runFilter.modeOpenFixed, open_curve: ko.runFilter.modeOpenCurve,
};
const DATE_LABEL: Record<DatePreset, string> = {
  all: ko.runFilter.dateAll, today: ko.runFilter.dateToday, "7d": ko.runFilter.date7d,
  "30d": ko.runFilter.date30d,
};
export const SORT_FIELD_LABEL: Record<SortField, string> = {
  created: ko.runSort.fieldCreated, duration: ko.runSort.fieldDuration, vu: ko.runSort.fieldVu,
  verdict: ko.runSort.fieldVerdict, status: ko.runSort.fieldStatus,
};

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

type Props = {
  filter: RunFilter;
  sort: SortKey[];
  total: number;
  shown: number;
  onChange: (next: { filter: RunFilter; sort: SortKey[] }) => void;
};

export function RunListControls({ filter, sort, total, shown, onChange }: Props) {
  const setFilter = (f: RunFilter) => onChange({ filter: f, sort });
  const setSort = (s: SortKey[]) => onChange({ filter, sort: s });
  const active = hasActiveControls(filter, sort);

  return (
    <div className="mb-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Chips
          label={ko.runFilter.verdictLabel}
          options={VERDICT_KEYS}
          selected={filter.verdicts}
          labelOf={(k) => VERDICT_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, verdicts: toggle(filter.verdicts, k) })}
        />
        <Chips
          label={ko.runFilter.statusLabel}
          options={STATUS_KEYS}
          selected={filter.statuses}
          labelOf={(k) => STATUS_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, statuses: toggle(filter.statuses, k) })}
        />
        <Chips
          label={ko.runFilter.modeLabel}
          options={MODE_KEYS}
          selected={filter.modes}
          labelOf={(k) => MODE_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, modes: toggle(filter.modes, k) })}
        />
        <DateFilter filter={filter} onChange={setFilter} />
      </div>

      <SortBuilder sort={sort} onChange={setSort} />

      {active && (
        <div className="flex items-center gap-3">
          <span className="text-slate-600">{ko.runFilter.count(shown, total)}</span>
          <button
            type="button"
            onClick={() => onChange({ filter: EMPTY_FILTER, sort: DEFAULT_SORT })}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50"
          >
            {ko.runFilter.reset}
          </button>
        </div>
      )}
    </div>
  );
}

function Chips<T extends string>({
  label, options, selected, labelOf, onToggle,
}: {
  label: string; options: readonly T[]; selected: T[];
  labelOf: (k: T) => string; onToggle: (k: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{label}:</span>
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt)}
            className={[
              "rounded border px-2 py-0.5",
              on ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            ].join(" ")}
          >
            {labelOf(opt)}
          </button>
        );
      })}
    </div>
  );
}

function DateFilter({ filter, onChange }: { filter: RunFilter; onChange: (f: RunFilter) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{ko.runFilter.dateLabel}:</span>
      <select
        aria-label={ko.runFilter.dateLabel}
        value={filter.dateFrom || filter.dateTo ? "all" : filter.datePreset}
        onChange={(e) =>
          onChange({ ...filter, datePreset: e.target.value as DatePreset, dateFrom: null, dateTo: null })
        }
        className="rounded border border-slate-300 bg-white px-2 py-0.5"
      >
        {DATE_PRESETS.map((p) => (
          <option key={p} value={p}>{DATE_LABEL[p]}</option>
        ))}
      </select>
      <input
        type="date"
        aria-label={ko.runFilter.dateFromAria}
        value={filter.dateFrom ?? ""}
        onChange={(e) => onChange({ ...filter, dateFrom: e.target.value || null })}
        className="rounded border border-slate-300 bg-white px-1 py-0.5"
      />
      <span className="text-slate-400">~</span>
      <input
        type="date"
        aria-label={ko.runFilter.dateToAria}
        value={filter.dateTo ?? ""}
        onChange={(e) => onChange({ ...filter, dateTo: e.target.value || null })}
        className="rounded border border-slate-300 bg-white px-1 py-0.5"
      />
    </div>
  );
}

function SortBuilder({ sort, onChange }: { sort: SortKey[]; onChange: (s: SortKey[]) => void }) {
  const used = new Set(sort.map((k) => k.field));
  const firstUnused = SORT_FIELDS.find((f) => !used.has(f));

  const setField = (idx: number, field: SortField) =>
    onChange(sort.map((k, i) => (i === idx ? { ...k, field } : k)));
  const toggleDir = (idx: number) =>
    onChange(sort.map((k, i) => (i === idx ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k)));
  const remove = (idx: number) => onChange(sort.filter((_, i) => i !== idx));
  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= sort.length) return;
    const next = [...sort];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-slate-500">{ko.runSort.label}:</span>
      {sort.map((k, idx) => {
        const label = SORT_FIELD_LABEL[k.field];
        return (
          <div key={k.field} className="flex items-center gap-0.5 rounded border border-slate-300 bg-white px-1 py-0.5">
            <span className="text-slate-400">{idx + 1}</span>
            <select
              aria-label={ko.runSort.fieldSelectAria(idx + 1)}
              value={k.field}
              onChange={(e) => setField(idx, e.target.value as SortField)}
              className="bg-transparent"
            >
              {SORT_FIELDS.filter((f) => f === k.field || !used.has(f)).map((f) => (
                <option key={f} value={f}>{SORT_FIELD_LABEL[f]}</option>
              ))}
            </select>
            <button type="button" aria-label={ko.runSort.toggleDirAria(label)} onClick={() => toggleDir(idx)}
              className="px-1 text-slate-600 hover:text-slate-900">
              {k.dir === "asc" ? "▲" : "▼"}
            </button>
            <button type="button" aria-label={ko.runSort.moveUpAria(label)} disabled={idx === 0}
              onClick={() => move(idx, -1)} className="px-1 text-slate-500 disabled:opacity-30">↑</button>
            <button type="button" aria-label={ko.runSort.moveDownAria(label)} disabled={idx === sort.length - 1}
              onClick={() => move(idx, 1)} className="px-1 text-slate-500 disabled:opacity-30">↓</button>
            <button type="button" aria-label={ko.runSort.removeKeyAria(label)} onClick={() => remove(idx)}
              className="px-1 text-slate-500 hover:text-red-600">×</button>
          </div>
        );
      })}
      {firstUnused && (
        <button type="button" onClick={() => onChange([...sort, { field: firstUnused, dir: "desc" }])}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-600 hover:bg-slate-50">
          + {ko.runSort.add}
        </button>
      )}
    </div>
  );
}
```

Note on the "add" test: with `DEFAULT_SORT = [created:desc]`, the first unused field is `duration`, and `+ 추가` appends `{field:"duration", dir:"desc"}`. The test asserts exactly that.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm test RunListControls`
Expected: PASS.

- [ ] **Step 6: Lint + typecheck**

Run: `cd ui && pnpm lint && pnpm build`
Expected: 0 errors/warnings.

- [ ] **Step 7: Commit**

```bash
git add ui/src/i18n/ko.ts ui/src/components/RunListControls.tsx ui/src/components/__tests__/RunListControls.test.tsx
git commit -m "feat(ui): RunListControls toolbar (필터 4 + 정렬 빌더) + ko 문구 (R1-R4,R6,R12,R14,R17)"
```

---

## Task 3: `ScenarioRunsPage` 배선 + 헤더 클릭 정렬 + 빈상태 + RTL

**충족 R**: R5, R8, R12(헤더 측), R15, R16, R18.

**Files:**
- Modify: `ui/src/pages/ScenarioRunsPage.tsx`
- Modify: `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx`

**Interfaces (Consumes from Task 1/2):** `parseRunControls`, `serializeRunControls`, `filterRuns`, `sortRuns`, `promoteSort`, `DEFAULT_SORT`, `EMPTY_FILTER`, `type SortField`, `RunListControls`, `SORT_FIELD_LABEL`, `ko.runFilter.emptyFiltered`, `ko.runSort.sortByHeaderAria`.

- [ ] **Step 1: Write the failing tests (append to existing file)**

Append to `ui/src/pages/__tests__/ScenarioRunsPage.test.tsx` a new describe block.

**Reuse the existing helpers — do NOT redeclare them** (they already exist in this file):
- `mockApiRuns(runs: unknown[])` (≈ line 200) — handles scenario GET + runs list + datasets. Pass our `RUNS` array.
- `runRow(over)` (≈ line 26) — base run fixture (verdict/last_metric_ts absent by default; we pass `verdict` via `over`).
- The existing `LocationProbe` (≈ line 225) renders only on the **compare** route, so it can't read the runs-page URL. Add a NEW route-agnostic probe + a probe-equipped render helper (distinct names — no collision) near the existing render helpers:

```tsx
function RunsLocationProbe() {
  return <div data-testid="runs-location">{useLocation().search}</div>;
}
function renderRuns(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <RunsLocationProbe />
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

(`useLocation`/`QueryClient`/`MemoryRouter`/`Route`/`Routes`/`render` are already imported at the top of this file.)

Then the new describe block (uses `renderRuns`):

```tsx
describe("ScenarioRunsPage — filter/sort (run-list-filter-sort)", () => {
  const RUNS = [
    runRow({ id: "PASS1", status: "completed", verdict: { passed: true, criteria: [] },
      created_at: 3000 }),
    runRow({ id: "FAIL1", status: "failed", verdict: { passed: false,
      criteria: [{ metric: "p95_ms", direction: "max", threshold: 1, actual: 9, passed: false }] },
      created_at: 2000 }),
    runRow({ id: "RUN1", status: "running", verdict: null, created_at: 1000 }),
  ];

  it("no-param page renders all rows newest-first (R8, R18)", async () => {
    mockApiRuns(RUNS);
    renderRuns();
    await screen.findByRole("button", { name: ko.pages.runScenario });
    const links = screen.getAllByRole("link", { name: "view →" });
    expect(links).toHaveLength(3); // all rows visible
  });

  it("status filter hides non-matching rows (R5)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    await user.click(await screen.findByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getAllByRole("link", { name: "view →" })).toHaveLength(1);
  });

  it("filter writes URL query params (R13)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    await user.click(await screen.findByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getByTestId("runs-location").textContent).toContain("status=running");
  });

  it("shows the filtered empty state when nothing matches (R15)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // verdict=fail + status=completed → 0 matches
    await user.click(await screen.findByRole("button", { name: ko.runFilter.verdictFail }));
    await user.click(screen.getByRole("button", { name: ko.runFilter.statusCompleted }));
    expect(await screen.findByText(ko.runFilter.emptyFiltered)).toBeInTheDocument();
    expect(screen.queryByText(ko.empty.runs)).not.toBeInTheDocument();
  });

  it("header click sorts by that field (R12)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // 결과(verdict) 헤더 클릭 → promoteSort → [verdict:asc, created:desc]
    await user.click(await screen.findByRole("button", { name: ko.runSort.sortByHeaderAria(ko.runFilter.verdictLabel) }));
    const ids = screen.getAllByRole("link", { name: "view →" }).map((a) => a.getAttribute("href"));
    // verdict asc default → fail(0) first, then pass(1), then none(2)
    expect(ids).toEqual(["/runs/FAIL1", "/runs/PASS1", "/runs/RUN1"]);
  });

  it("keeps comparison selection independent of filtering (R16)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // select PASS1 and FAIL1 (both terminal)
    await user.click(await screen.findByRole("checkbox", { name: ko.report.selectRunAria("PASS1") }));
    await user.click(screen.getByRole("checkbox", { name: ko.report.selectRunAria("FAIL1") }));
    expect(screen.getByRole("button", { name: "비교 (2)" })).toBeInTheDocument();
    // now filter to running only — selected runs hidden, but compare count unchanged
    await user.click(screen.getByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getByRole("button", { name: "비교 (2)" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test ScenarioRunsPage`
Expected: FAIL — new tests fail (RunListControls/filter not wired; header buttons absent).

- [ ] **Step 3: Wire the page**

Modify `ui/src/pages/ScenarioRunsPage.tsx`:

(a) Add imports:
```tsx
import { RunListControls, SORT_FIELD_LABEL } from "../components/RunListControls";
import {
  DEFAULT_SORT,
  filterRuns,
  parseRunControls,
  promoteSort,
  serializeRunControls,
  sortRuns,
  type SortField,
} from "../runs/runFilterSort";
```

(b) Destructure the setter:
```tsx
  const [searchParams, setSearchParams] = useSearchParams();
```

(c) After `const now = useNow(...)`, derive controls + a date `now` snapshot and the apply helpers:
```tsx
  const { filter, sort: parsedSort } = parseRunControls(searchParams);
  const sortKeys = parsedSort.length ? parsedSort : DEFAULT_SORT;
  const dateNow = now; // useNow snapshot; date boundaries re-eval on filter/URL change/refetch

  const applyControls = (next: { filter: typeof filter; sort: typeof sortKeys }) => {
    const sp = serializeRunControls(next.filter, next.sort);
    // preserve unrelated params (e.g. ?retry=) that this page also reads
    const retry = searchParams.get("retry");
    if (retry) sp.set("retry", retry);
    setSearchParams(sp, { replace: true });
  };
  const onHeaderSort = (field: SortField) =>
    applyControls({ filter, sort: promoteSort(sortKeys, field) });
```

(d) Inside the `runs.data && runs.data.runs.length > 0 && (() => { ... })()` IIFE, after `const allRuns = runs.data!.runs;`, compute `visible`:
```tsx
          const allRuns = runs.data!.runs;
          const visible = sortRuns(filterRuns(allRuns, filter, dateNow), sortKeys);
          const selected = allRuns.filter((r) => selectedIds.has(r.id)); // R16: over full set
```
(`selected`/`baseline`/`n` computation stays exactly as before — operating over `allRuns`, not `visible`.)

(e) Render `<RunListControls>` above the compare toolbar (just inside the returned fragment, before the `{n >= 1 && (...)}` block):
```tsx
          return (
            <>
              <RunListControls
                filter={filter}
                sort={sortKeys}
                total={allRuns.length}
                shown={visible.length}
                onChange={applyControls}
              />
              {n >= 1 && (
```

(f) Change the table body to render `visible` and add the filtered empty state. Replace `allRuns.map((r) => {` with `visible.map((r) => {`. After the `</table>`, add the filtered empty state (still inside the IIFE fragment):
```tsx
              </table>
              {visible.length === 0 && (
                <p className="mt-3 text-sm text-slate-500">{ko.runFilter.emptyFiltered}</p>
              )}
            </>
```
(Note: this branch only runs when `allRuns.length > 0`, so an empty `visible` here means "filtered to nothing" — distinct from the `ko.empty.runs` no-runs state which is a separate top-level branch. R15.)

(g) Make the sortable column headers clickable buttons with active indicator. Replace the `<thead>` block:
```tsx
                <thead className="border-b border-slate-200 text-left text-slate-600">
                  <tr>
                    <th className="py-2 pr-2 font-medium">비교</th>
                    <SortableTh field="status" label={ko.runFilter.statusLabel} sort={sortKeys} onSort={onHeaderSort} />
                    <SortableTh field="verdict" label={ko.runFilter.verdictLabel} sort={sortKeys} onSort={onHeaderSort} />
                    <SortableTh field="vu" label={ko.report.colVus} sort={sortKeys} onSort={onHeaderSort} />
                    <SortableTh field="duration" label={ko.report.colDuration} sort={sortKeys} onSort={onHeaderSort} />
                    <SortableTh field="created" label={ko.report.colCreated} sort={sortKeys} onSort={onHeaderSort} />
                    <th />
                  </tr>
                </thead>
```
(Note: the status header reuses `ko.runFilter.statusLabel`="상태" and verdict reuses `ko.runFilter.verdictLabel`="결과"; both equal the prior plain-text headers `ko.report.colStatus`/"결과", so visible text is unchanged.)

(h) Add the `SortableTh` helper at the bottom of the file (module scope, after the component):
```tsx
function SortableTh({
  field, label, sort, onSort,
}: {
  field: SortField; label: string; sort: { field: SortField; dir: "asc" | "desc" }[];
  onSort: (f: SortField) => void;
}) {
  const idx = sort.findIndex((k) => k.field === field);
  const active = sort[idx];
  return (
    <th className="py-2 pr-4 font-medium">
      <button
        type="button"
        onClick={() => onSort(field)}
        aria-label={ko.runSort.sortByHeaderAria(label)}
        className="inline-flex items-center gap-1 hover:text-slate-900"
      >
        {label}
        {active && (
          <span className="text-xs text-indigo-600">
            {active.dir === "asc" ? "▲" : "▼"}
            {sort.length > 1 ? idx + 1 : ""}
          </span>
        )}
      </button>
    </th>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test ScenarioRunsPage`
Expected: PASS — new block + all existing cases (retry/verdict/compare) green (R18: existing cells/compare assertions unaffected; headers became buttons but existing tests query cells/labels not column headers).

- [ ] **Step 5: Full suite + lint + build**

Run: `cd ui && pnpm test && pnpm lint && pnpm build`
Expected: full suite green (targeted-green ≠ full-green — ui/CLAUDE.md), 0 lint warnings, `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/ScenarioRunsPage.tsx ui/src/pages/__tests__/ScenarioRunsPage.test.tsx
git commit -m "feat(ui): ScenarioRunsPage 필터/정렬 배선 + 헤더 클릭 정렬 + 빈상태 (R5,R8,R12,R15,R16,R18)"
```

---

## Self-Review (작성자 체크 — 구현 전 확인)

- **Spec coverage**: R1–R5(Task1 filterRuns + Task2 chips + Task3 wiring) · R6–R11(Task1 sortRuns/comparator) · R12(Task1 promoteSort + Task2 builder + Task3 header) · R13(Task1 parse/serialize + Task3 URL) · R14(Task2 count/reset) · R15(Task3 emptyFiltered) · R16(Task3 selected over allRuns) · R17(Task2 ko) · R18(Task3 existing-tests green) · R19(Task1 module). 모든 R에 task 매핑됨.
- **Placeholder scan**: 모든 step에 실제 코드/명령/기대값. TBD 없음.
- **Type consistency**: `RunFilter`/`SortKey`/`SortField`·`promoteSort`/`filterRuns`/`sortRuns`/`parseRunControls`/`serializeRunControls`·`SORT_FIELD_LABEL`가 Task 간 동일 시그니처. `Run`/`Profile`/`Verdict`는 `api/schemas`에서 import.
- **알려진 함정 반영**: tdd-guard(테스트 먼저)·vitest `__tests__/` 위치·`pnpm build` 최종 게이트·`Pick<>` leak-free·`-Infinity` 회피(deriveLoadMode 분기)·헤더 텍스트 불변(기존 라벨 재사용)·`?retry=` 파라미터 보존(applyControls가 retry를 다시 set).

## Notes for the implementer

- **`?retry=` 보존**: `applyControls`가 `setSearchParams`로 URL을 쓸 때 `retry` 파라미터를 보존한다 — `consumedRetry` ref 가드(line 67)는 그대로 두고, 절대 effect deps `[retryId, runs.data, createRun]`에 `searchParams`를 넣지 말 것(기존 exhaustive-deps 함정·회귀 테스트 존재).
- **헤더 텍스트 byte-identical**: status 헤더=`ko.runFilter.statusLabel`("상태")·verdict 헤더=`ko.runFilter.verdictLabel`("결과")는 기존 `ko.report.colStatus`("상태")·인라인 "결과"와 같은 표시 텍스트라 셀/헤더 텍스트 단언 무영향. VU/Duration/Created는 기존 `ko.report.col*` 그대로 재사용.
- **선택 독립(R16)**: 비교 toolbar의 `selected`/`baseline`/`n`은 반드시 `allRuns` 위에서 계산 — `visible`로 바꾸면 필터 시 선택이 사라진다(R16 위반). 테이블 `tbody`만 `visible.map`.
- **날짜 경계 liveness**: `dateNow=now`(useNow 스냅샷, running 없으면 mount-frozen)라 세션이 자정을 넘으면 "오늘" 경계가 refetch까지 stale — 사용성 기능엔 허용(spec §4.3). live-tick 비목표.
- **머지 전 라이브 검증**: spec §7 — UI-only·read-only·`RunSchema` 0-diff라 S-D 갭 무관 → **waived 후보**. finish-slice에서 최종 판정(근거 build-log).

<!-- REVIEW-GATE: APPROVED -->
