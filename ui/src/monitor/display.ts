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
  consecutive: 5.4,
  threshold: 4.9,
  axis: 3.7,
  failMark: 3.3,
} as const;

const WIDE_CAP = 1.6;

/** CSS font-size in panel container units, scaled by the board font scale. */
export function panelFont(ratio: number, scale: number): string {
  const w = +(ratio * scale).toFixed(3);
  const h = +(ratio * scale * WIDE_CAP).toFixed(3);
  return `min(${w}cqw, ${h}cqh)`;
}

/** Below this share of the panel height left for the graph, the graph is hidden. */
export const GRAPH_MIN_SHARE = 0.15;

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
