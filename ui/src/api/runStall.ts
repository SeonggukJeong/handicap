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
