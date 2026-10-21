import type { CheckResult, FontScale, Threshold } from "../api/monitors";

export const DEFAULT_BAR_COLOR = "#22c55e";

export const FONT_SCALE: Record<FontScale, number> = {
  small: 0.7,
  medium: 0.85,
  large: 1,
  xlarge: 1.2,
};

export type PanelState =
  | "ok"
  | "slow"
  | "fail"
  | "config_error"
  | "stale"
  | "stale_off"
  | "pending";

/** Integer ms with thousands separators, e.g. `1,350 ms`. */
export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

/** Color of the highest crossed threshold (thresholds ascending), else green. */
export function barColor(latencyMs: number, thresholds: Threshold[]): string {
  let color = DEFAULT_BAR_COLOR;
  for (const t of thresholds) {
    if (latencyMs >= t.ms) color = t.color;
  }
  return color;
}

export function staleAfterMs(intervalSec: number, timeoutSec: number): number {
  return (intervalSec * 3 + timeoutSec + 5) * 1000;
}

export function panelState(args: {
  latest?: CheckResult;
  nowMs: number;
  startedAtMs: number | null;
  enabled: boolean;
  serverDown: boolean;
  intervalSec: number;
  timeoutSec: number;
  thresholds: Threshold[];
}): PanelState {
  const { latest, nowMs, startedAtMs, enabled, serverDown, intervalSec, timeoutSec, thresholds } =
    args;
  if (serverDown) return "stale";
  if (!enabled) return "stale_off";
  const ref = latest ? latest.at_ms : startedAtMs;
  if (ref !== null && nowMs - ref >= staleAfterMs(intervalSec, timeoutSec)) return "stale";
  if (!latest) return "pending";
  if (latest.verdict === "fail") return "fail";
  if (latest.verdict === "config_error") return "config_error";
  if (latest.latency_ms !== null && thresholds.some((t) => latest.latency_ms! >= t.ms)) {
    return "slow";
  }
  return "ok";
}

/** `barCount` slots filled from the left; oldest results evicted when over. */
export function barSlots(results: CheckResult[], barCount: number): (CheckResult | null)[] {
  const kept = results.length > barCount ? results.slice(results.length - barCount) : results;
  const slots: (CheckResult | null)[] = kept.slice();
  while (slots.length < barCount) slots.push(null);
  return slots;
}

export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

/** Inner label of the time axis ("10분"); the " 전" suffix comes from the copy key. */
export function axisAgoLabel(barCount: number, intervalSec: number): string {
  const total = barCount * intervalSec;
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

export const showConsecutive = (n: number): boolean => n >= 2;

export function bigValueText(state: PanelState, latest?: CheckResult): string {
  if (state === "ok" || state === "slow") {
    return latest && latest.latency_ms !== null ? formatMs(latest.latency_ms) : "—";
  }
  if (state === "fail" || state === "config_error") return latest?.reason ?? "—";
  return "—";
}
