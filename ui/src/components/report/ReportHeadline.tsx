import type { Profile, ReportSummary, Validity, Verdict } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { formatDurationKo, formatSecondsKo } from "../../i18n/duration";
import { floorPct } from "./format";

type Props = {
  summary: ReportSummary;
  profile: Profile;
  verdict: Verdict | null | undefined;
  /** A11: when level is limited/suspect, SLO pass must not use emerald (H4). */
  validity?: Validity | null;
};

/** §7.1 쉬운 요약 헤더 — 리포트 최상단 한 문장 + verdict 콜아웃(클라 파생, 백엔드 무변경). */
export function ReportHeadline({ summary, profile, verdict, validity }: Props) {
  const common = {
    duration: formatDurationKo(summary.duration_seconds),
    count: summary.count.toLocaleString("en-US"),
    p95: formatSecondsKo(summary.p95_ms),
    errPct: summary.count === 0 ? "0%" : floorPct((summary.errors / summary.count) * 100),
  };
  const isCurve = (profile.stages?.length ?? 0) > 0;
  const isVuCurve = (profile.vu_stages?.length ?? 0) > 0;
  const sentence =
    summary.count === 0
      ? ko.report.headlineNoRequests
      : profile.target_rps != null
        ? ko.report.headlineOpenFixed({ ...common, targetRps: profile.target_rps })
        : isCurve
          ? ko.report.headlineOpenCurve(common)
          : isVuCurve
            ? ko.report.headlineClosedCurve(common)
            : ko.report.headlineClosed({ ...common, vus: profile.vus });

  return (
    <section aria-label={ko.report.headlineAria} className="mb-6">
      {verdict ? <VerdictCallout verdict={verdict} validity={validity} /> : (
        <p className="mb-1 text-sm text-slate-500">{ko.report.sloHint}</p>
      )}
      <p className="text-base text-slate-800">{sentence}</p>
    </section>
  );
}

function VerdictCallout({
  verdict,
  validity,
}: {
  verdict: Verdict;
  validity?: Validity | null;
}) {
  // Fail always red. Pass with limited/suspect validity: neutral + coupled copy (no emerald).
  if (!verdict.passed) {
    return (
      <div className="mb-1 text-2xl font-bold text-red-700">{ko.report.verdictFail}</div>
    );
  }
  const level = validity?.level;
  if (level === "suspect") {
    return (
      <div className="mb-1 text-2xl font-bold text-slate-700">
        {ko.report.headlineSloPassSuspect}
      </div>
    );
  }
  if (level === "limited") {
    return (
      <div className="mb-1 text-2xl font-bold text-slate-700">
        {ko.report.headlineSloPassLimited}
      </div>
    );
  }
  // level ok or validity absent (old report): keep existing emerald 합격 emphasis
  return (
    <div className="mb-1 text-2xl font-bold text-emerald-700">{ko.report.verdictPass}</div>
  );
}
