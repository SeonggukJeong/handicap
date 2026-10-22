import type { CheckResult, PanelConfig } from "../../api/monitors";
import { formatMs, type PanelState } from "../../monitor/logic";
import {
  CARD_BOX,
  CARD_TEXT,
  COLOR,
  STATE_LABEL,
  borderColorOf,
  cardFont,
  stateColorOf,
} from "../../monitor/display";

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
        style={
          {
            "--card-fit": String(+cardFit.toFixed(4)),
            background: COLOR.panel,
            border: `${CARD_BOX.border}cqmin solid ${borderColorOf(state, stateColor)}`,
            borderRadius: `${CARD_BOX.radius}cqmin`,
            padding: `${CARD_BOX.pad}cqmin`,
          } as React.CSSProperties
        }
      >
        <div
          className="truncate font-bold leading-tight"
          style={{ fontSize: cardFont(CARD_TEXT.title, fontScale), color: COLOR.text }}
        >
          {panel.title}
        </div>
        <div
          data-testid="strip-status"
          className="flex justify-between gap-[2cqw] whitespace-nowrap font-bold leading-tight"
          style={{ fontSize: cardFont(CARD_TEXT.state, fontScale), color: stateColor }}
        >
          <span>{STATE_LABEL[state]}</span>
          <span>{ms}</span>
        </div>
      </div>
    </article>
  );
}
