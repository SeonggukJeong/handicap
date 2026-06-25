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
    scenario_id: "S1",
    scenario_yaml: "",
    status: "completed",
    profile: {
      vus: 0,
      ramp_up_seconds: 0,
      duration_seconds: 0,
      loop_breakdown_cap: 256,
      http_timeout_seconds: 30,
      measure_phases: false,
    },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 0,
    verdict: null,
    last_metric_ts: null,
    ...over,
  } as Run;
}
const closedFixed = (vus: number) => ({
  vus,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
});
const closedCurve = (peak: number) => ({
  vus: 0,
  ramp_up_seconds: 0,
  duration_seconds: 0,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
  vu_stages: [
    { target: 1, duration_seconds: 10 },
    { target: peak, duration_seconds: 10 },
  ],
});
const openFixed = (rps: number) => ({
  vus: 0,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
  target_rps: rps,
  max_in_flight: 100,
});

const PASS = { passed: true, criteria: [] };
const FAIL = {
  passed: false,
  criteria: [
    { metric: "p95_ms", direction: "max" as const, threshold: 1, actual: 9, passed: false },
  ],
};

describe("verdictKey / modeKey", () => {
  it("verdictKey maps null→none, passed→pass, else fail", () => {
    expect(verdictKey(null)).toBe("none");
    expect(verdictKey(undefined)).toBe("none");
    expect(verdictKey(PASS)).toBe("pass");
    expect(verdictKey(FAIL)).toBe("fail");
  });
  it("modeKey covers 4 modes", () => {
    expect(modeKey(closedFixed(5) as never)).toBe("closed_fixed");
    expect(modeKey(closedCurve(50) as never)).toBe("closed_curve");
    expect(modeKey(openFixed(100) as never)).toBe("open_fixed");
    expect(
      modeKey({
        vus: 0,
        ramp_up_seconds: 0,
        duration_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        stages: [{ target: 10, duration_seconds: 5 }],
      } as never),
    ).toBe("open_curve");
  });
});

describe("filterRuns (R1–R5)", () => {
  const runs = [
    mkRun({
      id: "a",
      verdict: PASS,
      status: "completed",
      profile: closedFixed(5),
      created_at: 1000,
    }),
    mkRun({ id: "b", verdict: FAIL, status: "failed", profile: openFixed(100), created_at: 2000 }),
    mkRun({
      id: "c",
      verdict: null,
      status: "running",
      profile: closedCurve(50),
      created_at: 3000,
    }),
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
    const runs = [
      mkRun({ id: "a", created_at: 1 }),
      mkRun({ id: "b", created_at: 3 }),
      mkRun({ id: "c", created_at: 2 }),
    ];
    expect(sortRuns(runs, []).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
  it("multi-key [verdict asc, created desc] keeps priority order (R6, R11)", () => {
    const runs = [
      mkRun({ id: "p1", verdict: PASS, created_at: 1 }),
      mkRun({ id: "f1", verdict: FAIL, created_at: 2 }),
      mkRun({ id: "f2", verdict: FAIL, created_at: 5 }),
      mkRun({ id: "n1", verdict: null, created_at: 9 }),
    ];
    const keys: SortKey[] = [
      { field: "verdict", dir: "asc" },
      { field: "created", dir: "desc" },
    ];
    // fail(rank0) first, within fail newest-first(5>2), then pass, then none
    expect(sortRuns(runs, keys).map((r) => r.id)).toEqual(["f2", "f1", "p1", "n1"]);
  });
  it("vu nulls-last regardless of dir (R10)", () => {
    const runs = [
      mkRun({ id: "open", profile: openFixed(100) }),
      mkRun({ id: "c5", profile: closedFixed(5) }),
      mkRun({ id: "c8", profile: closedFixed(8) }),
    ];
    expect(sortRuns(runs, [{ field: "vu", dir: "asc" }]).map((r) => r.id)).toEqual([
      "c5",
      "c8",
      "open",
    ]);
    expect(sortRuns(runs, [{ field: "vu", dir: "desc" }]).map((r) => r.id)).toEqual([
      "c8",
      "c5",
      "open",
    ]);
  });
  it("vu sort: closed+curve uses peak (R10)", () => {
    const runs = [
      mkRun({ id: "c50", profile: closedCurve(50) }),
      mkRun({ id: "c5", profile: closedFixed(5) }),
    ];
    expect(sortRuns(runs, [{ field: "vu", dir: "desc" }]).map((r) => r.id)).toEqual(["c50", "c5"]);
  });
  it("status rank running<pending<failed<aborted<completed (R11)", () => {
    const runs = [
      mkRun({ id: "comp", status: "completed", created_at: 1 }),
      mkRun({ id: "run", status: "running", created_at: 1 }),
      mkRun({ id: "pend", status: "pending", created_at: 1 }),
    ];
    expect(sortRuns(runs, [{ field: "status", dir: "asc" }]).map((r) => r.id)).toEqual([
      "run",
      "pend",
      "comp",
    ]);
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
    expect(promoteSort(keys, "verdict")).toEqual([
      { field: "verdict", dir: "asc" },
      { field: "created", dir: "desc" },
    ]);
  });
  it("moves an existing non-primary field to front (no dup)", () => {
    const keys: SortKey[] = [
      { field: "created", dir: "desc" },
      { field: "verdict", dir: "asc" },
    ];
    expect(promoteSort(keys, "verdict")).toEqual([
      { field: "verdict", dir: "asc" },
      { field: "created", dir: "desc" },
    ]);
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
    const f: RunFilter = {
      verdicts: ["fail"],
      statuses: ["running", "pending"],
      modes: ["closed_curve"],
      datePreset: "all",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-25",
    };
    const keys: SortKey[] = [
      { field: "verdict", dir: "asc" },
      { field: "created", dir: "desc" },
    ];
    const back = parseRunControls(serializeRunControls(f, keys));
    expect(back.filter).toEqual(f);
    expect(back.sort).toEqual(keys);
  });
  it("ignores unknown tokens (robust)", () => {
    const sp = new URLSearchParams(
      "status=bogus,running&verdict=xx&mode=nope&sort=zzz:asc,created:up",
    );
    const back = parseRunControls(sp);
    expect(back.filter.statuses).toEqual(["running"]);
    expect(back.filter.verdicts).toEqual([]);
    expect(back.filter.modes).toEqual([]);
    expect(back.sort).toEqual([]); // both sort tokens invalid
  });
  it("custom date overrides preset in serialization", () => {
    const f: RunFilter = {
      ...EMPTY_FILTER,
      datePreset: "7d",
      dateFrom: "2026-06-01",
      dateTo: null,
    };
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
