import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelConfig } from "../../api/monitors";
import {
  barColor,
  bigValueText,
  formatMs,
  showConsecutive,
  type PanelState,
} from "../../monitor/logic";
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
import { WIDEST_REASON_CANDIDATES } from "../../monitor/reasons";
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

/** What a size probe reports to the board for the uniform scale (spec §7.3). */
export type PanelMeasure = {
  w: number;
  h: number;
  /** Text block height, measured at `fit`. */
  textH: number;
  fit: number;
  /** Scale at which every one-line value fits its width (Infinity = all fit). */
  widthNeed: number;
  /** Extra scale at which every reason-probe line fits (Infinity = all fit). */
  reasonNeed: number;
};

/** Measures `boxRef`/`textRef` after every render (passive) and on resize. */
function useBoxMeasure(
  boxRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
  fit: number,
  onMeasure: (m: PanelMeasure) => void,
): void {
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const measure = useCallback(() => {
    const boxEl = boxRef.current;
    const textEl = textRef.current;
    if (!boxEl || !textEl) return;
    const r = boxEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    let widthNeed = Infinity;
    textEl.querySelectorAll<HTMLElement>("[data-fit-line]").forEach((el) => {
      const box = el.clientWidth;
      const natural = el.scrollWidth;
      if (box > 0 && natural > box + 0.5) {
        widthNeed = Math.min(widthNeed, fitRef.current * (box / natural) * 0.98);
      }
    });
    let reasonNeed = Infinity;
    boxEl.querySelectorAll<HTMLElement>("[data-reason-probe]").forEach((el) => {
      const box = el.clientWidth;
      const natural = el.scrollWidth;
      if (box > 0 && natural > box + 0.5) {
        reasonNeed = Math.min(reasonNeed, (box / natural) * 0.98);
      }
    });
    onMeasureRef.current({
      w: r.width,
      h: r.height,
      textH: textEl.getBoundingClientRect().height,
      fit: fitRef.current,
      widthNeed,
      reasonNeed,
    });
  }, [boxRef, textRef]);

  // Passive, not layout: the board's step-down can take several updates, and
  // chained layout-effect updates hit React's nested-update limit (#185, live).
  useEffect(() => {
    measure();
  });

  useEffect(() => {
    const boxEl = boxRef.current;
    const textEl = textRef.current;
    if (!boxEl || !textEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(boxEl);
    ro.observe(textEl);
    return () => ro.disconnect();
  }, [measure, boxRef, textRef]);
}

const BOX_STYLE = (fit: number, borderColor: string): React.CSSProperties =>
  ({
    "--fit": String(+fit.toFixed(4)),
    border: `${PANEL_BOX.border}cqw solid ${borderColor}`,
    borderRadius: `${PANEL_BOX.radius}cqw`,
    padding: `${PANEL_BOX.padTop}cqw ${PANEL_BOX.padSide}cqw ${PANEL_BOX.padBottom}cqw`,
  }) as React.CSSProperties;

/**
 * Title + state: one row when they fit (mockup); otherwise the state wraps below
 * and the title takes the full width, at most 2 lines. Shared by the panel and
 * its size probe so both lay out identically.
 */
function TitleStateRow({
  title,
  stateLabel,
  stateColor,
  fontScale,
  heading,
}: {
  title: string;
  stateLabel: string;
  stateColor: string;
  fontScale: number;
  heading: boolean;
}) {
  const titleClass =
    "line-clamp-2 min-w-0 break-keep font-extrabold leading-tight [overflow-wrap:anywhere]";
  const titleStyle = { fontSize: panelFont(PANEL_TEXT.title, fontScale) };
  return (
    <div className="flex flex-wrap items-baseline" style={{ columnGap: "2cqw" }}>
      {heading ? (
        <h2 className={titleClass} style={titleStyle}>
          {title}
        </h2>
      ) : (
        <div className={titleClass} style={titleStyle}>
          {title}
        </div>
      )}
      <div
        className="ml-auto max-w-full break-keep text-right font-black leading-tight"
        style={{ fontSize: panelFont(PANEL_TEXT.state, fontScale), color: stateColor }}
      >
        {stateLabel}
      </div>
    </div>
  );
}

/** Shared by the real reason line and its probe so both measure the same. */
const REASON_CLASS = "font-black leading-tight";
const REASON_STYLE: React.CSSProperties = { letterSpacing: "-0.02em" };

function BigValueLine({
  text,
  color,
  fontScale,
}: {
  text: string;
  color: string;
  fontScale: number;
}) {
  return (
    <FitLine
      text={text}
      fontSize={panelFont(PANEL_TEXT.big, fontScale)}
      className="text-right font-black"
      // = the font's content area (~1.18em): the glyph box never pokes into the
      // state row above or the line below.
      style={{ color, lineHeight: 1.18, letterSpacing: "-0.02em" }}
    />
  );
}

/**
 * Invisible stand-in that fixes the board scales from settings only (spec §7.3
 * 축소 비율은 설정으로 고정). Its text block holds the panel's title, the
 * longest state label that can appear while checking runs (`⚠ 설정 오류`,
 * wrapped below the title when it doesn't fit beside it) and a one-line value
 * at the widest the panel can show (its timeout in ms); that sets `--fit`.
 * Below it, the widest fixed reasons at reason size set the reason line's own
 * `--reason-fit` (R18). Live lines (reason, step name, consecutive fails, the
 * stopped-only `점검 꺼짐` label) never reach it, so neither scale moves during
 * an incident; those lines take room from that panel's graph instead.
 */
export function PanelProbe({
  panel,
  fontScale,
  fit,
  onMeasure,
}: {
  panel: PanelConfig;
  fontScale: number;
  fit: number;
  onMeasure: (id: string, m: PanelMeasure) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useBoxMeasure(boxRef, textRef, fit, (m) => onMeasure(panel.id, m));
  return (
    <div
      ref={boxRef}
      data-testid="panel-probe"
      data-title={panel.title}
      className="relative min-h-0 min-w-0"
      style={{ containerType: "size" }}
    >
      <div
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={BOX_STYLE(fit, "transparent")}
      >
        <div ref={textRef} data-testid="probe-text" className="shrink-0">
          <TitleStateRow
            title={panel.title}
            stateLabel={ko.monitor.stateConfigError}
            stateColor="transparent"
            fontScale={fontScale}
            heading={false}
          />
          <BigValueLine
            text={formatMs(panel.timeout_seconds * 1000)}
            color="transparent"
            fontScale={fontScale}
          />
        </div>
        {WIDEST_REASON_CANDIDATES.map((r) => (
          <div
            key={r}
            data-testid="reason-probe"
            data-reason-probe=""
            className={`overflow-hidden whitespace-nowrap ${REASON_CLASS}`}
            style={{ ...REASON_STYLE, fontSize: panelFont(PANEL_TEXT.reason, fontScale) }}
          >
            {r}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Graph-hide rule (spec §7.3 "글자 우선"): the panel's own text (including live
 * lines) is measured; no graph when < 15% of the panel height is left below it,
 * or when the bars area itself would be < 8% (see `graphFits`).
 * Unmeasured (jsdom, first paint) -> graph shown.
 */
function useGraphShown(
  panelRef: React.RefObject<HTMLElement>,
  textRef: React.RefObject<HTMLElement>,
  fit: number,
  fontScale: number,
): boolean {
  const [dims, setDims] = useState<{ w: number; h: number; textH: number } | null>(null);
  useBoxMeasure(panelRef, textRef, fit, (m) =>
    setDims((prev) =>
      prev && prev.w === m.w && prev.h === m.h && prev.textH === m.textH
        ? prev
        : { w: m.w, h: m.h, textH: m.textH },
    ),
  );
  if (dims === null) return true;
  return graphFits({ ...dims, fontScale });
}

export function MonitorPanel({
  panel,
  status,
  state,
  fontScale,
  blinkOn,
  showInterval = false,
  fit = 1,
  reasonFit = 1,
}: {
  panel: PanelConfig;
  status: PanelStatus | undefined;
  state: PanelState;
  fontScale: number;
  blinkOn: boolean;
  showInterval?: boolean;
  /** Board-wide text scale (1 = configured size); the same for every panel. */
  fit?: number;
  /** Board-wide extra scale for the reason line only (R18). */
  reasonFit?: number;
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

  const graph = useGraphShown(panelRef, textRef, fit, fontScale);

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
            ...BOX_STYLE(fit, borderColor),
            "--reason-fit": String(+reasonFit.toFixed(4)),
            background: COLOR.panel,
          } as React.CSSProperties
        }
      >
        <div ref={textRef} data-testid="panel-text" className="shrink-0">
          <TitleStateRow
            title={panel.title}
            stateLabel={STATE_LABEL[state]}
            stateColor={stateColor}
            fontScale={fontScale}
            heading
          />
          {reason ? (
            <>
              <FitLine
                text={reason.fixed}
                // the reason's own settings scale (R18): the widest fixed
                // reason always fits on one line, no "…"
                fontSize={`calc(${panelFont(PANEL_TEXT.reason, fontScale)} * var(--reason-fit, 1))`}
                className={`text-right ${REASON_CLASS}`}
                style={{ ...REASON_STYLE, color: bigColor, marginTop: "0.8cqw" }}
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
            <BigValueLine text={bigText} color={bigColor} fontScale={fontScale} />
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
