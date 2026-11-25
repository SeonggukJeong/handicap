import { Fragment, useState } from "react";
import type { ReportSampleName, ReportStep, ReportSummary } from "../../api/schemas";
import { hasLatency, stepCounts } from "../../report/hasLatency";
import { ko } from "../../i18n/ko";
import { CAP_US, latencyCellText, latencyShown, meanShown, splitLatencyText } from "./format";
import { HelpTip } from "../HelpTip";
import { PageSection } from "../ui/PageSection";
import { RetryBadge } from "./LoopExitSummary";
import { MixedSampleBadge } from "./MixedSampleBadge";
import { SampleTag } from "./SampleTag";
import { WholeRunBadge } from "./WholeRunBadge";

type StepMeta = { id: string; name: string; method: string; url: string };

type Props = {
  steps: ReportStep[];
  meta: Map<string, StepMeta>;
  retriedStepIds?: ReadonlySet<string>;
  /** 반복 횟수별 집계·응답 분리·대기/다운로드 열이 run 전체 값일 때 「전체 구간」 표지를 단다. */
  wholeRunBadge?: boolean;
  /** 응답 시간을 계산한 표본 — 그 표본에 요청이 없으면 「—」. */
  sample?: ReportSampleName;
  /** 응답 시간 표본을 나눈 run이면 아직 나누지 않은 열·행에 「실패 포함」 표지를 단다. */
  mixedSample?: boolean;
  /** 표본을 바꿔 보는 동안의 표본 이름 — 표 제목 곁에 단다. */
  sampleTag?: string | null;
  /** 보여 주는 표본의 summary — 있으면 통계를 펼쳤을 때 「모든 스텝」 행을 단다. */
  summary?: ReportSummary;
  /** 바깥 구역이 제목을 이미 달았을 때 — 제목·구역 없이 표만 그린다. */
  embedded?: boolean;
};

const STAT_BG = "bg-slate-50";
// 펼친 표는 표 전체가 줄바꿈 금지라, 긴 주소·스텝 이름 칸만 다시 줄바꿈을 허용한다.
const NAME_WRAP = " whitespace-normal min-w-[10rem]";
const URL_WRAP = " whitespace-normal min-w-[16rem]";
const TOTAL_TOP = "border-t border-slate-300";
const floorMs = (us: number) => Math.floor(us / 1000);
const roundMs = (us: number) => Math.round(us / 1000);

// 통계 열 한 칸 — µs 값이 없으면 「—」.
function statText(us: number | undefined, toMs: (us: number) => number): string {
  if (us === undefined) return "—";
  return latencyCellText(latencyShown(toMs(us), us));
}

// 하나도 보내지 않은 스텝에는 잰 시간이 없다 — 0으로 찍지 않는다.
// 보냈지만 응답을 못 받은 요청(시간 초과·거부)은 실패까지 걸린 시간이 표본에 들어 있어 그대로 찍는다.
// 1ms 미만은 µs, 60초 칸은 「≥ 60,000」(stats가 없으면 지금 글자 그대로).
function latency(
  s: ReportStep,
  ms: number,
  us: number | undefined,
  sample: ReportSampleName,
): number | string {
  if (!hasLatency(stepCounts(s), sample)) return "—";
  const shown = latencyShown(ms, us);
  return shown.kind === "ms" ? shown.ms : latencyCellText(shown);
}

