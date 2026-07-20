import type { Narrative } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";

// Full-wire-code keys (colon included) — same pattern as ko.insightActions (Task 3).
const EVENT_LABELS: Record<string, string | undefined> = ko.narrative.event;
const CAN_LABELS: Record<string, string | undefined> = ko.narrative.can;
const CANNOT_LABELS: Record<string, string | undefined> = ko.narrative.cannot;

function label(map: Record<string, string | undefined>, code: string): string {
  return map[code] ?? code;
}

/** Short can/cannot narrative block (A11 §5.1–5.3). Absent when key missing (D11). */
export function NarrativeBlock({ narrative }: { narrative?: Narrative | null }) {
  if (!narrative) return null;
  return (
    <PageSection ariaLabel={ko.narrative.sectionAria} title={ko.narrative.title}>
      {narrative.events.length > 0 ? (
        <div className="mb-3">
          <h4 className="mb-1 text-sm font-semibold text-slate-700">{ko.narrative.eventsHeading}</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-800">
            {narrative.events.map((code) => (
              <li key={`e-${code}`}>{label(EVENT_LABELS, code)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {narrative.can_claim.length > 0 ? (
        <div className="mb-3">
          <h4 className="mb-1 text-sm font-semibold text-slate-700">{ko.narrative.canHeading}</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-800">
            {narrative.can_claim.map((code) => (
              <li key={`c-${code}`}>{label(CAN_LABELS, code)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {narrative.cannot_claim.length > 0 ? (
        <div>
          <h4 className="mb-1 text-sm font-semibold text-slate-700">{ko.narrative.cannotHeading}</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-800">
            {narrative.cannot_claim.map((code) => (
              <li key={`n-${code}`}>{label(CANNOT_LABELS, code)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </PageSection>
  );
}
