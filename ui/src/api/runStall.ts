import type { Run, RunStatus, WindowSummary } from "./schemas";

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
 * stall 판정 코어(백엔드 무관). startup/midrun 임계값·kind의 단일 소스.
 * - lastMetricTs === null: 메트릭 없음 → startup 후보(시작 후 STARTUP_STALL_MS 초과 시 startup).
 * - lastMetricTs !== null: 마지막 메트릭(wall-clock unix초) 이후 MIDRUN_STALL_MS 초과 침묵 → midrun.
 * 상세(`computeRunStall`)·목록(`ScenarioRunsPage`)이 공유한다.
 */
export function classifyRunStall(
  status: RunStatus,
  startedMs: number,
  lastMetricTs: number | null,
  nowMs: number,
): RunStall {
  if (status !== "running") return NONE;
  if (lastMetricTs === null) {
    return nowMs - startedMs > STARTUP_STALL_MS ? { kind: "startup", silentSeconds: 0 } : NONE;
  }
  const silence = Math.floor(nowMs / 1000) - lastMetricTs;
  return silence * 1000 > MIDRUN_STALL_MS ? { kind: "midrun", silentSeconds: silence } : NONE;
}

/**
 * run의 진행 stall 상태를 순수 계산한다(상세 화면 — 메트릭 윈도 입력).
 * 메트릭 미도착(windows===undefined)이면 판정하지 않는다(첫 RTT 배너 플래시 방지).
 * 그 외는 windows에서 totalCount/maxTs를 도출해 classifyRunStall로 위임.
 */
export function computeRunStall(
  run: Pick<Run, "status" | "started_at" | "created_at">,
  windows: readonly WindowSummary[] | undefined,
  nowMs: number,
): RunStall {
  if (run.status !== "running") return NONE;
  if (windows === undefined) return NONE;

  const totalCount = windows.reduce((acc, w) => acc + w.count, 0);
  let maxTs = 0;
  for (const w of windows) if (w.ts_second > maxTs) maxTs = w.ts_second;

  return classifyRunStall(
    run.status,
    run.started_at ?? run.created_at,
    totalCount > 0 ? maxTs : null,
    nowMs,
  );
}
