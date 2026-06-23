import { describe, expect, it } from "vitest";
import { classifyRunStall, computeRunStall, MIDRUN_STALL_MS, STARTUP_STALL_MS } from "../runStall";
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

describe("classifyRunStall (목록 직접 진입점)", () => {
  const NOW = 1_000_000_000_000;
  const NOW_SEC = Math.floor(NOW / 1000);

  it("비-running → none", () => {
    expect(classifyRunStall("completed", NOW - 1_000, null, NOW)).toEqual({
      kind: "none",
      silentSeconds: 0,
    });
  });
  it("running + lastMetricTs null + STARTUP 초과 → startup", () => {
    expect(classifyRunStall("running", NOW - 20_000, null, NOW).kind).toBe("startup");
  });
  it("running + lastMetricTs null + STARTUP 미만 → none", () => {
    expect(classifyRunStall("running", NOW - 3_000, null, NOW).kind).toBe("none");
  });
  it("running + lastMetricTs 최근(침묵 2s) → none", () => {
    expect(classifyRunStall("running", NOW - 1_000, NOW_SEC - 2, NOW).kind).toBe("none");
  });
  it("MIDRUN 경계: 침묵 120s none, 121s midrun(silentSeconds=121)", () => {
    expect(classifyRunStall("running", NOW - 1_000, NOW_SEC - 120, NOW).kind).toBe("none");
    const r = classifyRunStall("running", NOW - 1_000, NOW_SEC - 121, NOW);
    expect(r).toEqual({ kind: "midrun", silentSeconds: 121 });
  });
});
