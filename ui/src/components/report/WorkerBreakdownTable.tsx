import type { ReportSampleName, WorkerBreakdown } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { PageSection } from "../ui/PageSection";
import { formatErrPct } from "./format";
import { SampleTag } from "./SampleTag";

type Props = {
  breakdown: WorkerBreakdown[];
  sample?: ReportSampleName;
  /** 표본을 바꿔 보는 동안의 표본 이름 — 제목 곁에 단다. */
  sampleTag?: string | null;
};

// 워커별 「보내지 않음」 수는 와이어에 없어 all 표본은 지금처럼 늘 값.
function workerLatency(w: WorkerBreakdown, ms: number, sample: ReportSampleName): number | string {
  if (sample === "passed") return w.count - w.errors > 0 ? ms : "—";
  if (sample === "failed") return w.errors > 0 ? ms : "—";
  return ms;
}

export function WorkerBreakdownTable({ breakdown, sample = "all", sampleTag }: Props) {
  // Server emits only when >=2 distinct workers; mirror that gate defensively.
  if (breakdown.length < 2) return null;
  return (
    <PageSection
      ariaLabel={ko.report.workerBreakdownLabel}
      title={ko.report.workerBreakdownTitle(breakdown.length)}
      titleAside={sampleTag ? <SampleTag name={sampleTag} /> : undefined}
    >
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colWorker}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colErrorRate}</th>
            <th className="py-2 pr-4 font-medium">
              p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
            </th>
            <th className="py-2 pr-4 font-medium">
              p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((w, i) => (
            <tr key={w.worker_id} className="border-b border-slate-100">
              <td className="py-2 pr-4 font-medium" title={w.worker_id}>
                {ko.report.workerLabel(i + 1)}
              </td>
              <td className="py-2 pr-4">{w.count}</td>
              <td className="py-2 pr-4">{w.errors}</td>
              <td className="py-2 pr-4">{formatErrPct(w.errors, w.count)}</td>
              <td className="py-2 pr-4">{workerLatency(w, w.p50_ms, sample)}</td>
              <td className="py-2 pr-4">{workerLatency(w, w.p95_ms, sample)}</td>
              <td className="py-2 pr-4">{workerLatency(w, w.p99_ms, sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageSection>
  );
}
