import type { BoardStatus } from "../api/monitors";

export type PanelStatus = BoardStatus["panels"][number];

// Display-screen sizing. Text is sized in panel-box container units: each panel
// is a `container-type: size` box, so `cqw`/`cqh` are 1% of that panel.
//
// Base ratios reproduce mockup v4 (`02-latency-bars-final.html`) at
// 1920x1080 · 2 panels · "large": the mockup sizes text in *screen* cqw and a
// panel there is 48.5 screen-cqw wide ((100 - 3 gaps/paddings) / 2), so
// panel-cqw = screen-cqw / 0.485 (title 5.2 -> 10.7, big value 9 -> 18.6,
// threshold labels 2.4 -> 4.9, axis 1.8 -> 3.7). Tuned live (±10%).
//
// `min(a·cqw, a·K·cqh)` caps text in panels much wider than tall (1 panel,
// 2x2, 3x3 grids) so the graph keeps room; at 2 panels (w/h ≈ 0.95) the cqw
// term wins, so the mockup reference case is unaffected.

export const PANEL_TEXT = {
  title: 10.7,
  state: 10.7,
  big: 18.6,
  reason: 11.2,
  /** Step-name part of a fail reason (after the first " · "), below the reason. */
  step: 6.4,
  consecutive: 5.4,
  threshold: 4.9,
  axis: 3.7,
  failMark: 3.3,
} as const;

const WIDE_CAP = 1.6;

/**
 * CSS font-size in panel container units, scaled by the board font scale.
 * `--fit` (set on the panel box, default 1) shrinks all panel text only when
 * the text block would not fit the panel at all (extreme titles/reasons).
 */
export function panelFont(ratio: number, scale: number): string {
  const w = +(ratio * scale).toFixed(3);
  const h = +(ratio * scale * WIDE_CAP).toFixed(3);
  return `calc(min(${w}cqw, ${h}cqh) * var(--fit, 1))`;
}

/** The same font size in px for a panel of `w`x`h` px. */
export function panelFontPx(ratio: number, scale: number, w: number, h: number, fit = 1): number {
  return Math.min((ratio * scale * w) / 100, (ratio * scale * WIDE_CAP * h) / 100) * fit;
}

/** Panel box chrome in panel cqw (single source for the style and the maths). */
export const PANEL_BOX = { border: 1, padTop: 2.4, padSide: 2.4, padBottom: 2, radius: 2 } as const;
/** Latency graph chrome in panel cqw around the bars area. */
export const GRAPH_CHROME = { marginTop: 1, axisBorder: 0.4, axisMarginTop: 0.6 } as const;
export const AXIS_LINE_HEIGHT = 1.3;

/** Below this share of the panel height left for the bars, the graph is hidden. */
export const GRAPH_MIN_SHARE = 0.15;

/** Height text and graph share: the panel minus its border and padding. */
export function boxContentHeight(w: number, h: number): number {
  const cqw = w / 100;
  return h - (2 * PANEL_BOX.border + PANEL_BOX.padTop + PANEL_BOX.padBottom) * cqw;
}

/** Height left for the bars area once text, margins and the axis row are placed. */
export function barsSpace(a: {
  w: number;
  h: number;
  textH: number;
  fontScale: number;
  fit: number;
}): number {
  const cqw = a.w / 100;
  const chrome =
    (GRAPH_CHROME.marginTop + GRAPH_CHROME.axisBorder + GRAPH_CHROME.axisMarginTop) * cqw +
    panelFontPx(PANEL_TEXT.axis, a.fontScale, a.w, a.h, a.fit) * AXIS_LINE_HEIGHT;
  return boxContentHeight(a.w, a.h) - a.textH - chrome;
}

/** Spec §7.3: no graph (bars, axis, labels) when the bars would get < 15% of the panel. */
export function graphFits(a: {
  w: number;
  h: number;
  textH: number;
  fontScale: number;
  fit: number;
}): boolean {
  return barsSpace(a) >= a.h * GRAPH_MIN_SHARE;
}

/**
 * A fail reason is a fixed reason optionally followed by ` · {step name}`; fixed
 * reasons never contain ` · ` (spec §7.3 극단값 표시 정책), so split at the first.
 */
export function splitReason(reason: string): { fixed: string; step: string | null } {
  const i = reason.indexOf(" · ");
  return i < 0
    ? { fixed: reason, step: null }
    : { fixed: reason.slice(0, i), step: reason.slice(i + 3) };
}

export const COLOR = {
  bg: "#0b0f14",
  panel: "#111a23",
  text: "#f2f5f8",
  muted: "#9aa7b4",
  axis: "#7b8794",
  ok: "#22c55e",
  fail: "#ef4444",
  gray: "#94a3b8",
  grayBorder: "#64748b",
} as const;
