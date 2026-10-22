import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { DisplayStyle, PanelConfig } from "../../api/monitors";
import { bigValueText, formatMs, showConsecutive, type PanelState } from "../../monitor/logic";
import {
  COLOR,
  PANEL_BOX,
  STATE_LABEL,
  borderColorOf,
  stateColorOf,
  PANEL_TEXT,
  fillBackground,
  graphFits,
  contrastText,
  panelFont,
  reasonParts,
  type PanelStatus,
} from "../../monitor/display";
import { formatHms } from "../../monitor/time";
import { ko } from "../../i18n/ko";
import { WIDEST_REASON_CANDIDATES } from "../../monitor/reasons";
import { FitLine } from "./FitLine";
import { LatencyBars } from "./LatencyBars";

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
  titleColor,
}: {
  title: string;
  stateLabel: string;
  stateColor: string;
  fontScale: number;
  heading: boolean;
  titleColor?: string;
}) {
  const titleClass =
    "line-clamp-2 min-w-0 break-keep font-extrabold leading-tight [overflow-wrap:anywhere]";
  const titleStyle = {
    fontSize: panelFont(PANEL_TEXT.title, fontScale),
    ...(titleColor ? { color: titleColor } : {}),
  };
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
 *
 * Memoized: the board re-renders every status poll, and a probe re-measures on
 * every render it gets. Props are settings and search state only; `searchDone`
 * forces the one re-measure on the render where the search completes (that
 * measurement sets the reason scale, and `fit` may not change on that render).
 */
export const PanelProbe = memo(function PanelProbe({
  panel,
  fontScale,
  fit,
  onMeasure,
  reportId,
  cell,
}: {
  panel: PanelConfig;
  fontScale: number;
  fit: number;
  /** Changes when the board's scale search completes (re-measure trigger). */
  searchDone: boolean;
  onMeasure: (id: string, m: PanelMeasure) => void;
  /** Id reported with each measurement (default: the panel id). */
  reportId?: string;
  /** Grid cell to occupy (C incident probes stack every panel in one cell). */
  cell?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const id = reportId ?? panel.id;
  useBoxMeasure(boxRef, textRef, fit, (m) => onMeasure(id, m));
  return (
    <div
      ref={boxRef}
      data-testid="panel-probe"
      data-title={panel.title}
      className="relative min-h-0 min-w-0"
      style={
        cell === undefined ? { containerType: "size" } : { containerType: "size", gridArea: cell }
      }
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
});

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
  inset: boolean,
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
  return graphFits({ ...dims, fontScale, inset });
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
  displayStyle = "border",
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
  /** Board display style; `focus` renders like `border` here (C layout is the board's). */
  displayStyle?: DisplayStyle;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const results = status?.results ?? [];
  const latest = results.length > 0 ? results[results.length - 1] : undefined;

  const stateColor = stateColorOf(state, latest?.latency_ms ?? null, panel.thresholds);
  const borderColor = borderColorOf(state, stateColor);
  // Mockup v4: a healthy value reads white; slow/fail take the state color.
  const fillBg =
    displayStyle === "fill"
      ? fillBackground(state, latest?.latency_ms ?? null, panel.thresholds)
      : null;
  // A: the background is the state; every text uses one contrast colour.
  const ink = fillBg === null ? null : contrastText(fillBg);
  const bigColor = ink ?? (state === "ok" ? COLOR.text : stateColor);
  const isReason = state === "fail" || state === "config_error";
  const bigText = bigValueText(state, latest);
  // Fail reason: fixed part big on one line, step-name part small below.
  const reason = isReason ? reasonParts(bigText, latest?.detail ?? null) : null;
  const smallLine = reason === null ? null : reason.kind === "split" ? reason.step : reason.small;

  const consecutive =
    state === "fail" &&
    status !== undefined &&
    showConsecutive(status.consecutive_fail) &&
    status.fail_since_ms !== null
      ? ko.monitor.consecutive(status.consecutive_fail, formatHms(status.fail_since_ms))
      : null;

  const graph = useGraphShown(panelRef, textRef, fit, fontScale, fillBg !== null);

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
            ...BOX_STYLE(fit, fillBg ?? borderColor),
            "--reason-fit": String(+reasonFit.toFixed(4)),
            background: fillBg ?? COLOR.panel,
          } as React.CSSProperties
        }
      >
        <div ref={textRef} data-testid="panel-text" className="shrink-0">
          <TitleStateRow
            title={panel.title}
            stateLabel={STATE_LABEL[state]}
            stateColor={ink ?? stateColor}
            fontScale={fontScale}
            titleColor={ink ?? undefined}
            heading
          />
          {reason ? (
            <>
              {reason.kind === "not_contained" ? (
                <div
                  data-testid="reason-not-contained"
                  className={`flex justify-end whitespace-nowrap ${REASON_CLASS}`}
                  style={{
                    ...REASON_STYLE,
                    color: bigColor,
                    marginTop: "0.8cqw",
                    fontSize: `calc(${panelFont(PANEL_TEXT.reason, fontScale)} * var(--reason-fit, 1))`,
                  }}
                >
                  <span className="shrink-0">&quot;</span>
                  <span className="min-w-0 truncate">{reason.needle}</span>
                  <span className="shrink-0 whitespace-nowrap">&quot; 포함 안 됨</span>
                </div>
              ) : (
                <FitLine
                  text={reason.kind === "detail" ? reason.big : reason.fixed}
                  // the reason's own settings scale (R18): the widest fixed
                  // reason always fits on one line, no "…"
                  fontSize={`calc(${panelFont(PANEL_TEXT.reason, fontScale)} * var(--reason-fit, 1))`}
                  className={`text-right ${REASON_CLASS}`}
                  style={{ ...REASON_STYLE, color: bigColor, marginTop: "0.8cqw" }}
                />
              )}
              {smallLine !== null && (
                <div
                  className="truncate text-right font-bold leading-tight"
                  style={{
                    fontSize: panelFont(PANEL_TEXT.step, fontScale),
                    color: bigColor,
                    marginTop: "0.4cqw",
                  }}
                >
                  {smallLine}
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
                color: ink ?? COLOR.fail,
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
            inset={fillBg !== null}
          />
        )}
      </div>
    </article>
  );
}
