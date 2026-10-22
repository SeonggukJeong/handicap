import type { PanelConfig } from "../../api/monitors";
import { focusGeometries } from "../../monitor/logic";
import { focusMainStyle, panelGridStyle, stripGridStyle } from "../../monitor/display";
import type { ProbeReport } from "../../monitor/useScaleSearch";
import { PanelProbe, type PanelMeasure } from "./MonitorPanel";
import { StripCardProbe } from "./StripCard";

const LAYER = "pointer-events-none invisible absolute inset-0";

/**
 * C (focus) size probes (spec §6.3 글자 크기): every C geometry the board can
 * take is laid out once, invisibly, so the incident and card scales are fixed
 * at configuration time and never follow the fail count.
 *
 * - Incident: per big-area geometry, every panel's `PanelProbe` stacked in the
 *   big grid's first cell (any panel may fail) — report id `${key}|${panel.id}`.
 * - Card: per strip geometry, one `StripCardProbe` in the strip's first cell.
 *
 * Only settings reach here (panels, font scale, search state) — never results.
 */
export function FocusProbes({
  panels,
  fontScale,
  cardMs,
  incidentFit,
  incidentDone,
  onIncidentMeasure,
  cardFit,
  cardDone,
  onCardMeasure,
}: {
  panels: PanelConfig[];
  fontScale: number;
  /** The widest ms value a card can show (largest timeout). */
  cardMs: string;
  incidentFit: number;
  incidentDone: boolean;
  onIncidentMeasure: (id: string, m: PanelMeasure) => void;
  cardFit: number;
  cardDone: boolean;
  onCardMeasure: (id: string, r: ProbeReport) => void;
}) {
  const n = panels.length;
  const { big, strip } = focusGeometries(n);
  return (
    <>
      {big.map((g) => (
        <div
          key={g.key}
          aria-hidden="true"
          data-testid="incident-probe-layout"
          data-geometry={g.key}
          className={LAYER}
          style={focusMainStyle(g.f === 1 ? "right" : "bottom")}
        >
          <div className="min-h-0 min-w-0" style={panelGridStyle(g.f)}>
            {panels.map((p) => (
              <PanelProbe
                key={p.id}
                reportId={`${g.key}|${p.id}`}
                cell="1 / 1"
                panel={p}
                fontScale={fontScale}
                fit={incidentFit}
                searchDone={incidentDone}
                onMeasure={onIncidentMeasure}
              />
            ))}
          </div>
        </div>
      ))}
      {strip.map((g) => {
        const side = g.f === 1 ? "right" : "bottom";
        return (
          <div
            key={g.key}
            aria-hidden="true"
            data-testid="card-probe-layout"
            data-geometry={g.key}
            className={LAYER}
            style={focusMainStyle(side)}
          >
            {/* big area placeholder: the strip takes the second track */}
            <div className="min-h-0 min-w-0" />
            <div className="min-h-0 min-w-0" style={stripGridStyle(side, n - g.f)}>
              <StripCardProbe
                reportId={g.key}
                msText={cardMs}
                fontScale={fontScale}
                fit={cardFit}
                searchDone={cardDone}
                onMeasure={onCardMeasure}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
