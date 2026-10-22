import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CheckResult, Threshold } from "../../api/monitors";
import { axisAgoLabel, barColor, barSlots } from "../../monitor/logic";
import {
  AXIS_LINE_HEIGHT,
  COLOR,
  GRAPH_CHROME,
  PANEL_TEXT,
  panelFont,
} from "../../monitor/display";
import { ko } from "../../i18n/ko";

const FAIL_BASE = "#7f1d1d";
const CONFIG_BASE = "#334155";
const FAIL_STRIPES = `repeating-linear-gradient(45deg, ${COLOR.fail} 0 1cqw, ${FAIL_BASE} 1cqw 2cqw)`;
const CONFIG_STRIPES = `repeating-linear-gradient(45deg, ${COLOR.grayBorder} 0 1cqw, ${CONFIG_BASE} 1cqw 2cqw)`;

/** Bar visual width is ~78% of its slot; the rest is the gap (mockup pitch). */
const GAP_SHARE = 22;

function pct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

const fmtPct = (n: number) => `${+n.toFixed(2)}%`;

/**
 * Axis line under the bars. The label column carries the same bottom border
 * (transparent) so its content box — where label offsets are measured — shares
 * the bars area's content-box baseline, where the dashed lines' `bottom:%` is.
 */
const AXIS_BORDER_WIDTH = `${GRAPH_CHROME.axisBorder}cqw`;

/**
 * Bars-area height and threshold-label height, measured with ResizeObserver;
 * null until measured (first paint, jsdom without a mock).
 */
function useLabelMetrics(
  areaRef: React.RefObject<HTMLElement>,
  labelsRef: React.RefObject<HTMLElement>,
  labelCount: number,
): { areaH: number; labelH: number } | null {
  const [m, setM] = useState<{ areaH: number; labelH: number } | null>(null);
  useEffect(() => {
    const area = areaRef.current;
    const labels = labelsRef.current;
    if (!area || !labels || typeof ResizeObserver === "undefined") return;
    let areaH: number | null = null;
    let labelH: number | null = null;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) if (e.target === area) areaH = e.contentRect.height;
      // When every number is dropped there is no span; keep the last height.
      const label = labels.querySelector("span");
      if (label) labelH = label.getBoundingClientRect().height;
      if (areaH === null || labelH === null) return;
      const next = { areaH, labelH };
      setM((prev) =>
        prev && prev.areaH === next.areaH && prev.labelH === next.labelH ? prev : next,
      );
    });
    ro.observe(area);
    ro.observe(labels);
    return () => ro.disconnect();
    // labelCount: re-observe when labels appear/disappear (no resize then).
  }, [areaRef, labelsRef, labelCount]);
  return m;
}

/**
 * Which threshold numbers to show and where (centre offset from the column
 * bottom). Unmeasured: all, at their line's %. Measured (spec §7.3 극단값 표시
 * 정책): each number sits at its line, held inside the column (never into the
 * `(ms)` row below or the text above); walking from the highest (most severe)
 * threshold down, a number that would overlap one already placed is dropped.
 * The dashed lines are always drawn.
 */
function placeLabels(
  thresholds: Threshold[],
  graphMaxMs: number,
  m: { areaH: number; labelH: number } | null,
): { index: number; offset: string }[] {
  if (m === null || m.labelH <= 0) {
    return thresholds.map((t, index) => ({ index, offset: fmtPct(pct(t.ms, graphMaxMs)) }));
  }
  const lo = m.labelH / 2;
  const hi = m.areaH - m.labelH / 2;
  if (hi < lo) return [];
  const placed: { index: number; offset: string }[] = [];
  let lastCentre = Infinity;
  for (let index = thresholds.length - 1; index >= 0; index--) {
    const raw = (pct(thresholds[index].ms, graphMaxMs) / 100) * m.areaH;
    const centre = Math.min(hi, Math.max(lo, raw));
    if (lastCentre - centre >= m.labelH - 0.01) {
      placed.push({ index, offset: `${+centre.toFixed(2)}px` });
      lastCentre = centre;
    }
  }
  return placed.reverse();
}

