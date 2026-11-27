// 겹쳐 보기 모델(순수): 두 측정의 1초 윈도우를 같은 시간 축의 묶음으로 만든다. spec §9.3.
import { ko } from "../../i18n/ko";
import { formatDurationKo } from "../../i18n/duration";
import { fmtElapsed, niceTicks, pickBinSeconds, runT0, timeTicks } from "../chartModel";
import type { RunModel } from "./runModel";

const K = ko.print.cmp.overlay;
const ZERO_SEC = ko.print.chart.zeroSec;

/** rps·err는 둘 다 건/초 */
export type OverlayBin = { startSec: number; seconds: number; rps: number; err: number };
export type OverlaySide = {
  durationSec: number;
  bins: OverlayBin[];
  errTotal: number;
  firstErrSec: number | null;
};
export type OverlayModel = {
  durationSec: number;
  binSeconds: number;
  before: OverlaySide;
  after: OverlaySide;
  hasErrors: boolean;
  /** 둘 다 요청이 있고 비교할 수 있는데 오류가 없다 — 측정하지 않은 쪽을 「오류 없음」이라 적지 않는다 */
  noErrorsNote: boolean;
  rpsTicks: number[];
  errTicks: number[];
  timeTicks: number[];
  reading: string;
  durationNote: string | null;
};

/** 오류가 거의 없다고 읽는 상한: 이전 초당 평균 오류의 5% */
const NEAR_NONE = 0.05;
const NOTE_RATIO = 0.05;

export function sideDuration(run: RunModel): { t0: number; durationSec: number } {
  const { windows } = run.report;
  const t0 = runT0(run.meta.started_at, windows);
  if (windows.length === 0 || t0 === null) return { t0: 0, durationSec: 0 };
  const last = windows.reduce((m, w) => Math.max(m, w.ts_second), t0);
  return { t0, durationSec: last - t0 + 1 };
}

function buildSide(run: RunModel, binSeconds: number): OverlaySide {
  const { t0, durationSec } = sideDuration(run);
  if (durationSec === 0) return { durationSec: 0, bins: [], errTotal: 0, firstErrSec: null };
  const n = Math.ceil(durationSec / binSeconds);
  const count = new Array<number>(n).fill(0);
  const errs = new Array<number>(n).fill(0);
  let errTotal = 0;
  for (const w of run.report.windows) {
    const i = Math.min(n - 1, Math.floor((w.ts_second - t0) / binSeconds));
    count[i] += w.count;
    errs[i] += w.error_count;
    errTotal += w.error_count;
  }
  const bins: OverlayBin[] = count.map((c, i) => {
    const startSec = i * binSeconds;
    const seconds = Math.min(binSeconds, durationSec - startSec);
    return { startSec, seconds, rps: c / seconds, err: errs[i]! / seconds };
  });
  const first = bins.find((b) => b.err > 0);
  return { durationSec, bins, errTotal, firstErrSec: first ? first.startSec : null };
}

const at = (sec: number): string => (sec === 0 ? ZERO_SEC : fmtElapsed(sec));

function readingLine(before: OverlaySide, after: OverlaySide, incomparable: boolean): string {
  if (incomparable) return ko.print.cmp.lines.incomparable;
  // 오류가 있으면(errTotal > 0) 오류 묶음이 있어 firstErrSec는 null이 아니다
  const b = before.firstErrSec;
  const a = after.firstErrSec;
  // 두 측정의 기간이 다를 수 있어 합계가 아니라 초당 평균 오류로 견준다(기간이 0인 쪽은 0으로 본다)
  const perSec = (s: OverlaySide): number => (s.durationSec > 0 ? s.errTotal / s.durationSec : 0);
  if (b !== null && perSec(after) <= perSec(before) * NEAR_NONE) return K.readingDropped(at(b));
  if (b !== null && a !== null) return K.readingBoth(at(b), at(a));
  if (a !== null) return K.readingAfterOnly(at(a));
  return K.readingNone;
}

export function buildOverlay(
  before: RunModel,
  after: RunModel,
  incomparable: boolean,
): OverlayModel {
  const durationSec = Math.max(sideDuration(before).durationSec, sideDuration(after).durationSec);
  const binSeconds = durationSec === 0 ? 1 : pickBinSeconds(durationSec);
  const b = buildSide(before, binSeconds);
  const a = buildSide(after, binSeconds);
  const hasErrors = b.errTotal > 0 || a.errTotal > 0;
  const maxOf = (pick: (x: OverlayBin) => number): number =>
    Math.max(0, ...b.bins.map(pick), ...a.bins.map(pick));
  const longer = Math.max(b.durationSec, a.durationSec);
  const differs =
    b.bins.length > 0 &&
    a.bins.length > 0 &&
    Math.abs(b.durationSec - a.durationSec) > Math.max(binSeconds, longer * NOTE_RATIO);
  return {
    durationSec,
    binSeconds,
    before: b,
    after: a,
    hasErrors,
    noErrorsNote: !hasErrors && !incomparable && b.bins.length > 0 && a.bins.length > 0,
    rpsTicks: niceTicks(
      maxOf((x) => x.rps),
      5,
    ),
    errTicks: hasErrors
      ? niceTicks(
          maxOf((x) => x.err),
          5,
        )
      : [],
    timeTicks: timeTicks(durationSec),
    reading: readingLine(b, a, incomparable),
    durationNote: differs
      ? K.durationNote(formatDurationKo(b.durationSec), formatDurationKo(a.durationSec))
      : null,
  };
}
