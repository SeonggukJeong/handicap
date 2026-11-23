import type { Report, ReportStep } from "../api/schemas";
import { reportSample } from "../api/schemas";
import { hasLatency, stepCounts, summaryCounts } from "../report/hasLatency";

/** 서버 `latency_missing`과 같은 식 — 기본 표본이 「통과한 요청」인데 통과한 요청이 하나도 없다. */
export function summaryLatencyMissing(r: Report): boolean {
  return reportSample(r).default === "passed" && !hasLatency(summaryCounts(r), "passed");
}

export function stepLatencyMissing(r: Pick<Report, "sample">, s: ReportStep): boolean {
  return reportSample(r).default === "passed" && !hasLatency(stepCounts(s), "passed");
}
