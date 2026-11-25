import type { ReportSummary } from "../../api/schemas";
import { ko } from "../../i18n/ko";

/** Format a microsecond latency into a compact human string (µs / ms / s). */
export function formatLatency(us: number): string {
  if (!Number.isFinite(us) || us < 0) return "—";
  if (us < 1_000) return `${Math.round(us)} µs`;
  const ms = us / 1_000;
  // Round-aware thresholds so adjacent labels stay consistent: values that round
  // up to 10 ms use the integer branch (not "10.0 ms"), and values that round up
  // to 1000 ms render as "1.0 s" (not "1000 ms").
  if (ms < 9.95) return `${ms.toFixed(1)} ms`;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  return `${(us / 1_000_000).toFixed(1)} s`;
}

/** 백분율(0–100)을 표시 문자열로. nonzero인데 표시 최소값(0.1%) 미만이면 "<0.1%"로 floor
 *  — 에러/드롭이 실재하는데 "0.0%"로 보이는 오해 방지(R5). 진짜 0은 "0.0%". */
export function floorPct(pct: number): string {
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** 시간(ms) 숫자 글자 — 소수 3자리 반올림·뒤 0 생략·천 단위 쉼표(en-US). 판정 표·배지 전용. */
export function msNumberText(ms: number): string {
  return (Math.round(ms * 1000) / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

/** 에러율(errors/count) 표시 — count 0이면 "—". */
export function formatErrPct(errors: number, count: number): string {
  return count === 0 ? "—" : floorPct((errors / count) * 100);
}

/** 응답 시간이 60초 상한 칸에 닿았음을 뜻하는 µs 값(서버 상한과 같다). */
export const CAP_US = 60_000_000;

export type LatencyShown =
  | { kind: "ms"; ms: number }
  | { kind: "us"; text: string }
  | { kind: "capped" };

/** 화면의 시간 한 칸을 무엇으로 보일지. µs 값이 없으면 지금처럼 정수 ms. */
export function latencyShown(ms: number, us: number | undefined): LatencyShown {
  if (us === undefined) return { kind: "ms", ms };
  if (us >= CAP_US) return { kind: "capped" };
  if (us < 1000) return { kind: "us", text: formatLatency(us) };
  return { kind: "ms", ms };
}

/** 표 칸 글자(단위 없음). */
export function latencyCellText(x: LatencyShown): string {
  if (x.kind === "ms") return `${x.ms}`;
  if (x.kind === "us") return x.text;
  return ko.report.stats.capped;
}

/** 카드·문장 글자(단위 포함). */
export function latencyUnitText(x: LatencyShown): string {
  if (x.kind === "ms") return `${x.ms} ms`;
  if (x.kind === "us") return x.text;
  return `${ko.report.stats.capped} ms`;
}

/** 평균 한 칸 — 카드와 「모든 스텝」 행이 함께 쓰는 단일 식. stats가 없으면 null. */
export function meanShown(s: Pick<ReportSummary, "mean_ms" | "stats">): LatencyShown | null {
  if (s.stats === undefined) return null;
  return latencyShown(Math.min(s.mean_ms, 60000), s.stats.mean_us);
}
