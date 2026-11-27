import type { StairReport } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { configLineText, headlineParts } from "./stairFormat";

const FIRST_TONE: Record<StairReport["headline"]["kind"], string> = {
  saturated: "border-red-300 bg-red-50 text-red-800",
  unconfirmed: "border-amber-300 bg-amber-50 text-amber-800",
  all_ok: "border-emerald-300 bg-emerald-50 text-emerald-800",
  ok_then_unmeasured: "border-amber-300 bg-amber-50 text-amber-800",
  no_data: "border-slate-300 bg-slate-50 text-slate-700",
};

export function StairHeadline({ stair }: { stair: StairReport }) {
  const { first, lines } = headlineParts(stair);
  const t = ko.report.stair;
  return (
    <div className="mb-3 space-y-1">
      <div
        data-tone="headline"
        className={`rounded-md border p-3 ${FIRST_TONE[stair.headline.kind]}`}
      >
        <p className="text-base font-semibold break-words">{first}</p>
        {lines.map((l) => (
          <p
            key={l.kind}
            data-tone={l.kind === "slot" ? "warn" : "info"}
            className={`mt-1 text-sm break-words ${
              l.kind === "slot"
                ? "rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800"
                : ""
            }`}
          >
            {l.text}
          </p>
        ))}
      </div>
      <p className="text-sm text-slate-700 break-words">{configLineText(stair)}</p>
      {stair.notes.t0_estimated && <p className="text-xs text-slate-600">{t.noteT0}</p>}
      {stair.notes.open_loop_unknown && (
        <p className="text-xs text-slate-600">{t.noteOpenLoopUnknown}</p>
      )}
    </div>
  );
}
