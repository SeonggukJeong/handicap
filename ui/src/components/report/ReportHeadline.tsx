import type {
  Profile,
  ReportSampleName,
  ReportSummary,
  StairReport,
  Validity,
  Verdict,
} from "../../api/schemas";
import { hasLatency, type LatencyCounts } from "../../report/hasLatency";
import { ko } from "../../i18n/ko";
import { formatDurationKo, formatLatencyKo, formatSecondsKo } from "../../i18n/duration";
import { noLatencyWord } from "../../report/sampleView";
import { floorPct, latencyShown } from "./format";
import { fixedTarget } from "../run/loadModel";
import { criteriaHasAny, verdictBox } from "../../print/verdict";
import { stairSummaryText } from "../../print/stairKpi";

type Props = {
  summary: ReportSummary;
  profile: Profile;
  verdict: Verdict | null | undefined;
  /** A11: when level is limited/suspect, SLO pass must not use emerald (H4). */
  validity?: Validity | null;
  /** 시나리오에 본 스텝이 없고 준비 스텝만 있다(spec D16) — 요청 0건이 정상 완료다. */
  setupOnly?: boolean;
  /** 리포트의 준비 결과(실패·끝나기 전 종료 수) — 요청 0건의 원인이 준비 쪽인지 가린다. */
  setup?: { failed: number; interrupted: number };
  /** 실행 상태(`report.run.status`) — 판정이 없는 이유를 가른다. 모르면 완료로 본다. */
  status?: string;
  /** 응답 시간 표본과 그 표본의 요청 수 — 통과·실패 표본에서 값이 없으면 문장이 값을 말하지 않는다. */
  latency?: { sample: ReportSampleName; counts: LatencyCounts; switched?: boolean };
  /** 계단 run의 판정 — 있으면 run 전체 평균 문장 대신 계단 문장(인쇄 첫 쪽 요약과 같은 글자). */
  stair?: StairReport | null;
};

function zeroSentence(setupOnly: boolean, setup: Props["setup"]): string {
  if (setupOnly) return ko.report.headlineSetupOnly;
  if (setup && setup.failed > 0) return ko.report.headlineSetupFailed;
  if (setup && setup.interrupted > 0) return ko.report.headlineSetupInterrupted;
  return ko.report.headlineNoRequests;
}

/** §7.1 쉬운 요약 헤더 — 리포트 최상단 한 문장 + verdict 콜아웃(클라 파생, 백엔드 무변경). */
export function ReportHeadline({
  summary,
  profile,
  verdict,
  validity,
  setupOnly = false,
  setup,
  status = "completed",
  latency,
  stair,
}: Props) {
  const noLatency =
    latency != null &&
    (latency.switched || latency.sample !== "all") &&
    !hasLatency(latency.counts, latency.sample);
  const p95x = latencyShown(summary.p95_ms, summary.stats?.p95_us);
  const p95 = p95x.kind === "ms" ? formatSecondsKo(p95x.ms) : p95x.kind === "us" ? p95x.text : null;
  const p95Ms =
    p95x.kind === "ms" ? formatLatencyKo(p95x.ms) : p95x.kind === "us" ? p95x.text : null;
  const t = ko.report;
  const latencyText = !latency?.switched
    ? noLatency
      ? t.headlineLatency(null)
      : p95 === null
        ? t.headlineLatencyCapped
        : t.headlineLatency(p95)
    : noLatency
      ? noLatencyWord(latency.sample, summary.errors)
      : latency.sample === "failed"
        ? p95Ms === null
          ? t.headlineLatencyFailedCapped
          : t.headlineLatencyFailed(p95Ms)
        : p95Ms === null
          ? t.headlineLatencyAllCapped
          : t.headlineLatencyAll(p95Ms);
  const common = {
    duration: formatDurationKo(summary.duration_seconds),
    count: summary.count.toLocaleString("en-US"),
    latency: latencyText,
    errPct: summary.count === 0 ? "0%" : floorPct((summary.errors / summary.count) * 100),
  };
  const isCurve = (profile.stages?.length ?? 0) > 0;
  const isVuCurve = (profile.vu_stages?.length ?? 0) > 0;
  const fixed = fixedTarget(profile);
  const sentence =
    summary.count === 0
      ? zeroSentence(setupOnly, setup)
      : fixed != null
        ? ko.report.headlineOpenFixed({ ...common, targetRps: fixed })
        : isCurve
          ? ko.report.headlineOpenCurve(common)
          : isVuCurve
            ? ko.report.headlineClosedCurve(common)
            : ko.report.headlineClosed({ ...common, vus: profile.vus });

  // 계단 run: 낮은 계단·높은 계단·상승 구간이 섞인 전체 값 대신 계단 판정. 표본을 바꿔 보는 중이면 기존 문장.
  const stairText =
    stair && summary.count > 0 && !latency?.switched ? stairSummaryText(stair) : null;

  // 판정이 없을 때만: 기준이 있었는데 왜 판정이 없는지(인쇄 verdictBox와 같은 분기).
  const box = verdictBox({
    count: summary.count,
    status,
    criteria: profile.criteria,
    verdict: null,
  });
  const noVerdictText = !criteriaHasAny(profile.criteria)
    ? ko.report.sloHint
    : box.kind === "notJudged" && box.reason === "zero"
      ? ko.report.headlineNotJudged
      : box.kind === "notJudged" && box.reason === "aborted"
        ? ko.report.headlineNotJudgedAborted
        : box.kind === "notJudged"
          ? ko.report.headlineNotJudgedFailed
          : ko.report.headlineNotEvaluable;

  return (
    <section aria-label={ko.report.headlineAria} className="mb-6">
      {verdict ? (
        <VerdictCallout verdict={verdict} validity={validity} />
      ) : (
        <p className="mb-1 text-sm text-slate-500">{noVerdictText}</p>
      )}
      <p className="text-base text-slate-800">{stairText ?? sentence}</p>
      {stairText && (
        <p className="mt-0.5 text-sm text-slate-600">
          {ko.report.headlineStairTotals({
            duration: common.duration,
            count: common.count,
            errPct: common.errPct,
          })}
        </p>
      )}
    </section>
  );
}

function VerdictCallout({ verdict, validity }: { verdict: Verdict; validity?: Validity | null }) {
  // Fail always red. Pass with limited/suspect validity: neutral + coupled copy (no emerald).
  if (!verdict.passed) {
    return <div className="mb-1 text-2xl font-bold text-red-700">{ko.report.verdictFail}</div>;
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
  return <div className="mb-1 text-2xl font-bold text-emerald-700">{ko.report.verdictPass}</div>;
}
