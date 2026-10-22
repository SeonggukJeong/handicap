import { memo, useCallback, useEffect, useRef } from "react";
import type { CheckResult, PanelConfig } from "../../api/monitors";
import { formatMs, type PanelState } from "../../monitor/logic";
import {
  CARD_BOX,
  CARD_TEXT,
  COLOR,
  STATE_LABEL,
  borderColorOf,
  cardFont,
  cardNeed,
  stateColorOf,
} from "../../monitor/display";
import type { ProbeReport } from "../../monitor/useScaleSearch";

/** Box chrome shared by the card and its size probe (cqmin = card units). */
const cardBoxStyle = (fit: number, borderColor: string): React.CSSProperties =>
  ({
    "--card-fit": String(+fit.toFixed(4)),
    border: `${CARD_BOX.border}cqmin solid ${borderColor}`,
    borderRadius: `${CARD_BOX.radius}cqmin`,
    padding: `${CARD_BOX.pad}cqmin`,
  }) as React.CSSProperties;

const CARD_TITLE_CLASS = "truncate font-bold leading-tight";
const CARD_STATUS_CLASS =
  "flex justify-between gap-[2cqw] whitespace-nowrap font-bold leading-tight";
/** Probe title: one line of a full-width glyph (titles truncate with "…"); never shown. */
const PROBE_TITLE = "가";

/**
 * Invisible stand-in that fixes the strip card scale from settings only: a
 * one-line title (it may end in "…" anyway), the longest strip state label
 * (`⚠ 설정 오류`) and the board's widest ms value (`msText`, from the largest
 * timeout). Reports `{ fit, need }` for the card scale search; never sees
 * results. Memoized like `PanelProbe` (`searchDone` = completion re-measure).
 */
export const StripCardProbe = memo(function StripCardProbe({
  reportId,
  msText,
  fontScale,
  fit,
  onMeasure,
}: {
  reportId: string;
  msText: string;
  fontScale: number;
  fit: number;
  /** Changes when the card scale search completes (re-measure trigger). */
  searchDone: boolean;
  onMeasure: (id: string, r: ProbeReport) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  const measure = useCallback(() => {
    const box = boxRef.current;
    const text = textRef.current;
    const status = statusRef.current;
    if (!box || !text || !status) return;
    const r = box.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const cqmin = Math.min(r.width, r.height) / 100;
    const f = fitRef.current;
    onMeasureRef.current(reportId, {
      fit: f,
      need: cardNeed({
        fit: f,
        contentH: r.height - 2 * (CARD_BOX.border + CARD_BOX.pad) * cqmin,
        textH: text.getBoundingClientRect().height,
        lineClientW: status.clientWidth,
        lineScrollW: status.scrollWidth,
      }),
      reasonNeed: Infinity,
    });
  }, [reportId]);

  // Passive, after every render (memo keeps those to search steps), and on resize.
  useEffect(() => {
    measure();
  });
  useEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(box);
    ro.observe(text);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={boxRef}
      data-testid="card-probe"
      className="relative min-h-0 min-w-0"
      style={{ containerType: "size", gridArea: "1 / 1" }}
    >
      <div
        className="absolute inset-0 flex flex-col justify-center overflow-hidden"
        style={cardBoxStyle(fit, "transparent")}
      >
        <div ref={textRef} data-testid="card-probe-text">
          <div
            className={CARD_TITLE_CLASS}
            style={{ fontSize: cardFont(CARD_TEXT.title, fontScale) }}
          >
            {PROBE_TITLE}
          </div>
          <div
            ref={statusRef}
            data-testid="card-probe-status"
            className={CARD_STATUS_CLASS}
            style={{ fontSize: cardFont(CARD_TEXT.state, fontScale) }}
          >
            <span>{STATE_LABEL.config_error}</span>
            <span>{msText}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

/** C layout: a failing board's healthy panels shrink to title + state + ms. */
export function StripCard({
  panel,
  state,
  latest,
  fontScale,
  blinkOn,
  cardFit = 1,
}: {
  panel: PanelConfig;
  state: PanelState;
  latest: CheckResult | undefined;
  fontScale: number;
  blinkOn: boolean;
  cardFit?: number;
}) {
  const latency = latest?.latency_ms ?? null;
  const stateColor = stateColorOf(state, latency, panel.thresholds);
  const ms = (state === "ok" || state === "slow") && latency !== null ? formatMs(latency) : "—";
  return (
    <article
      data-testid="strip-card"
      aria-label={panel.title}
      className="relative min-h-0 min-w-0"
      style={{ containerType: "size" }}
    >
      <div
        data-testid="card-box"
        data-state={state}
        data-blink={blinkOn ? "on" : undefined}
        className="absolute inset-0 flex flex-col justify-center overflow-hidden"
        style={{
          ...cardBoxStyle(cardFit, borderColorOf(state, stateColor)),
          background: COLOR.panel,
        }}
      >
        <div
          className={CARD_TITLE_CLASS}
          style={{ fontSize: cardFont(CARD_TEXT.title, fontScale), color: COLOR.text }}
        >
          {panel.title}
        </div>
        <div
          data-testid="strip-status"
          className={CARD_STATUS_CLASS}
          style={{ fontSize: cardFont(CARD_TEXT.state, fontScale), color: stateColor }}
        >
          <span>{STATE_LABEL[state]}</span>
          <span>{ms}</span>
        </div>
      </div>
    </article>
  );
}
