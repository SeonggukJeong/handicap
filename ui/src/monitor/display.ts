import type { BoardStatus, Threshold } from "../api/monitors";
import { ko } from "../i18n/ko";
import type { CSSProperties } from "react";
import { barColor, gridFor, type PanelState } from "./logic";

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
export const GRAPH_CHROME = {
  marginTop: 1,
  axisBorder: 0.4,
  axisMarginTop: 0.6,
  /** A (fill) only: padding / radius of the dark box around the graph. */
  insetPad: 1,
  insetRadius: 1.2,
} as const;
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
export function barsAreaHeight(
  w: number,
  h: number,
  textH: number,
  fontScale: number,
  inset = false,
): number {
  const cqw = w / 100;
  const axisPx = Math.min(
    (PANEL_TEXT.axis * fontScale * w) / 100,
    (PANEL_TEXT.axis * fontScale * WIDE_CAP * h) / 100,
  );
  return (
    freeBelowText(w, h, textH) -
    (PANEL_BOX.padBottom + PANEL_BOX.border) * cqw -
    (GRAPH_CHROME.marginTop + GRAPH_CHROME.axisBorder + GRAPH_CHROME.axisMarginTop) * cqw -
    axisPx * AXIS_LINE_HEIGHT -
    (inset ? 2 * GRAPH_CHROME.insetPad * cqw : 0)
  );
}

/**
 * Spec §7.3 "글자 우선": no graph (bars, axis, labels) when < 15% of the panel
 * height is left below the text, or when the bars themselves would get < 8%
 * (a few-pixel graph is unreadable).
 */
export function graphFits(a: {
  w: number;
  h: number;
  textH: number;
  fontScale: number;
  inset?: boolean;
}): boolean {
  return (
    freeBelowText(a.w, a.h, a.textH) >= a.h * GRAPH_MIN_SHARE &&
    barsAreaHeight(a.w, a.h, a.textH, a.fontScale, a.inset ?? false) >= a.h * BARS_MIN_SHARE
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

export type ReasonParts =
  | { kind: "split"; fixed: string; step: string | null }
  | { kind: "detail"; big: string; small: string }
  | { kind: "not_contained"; needle: string; small: string };

const NOT_CONTAINED_HEAD = "본문 전체 · 포함 ";
const NOT_CONTAINED_TAIL = '" 포함 안 됨';

/**
 * Condition results carry `detail` (path · rule · step): the reason is then the
 * actual value and is never split (values may contain " · "). A body_text
 * "contains" failure is rendered with its tail kept visible.
 */
export function reasonParts(reason: string, detail: string | null): ReasonParts {
  if (detail === null) return { kind: "split", ...splitReason(reason) };
  if (
    detail.startsWith(NOT_CONTAINED_HEAD) &&
    reason.length >= 1 + NOT_CONTAINED_TAIL.length &&
    reason.startsWith('"') &&
    reason.endsWith(NOT_CONTAINED_TAIL)
  )
    return {
      kind: "not_contained",
      needle: reason.slice(1, -NOT_CONTAINED_TAIL.length),
      small: detail,
    };
  return { kind: "detail", big: reason, small: detail };
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

/** A (fill) panel backgrounds (spec 6.2); slow takes the crossed threshold's colour. */
export const FILL = { ok: "#15803d", fail: "#b91c1c", gray: "#475569" } as const;

/** Panel background in A; null = pending (rendered like B). */
export function fillBackground(
  state: PanelState,
  latencyMs: number | null,
  thresholds: Threshold[],
): string | null {
  switch (state) {
    case "ok":
      return FILL.ok;
    case "slow":
      return barColor(latencyMs ?? 0, thresholds);
    case "fail":
      return FILL.fail;
    case "config_error":
    case "stale":
    case "stale_off":
      return FILL.gray;
    case "pending":
      return null;
  }
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever has the higher WCAG contrast on `bg` (tie -> white). */
export function contrastText(bg: string): "#ffffff" | "#0b0f14" {
  const l = luminance(bg);
  const white = 1.05 / (l + 0.05);
  const dark = (l + 0.05) / (luminance("#0b0f14") + 0.05);
  return dark > white ? "#0b0f14" : "#ffffff";
}

export const STATE_LABEL: Record<PanelState, string> = {
  ok: ko.monitor.stateOk,
  slow: ko.monitor.stateSlow,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
  stale: ko.monitor.stateStale,
  stale_off: ko.monitor.stateStaleOff,
  pending: ko.monitor.statePending,
};

/** B state colour (ok/slow/fail carry colour, everything else is gray). */
export function stateColorOf(
  state: PanelState,
  latencyMs: number | null,
  thresholds: Threshold[],
): string {
  if (state === "ok") return COLOR.ok;
  if (state === "slow") return barColor(latencyMs ?? 0, thresholds);
  if (state === "fail") return COLOR.fail;
  return COLOR.gray;
}

export function borderColorOf(state: PanelState, stateColor: string): string {
  return state === "ok" || state === "slow" || state === "fail" ? stateColor : COLOR.grayBorder;
}

// Board layout grids — shared by the real panels and the invisible size probes
// so both lay out identically.

/** `gridFor(n)` equal cells with the board gap (no padding). */
export function panelGridStyle(n: number): CSSProperties {
  const { cols, rows } = gridFor(n);
  return {
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    gap: "1vw",
  };
}

/** C board area: big area (3) + strip (1), strip right (f=1) or below (f>=2). */
export function focusMainStyle(side: "right" | "bottom"): CSSProperties {
  return {
    display: "grid",
    gap: "1vw",
    padding: "1vw",
    ...(side === "right"
      ? { gridTemplateColumns: "3fr 1fr", gridTemplateRows: "minmax(0, 1fr)" }
      : { gridTemplateRows: "3fr 1fr", gridTemplateColumns: "minmax(0, 1fr)" }),
  };
}

/** C strip: `count` equal cards in one column (right) or one row (bottom). */
export function stripGridStyle(side: "right" | "bottom", count: number): CSSProperties {
  return {
    display: "grid",
    gap: "1vw",
    ...(side === "right"
      ? {
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: `repeat(${count}, minmax(0, 1fr))`,
        }
      : {
          gridTemplateRows: "minmax(0, 1fr)",
          gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        }),
  };
}

/** C strip card text ratios (card container units) and box chrome (cqmin). */
export const CARD_TEXT = { title: { cqh: 22, cqw: 10 }, state: { cqh: 20, cqw: 9 } } as const;
export const CARD_BOX = { border: 2, pad: 6, radius: 4 } as const;

/**
 * The card scale a strip card probe needs (Infinity = it fits), measured at
 * `fit`: its text block must fit the card's content height, and its status
 * line (state + ms, one line) its width. The title may end in "…".
 */
export function cardNeed(m: {
  fit: number;
  contentH: number;
  textH: number;
  lineClientW: number;
  lineScrollW: number;
}): number {
  let vertical = Infinity;
  if (m.textH > m.contentH + 0.5) {
    vertical = m.contentH > 0 ? m.fit * (m.contentH / m.textH) * 0.98 : 0;
  }
  let horizontal = Infinity;
  if (m.lineClientW > 0 && m.lineScrollW > m.lineClientW + 0.5) {
    horizontal = m.fit * (m.lineClientW / m.lineScrollW) * 0.98;
  }
  return Math.min(vertical, horizontal);
}

export function cardFont(r: { cqh: number; cqw: number }, scale: number): string {
  return `calc(min(${+(r.cqh * scale).toFixed(3)}cqh, ${+(r.cqw * scale).toFixed(3)}cqw) * var(--card-fit, 1))`;
}
