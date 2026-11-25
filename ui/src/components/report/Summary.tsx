import type { ReportSampleName, ReportSummary } from "../../api/schemas";
import { hasLatency, type LatencyCounts } from "../../report/hasLatency";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { PageSection } from "../ui/PageSection";
import { floorPct, latencyShown, latencyUnitText, meanShown } from "./format";
import type { OpenLoopRates } from "./openLoopRates";
import { SampleTag } from "./SampleTag";
import { WholeRunBadge } from "./WholeRunBadge";

type Props = {
  summary: ReportSummary;
  dropped?: number;
  openLoop?: OpenLoopRates | null;
  /** dropped가 run 전체 값일 때 버림 비율의 분모에 쓰는 전체 구간 요청 수. */
  dropBase?: { count: number };
  /** 버림 수·달성 도착률이 run 전체 값일 때 그 카드 옆에 「전체 구간」 표지를 단다. */
  wholeRunBadge?: boolean;
  /** 응답 시간 표본과 그 표본의 요청 수 — 통과·실패 표본에서 값이 없으면 「—」. 없으면 항상 값. */
  latency?: { sample: ReportSampleName; counts: LatencyCounts; switched?: boolean };
  /** 표본을 바꿔 보는 동안의 표본 이름 — p50 카드 곁에 단다. */
  sampleTag?: string | null;
};

export function Summary({
  summary,
  dropped,
  openLoop,
  dropBase,
  wholeRunBadge,
  latency,
  sampleTag,
}: Props) {
  const noLatency =
    latency != null &&
    (latency.switched || latency.sample !== "all") &&
    !hasLatency(latency.counts, latency.sample);
  const ms = (v: number, us: number | undefined) =>
    noLatency ? "—" : latencyUnitText(latencyShown(v, us));
  const mean = noLatency ? null : meanShown(summary);
  const meanValue =
    mean === null
      ? "—"
      : (mean.kind !== "capped" && summary.stats?.capped ? "≥\u00a0" : "") + latencyUnitText(mean);
  const cards: Array<{ label: string; value: string; help?: string; whole?: boolean }> = [
    { label: ko.report.cardTotalRequests, value: summary.count.toLocaleString() },
    { label: ko.report.cardErrors, value: summary.errors.toLocaleString() },
    { label: ko.report.cardAvgRps, value: summary.rps.toFixed(1), help: ko.glossary.rps },
    { label: ko.report.cardDuration, value: `${summary.duration_seconds}s` },
    { label: ko.report.cardMean, value: meanValue, help: ko.glossary.mean },
    { label: "p50", value: ms(summary.p50_ms, summary.stats?.p50_us), help: ko.glossary.p50 },
    { label: "p95", value: ms(summary.p95_ms, summary.stats?.p95_us), help: ko.glossary.p95 },
    { label: "p99", value: ms(summary.p99_ms, summary.stats?.p99_us), help: ko.glossary.p99 },
  ];

  if (openLoop != null) {
    const droppedCount = dropped ?? 0;
    const total = droppedCount + (dropBase?.count ?? summary.count);
    const dropRate = total === 0 ? 0 : droppedCount / total;
    const dropPct = floorPct(dropRate * 100);
    cards.push(
      {
        label: openLoop.curve ? ko.report.cardTargetRatePeak : ko.report.cardTargetRps,
        value: openLoop.target.toLocaleString(),
        help: ko.glossary.arrivalRate,
      },
      {
        label: ko.report.cardAchievedRate,
        value: openLoop.achieved != null ? openLoop.achieved.toFixed(1) : "—",
        help: ko.report.cardAchievedRateHelp,
        whole: wholeRunBadge,
      },
      {
        label: ko.report.cardDropped,
        value: `${droppedCount.toLocaleString()} (${dropPct})`,
        // 드롭 정의는 max in-flight 용어 정의가 단일 소스(초과분 drop 집계 설명 포함)
        help: ko.glossary.maxInFlight,
        whole: wholeRunBadge,
      },
    );
  }

  // 카드 하나가 8자리 쉼표 숫자(「12,345,678」 95px + 여백 26.5px)를 담으려면 ≥ 122px.
  // 1440px에서 11칸은 89px라 넘쳐서 폭별로 칸 수를 나눈다.
  const gridColsClass =
    openLoop != null
      ? "grid-cols-2 md:grid-cols-4 lg:grid-cols-6"
      : "grid-cols-2 md:grid-cols-4 xl:grid-cols-8";

  return (
    <PageSection ariaLabel={ko.report.summaryLabel} title={ko.report.summaryTitle}>
      <div className={`grid ${gridColsClass} gap-3 text-sm`}>
        {cards.map((c) => (
          <div key={c.label} className="border border-slate-200 rounded-md p-3 bg-white">
            <div className="text-slate-500 text-xs">
              {c.label}
              {c.help && <HelpTip label={`${c.label} 설명`}>{c.help}</HelpTip>}
              {c.whole && <WholeRunBadge className="ml-1" />}
              {c.label === "p50" && sampleTag && <SampleTag name={sampleTag} className="ml-1" />}
            </div>
            <div className="text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
    </PageSection>
  );
}
