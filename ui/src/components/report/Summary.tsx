import type { ReportSummary } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { PageSection } from "../ui/PageSection";
import { floorPct } from "./format";

type Props = {
  summary: ReportSummary;
  dropped?: number;
  targetRps?: number | null;
};

export function Summary({ summary, dropped, targetRps }: Props) {
  const cards: Array<{ label: string; value: string; help?: string }> = [
    { label: ko.report.cardTotalRequests, value: summary.count.toLocaleString() },
    { label: ko.report.cardErrors, value: summary.errors.toLocaleString() },
    { label: ko.report.cardAvgRps, value: summary.rps.toFixed(1), help: ko.glossary.rps },
    { label: ko.report.cardDuration, value: `${summary.duration_seconds}s` },
    { label: "p50", value: `${summary.p50_ms} ms`, help: ko.glossary.p50 },
    { label: "p95", value: `${summary.p95_ms} ms`, help: ko.glossary.p95 },
    { label: "p99", value: `${summary.p99_ms} ms`, help: ko.glossary.p99 },
  ];

  if (targetRps != null) {
    const droppedCount = dropped ?? 0;
    const total = droppedCount + summary.count;
    const dropRate = total === 0 ? 0 : droppedCount / total;
    const dropPct = floorPct(dropRate * 100);
    cards.push(
      { label: ko.report.cardTargetRps, value: targetRps.toLocaleString() },
      {
        label: ko.report.cardDropped,
        value: `${droppedCount.toLocaleString()} (${dropPct})`,
        // 드롭 정의는 max in-flight 용어 정의가 단일 소스(초과분 drop 집계 설명 포함)
        help: ko.glossary.maxInFlight,
      },
    );
  }

  const gridColsClass = targetRps != null ? "md:grid-cols-9" : "md:grid-cols-7";

  return (
    <PageSection ariaLabel={ko.report.summaryLabel} title={ko.report.summaryTitle}>
      <div className={`grid grid-cols-3 ${gridColsClass} gap-3 text-sm`}>
        {cards.map((c) => (
          <div key={c.label} className="border border-slate-200 rounded-md p-3 bg-white">
            <div className="text-slate-500 text-xs">
              {c.label}
              {c.help && <HelpTip label={`${c.label} 설명`}>{c.help}</HelpTip>}
            </div>
            <div className="text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
    </PageSection>
  );
}
