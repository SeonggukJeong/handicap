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

/** Panel box chrome in panel cqw (single source for the style and the maths). */
export const PANEL_BOX = { border: 1, padTop: 2.4, padSide: 2.4, padBottom: 2, radius: 2 } as const;
/** Latency graph chrome in panel cqw around the bars area. */
export const GRAPH_CHROME = { marginTop: 1, axisBorder: 0.4, axisMarginTop: 0.6 } as const;
export const AXIS_LINE_HEIGHT = 1.3;

/** Graph hidden when less than this share of the panel height is left below the text. */
export const GRAPH_MIN_SHARE = 0.15;
/**
 * Shrink target (spec §7.3 극단값 표시 정책): text plus a graph area of at least
 * this share of the panel height (axis included) must fit before the board stops
 * shrinking.
 */
export const GRAPH_TARGET_SHARE = 0.3;
/** Board text never shrinks below this share of its configured size. */
export const MIN_FIT = 0.4;

/** Height text and graph share: the panel minus its border and padding. */
export function boxContentHeight(w: number, h: number): number {
  const cqw = w / 100;
  return h - (2 * PANEL_BOX.border + PANEL_BOX.padTop + PANEL_BOX.padBottom) * cqw;
}

/** Space left below the text block, down to the panel's bottom edge. */
export function freeBelowText(w: number, h: number, textH: number): number {
  return h - (PANEL_BOX.border + PANEL_BOX.padTop) * (w / 100) - textH;
}

/** No graph when its bars area itself would be under this share of the panel height. */
export const BARS_MIN_SHARE = 0.08;

/**
 * Height the bars area would get: the space below the text minus the bottom
 * padding/border, the graph's margins/axis border and the axis row. Graph text
 * is not scaled by the board scale (LatencyBars sets --fit: 1).
 */
export function barsAreaHeight(w: number, h: number, textH: number, fontScale: number): number {
  const cqw = w / 100;
  const axisPx = Math.min(
    (PANEL_TEXT.axis * fontScale * w) / 100,
    (PANEL_TEXT.axis * fontScale * WIDE_CAP * h) / 100,
  );
  return (
    freeBelowText(w, h, textH) -
    (PANEL_BOX.padBottom + PANEL_BOX.border) * cqw -
    (GRAPH_CHROME.marginTop + GRAPH_CHROME.axisBorder + GRAPH_CHROME.axisMarginTop) * cqw -
    axisPx * AXIS_LINE_HEIGHT
  );
}

/**
 * Spec §7.3 "글자 우선": no graph (bars, axis, labels) when < 15% of the panel
 * height is left below the text, or when the bars themselves would get < 8%
 * (a few-pixel graph is unreadable).
 */
export function graphFits(a: { w: number; h: number; textH: number; fontScale: number }): boolean {
  return (
    freeBelowText(a.w, a.h, a.textH) >= a.h * GRAPH_MIN_SHARE &&
    barsAreaHeight(a.w, a.h, a.textH, a.fontScale) >= a.h * BARS_MIN_SHARE
  );
}

/**
 * The board scale this panel needs (Infinity = none): its text, measured at
 * `fit`, must leave GRAPH_TARGET_SHARE of the panel free below it, and every
 * one-line value must fit its width (`widthNeed`, already a scale).
 */
export function requiredFit(m: {
  w: number;
  h: number;
  textH: number;
  fit: number;
  widthNeed: number;
}): number {
  const maxText =
    m.h - (PANEL_BOX.border + PANEL_BOX.padTop) * (m.w / 100) - m.h * GRAPH_TARGET_SHARE;
  let vertical = Infinity;
  if (m.textH > maxText + 0.5) {
    vertical = maxText > 0 ? m.fit * (maxText / m.textH) * 0.98 : 0;
  }
  return Math.min(vertical, m.widthNeed);
}

/** Binary search state for the board scale (candidate under test, bounds). */
export type ScaleSearch = { lo: number; hi: number; cand: number; done: boolean };
/** Stop when the bracket is narrower than this. */
const SEARCH_STEP = 0.01;

/** Next search state after every probe reported for `cur.cand` (`ok` = all fit). */
export function nextSearch(cur: ScaleSearch, ok: boolean): ScaleSearch {
  if (ok && cur.cand >= 1) return { lo: 1, hi: 1, cand: 1, done: true };
  const lo = ok ? cur.cand : cur.lo;
  const hi = ok ? cur.hi : cur.cand;
  if (hi - lo < SEARCH_STEP) return { lo, hi, cand: lo, done: true };
  return { lo, hi, cand: +((lo + hi) / 2).toFixed(4), done: false };
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
