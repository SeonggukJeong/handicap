import type { StairReport } from "../api/schemas";
import { ko } from "../i18n/ko";
import {
  errorRateText,
  formatCount,
  formatMs,
  lastOkStep,
  reasonTexts,
  saturationStartStep,
  showsNumbers,
} from "../components/report/stair/stairFormat";
import type { KpiCard } from "./verdict";

const k = ko.print.stair.kpi;

/**
 * 계단 run의 첫 쪽 지표 4칸 — run 전체 평균(낮은 계단·높은 계단·상승 구간이 섞임) 대신
 * 마지막 정상 계단의 값과 포화 시작 목표. 판정할 계단이 없으면(no_data) null → 기존 칸.
 */
export function stairKpiCards(stair: StairReport): KpiCard[] | null {
  const h = stair.headline;
  if (h.kind === "no_data") return null;
  const ok = lastOkStep(stair);
  const measured = ok !== undefined && showsNumbers(ok.state);
  const timed = measured && ok.p99_us > 0;
  const n = (v: number) => v.toLocaleString("en-US");

  const lastOk: KpiCard = ok
    ? {
        key: "stairLastOk",
        label: k.lastOk.label,
        value: n(ok.target),
        unit: k.unitTarget,
        explain: k.lastOk.explain,
        target: [
          k.lastOk.where(ok.index + 1),
          ...(measured && ok.achieved != null ? [k.lastOk.achieved(formatCount(ok.achieved))] : []),
        ].join(" · "),
        bad: false,
      }
    : {
        key: "stairLastOk",
        label: k.lastOk.label,
        value: k.lastOk.noneValue,
        unit: "",
        explain: k.lastOk.noneExplain,
        target: k.none,
        bad: false,
      };

  const throughput: KpiCard = {
    key: "stairThroughput",
    label: k.throughput.label,
    value: measured ? formatCount(ok.throughput_rps) : k.none,
    unit: measured ? k.unitThroughput : "",
    explain: k.throughput.explain,
    target: measured ? k.throughput.errorRate(errorRateText(ok.error_rate)) : k.none,
    bad: false,
  };

  const p95: KpiCard = {
    key: "stairP95",
    label: k.p95.label,
    value: timed ? formatMs(ok.p95_us) : k.none,
    unit: timed ? k.unitMs : "",
    explain: k.p95.explain,
    target: timed ? k.p95.p99(formatMs(ok.p99_us)) : k.none,
    bad: false,
  };

  const start = saturationStartStep(stair);
  const s = k.saturation;
  let saturation: KpiCard;
  if (h.kind === "saturated" || h.kind === "unconfirmed") {
    const suspect = h.kind === "unconfirmed";
    const reasons = start ? reasonTexts(stair, start) : [];
    saturation = {
      key: "stairSaturation",
      label: suspect ? s.labelSuspect : s.label,
      value: h.saturated_target != null ? n(h.saturated_target) : k.none,
      unit: h.saturated_target != null ? k.unitTarget : "",
      explain: suspect ? s.explainSuspect : s.explain,
      target: reasons.length > 0 ? reasons.join(" · ") : k.none,
      bad: !suspect,
    };
  } else {
    saturation = {
      key: "stairSaturation",
      label: s.label,
      value: s.notFound,
      unit: "",
      explain: h.kind === "all_ok" ? s.explainAllOk : s.explainUnmeasured,
      target: k.none,
      bad: false,
    };
  }
  return [lastOk, throughput, p95, saturation];
}