export function StepStatsTable({
  steps,
  meta,
  retriedStepIds,
  wholeRunBadge,
  sample = "all",
  mixedSample,
  sampleTag,
  summary,
  embedded = false,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [statsOpen, setStatsOpen] = useState(false);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const anyDownload = steps.some((s) => s.download != null);
  const anyWait = steps.some((s) => s.wait != null);

  // Base: Step, Method, URL, Requests, Errors, p50 ms, p95 ms, p99 ms = 8
  // With download: +3 (다운로드 p50, p95, p99)
  // With wait: +1 (대기 p50)
  // 통계 더 보기: +5 (최소·평균·최대·표준편차·p90)
  const nameWrap = statsOpen ? NAME_WRAP : "";
  const urlWrap = statsOpen ? URL_WRAP : "";
  const colSpan = 8 + (statsOpen ? 5 : 0) + (anyDownload ? 3 : 0) + (anyWait ? 1 : 0);

  // 렌더하는 p50·p95·p99 칸 중 하나라도 「≥ 60,000」이면 표 아래에 안내를 단다.
  const cappedShown =
    steps.some(
      (s) =>
        hasLatency(stepCounts(s), sample) &&
        (
          [
            [s.p50_ms, s.stats?.p50_us],
            [s.p95_ms, s.stats?.p95_us],
            [s.p99_ms, s.stats?.p99_us],
          ] as const
        ).some(([ms, us]) => latencyShown(ms, us).kind === "capped"),
    ) ||
    steps.some((s) =>
      (["final", "retry"] as const).some((k) => {
        const part = s.loop_split?.[k];
        return (
          part !== undefined &&
          part.count > 0 &&
          [part.p50_ms, part.p95_ms, part.p99_ms].some((v) => v > 60000)
        );
      }),
    );

  // 펼친 상태의 새 칸(스텝 행은 p 칸과 같은 「값을 그린 칸」 조건, 「모든 스텝」 행 포함).
  const sst = summary?.stats;
  const cappedExpanded =
    statsOpen &&
    (steps.some(
      (s) =>
        hasLatency(stepCounts(s), sample) &&
        s.stats !== undefined &&
        [s.stats.min_us, s.stats.mean_us, s.stats.max_us, s.stats.stdev_us, s.stats.p90_us].some(
          (us) => us >= CAP_US,
        ),
    ) ||
      (summary !== undefined &&
        sst !== undefined &&
        (meanShown(summary)?.kind === "capped" ||
          [
            sst.min_us,
            sst.max_us,
            sst.stdev_us,
            sst.p50_us,
            sst.p90_us,
            sst.p95_us,
            sst.p99_us,
          ].some((us) => us >= CAP_US))));

  const summaryHasLatency =
    summary !== undefined &&
    hasLatency(
      {
        count: summary.count,
        errors: summary.errors,
        notSent: steps.reduce((a, s) => a + (s.not_sent ?? 0), 0),
      },
      sample,
    );
  const summaryP = (ms: number, us: number | undefined) =>
    summaryHasLatency ? latencyCellText(latencyShown(ms, us)) : "—";

  const toggleButton = (
    <button
      type="button"
      aria-expanded={statsOpen}
      onClick={() => setStatsOpen((v) => !v)}
      className="ml-auto rounded border border-slate-300 bg-white px-2.5 py-0.5 text-[13px] text-slate-600"
    >
      <span aria-hidden="true">{statsOpen ? "▾" : "▸"} </span>
      {statsOpen ? ko.report.stats.toggleLess : ko.report.stats.toggleMore}
    </button>
  );

  const aside = (
    <>
      {sampleTag ? <SampleTag name={sampleTag} /> : undefined}
      {toggleButton}
    </>
  );
  const body = (
    <>
      {anyDownload && <p className="mb-2 text-xs text-slate-500">{ko.report.phaseCaveat}</p>}
      <div className="overflow-x-auto">
        <table className={`min-w-full text-sm${statsOpen ? " whitespace-nowrap" : ""}`}>
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className={`py-2 pr-4 font-medium${nameWrap}`}>{ko.report.colStep}</th>
              <th className="py-2 pr-4 font-medium">{ko.report.colMethod}</th>
              <th className={`py-2 pr-4 font-medium${urlWrap}`}>URL</th>
              <th className="py-2 pr-4 font-medium">{ko.report.colRequests}</th>
              <th className="py-2 pr-4 font-medium">{ko.report.colErrors}</th>
              {statsOpen && (
                <>
                  <th className={`${STAT_BG} py-2 pr-4 font-medium`}>{ko.report.stats.colMin}</th>
                  <th className={`${STAT_BG} py-2 pr-4 font-medium`}>
                    {ko.report.stats.colMean}
                    <HelpTip label={ko.report.stats.helpMean}>{ko.glossary.mean}</HelpTip>
                  </th>
                  <th className={`${STAT_BG} py-2 pr-4 font-medium`}>
                    {ko.report.stats.colMax}
                    <HelpTip label={ko.report.stats.helpMax}>{ko.glossary.max}</HelpTip>
                  </th>
                  <th className={`${STAT_BG} py-2 pr-4 font-medium`}>
                    {ko.report.stats.colStdev}
                    <HelpTip label={ko.report.stats.helpStdev}>{ko.glossary.stdev}</HelpTip>
                  </th>
                </>
              )}
              <th className="py-2 pr-4 font-medium">
                p50 ms<HelpTip label="p50 설명">{ko.glossary.p50}</HelpTip>
              </th>
              {statsOpen && (
                <th className={`${STAT_BG} py-2 pr-4 font-medium`}>
                  p90 ms<HelpTip label="p90 설명">{ko.glossary.p90}</HelpTip>
                </th>
              )}
              <th className="py-2 pr-4 font-medium">
                p95 ms<HelpTip label="p95 설명">{ko.glossary.p95}</HelpTip>
              </th>
              <th className="py-2 pr-4 font-medium">
                p99 ms<HelpTip label="p99 설명">{ko.glossary.p99}</HelpTip>
              </th>
              {anyWait && (
                <th className="py-2 pr-4 font-medium">
                  {ko.report.phaseWait} p50
                  <HelpTip label={ko.report.phaseWait}>{ko.report.phaseWaitHelp}</HelpTip>
                  {wholeRunBadge && <WholeRunBadge className="ml-1" />}
                  {mixedSample && <MixedSampleBadge className="ml-1" />}
                </th>
              )}
              {anyDownload && (
                <>
                  <th className="py-2 pr-4 font-medium">
                    {ko.report.phaseDownload} p50 ms
                    {wholeRunBadge && <WholeRunBadge className="ml-1" />}
                    {mixedSample && <MixedSampleBadge className="ml-1" />}
                  </th>
                  <th className="py-2 pr-4 font-medium">{ko.report.phaseDownload} p95 ms</th>
                  <th className="py-2 pr-4 font-medium">{ko.report.phaseDownload} p99 ms</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => {
              const m = meta.get(s.step_id);
              const breakdown = s.loop_breakdown ?? [];
              const hasBreakdown = breakdown.length > 0;
              const ls = s.loop_split;
              const isOpen = open.has(s.step_id);
              // 새 통계 칸 — p 칸과 같이 하나도 보내지 않은 스텝은 「—」.
              const sent = hasLatency(stepCounts(s), sample);
              const shownStat = (us: number | undefined, toMs: (us: number) => number) =>
                sent ? statText(us, toMs) : "—";
              return (
                <Fragment key={s.step_id}>
                  <tr className="border-b border-slate-100">
                    <td className={`py-2 pr-4 font-medium${nameWrap}`}>
                      {hasBreakdown && (
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={ko.report.toggleLoopBreakdown(m?.name ?? s.step_id)}
                          onClick={() => toggle(s.step_id)}
                          className="mr-1 text-slate-500"
                        >
                          {isOpen ? "▾" : "▸"}
                        </button>
                      )}
                      {m?.name ?? s.step_id}
                      {retriedStepIds?.has(s.step_id) && <RetryBadge />}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{m?.method ?? ""}</td>
                    <td className={`py-2 pr-4 font-mono text-xs break-all${urlWrap}`}>
                      {m?.url ?? ""}
                    </td>
                    <td className="py-2 pr-4">{s.count}</td>
                    <td className="py-2 pr-4">{s.error_count}</td>
                    {statsOpen && (
                      <>
                        <td className={`${STAT_BG} py-2 pr-4`}>
                          {shownStat(s.stats?.min_us, floorMs)}
                        </td>
                        <td className={`${STAT_BG} py-2 pr-4`}>
                          {shownStat(s.stats?.mean_us, roundMs)}
                        </td>
                        <td className={`${STAT_BG} py-2 pr-4`}>
                          {shownStat(s.stats?.max_us, floorMs)}
                        </td>
                        <td className={`${STAT_BG} py-2 pr-4`}>
                          {shownStat(s.stats?.stdev_us, roundMs)}
                        </td>
                      </>
                    )}
                    <td className="py-2 pr-4">{latency(s, s.p50_ms, s.stats?.p50_us, sample)}</td>
                    {statsOpen && (
                      <td className={`${STAT_BG} py-2 pr-4`}>
                        {shownStat(s.stats?.p90_us, floorMs)}
                      </td>
                    )}
                    <td className="py-2 pr-4">{latency(s, s.p95_ms, s.stats?.p95_us, sample)}</td>
                    <td className="py-2 pr-4">{latency(s, s.p99_ms, s.stats?.p99_us, sample)}</td>
                    {anyWait && <td className="py-2 pr-4">{s.wait?.p50_ms ?? "—"}</td>}
                    {anyDownload && (
                      <>
                        <td className="py-2 pr-4">{s.download?.p50_ms ?? "—"}</td>
                        <td className="py-2 pr-4">{s.download?.p95_ms ?? "—"}</td>
                        <td className="py-2 pr-4">{s.download?.p99_ms ?? "—"}</td>
                      </>
                    )}
                  </tr>
                  {ls &&
                    (["final", "retry"] as const).map((k) => {
                      const part = ls[k];
                      const label =
                        k === "final"
                          ? ko.report.loopExit.splitFinal
                          : ko.report.loopExit.splitRetry;
                      const pct = (v: number) => (part.count === 0 ? "—" : splitLatencyText(v));
                      return (
                        <tr key={k} className="border-b border-slate-100 text-slate-600">
                          <td className={`py-2 pr-4 pl-6${nameWrap}`}>
                            <span aria-hidden="true">└ </span>
                            {label}
                            {k === "final" && (
                              <HelpTip
                                label={ko.report.loopExit.splitHelpLabel(m?.name ?? s.step_id)}
                              >
                                <span className="block">{ko.report.loopExit.splitHelpFinal}</span>
                                <span className="block">{ko.report.loopExit.splitHelpRetry}</span>
                              </HelpTip>
                            )}
                            {k === "final" && wholeRunBadge && <WholeRunBadge className="ml-1" />}
                            {k === "final" && mixedSample && <MixedSampleBadge className="ml-1" />}
                          </td>
                          <td className="py-2 pr-4" />
                          <td className="py-2 pr-4" />
                          <td className="py-2 pr-4">{part.count}</td>
                          <td className="py-2 pr-4">{part.error_count}</td>
                          {statsOpen && (
                            <>
                              <td className={`${STAT_BG} py-2 pr-4`} />
                              <td className={`${STAT_BG} py-2 pr-4`} />
                              <td className={`${STAT_BG} py-2 pr-4`} />
                              <td className={`${STAT_BG} py-2 pr-4`} />
                            </>
                          )}
                          <td className="py-2 pr-4">{pct(part.p50_ms)}</td>
                          {statsOpen && <td className={`${STAT_BG} py-2 pr-4`} />}
                          <td className="py-2 pr-4">{pct(part.p95_ms)}</td>
                          <td className="py-2 pr-4">{pct(part.p99_ms)}</td>
                          {anyWait && <td className="py-2 pr-4" />}
                          {anyDownload && (
                            <>
                              <td className="py-2 pr-4" />
                              <td className="py-2 pr-4" />
                              <td className="py-2 pr-4" />
                            </>
                          )}
                        </tr>
                      );
                    })}
                  {hasBreakdown && isOpen && (
                    <tr className="bg-slate-50">
                      <td colSpan={colSpan} className="px-6 py-2">
                        {wholeRunBadge && <WholeRunBadge className="mb-1" />}
                        <table className="text-xs">
                          <thead className="text-slate-500">
                            <tr>
                              <th className="pr-4 text-left">loop_index</th>
                              <th className="pr-4 text-left">{ko.report.colRequests}</th>
                              <th className="pr-4 text-left">{ko.report.colErrors}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {breakdown.map((b, i) => (
                              <tr key={i}>
                                <td className="pr-4 font-mono">
                                  {b.loop_index === null ? "그 외 (상한 초과)" : b.loop_index}
                                </td>
                                <td className="pr-4">{b.count}</td>
                                <td className="pr-4">{b.error_count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {statsOpen && summary && (
              <tr className="font-semibold">
                <td className={`${TOTAL_TOP} py-2 pr-4${nameWrap}`}>{ko.report.stats.allSteps}</td>
                <td className={`${TOTAL_TOP} py-2 pr-4`} />
                <td className={`${TOTAL_TOP} py-2 pr-4`} />
                <td className={`${TOTAL_TOP} py-2 pr-4`}>{summary.count}</td>
                <td className={`${TOTAL_TOP} py-2 pr-4`}>{summary.errors}</td>
                <td className={`${TOTAL_TOP} ${STAT_BG} py-2 pr-4`}>
                  {statText(sst?.min_us, floorMs)}
                </td>
                <td className={`${TOTAL_TOP} ${STAT_BG} py-2 pr-4`}>
                  {(() => {
                    const m = meanShown(summary);
                    return m === null ? "—" : latencyCellText(m);
                  })()}
                </td>
                <td className={`${TOTAL_TOP} ${STAT_BG} py-2 pr-4`}>
                  {statText(sst?.max_us, floorMs)}
                </td>
                <td className={`${TOTAL_TOP} ${STAT_BG} py-2 pr-4`}>
                  {statText(sst?.stdev_us, roundMs)}
                </td>
                <td className={`${TOTAL_TOP} py-2 pr-4`}>
                  {summaryP(summary.p50_ms, sst?.p50_us)}
                </td>
                <td className={`${TOTAL_TOP} ${STAT_BG} py-2 pr-4`}>
                  {statText(sst?.p90_us, floorMs)}
                </td>
                <td className={`${TOTAL_TOP} py-2 pr-4`}>
                  {summaryP(summary.p95_ms, sst?.p95_us)}
                </td>
                <td className={`${TOTAL_TOP} py-2 pr-4`}>
                  {summaryP(summary.p99_ms, sst?.p99_us)}
                </td>
                {anyWait && <td className={`${TOTAL_TOP} py-2 pr-4`} />}
                {anyDownload && (
                  <>
                    <td className={`${TOTAL_TOP} py-2 pr-4`} />
                    <td className={`${TOTAL_TOP} py-2 pr-4`} />
                    <td className={`${TOTAL_TOP} py-2 pr-4`} />
                  </>
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(cappedShown || cappedExpanded) && (
        <p
          role="note"
          className="mt-2.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
        >
          {statsOpen ? ko.report.stats.cappedNoteExpanded : ko.report.stats.cappedNoteCollapsed}
        </p>
      )}
    </>
  );
  if (embedded) {
    return (
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-x-2">{aside}</div>
        {body}
      </div>
    );
  }
  return (
    <PageSection
      ariaLabel={ko.report.perStepStatsLabel}
      title={ko.report.stepsHeading}
      titleAside={aside}
    >
      {body}
    </PageSection>
  );
}
