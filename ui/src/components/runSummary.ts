import type { LoadModelState } from "./loadModel";
import { peakStageTarget } from "./sizing";
import { ko } from "../i18n/ko";

export type SummarySegment = { text: string; bold?: boolean };

function fmtTime(sec: number): string | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60),
    r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

export function runSummary(s: LoadModelState): {
  main: SummarySegment[];
  sub: string;
  tone: "ok" | "warn";
  curve: boolean;
} {
  if (s.rateMode === "curve") {
    const valid = s.stages
      .map((x) => ({ t: Number(x.target), d: Number(x.duration_seconds) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.d) && x.d > 0);
    const peak = peakStageTarget(s.stages);
    if (valid.length === 0 || peak == null)
      return { main: [{ text: ko.runDialog.summaryInvalid }], sub: "", tone: "warn", curve: true };
    const total = valid.reduce((a, x) => a + x.d, 0);
    const main =
      s.loadModel === "closed"
        ? ko.runDialog.summaryCurveVu(peak)
        : ko.runDialog.summaryCurveRps(peak);
    return {
      main,
      sub: ko.runDialog.summaryCurveSub(total, valid.length),
      tone: "ok",
      curve: true,
    };
  }
  if (s.loadModel === "closed") {
    const time = fmtTime(s.duration);
    if (!(s.vus >= 1) || !time)
      return {
        main: [{ text: ko.runDialog.summaryInvalid }],
        sub: ko.runDialog.summaryWarnClosedSub,
        tone: "warn",
        curve: false,
      };
    return {
      main: ko.runDialog.summaryClosed(s.vus, time),
      sub: ko.runDialog.summaryRampUp(s.rampUp),
      tone: "ok",
      curve: false,
    };
  }
  const rps = Number(s.targetRps),
    time = fmtTime(s.duration);
  if (!(rps >= 1) || !time)
    return {
      main: [{ text: ko.runDialog.summaryInvalid }],
      sub: ko.runDialog.summaryWarnOpenSub,
      tone: "warn",
      curve: false,
    };
  const total = (rps * Math.round(s.duration)).toLocaleString("ko");
  return {
    main: ko.runDialog.summaryOpen(rps, total, time),
    sub: ko.runDialog.summaryOpenSub(s.maxInFlight),
    tone: "ok",
    curve: false,
  };
}
