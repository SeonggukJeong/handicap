import type { EmergencyStopConfig, StairLive } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import {
  clockText,
  errorRateText,
  formatMs,
  stopHeadText,
  stopReasonParts,
} from "../report/stair/stairFormat";

const t = ko.runDetail.stairLive;
const rt = ko.report.stair;

export type LiveStepState = StairLive["step_states"][number];

const VERDICT_STATES: ReadonlySet<LiveStepState> = new Set([
  "ok",
  "spike",
  "saturated",
  "unconfirmed",
  "after",
  "not_measured",
]);

/** 칩·요약 라벨. 마지막 판정 계단의 unconfirmed는 정지·동결 전까지 잠정이다. */
export function liveStateLabel(s: LiveStepState, live: StairLive): string {
  if (s === "measuring") return t.measuring;
  if (s === "pending") return t.pending;
  if (s === "frozen") return t.frozen;
  if (s === "unconfirmed" && live.stop == null && !live.frozen) return t.unconfirmedPending;
  return rt.states[s];
}

/** 앞쪽 연속 판정 칩 수. */
function judgedCount(live: StairLive): number {
  let n = 0;
  while (n < live.step_states.length && VERDICT_STATES.has(live.step_states[n])) n++;
  return n;
}

export function liveHeadText(live: StairLive, targets: readonly number[]): string | null {
  if (live.stop != null) return null;
  if (live.current_step == null) return t.waitingFirst;
  const phase = rt.stopPhaseName[live.phase ?? "measure"];
  return t.head(live.current_step + 1, targets.length, targets[live.current_step], phase);
}

export function liveSummaryText(live: StairLive): string | null {
  const n = judgedCount(live);
  if (n === 0) return null;
  const groups: string[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || live.step_states[i] !== live.step_states[start]) {
      groups.push(t.group(start + 1, i, liveStateLabel(live.step_states[start], live)));
      start = i;
    }
  }
  return groups.join(" · ");
}

export function liveForecastText(live: StairLive): string | null {
  return live.next_fail_stops ? t.forecast(judgedCount(live) + 1) : null;
}

export function liveEmergencyText(
  live: StairLive,
  em: EmergencyStopConfig | null | undefined,
): string | null {
  if (!em) return null;
  const now = live.emergency_now;
  if (now == null) return t.emergencyWaiting;
  if (now.held)
    return t.emergencyHeld(em.min_requests, em.error_rate_pct, em.p99_ms, em.consecutive_seconds);
  return t.emergency(
    errorRateText(now.error_rate),
    formatMs(now.p99_us),
    em.error_rate_pct,
    em.p99_ms,
    em.consecutive_seconds,
    now.bad_streak,
  );
}

export function liveStopText(live: StairLive, targets: readonly number[]): string | null {
  const stop = live.stop;
  if (stop == null) return null;
  const i = live.last_ok_step;
  const lastOk = i != null ? { label: rt.stopLabel(i + 1, targets[i]) } : null;
  const parts = [...stopReasonParts(stop, lastOk), clockText(stop.stopped_at_ms)];
  return `${stopHeadText(stop, targets)} — ${parts.join(" · ")}`;
}
