import { useEffect, useRef, useState } from "react";
import type { PanelConfig } from "../../api/monitors";
import { barColor, bigValueText, showConsecutive, type PanelState } from "../../monitor/logic";
import {
  COLOR,
  GRAPH_MIN_SHARE,
  PANEL_TEXT,
  panelFont,
  type PanelStatus,
} from "../../monitor/display";
import { formatHms } from "../../monitor/time";
import { ko } from "../../i18n/ko";
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

/**
 * Graph-hide rule (spec §7.3 "글자 우선"): measures the panel box's content
 * height (inside border + padding — the space text and graph actually share)
 * and the text block; hides the graph when what is left is under 15%.
 */
function useGraphFits(
  panelRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
): boolean {
  const [heights, setHeights] = useState<{ panel: number; text: number } | null>(null);
  useEffect(() => {
    const panelEl = panelRef.current;
    const textEl = textRef.current;
    if (!panelEl || !textEl || typeof ResizeObserver === "undefined") return;
    let panel: number | null = null;
    let text: number | null = null;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === panelEl) panel = e.contentRect.height;
        else if (e.target === textEl) text = e.contentRect.height;
      }
      if (panel !== null && text !== null) {
        const next = { panel, text };
        setHeights((prev) =>
          prev && prev.panel === next.panel && prev.text === next.text ? prev : next,
        );
      }
    });
    ro.observe(panelEl);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [panelRef, textRef]);
  // Unmeasured (first paint, or no ResizeObserver) -> show the graph.
  if (heights === null) return true;
  return heights.panel - heights.text >= heights.panel * GRAPH_MIN_SHARE;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const graphFits = useGraphFits(panelRef, textRef);

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

  const consecutive =
    state === "fail" &&
    status !== undefined &&
    showConsecutive(status.consecutive_fail) &&
    status.fail_since_ms !== null
      ? ko.monitor.consecutive(status.consecutive_fail, formatHms(status.fail_since_ms))
      : null;

  return (
    <article
      data-testid="monitor-panel"
      aria-label={panel.title}
      className="relative min-h-0 min-w-0"
      style={{ containerType: "size" }}
    >
      <div
        ref={panelRef}
        data-testid="panel-box"
        data-state={state}
        data-blink={blinkOn ? "on" : undefined}
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={{
          background: COLOR.panel,
          border: `1cqw solid ${borderColor}`,
          borderRadius: "2cqw",
          padding: "2.4cqw 2.4cqw 2cqw",
        }}
      >
        <div ref={textRef} data-testid="panel-text" className="shrink-0">
          <div className="flex items-baseline justify-between" style={{ gap: "2cqw" }}>
            <h2
              className="min-w-0 flex-1 truncate font-extrabold leading-tight"
              style={{ fontSize: panelFont(PANEL_TEXT.title, fontScale) }}
            >
              {panel.title}
            </h2>
            <div
              className="break-keep text-right font-black leading-tight"
              style={{
                fontSize: panelFont(PANEL_TEXT.state, fontScale),
                color: stateColor,
                maxWidth: "72%",
              }}
            >
              {STATE_LABEL[state]}
            </div>
          </div>
          <div
            className={
              isReason
                ? "break-keep text-right font-black leading-tight [overflow-wrap:anywhere]"
                : "whitespace-nowrap text-right font-black leading-none"
            }
            style={{
              fontSize: panelFont(isReason ? PANEL_TEXT.reason : PANEL_TEXT.big, fontScale),
              color: bigColor,
              marginTop: "0.8cqw",
              letterSpacing: "-0.02em",
            }}
          >
            {bigValueText(state, latest)}
          </div>
          {consecutive && (
            <div
              className="text-right font-bold"
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
        {graphFits && (
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
