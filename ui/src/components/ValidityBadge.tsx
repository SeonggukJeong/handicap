import type { Validity } from "../api/schemas";
import { ko } from "../i18n/ko";

const BADGE_CLASS = "inline-block rounded px-2 py-0.5 text-xs font-medium";

// level colors per §5.3: ok=slate/neutral, limited=amber, suspect=red/amber-red.
// Do NOT mirror completed emerald — validity is orthogonal to run status (US1).
const LEVEL_CLASS: Record<Validity["level"], string> = {
  ok: "bg-slate-200 text-slate-700",
  limited: "bg-amber-200 text-amber-900",
  suspect: "bg-red-200 text-red-900",
};

/** Soft validity level badge (A11). Absent when report omits `validity` (D11 — no fake ok). */
export function ValidityBadge({ validity }: { validity?: Validity | null }) {
  if (!validity) return null;
  return (
    <span className={`${BADGE_CLASS} ${LEVEL_CLASS[validity.level]}`}>
      {ko.validity.level[validity.level]}
    </span>
  );
}
