import { ko } from "../i18n/ko";
import { formatDurationKo } from "../i18n/duration";
import type { Report } from "../api/schemas";
import type { StepRow } from "./stepTable";

const K = ko.print.chart;

export const BIN_CHOICES = [1, 2, 5, 10, 15, 30, 60, 120, 300];
export const CHART_W_MM = 180;
export const CHART_H_MM = 55;
/** 축 라벨 여백: 왼쪽 12mm, 오른쪽 12mm. */
export const PLOT_X0_MM = 12;
export const PLOT_X1_MM = 168;
/** 표시선 라벨 폭 추정(글자 수 × mm). */
export const LABEL_CHAR_MM = 1.9;
/** 표시선과 라벨 사이 간격(mm). */
export const MARKER_LABEL_GAP_MM = 0.8;
const MAX_BARS = 120;
const MAX_MARKERS = 3;

export function pickBinSeconds(durationSec: number): number {
  for (const n of BIN_CHOICES) if (Math.ceil(durationSec / n) <= MAX_BARS) return n;
  return BIN_CHOICES[BIN_CHOICES.length - 1];
}

export function niceTicks(max: number, maxTicks: number): number[] {
  const m = Number.isFinite(max) && max > 0 ? max : 0;
  if (m === 0) return [0, 1];
  for (let p = -3; p < 15; p++) {
    for (const f of [1, 2, 5]) {
      const step = f * 10 ** p;
      const n = Math.ceil(m / step - 1e-9);
      if (n + 1 <= maxTicks) {
        const out: number[] = [];
        for (let i = 0; i <= n; i++) out.push(Math.round(i * step * 1e6) / 1e6);
        return out;
      }
    }
  }
  return [0, m];
}

const TIME_STEPS = [30, 60, 120, 300, 600, 1800, 3600, 7200];

export function timeTicks(durationSec: number): number[] {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  let step = TIME_STEPS.find((s) => Math.floor(d / s) + 1 <= 8);
  if (step === undefined) {
    step = TIME_STEPS[TIME_STEPS.length - 1];
    while (Math.floor(d / step) + 1 > 8) step *= 2;
  }
  const out: number[] = [];
  for (let t = 0; t <= d; t += step) out.push(t);
  return out;
}

export function fmtElapsed(sec: number): string {
  return sec === 0 ? "0" : formatDurationKo(sec);
}

const elapsedText = (sec: number): string => (sec === 0 ? K.zeroSec : fmtElapsed(sec));

export type ChartBin = {
  startSec: number;
  seconds: number;
  rps: number;
  topErr: number;
  otherErr: number;
};
/** `labelX` = SVG 텍스트 x(mm). `anchor`가 "end"면 라벨은 표시선 왼쪽에 끝을 맞춘다. */
export type ChartMarker = {
  sec: number;
  label: string;
  level: 0 | 1;
  anchor: "start" | "end";
  labelX: number;
};
export type ChartModel = {
  durationSec: number;
  binSeconds: number;
  bins: ChartBin[];
  topStepId: string | null;
  hasErrors: boolean;
  rpsTicks: number[];
  errTicks: number[];
  timeTicks: number[];
  markers: ChartMarker[];
};

export function runT0(startedMs: number | null, windows: Report["windows"]): number | null {
  const cands: number[] = [];
  if (startedMs !== null && Number.isFinite(startedMs)) cands.push(Math.floor(startedMs / 1000));
  for (const w of windows) cands.push(w.ts_second);
  return cands.length === 0 ? null : cands.reduce((a, b) => Math.min(a, b));
}

export function markerX(sec: number, durationSec: number): number {
  return PLOT_X0_MM + (sec / Math.max(durationSec, 1)) * (PLOT_X1_MM - PLOT_X0_MM);
}

/** 라벨의 실제 가로 구간: 오른쪽으로 그림 영역을 넘으면 표시선 왼쪽에 끝 맞춤(end)으로 뒤집는다. */
export function markerLabelSpan(
  x: number,
  label: string,
): { anchor: "start" | "end"; labelX: number; left: number; right: number } {
  const w = [...label].length * LABEL_CHAR_MM;
  if (x + MARKER_LABEL_GAP_MM + w > PLOT_X1_MM) {
    const labelX = x - MARKER_LABEL_GAP_MM;
    return { anchor: "end", labelX, left: labelX - w, right: labelX };
  }
  const labelX = x + MARKER_LABEL_GAP_MM;
  return { anchor: "start", labelX, left: labelX, right: labelX + w };
}

