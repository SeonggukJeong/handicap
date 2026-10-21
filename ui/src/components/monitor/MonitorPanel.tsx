import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelConfig } from "../../api/monitors";
import { barColor, bigValueText, showConsecutive, type PanelState } from "../../monitor/logic";
import {
  COLOR,
  PANEL_BOX,
  PANEL_TEXT,
  boxContentHeight,
  graphFits as graphFitsFor,
  panelFont,
  splitReason,
  type PanelStatus,
} from "../../monitor/display";
import { formatHms } from "../../monitor/time";
import { ko } from "../../i18n/ko";
import { FitLine } from "./FitLine";
import { LatencyBars } from "./LatencyBars";

const STATE_LABEL: Record<PanelState, string> = {
  ok: ko.monitor.stateOk,
  slow: ko.monitor.stateSlow,
  fail: ko.monitor.stateFail,
  config_error: ko.monitor.stateConfigError,
  stale: ko.monitor.stateStale,
  stale_off: ko.monitor.stateStaleOff,
  pending: ko.monitor.statePending,
};

/** Never shrink text below this share of its configured size. */
const MIN_FIT = 0.3;

/**
 * Measures the panel (`w`x`h`) and the text block, and derives:
 * - `fit`: shrink factor for all panel text, < 1 only when the text block is
 *   taller than the panel's content box (reset to 1 whenever the panel size or
 *   the content changes, then shrunk once per new text measurement);
 * - `graph`: spec §7.3 "글자 우선" — the graph (bars + axis + labels) renders
 *   only when the bars area would get >= 15% of the panel height.
 * Unmeasured (first paint, or no ResizeObserver) -> fit 1, graph shown.
 */
function usePanelLayout(
  panelRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
  fontScale: number,
  contentKey: string,
): { fit: number; graph: boolean } {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [textH, setTextH] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const shrunkFor = useRef<number | null>(null);

  useEffect(() => {
    const panelEl = panelRef.current;
    const textEl = textRef.current;
    if (!panelEl || !textEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === panelEl) {
          const { width: w, height: h } = e.contentRect;
          setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
        } else if (e.target === textEl) {
          setTextH(e.contentRect.height);
        }
      }
    });
    ro.observe(panelEl);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [panelRef, textRef]);

  const w = size?.w;
  const h = size?.h;
  useLayoutEffect(() => {
    shrunkFor.current = null;
    setFit(1);
  }, [w, h, contentKey]);

  useEffect(() => {
    if (w === undefined || h === undefined || textH === null) return;
    if (shrunkFor.current === textH) return;
    const content = boxContentHeight(w, h);
    if (textH > content + 0.5 && fit > MIN_FIT) {
      shrunkFor.current = textH;
      setFit((f) => Math.max(MIN_FIT, f * (content / textH) * 0.98));
    }
  }, [w, h, textH, fit]);

  if (w === undefined || h === undefined || textH === null) return { fit, graph: true };
  return { fit, graph: graphFitsFor({ w, h, textH, fontScale, fit }) };
}

