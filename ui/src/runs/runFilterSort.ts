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
  verdicts: [],
  statuses: [],
  modes: [],
  datePreset: "all",
  dateFrom: null,
  dateTo: null,
};
export const DEFAULT_SORT: SortKey[] = [{ field: "created", dir: "desc" }];

// 헤더 클릭 시 새 1차 키의 기본 방향 (R12): 크기/시간은 큰 것 먼저(desc), 랭크는 asc.
const DEFAULT_DIR: Record<SortField, SortDir> = {
  created: "desc",
  duration: "desc",
  vu: "desc",
  verdict: "asc",
  status: "asc",
};
// 서수 랭크 (R11). asc 기준 — 작은 rank가 먼저.
const VERDICT_RANK: Record<VerdictKey, number> = { fail: 0, pass: 1, none: 2 };
const STATUS_RANK: Record<StatusKey, number> = {
  running: 0,
  pending: 1,
  failed: 2,
  aborted: 3,
  completed: 4,
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
function vuSortValue(
  p: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages">,
): number | null {
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
    case "today":
      return [startOfDayMs(now), null];
    case "7d":
      return [now - 7 * DAY, null];
    case "30d":
      return [now - 30 * DAY, null];
    default:
      return [null, null]; // all
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
    if (
      SORT_FIELDS.includes(f as SortField) &&
      (d === "asc" || d === "desc") &&
      !seen.has(f as SortField)
    ) {
      seen.add(f as SortField);
      out.push({ field: f as SortField, dir: d });
    }
  }
  return out;
}
function isDefaultSort(sort: SortKey[]): boolean {
  return (
    sort.length === 0 ||
    (sort.length === 1 && sort[0].field === "created" && sort[0].dir === "desc")
  );
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
