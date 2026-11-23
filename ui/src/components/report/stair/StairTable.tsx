import type { StairReport, StairState } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { formatHms } from "../../../monitor/time";
import {
  errorRateText,
  formatCount,
  formatMs,
  reasonTexts,
  showsNumbers,
  stateLabel,
} from "./stairFormat";

const PILL: Record<StairState, string> = {
  ok: "bg-emerald-100 text-emerald-800",
  spike: "bg-amber-100 text-amber-800",
  saturated: "bg-red-100 text-red-800",
  unconfirmed: "border border-amber-500 bg-white text-amber-800",
  after: "bg-slate-100 text-slate-600",
  not_measured: "bg-slate-100 text-slate-600",
  emergency_stopped: "border border-red-500 bg-white text-red-800",
  partial: "bg-slate-100 text-slate-600",
  skipped: "bg-slate-100 text-slate-600",
};

const DASH = "—";

export function StairTable({ stair }: { stair: StairReport }) {
  const t = ko.report.stair;
  const th = "px-2 py-1 text-left font-medium whitespace-nowrap";
  const td = "px-2 py-1 whitespace-nowrap tabular-nums";
  const warnings = stair.steps.filter((s) => s.discard_warning && s.head_p99_ratio != null);
  return (
    <div className="mb-2">
      <div className="overflow-x-auto">
        <table aria-label={t.tableLabel} className="w-full text-sm border-collapse">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {[
                t.cols.index,
                t.cols.target,
                t.cols.achieved,
                t.cols.throughput,
                t.cols.p50,
                t.cols.p95,
                t.cols.p99,
                t.cols.errorRate,
                t.cols.dropped,
                t.cols.window,
                t.cols.state,
              ].map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stair.steps.map((s) => {
              const measured = showsNumbers(s.state);
              const timed = measured && s.p99_us > 0;
              const reasons = reasonTexts(stair, s);
              return (
                <tr key={s.index} className="border-t border-slate-200">
                  <td className={td}>{s.index + 1}</td>
                  <td className={td}>{s.target.toLocaleString("en-US")}</td>
                  <td className={td}>
                    {measured && s.achieved != null ? formatCount(s.achieved) : DASH}
                  </td>
                  <td className={td}>{measured ? formatCount(s.throughput_rps) : DASH}</td>
                  <td className={td}>{timed ? formatMs(s.p50_us) : DASH}</td>
                  <td className={td}>{timed ? formatMs(s.p95_us) : DASH}</td>
                  <td className={td}>{timed ? formatMs(s.p99_us) : DASH}</td>
                  <td className={td}>{measured ? errorRateText(s.error_rate) : DASH}</td>
                  <td className={td}>
                    {measured && s.dropped != null ? s.dropped.toLocaleString("en-US") : DASH}
                  </td>
                  <td className={td}>
                    {measured
                      ? `${formatHms(s.measure_start_ms)}–${formatHms(s.measure_end_ms)}`
                      : DASH}
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PILL[s.state]}`}
                    >
                      {stateLabel(s.state)}
                    </span>
                    {reasons.length > 0 && (
                      <span className="ml-2 text-xs text-slate-600">{reasons.join(" · ")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {warnings.map((s) => (
        <p key={s.index} className="mt-1 text-sm text-amber-800">
          {t.discardWarning(
            s.index + 1,
            (s.head_p99_ratio as number).toFixed(1),
            stair.config.discard_seconds,
          )}
        </p>
      ))}
      <p className="mt-2 text-xs text-slate-500">{t.unitsNote}</p>
    </div>
  );
}
