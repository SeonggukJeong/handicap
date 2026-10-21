import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CheckResult, Threshold } from "../../api/monitors";
import { axisAgoLabel, barColor, barSlots } from "../../monitor/logic";
import { COLOR, PANEL_TEXT, panelFont } from "../../monitor/display";
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
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) if (e.target === area) areaH = e.contentRect.height;
      const label = labels.querySelector("span");
      if (areaH === null || !label) return;
      const next = { areaH, labelH: label.getBoundingClientRect().height };
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
 * Label offsets from the bottom of the column. Unmeasured: the line's height in
 * %. Measured: px, pushed up so close thresholds' numbers never overlap
 * (thresholds are ascending).
 */
function labelOffsets(
  thresholds: Threshold[],
  graphMaxMs: number,
  m: { areaH: number; labelH: number } | null,
): string[] {
  if (m === null || m.labelH <= 0) return thresholds.map((t) => fmtPct(pct(t.ms, graphMaxMs)));
  const out: string[] = [];
  let prev = -Infinity;
  for (const t of thresholds) {
    const px = Math.max((pct(t.ms, graphMaxMs) / 100) * m.areaH, prev + m.labelH);
    out.push(`${+px.toFixed(2)}px`);
    prev = px;
  }
  return out;
}

export function LatencyBars({
  results,
  barCount,
  graphMaxMs,
  thresholds,
  intervalSec,
  fontScale = 1,
  showInterval = false,
}: {
  results: CheckResult[];
  barCount: number;
  graphMaxMs: number;
  thresholds: Threshold[];
  intervalSec: number;
  fontScale?: number;
  /** Panel intervals differ across the board -> show this panel's interval on its axis. */
  showInterval?: boolean;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const offsets = labelOffsets(thresholds, graphMaxMs, useLabelMetrics(areaRef, labelsRef, thresholds.length));
  const slots = barSlots(results, barCount);
  const slotPad = `0 ${+(GAP_SHARE / 2 / Math.max(1, barCount)).toFixed(4)}%`;
  const axisFont = panelFont(PANEL_TEXT.axis, fontScale);
  const ago = ko.monitor.axisAgo(axisAgoLabel(barCount, intervalSec));

  return (
    <div
      className="min-h-0 flex-1"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gridTemplateRows: "minmax(0, 1fr) auto",
        columnGap: "1.6cqw",
        marginTop: "2cqw",
      }}
    >
      <div
        ref={areaRef}
        data-testid="bars-area"
        className="relative min-h-0"
        style={{ borderBottom: "0.4cqw solid #334155" }}
      >
        <div className="absolute inset-0 flex items-end">
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
        style={{ display: "grid", gridTemplate: "minmax(0, 1fr) / auto" }}
      >
        {thresholds.map((t, i) => (
          <div
            key={`${t.ms}-${t.color}`}
            className="flex min-h-0 flex-col justify-end"
            style={{ gridArea: "1 / 1" }}
          >
            <span
              className="whitespace-nowrap font-extrabold leading-none"
              style={{
                color: t.color,
                fontSize: panelFont(PANEL_TEXT.threshold, fontScale),
                transform: "translateY(50%)",
              }}
            >
              {t.ms.toLocaleString("en-US")}
            </span>
            <div
              data-testid="threshold-label-offset"
              style={{ height: offsets[i], flexShrink: 0 }}
            />
          </div>
        ))}
      </div>

      <div
        className="flex justify-between gap-[2cqw] whitespace-nowrap"
        style={{ fontSize: axisFont, color: COLOR.axis, marginTop: "0.6cqw" }}
      >
        <span>{showInterval ? `${ago} · ${ko.monitor.everyN(intervalSec)}` : ago}</span>
        <span>{ko.monitor.axisNow}</span>
      </div>
      <div
        className="whitespace-nowrap"
        style={{ fontSize: axisFont, color: COLOR.axis, marginTop: "0.6cqw" }}
      >
        {thresholds.length > 0 ? ko.monitor.axisUnit : null}
      </div>
    </div>
  );
}
