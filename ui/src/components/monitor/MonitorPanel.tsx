import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelConfig } from "../../api/monitors";
import { barColor, bigValueText, showConsecutive, type PanelState } from "../../monitor/logic";
import {
  COLOR,
  PANEL_BOX,
  PANEL_TEXT,
  graphFits,
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

/** What a panel reports to the board for the uniform shrink (spec §7.3). */
export type PanelMeasure = {
  w: number;
  h: number;
  /** Text block height, measured at `fit`. */
  textH: number;
  fit: number;
  /** Scale at which every one-line value fits its width (Infinity = all fit). */
  widthNeed: number;
};

/**
 * Measures the panel and its text block after every render and on resize, and
 * reports to the board (which picks one scale for all panels). Decides the graph
 * locally: spec §7.3 "글자 우선" — no graph when < 15% of the panel height is
 * left below the text. Unmeasured (jsdom, first paint) -> graph shown.
 */
function usePanelMeasure(
  id: string,
  panelRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
  fit: number,
  onMeasure: ((id: string, m: PanelMeasure) => void) | undefined,
): boolean {
  const [dims, setDims] = useState<{ w: number; h: number; textH: number } | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const measure = useCallback(() => {
    const panelEl = panelRef.current;
    const textEl = textRef.current;
    if (!panelEl || !textEl) return;
    const pr = panelEl.getBoundingClientRect();
    const textH = textEl.getBoundingClientRect().height;
    if (pr.width <= 0 || pr.height <= 0) return;
    let widthNeed = Infinity;
    textEl.querySelectorAll<HTMLElement>("[data-fit-line]").forEach((el) => {
      const box = el.clientWidth;
      const natural = el.scrollWidth;
      if (box > 0 && natural > box + 0.5) {
        widthNeed = Math.min(widthNeed, fitRef.current * (box / natural) * 0.98);
      }
    });
    setDims((prev) =>
      prev && prev.w === pr.width && prev.h === pr.height && prev.textH === textH
        ? prev
        : { w: pr.width, h: pr.height, textH },
    );
    onMeasureRef.current?.(id, {
      w: pr.width,
      h: pr.height,
      textH,
      fit: fitRef.current,
      widthNeed,
    });
  }, [id, panelRef, textRef]);

  // Every render: values change every poll (a wider number, a new reason).
  // Passive, not layout: shrinking can take several steps (wrapping is not
  // linear), and chained layout-effect updates would hit React's nested-update
  // limit (#185, found live).
  useEffect(() => {
    measure();
  });

  useEffect(() => {
    const panelEl = panelRef.current;
    const textEl = textRef.current;
    if (!panelEl || !textEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(panelEl);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [measure, panelRef, textRef]);

  if (dims === null) return true;
  return graphFits(dims);
}

export function MonitorPanel({
  panel,
  status,
  state,
  fontScale,
  blinkOn,
  showInterval = false,
  fit = 1,
  onMeasure,
}: {
  panel: PanelConfig;
  status: PanelStatus | undefined;
  state: PanelState;
  fontScale: number;
  blinkOn: boolean;
  showInterval?: boolean;
  /** Board-wide text scale (1 = configured size); the same for every panel. */
  fit?: number;
  onMeasure?: (id: string, m: PanelMeasure) => void;
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

  const graph = usePanelMeasure(panel.id, panelRef, textRef, fit, onMeasure);

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