export function LatencyBars({
  results,
  barCount,
  graphMaxMs,
  thresholds,
  intervalSec,
  fontScale = 1,
  showInterval = false,
  inset = false,
}: {
  results: CheckResult[];
  barCount: number;
  graphMaxMs: number;
  thresholds: Threshold[];
  intervalSec: number;
  fontScale?: number;
  /** Panel intervals differ across the board -> show this panel's interval on its axis. */
  showInterval?: boolean;
  /** A (fill): the graph sits in a dark box (padding + COLOR.bg). */
  inset?: boolean;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const placed = placeLabels(
    thresholds,
    graphMaxMs,
    useLabelMetrics(areaRef, labelsRef, thresholds.length),
  );
  const slots = barSlots(results, barCount);
  const slotPad = `0 ${+(GAP_SHARE / 2 / Math.max(1, barCount)).toFixed(4)}%`;
  const axisFont = panelFont(PANEL_TEXT.axis, fontScale);
  const ago = ko.monitor.axisAgo(axisAgoLabel(barCount, intervalSec));

  return (
    <div
      data-testid="latency-bars"
      className="min-h-0 flex-1"
      style={{
        ...(inset
          ? {
              background: COLOR.bg,
              padding: `${GRAPH_CHROME.insetPad}cqw`,
              borderRadius: `${GRAPH_CHROME.insetRadius}cqw`,
            }
          : {}),
        // The board-wide shrink (--fit) is for panel text; axis and threshold
        // numbers keep their configured size (already small) to stay legible.
        ["--fit" as string]: "1",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gridTemplateRows: "minmax(0, 1fr) auto",
        columnGap: "1.6cqw",
        marginTop: `${GRAPH_CHROME.marginTop}cqw`,
      }}
    >
      <div
        ref={areaRef}
        data-testid="bars-area"
        className="relative min-h-0"
        style={{
          borderBottomWidth: AXIS_BORDER_WIDTH,
          borderBottomStyle: "solid",
          borderBottomColor: "#334155",
        }}
      >
        <div className="absolute inset-0 flex items-end" style={{ overflow: "hidden" }}>
          {slots.map((r, i) => {
            const base: CSSProperties = {
              flex: "1 1 0",
              minWidth: 0,
              padding: slotPad,
              backgroundClip: "content-box",
              position: "relative",
            };
            if (r === null) {
              return <div key={i} data-testid="bar-slot" data-empty="" style={base} />;
            }
            if (r.verdict === "fail") {
              return (
                <div
                  key={i}
                  data-testid="bar-slot"
                  data-verdict="fail"
                  style={{
                    ...base,
                    height: "100%",
                    backgroundColor: FAIL_BASE,
                    backgroundImage: FAIL_STRIPES,
                  }}
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 -translate-x-1/2 leading-none"
                    style={{
                      top: "0.6cqw",
                      color: "#fff",
                      fontSize: panelFont(PANEL_TEXT.failMark, fontScale),
                    }}
                  >
                    ✖
                  </span>
                </div>
              );
            }
            if (r.verdict === "config_error") {
              return (
                <div
                  key={i}
                  data-testid="bar-slot"
                  data-verdict="config_error"
                  style={{
                    ...base,
                    height: "100%",
                    backgroundColor: CONFIG_BASE,
                    backgroundImage: CONFIG_STRIPES,
                  }}
                />
              );
            }
            const latency = r.latency_ms ?? 0;
            return (
              <div
                key={i}
                data-testid="bar-slot"
                data-verdict="ok"
                style={{
                  ...base,
                  height: fmtPct(pct(latency, graphMaxMs)),
                  backgroundColor: barColor(latency, thresholds),
                }}
              />
            );
          })}
        </div>
        {thresholds.map((t) => (
          <span
            key={`${t.ms}-${t.color}`}
            data-testid="threshold-line"
            className="pointer-events-none absolute inset-x-0"
            style={{
              bottom: fmtPct(pct(t.ms, graphMaxMs)),
              borderTop: `0.55cqw dashed ${t.color}`,
              // centre the stroke on its height, where the label is centred too
              transform: "translateY(50%)",
              zIndex: 2,
            }}
          />
        ))}
      </div>

      {/* Threshold numbers: a sibling column, never inside the bars area. All
          labels share one grid cell, so the column is as wide as the longest. */}
      <div
        ref={labelsRef}
        data-testid="threshold-labels"
        className="min-h-0"
        style={{
          display: "grid",
          gridTemplate: "minmax(0, 1fr) / auto",
          borderBottomWidth: AXIS_BORDER_WIDTH,
          borderBottomStyle: "solid",
          borderBottomColor: "transparent",
        }}
      >
        {placed.map(({ index, offset }) => {
          const t = thresholds[index];
          return (
            <div
              key={`${t.ms}-${t.color}`}
              data-testid="threshold-label"
              className="flex min-h-0 flex-col justify-end"
              style={{ gridArea: "1 / 1" }}
            >
              <span
                className="whitespace-nowrap font-extrabold"
                style={{
                  color: t.color,
                  fontSize: panelFont(PANEL_TEXT.threshold, fontScale),
                  // >= the glyph box (~1.18em), so the measured height that
                  // spaces numbers apart covers what is actually painted
                  lineHeight: 1.2,
                  transform: "translateY(50%)",
                }}
              >
                {t.ms.toLocaleString("en-US")}
              </span>
              <div data-testid="threshold-label-offset" style={{ height: offset, flexShrink: 0 }} />
            </div>
          );
        })}
      </div>

      <div
        className="flex justify-between gap-[2cqw] whitespace-nowrap"
        style={{
          fontSize: axisFont,
          lineHeight: AXIS_LINE_HEIGHT,
          color: COLOR.axis,
          marginTop: `${GRAPH_CHROME.axisMarginTop}cqw`,
        }}
      >
        <span>{showInterval ? `${ago} · ${ko.monitor.everyN(intervalSec)}` : ago}</span>
        <span>{ko.monitor.axisNow}</span>
      </div>
      <div
        className="whitespace-nowrap"
        style={{
          fontSize: axisFont,
          lineHeight: AXIS_LINE_HEIGHT,
          color: COLOR.axis,
          marginTop: `${GRAPH_CHROME.axisMarginTop}cqw`,
        }}
      >
        {placed.length > 0 ? ko.monitor.axisUnit : null}
      </div>
    </div>
  );
}
