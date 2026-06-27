import type { LoadModelState } from "./loadModel";
import { peakStageTarget } from "./sizing";
import { ko } from "../i18n/ko";

function fmtTime(sec: number): string | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60),
    r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

export function runSummary(s: LoadModelState): {
  text: string;
  tone: "ok" | "warn";
  curve: boolean;
} {
  const warn = { text: ko.runDialog.summaryInvalid, tone: "warn" as const, curve: false };
  if (s.rateMode === "curve") {
    const valid = s.stages
      .map((x) => ({ t: Number(x.target), d: Number(x.duration_seconds) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.d) && x.d > 0);
    const peak = peakStageTarget(s.stages);
    if (valid.length === 0 || peak == null) return { ...warn, curve: true };
    const total = valid.reduce((a, x) => a + x.d, 0);
    const head =
      s.loadModel === "closed"
        ? ko.runDialog.summaryCurveVu(peak)
        : ko.runDialog.summaryCurveRps(peak);
    return {
      text: `${head} · ${ko.runDialog.summaryCurveSub(total, s.stages.length)}`,
      tone: "ok",
      curve: true,
    };
  }
  if (s.loadModel === "closed") {
    const time = fmtTime(s.duration);
    if (!(s.vus >= 1) || !time) return warn;
    return {
      text: `${ko.runDialog.summaryClosed(s.vus, time)} (${ko.runDialog.summaryRampUp(s.rampUp)})`,
      tone: "ok",
      curve: false,
    };
  }
  const rps = Number(s.targetRps),
    time = fmtTime(s.duration);
  if (!(rps >= 1) || !time) return warn;
  const total = (rps * Math.round(s.duration)).toLocaleString("ko");
  return {
    text: `${ko.runDialog.summaryOpen(rps, total, time)} · ${ko.runDialog.summaryOpenSub(s.maxInFlight)}`,
    tone: "ok",
    curve: false,
  };
}
