// 응답 속도 구간 비교 모델(순수): 두 측정의 전체 요청 구간을 한 표로. spec §9.4.
import { ko } from "../../i18n/ko";
import { fmtBoundary, fmtPct } from "../format";
import { buildOverallBand, type BandName, type OverallBand } from "../speedBands";
import type { RunModel } from "./runModel";

const K = ko.print.speed;
const C = ko.print.cmp.speed;

export type SpeedCompareRow = {
  role: string;
  boundary: string | null;
  band: OverallBand;
  merged: boolean;
  mergedText: string | null;
};
export type SpeedCompare = {
  same: boolean;
  threeCols: boolean;
  head: { fast: string | null; within: string; over: string };
  rows: [SpeedCompareRow, SpeedCompareRow];
  legend: Array<{ band: BandName; text: string }>;
  warn: string | null;
};

type Overall = NonNullable<RunModel["report"]["speed_bands"]>["overall"];

function row(
  role: string,
  run: RunModel,
  o: Overall,
  show: { same: boolean; threeCols: boolean },
): SpeedCompareRow {
  const band = buildOverallBand(o, run.report.summary);
  const boundary = show.same ? null : C.boundary(fmtBoundary(o.slow_ms));
  const merged = show.threeCols && band.twoBand && band.bar !== null;
  const total = o.within + o.over;
  return {
    role,
    boundary,
    band,
    merged,
    mergedText: merged ? K.withinMerged(fmtBoundary(o.slow_ms), fmtPct(o.within / total)) : null,
  };
}

export function buildSpeedCompare(before: RunModel, after: RunModel): SpeedCompare | null {
  const b = before.report.speed_bands?.overall;
  const a = after.report.speed_bands?.overall;
  if (!b || !a) return null;
  const same =
    b.slow_ms === a.slow_ms && b.basis === a.basis && (b.fast === null) === (a.fast === null);
  const threeCols = b.fast !== null || a.fast !== null;
  const B = fmtBoundary(b.slow_ms);
  const head: SpeedCompare["head"] = same
    ? threeCols
      ? { fast: K.headFast, within: K.headWithin(B), over: K.headOver(B) }
      : { fast: null, within: K.headIn(B), over: K.headOver(B) }
    : threeCols
      ? { fast: K.headFast, within: K.headWithinMixed, over: K.headOverMixed }
      : { fast: null, within: K.headInMixed, over: K.headOverMixed };
  const legend: SpeedCompare["legend"] = threeCols
    ? [
        { band: "fast", text: K.headFast },
        { band: "within", text: head.within },
        { band: "over", text: head.over },
      ]
    : [
        { band: "fast", text: head.within },
        { band: "over", text: head.over },
      ];
  const show = { same, threeCols };
  return {
    same,
    threeCols,
    head,
    rows: [
      row(ko.print.cmp.doc.roleBefore, before, b, show),
      row(ko.print.cmp.doc.roleAfter, after, a, show),
    ],
    legend,
    warn: same ? null : C.warn,
  };
}
