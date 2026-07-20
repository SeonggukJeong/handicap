import type { Validity, ValidityReason } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { floorPct } from "./format";
import { Callout } from "../ui/Callout";

// wire fraction 0–1 → display digits for templates that append "%" themselves
// (matches InsightPanel floorPct(pct*100) signal; strip trailing % for ko.reason.transport_heavy).
function pctDigits(fraction: number): string {
  return floorPct(fraction * 100).replace(/%$/, "");
}

function reasonText(r: ValidityReason): string {
  switch (r.kind) {
    case "zero_requests":
      return ko.validity.reason.zero_requests;
    case "transport_heavy":
      return ko.validity.reason.transport_heavy(
        pctDigits(r.pct ?? 0),
        (r.count ?? 0).toLocaleString("en-US"),
      );
    case "silent_http_errors":
      return ko.validity.reason.silent_http_errors;
    case "no_response_validation":
      return ko.validity.reason.no_response_validation;
    case "load_not_delivered":
      return ko.validity.reason.load_not_delivered;
    default:
      // unknown codes: graceful raw fallback (Task 3 / plan)
      return r.kind;
  }
}

const LEVEL_VARIANT: Record<Validity["level"], "info" | "warn" | "error"> = {
  ok: "info",
  limited: "warn",
  suspect: "error",
};

/** Report-top reasons list for soft validity (A11 §5.3). Absent when key missing. */
export function ValidityBanner({ validity }: { validity?: Validity | null }) {
  if (!validity) return null;
  return (
    <Callout
      variant={LEVEL_VARIANT[validity.level]}
      role="region"
      aria-label={ko.validity.bannerAria}
      title={ko.validity.title}
      className="mb-6"
    >
      {validity.reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {validity.reasons.map((r, idx) => (
            <li key={`${r.kind}-${idx}`}>{reasonText(r)}</li>
          ))}
        </ul>
      ) : null}
    </Callout>
  );
}