export function buildChartModel(
  windows: Report["windows"],
  t0: number | null,
  rows: StepRow[],
): ChartModel {
  if (windows.length === 0 || t0 === null) {
    return {
      durationSec: 0,
      binSeconds: 1,
      bins: [],
      topStepId: null,
      hasErrors: false,
      rpsTicks: niceTicks(0, 5),
      errTicks: [],
      timeTicks: timeTicks(0),
      markers: [],
    };
  }
  const maxTs = windows.reduce((a, w) => Math.max(a, w.ts_second), t0);
  const durationSec = Math.max(1, maxTs - t0 + 1);
  const binSeconds = pickBinSeconds(durationSec);
  const nBins = Math.ceil(durationSec / binSeconds);

  const total = new Array<number>(nBins).fill(0);
  const errByStep = new Map<string, number[]>();
  const errTotals = new Map<string, number>();
  const firstErr = new Map<string, number>();
  for (const w of windows) {
    const rel = Math.max(0, w.ts_second - t0);
    const i = Math.min(nBins - 1, Math.floor(rel / binSeconds));
    total[i] += w.count;
    if (w.error_count > 0) {
      let arr = errByStep.get(w.step_id);
      if (!arr) {
        arr = new Array<number>(nBins).fill(0);
        errByStep.set(w.step_id, arr);
      }
      arr[i] += w.error_count;
      errTotals.set(w.step_id, (errTotals.get(w.step_id) ?? 0) + w.error_count);
      const prev = firstErr.get(w.step_id);
      if (prev === undefined || rel < prev) firstErr.set(w.step_id, rel);
    }
  }

  const rowIndex = new Map(rows.map((r) => [r.stepId, r.index]));
  const idx = (id: string) => rowIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const ranked = [...errTotals.keys()].sort(
    (a, b) => (errTotals.get(b) ?? 0) - (errTotals.get(a) ?? 0) || idx(a) - idx(b),
  );
  const hasErrors = ranked.length > 0;
  const topStepId = hasErrors ? ranked[0] : null;

  const bins: ChartBin[] = [];
  for (let i = 0; i < nBins; i++) {
    const startSec = i * binSeconds;
    const seconds = Math.min(binSeconds, durationSec - startSec);
    let top = 0;
    let all = 0;
    for (const [id, arr] of errByStep) {
      all += arr[i];
      if (id === topStepId) top = arr[i];
    }
    bins.push({
      startSec,
      seconds,
      rps: total[i] / seconds,
      topErr: top / seconds,
      otherErr: (all - top) / seconds,
    });
  }

  const maxRps = bins.reduce((a, b) => Math.max(a, b.rps), 0);
  const maxErr = bins.reduce((a, b) => Math.max(a, b.topErr + b.otherErr), 0);

  const cands = ranked.slice(0, MAX_MARKERS).map((id, prio) => {
    const first = firstErr.get(id) ?? 0;
    const sec = Math.floor(first / binSeconds) * binSeconds;
    const row = rows.find((r) => r.stepId === id);
    return { sec, prio, label: K.marker(elapsedText(sec), row ? row.no : id) };
  });
  cands.sort((a, b) => a.sec - b.sec || a.prio - b.prio);
  const ends: [number, number] = [-Infinity, -Infinity];
  const markers: ChartMarker[] = [];
  // 겹침 판정은 뒤집기까지 반영한 실제 구간으로(렌더러는 이 결과를 그대로 그린다).
  for (const c of cands) {
    const { anchor, labelX, left, right } = markerLabelSpan(markerX(c.sec, durationSec), c.label);
    const level = left >= ends[0] ? 0 : left >= ends[1] ? 1 : null;
    if (level === null) continue;
    ends[level] = right;
    markers.push({ sec: c.sec, label: c.label, level, anchor, labelX });
  }

  return {
    durationSec,
    binSeconds,
    bins,
    topStepId,
    hasErrors,
    rpsTicks: niceTicks(maxRps, 5),
    errTicks: hasErrors ? niceTicks(maxErr, 5) : [],
    timeTicks: timeTicks(durationSec),
    markers,
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function chartReadingLine(chart: ChartModel): string {
  if (!chart.hasErrors || chart.markers.length === 0) return K.readingNone;
  const m = chart.markers[0];
  let text = K.readingErrors(elapsedText(m.sec));
  const i = chart.bins.findIndex((b) => b.startSec === m.sec);
  if (i > 0) {
    const before = mean(chart.bins.slice(Math.max(0, i - 3), i).map((b) => b.rps));
    const after = mean(chart.bins.slice(i, i + 3).map((b) => b.rps));
    if (before > 0 && after <= before * 0.9 + 1e-9) text += K.readingDrop;
  }
  return text;
}
