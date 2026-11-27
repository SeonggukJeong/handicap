// 겹쳐 보기의 평균 응답 시간 모델(순수): 두 측정의 초별 응답 시간을 겹쳐 보기와 같은 칸으로 묶는다.
import { ko } from "../../i18n/ko";
import { elapsedText, niceTicks } from "../chartModel";
import { binLatency, type LatencyBin } from "../latencyChart";
import { sideDuration, type OverlayModel, type OverlaySide } from "./overlay";
import type { RunModel } from "./runModel";

const K = ko.print.cmp.overlay.latency;

export type OverlayLatencySide = { bins: LatencyBin[]; has: boolean };
export type OverlayLatencyModel = {
  durationSec: number;
  timeTicks: number[];
  binText: string;
  before: OverlayLatencySide;
  after: OverlayLatencySide;
  yTicks: number[];
  capped: boolean;
  missingNote: string | null;
};

function buildSide(run: RunModel, side: OverlaySide, binSeconds: number): OverlayLatencySide {
  const { t0, durationSec } = sideDuration(run);
  const bins =
    durationSec === 0
      ? []
      : binLatency(run.report.latency_by_second ?? [], t0, { binSeconds, bins: side.bins });
  return { bins, has: bins.some((b) => b.meanMs !== null) };
}

export function buildOverlayLatency(
  before: RunModel,
  after: RunModel,
  overlay: OverlayModel,
): OverlayLatencyModel | null {
  const b = buildSide(before, overlay.before, overlay.binSeconds);
  const a = buildSide(after, overlay.after, overlay.binSeconds);
  if (!b.has && !a.has) return null;
  const allBins = [...b.bins, ...a.bins];
  const max = Math.max(0, ...allBins.map((x) => x.meanMs ?? 0));
  return {
    durationSec: overlay.durationSec,
    timeTicks: overlay.timeTicks,
    binText: elapsedText(overlay.binSeconds),
    before: b,
    after: a,
    yTicks: niceTicks(max, 5),
    capped: allBins.some((x) => x.capped),
    missingNote: b.has === a.has ? null : b.has ? K.missingAfter : K.missingBefore,
  };
}
