import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CheckResult, DisplayStyle, PanelConfig } from "../../api/monitors";
import {
  bigValueText,
  formatMs,
  formatStatNum,
  latencyStats,
  showConsecutive,
  type PanelState,
} from "../../monitor/logic";
import {
  COLOR,
  PANEL_BOX,
  STATE_LABEL,
  LONGEST_LIVE_STATE_LABEL,
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
  /** Extra scale at which every split-row probe line fits (Infinity = all fit). */
  splitNeed: number;
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
    let splitNeed = Infinity;
    boxEl.querySelectorAll<HTMLElement>("[data-split-probe]").forEach((el) => {
      const box = el.clientWidth;
      const natural = el.scrollWidth;
      if (box > 0 && natural > box + 0.5) {
        splitNeed = Math.min(splitNeed, (box / natural) * 0.98);
      }
    });
    onMeasureRef.current({
      w: r.width,
      h: r.height,
      textH: textEl.getBoundingClientRect().height,
      fit: fitRef.current,
      widthNeed,
      reasonNeed,
      splitNeed,
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

const BOX_STYLE = (
  fit: number,
  borderColor: string,
  borderStyle: "solid" | "dashed" = "solid",
): React.CSSProperties =>
  ({
    "--fit": String(+fit.toFixed(4)),
    border: `${PANEL_BOX.border}cqw ${borderStyle} ${borderColor}`,
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

/** Half-and-half row of an item panel (spec §6.1, mockup 02 board 1). */
const SPLIT_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
  columnGap: "3cqw",
};
/** Split row big lines (left first value, right latency): the BigValueLine line box. */
const SPLIT_BIG_STYLE: React.CSSProperties = { lineHeight: 1.18 };

/**
 * `평균 N 최대 M` line. Shared by the real line and the size probes so bold
 * digits and the 3cqw gap measure the same. A probe (`probe` set) is
 * transparent; "fit" joins the width-need measure, "split" is the split probe's.
 * `gap` (default 3cqw) separates the two pairs; the real split-row line passes
 * one scaled by `--split-fit` like its text, since the split scale is measured
 * on the full-size probe (text + plain 3cqw).
 */
export function StatsLine({
  avg,
  max,
  fontSize,
  labelColor,
  numColor,
  probe,
  gap = "3cqw",
}: {
  avg: number;
  max: number;
  fontSize: string;
  labelColor: string;
  numColor: string;
  probe?: "fit" | "split";
  gap?: string;
}) {
  const probeAttrs =
    probe === undefined
      ? { "data-testid": "latency-stats" }
      : {
          "data-testid": "stats-probe",
          ...(probe === "fit" ? { "data-fit-line": "" } : { "data-split-probe": "" }),
        };
  const label = probe ? "transparent" : labelColor;
  const num = probe ? "transparent" : numColor;
  return (
    <div
      {...probeAttrs}
      className={`overflow-hidden whitespace-nowrap text-right ${
        probe === undefined ? "text-ellipsis" : ""
      }`}
      style={{ fontSize, marginTop: "0.6cqw" }}
    >
      <span style={{ color: label }}>{ko.monitor.statsAvg}</span>{" "}
      <b style={{ color: num }}>{formatStatNum(avg)}</b>{" "}
      <span style={{ marginLeft: gap, color: label }}>{ko.monitor.statsMax}</span>{" "}
      <b style={{ color: num }}>{formatStatNum(max)}</b>
    </div>
  );
}

/**
 * Invisible stand-in that fixes the board scales from settings only (spec §7.3
 * 축소 비율은 설정으로 고정). Its text block holds the panel's title, the
 * longest state label that can appear while checking runs (`⚠ 설정 오류`,
 * wrapped below the title when it doesn't fit beside it) and a one-line value
 * at the widest the panel can show (its timeout in ms); that sets `--fit`.
 * A panel with display items holds the half-and-half row instead (spec §6.2):
 * left, transparent placeholder lines (height only); right, the timeout ms and
 * the worst avg/max line as `data-split-probe` lines, which set the split row's
 * own `--split-fit` and never the board-wide `--fit` (D2.17).
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
  showStats,
}: {
  panel: PanelConfig;
  fontScale: number;
  fit: number;
  /** Board shows the avg/max line: the probe measures it too (required so no caller forgets). */
  showStats: boolean;
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
  const itemCount = Math.min(panel.display_items.length, 2);
  const worstMs = panel.timeout_seconds * 1000;
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
            stateLabel={LONGEST_LIVE_STATE_LABEL}
            stateColor="transparent"
            fontScale={fontScale}
            heading={false}
          />
          {itemCount > 0 ? (
            <div
              data-testid="probe-split"
              // stale/pending/config_error draw the full-width big line in an
              // item panel; reserve its box height (height only — widths stay
              // out of [data-fit-line], D2.17).
              style={{
                ...SPLIT_GRID,
                minHeight: `calc(${panelFont(PANEL_TEXT.big, fontScale)} * 1.18)`,
              }}
            >
              <div data-testid="probe-split-left" className="min-w-0">
                <div
                  className="font-black"
                  style={{
                    ...SPLIT_BIG_STYLE,
                    fontSize: panelFont(PANEL_TEXT.splitBig, fontScale),
                    color: "transparent",
                  }}
                >
                  {"\u00a0"}
                </div>
                {itemCount > 1 && (
                  <div
                    style={{
                      fontSize: panelFont(PANEL_TEXT.step, fontScale),
                      color: "transparent",
                    }}
                  >
                    {"\u00a0"}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div
                  data-split-probe=""
                  className="overflow-hidden whitespace-nowrap text-right font-black"
                  style={{
                    ...SPLIT_BIG_STYLE,
                    fontSize: panelFont(PANEL_TEXT.splitBig, fontScale),
                    color: "transparent",
                  }}
                >
                  {formatMs(worstMs)}
                </div>
                {showStats && (
                  <StatsLine
                    avg={worstMs}
                    max={worstMs}
                    fontSize={panelFont(PANEL_TEXT.stats, fontScale)}
                    labelColor="transparent"
                    numColor="transparent"
                    probe="split"
                  />
                )}
              </div>
            </div>
          ) : (
            <>
              <BigValueLine text={formatMs(worstMs)} color="transparent" fontScale={fontScale} />
              {showStats && (
                <StatsLine
                  avg={worstMs}
                  max={worstMs}
                  fontSize={panelFont(PANEL_TEXT.stats, fontScale)}
                  labelColor="transparent"
                  numColor="transparent"
                  probe="fit"
                />
              )}
            </>
          )}
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
  splitFit = 1,
  displayStyle = "border",
  showStats = false,
  onSelectResult,
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
  /** Board-wide extra scale for item panels' split row only (spec §6.2, D2.17). */
  splitFit?: number;
  /** Board display style; `focus` renders like `border` here (C layout is the board's). */
  displayStyle?: DisplayStyle;
  /** Board setting `show_latency_stats`: draw `평균 N 최대 M` under the big value. */
  showStats?: boolean;
  /** A bar was clicked: open that check's record. */
  onSelectResult?: (r: CheckResult) => void;
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
  // 확인 못 함 / 분기 제외 (mockup 03): quiet gray states — dim text vs a brighter value.
  const quiet = state === "blocked" || state === "skipped";
  const bigColor =
    ink ?? (state === "ok" ? COLOR.text : state === "skipped" ? COLOR.bright : stateColor);
  const smallColor = ink ?? (state === "blocked" ? COLOR.grayBorder : bigColor);
  const borderStyle = state === "skipped" ? "dashed" : "solid";
  const titleInk = ink ?? (quiet ? COLOR.soft : undefined);
  const isReason = state === "fail" || state === "config_error" || quiet;
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

  const stats =
    showStats && (state === "ok" || state === "slow" || state === "fail")
      ? latencyStats(results)
      : null;

  // Display-only values (spec §6.1): the latest result's, for the items set now;
  // a missing index (settings changed since that check), null or "" -> null.
  const itemCount = Math.min(panel.display_items.length, 2);
  const display = latest?.display ?? [];
  const valueAt = (i: number): string | null => {
    const v = display[i];
    return v === undefined || v === null || v === "" ? null : v;
  };
  const shownAt = (i: number) => valueAt(i) ?? ko.monitor.noValue;
  const split = itemCount > 0 && (state === "ok" || state === "slow");
  // Fail: one line under the consecutive line, omitted when nothing is drawable.
  const displayLine =
    itemCount > 0 &&
    state === "fail" &&
    Array.from({ length: itemCount }, (_, i) => valueAt(i)).some((v) => v !== null);
  const splitFont = (ratio: number) => `calc(${panelFont(ratio, fontScale)} * var(--split-fit, 1))`;

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
        data-border-style={borderStyle}
        data-blink={blinkOn ? "on" : undefined}
        className="absolute inset-0 flex flex-col overflow-hidden"
        style={
          {
            ...BOX_STYLE(fit, fillBg ?? borderColor, borderStyle),
            "--reason-fit": String(+reasonFit.toFixed(4)),
            "--split-fit": String(+splitFit.toFixed(4)),
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
            titleColor={titleInk}
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
              ) : state === "skipped" && reason.kind === "detail" && reason.big.includes(" = ") ? (
                // target shrinks first so the value (`= false`) stays readable
                <div
                  data-testid="reason-skipped-split"
                  title={reason.big}
                  className={`flex min-w-0 justify-end overflow-hidden whitespace-nowrap ${REASON_CLASS}`}
                  style={{
                    ...REASON_STYLE,
                    color: bigColor,
                    marginTop: "0.8cqw",
                    fontSize: `calc(${panelFont(PANEL_TEXT.reason, fontScale)} * var(--reason-fit, 1))`,
                  }}
                >
                  <span className="min-w-0 truncate">
                    {reason.big.slice(0, reason.big.indexOf(" = "))}
                  </span>
                  <span className="ml-[0.3em] max-w-[70%] shrink-0 truncate">
                    {reason.big.slice(reason.big.indexOf(" = ") + 1)}
                  </span>
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
                    color: smallColor,
                    marginTop: "0.4cqw",
                  }}
                >
                  {smallLine}
                </div>
              )}
            </>
          ) : split ? (
            <div data-testid="split-row" style={SPLIT_GRID}>
              <div data-testid="split-left" className="min-w-0">
                <div
                  className="truncate text-left font-black"
                  style={{
                    ...SPLIT_BIG_STYLE,
                    fontSize: splitFont(PANEL_TEXT.splitBig),
                    color: ink ?? COLOR.text,
                  }}
                >
                  {shownAt(0)}
                </div>
                {itemCount > 1 && (
                  <div
                    className="truncate text-left"
                    style={{ fontSize: splitFont(PANEL_TEXT.step), color: ink ?? COLOR.soft }}
                  >
                    {shownAt(1)}
                  </div>
                )}
              </div>
              <div data-testid="split-right" className="min-w-0">
                <div
                  className="truncate text-right font-black"
                  style={{
                    ...SPLIT_BIG_STYLE,
                    fontSize: splitFont(PANEL_TEXT.splitBig),
                    color: bigColor,
                  }}
                >
                  {bigText}
                </div>
                {stats && (
                  <StatsLine
                    avg={stats.avg}
                    max={stats.max}
                    fontSize={splitFont(PANEL_TEXT.stats)}
                    labelColor={ink ?? COLOR.muted}
                    numColor={ink ?? COLOR.text}
                    gap="calc(3cqw * var(--split-fit, 1))"
                  />
                )}
              </div>
            </div>
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
          {displayLine && (
            <div
              data-testid="display-line"
              className="truncate text-left"
              style={{
                fontSize: panelFont(PANEL_TEXT.step, fontScale),
                color: ink ?? COLOR.soft,
                marginTop: "0.6cqw",
              }}
            >
              <b style={{ color: ink ?? COLOR.text }}>{shownAt(0)}</b>
              {itemCount > 1 && (
                <>
                  {" "}
                  <span style={{ color: ink ?? COLOR.soft }}>{shownAt(1)}</span>
                </>
              )}
            </div>
          )}
          {stats && !split && (
            <StatsLine
              avg={stats.avg}
              max={stats.max}
              fontSize={panelFont(PANEL_TEXT.stats, fontScale)}
              labelColor={ink ?? COLOR.muted}
              numColor={ink ?? COLOR.text}
            />
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
            onSelect={onSelectResult}
          />
        )}
      </div>
    </article>
  );
}