export function MonitorPanel({
  panel,
  status,
  state,
  fontScale,
  blinkOn,
  showInterval = false,
}: {
  panel: PanelConfig;
  status: PanelStatus | undefined;
  state: PanelState;
  fontScale: number;
  blinkOn: boolean;
  showInterval?: boolean;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const results = status?.results ?? [];
  const latest = results.length > 0 ? results[results.length - 1] : undefined;

  const stateColor =
    state === "ok"
      ? COLOR.ok
      : state === "slow"
        ? barColor(latest?.latency_ms ?? 0, panel.thresholds)
        : state === "fail"
          ? COLOR.fail
          : COLOR.gray;
  const borderColor =
    state === "ok" || state === "slow" || state === "fail" ? stateColor : COLOR.grayBorder;
  // Mockup v4: a healthy value reads white; slow/fail take the state color.
  const bigColor = state === "ok" ? COLOR.text : stateColor;
  const isReason = state === "fail" || state === "config_error";
  const bigText = bigValueText(state, latest);
  // Fail reason: fixed part big on one line, step-name part small below.
  const reason = isReason ? splitReason(bigText) : null;

  const consecutive =
    state === "fail" &&
    status !== undefined &&
    showConsecutive(status.consecutive_fail) &&
    status.fail_since_ms !== null
      ? ko.monitor.consecutive(status.consecutive_fail, formatHms(status.fail_since_ms))
      : null;

  const { fit, graph } = usePanelLayout(
    panelRef,
    textRef,
    fontScale,
    `${panel.title}|${state}|${bigText}|${consecutive ?? ""}|${fontScale}`,
  );

  return (
    <article
      ref={panelRef}
      data-testid="monitor-panel"
      aria-label={panel.title}
      className="relative min-h-0 min-w-0"
      style={{ containerType: "size" }}
    >
      <div
        data-testid="panel-box"
        data-state={state}
        data-blink={blinkOn ? "on" : undefined}
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={
          {
            "--fit": String(+fit.toFixed(4)),
            background: COLOR.panel,
            border: `${PANEL_BOX.border}cqw solid ${borderColor}`,
            borderRadius: `${PANEL_BOX.radius}cqw`,
            padding: `${PANEL_BOX.padTop}cqw ${PANEL_BOX.padSide}cqw ${PANEL_BOX.padBottom}cqw`,
          } as React.CSSProperties
        }
      >
        <div ref={textRef} data-testid="panel-text" className="shrink-0">
          {/* One row when title + state fit (mockup); otherwise the state wraps
              below and the title takes the full width, at most 2 lines. */}
          <div className="flex flex-wrap items-baseline" style={{ columnGap: "2cqw" }}>
            <h2
              className="line-clamp-2 min-w-0 break-keep font-extrabold leading-tight [overflow-wrap:anywhere]"
              style={{ fontSize: panelFont(PANEL_TEXT.title, fontScale) }}
            >
              {panel.title}
            </h2>
            <div
              className="ml-auto max-w-full break-keep text-right font-black leading-tight"
              style={{
                fontSize: panelFont(PANEL_TEXT.state, fontScale),
                color: stateColor,
              }}
            >
              {STATE_LABEL[state]}
            </div>
          </div>
          {reason ? (
            <>
              <FitLine
                text={reason.fixed}
                fontSize={panelFont(PANEL_TEXT.reason, fontScale)}
                className="text-right font-black leading-tight"
                style={{ color: bigColor, marginTop: "0.8cqw", letterSpacing: "-0.02em" }}
              />
              {reason.step !== null && (
                <div
                  className="truncate text-right font-bold leading-tight"
                  style={{
                    fontSize: panelFont(PANEL_TEXT.step, fontScale),
                    color: bigColor,
                    marginTop: "0.4cqw",
                  }}
                >
                  {reason.step}
                </div>
              )}
            </>
          ) : (
            <FitLine
              text={bigText}
              fontSize={panelFont(PANEL_TEXT.big, fontScale)}
              className="text-right font-black"
              // = the font's content area (~1.18em): the glyph box never pokes
              // into the state row above or the line below.
              style={{ color: bigColor, lineHeight: 1.18, letterSpacing: "-0.02em" }}
            />
          )}
          {consecutive && (
            <div
              className="truncate text-right font-bold"
              style={{
                fontSize: panelFont(PANEL_TEXT.consecutive, fontScale),
                color: COLOR.fail,
                marginTop: "0.6cqw",
              }}
            >
              {consecutive}
            </div>
          )}
        </div>
        {graph && (
          <LatencyBars
            results={results}
            barCount={panel.bar_count}
            graphMaxMs={panel.graph_max_ms}
            thresholds={panel.thresholds}
            intervalSec={panel.interval_seconds}
            fontScale={fontScale}
            showInterval={showInterval}
          />
        )}
      </div>
    </article>
  );
}
