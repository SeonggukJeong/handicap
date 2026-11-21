import type { ReportBasis } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Segmented } from "../ui/Segmented";
import { floorPct } from "./format";

type Basis = "steady" | "whole";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function basisLine(basis: ReportBasis): string {
  const t = ko.report.basis;
  const { config } = basis;
  const parts: string[] = [];
  if (basis.selected === "steady" && basis.window) {
    const w = basis.window;
    parts.push(
      t.lineSteady(
        clock(w.start_ms),
        clock(w.end_ms),
        w.measured_seconds,
        config.ramp_seconds,
        config.discard_seconds,
      ),
    );
    if (basis.state === "partial") {
      parts.push(t.partial(config.hold_seconds - config.discard_seconds, w.measured_seconds));
    }
  } else {
    parts.push(t.lineWhole(config.ramp_seconds));
  }
  if (basis.t0_estimated) parts.push(t.estimated);
  return parts.join(" · ");
}

export function BasisBar({
  basis,
  onSelect,
}: {
  basis: ReportBasis;
  onSelect: (b: Basis) => void;
}) {
  const t = ko.report.basis;
  const steadyOff = basis.state === "not_reached" || basis.state === "no_common_window";
  const other = basis.other;
  return (
    <div className="mb-4">
      <Segmented<Basis>
        value={basis.selected}
        onChange={onSelect}
        ariaLabel={t.switchAria}
        options={[
          { value: "steady", label: t.steady, disabled: steadyOff },
          { value: "whole", label: t.whole },
        ]}
      />
      {steadyOff && (
        <p role="status" className="mt-2 text-sm text-slate-600">
          {basis.state === "not_reached" ? t.notReached : t.noCommonWindow}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-sm text-slate-700">
          {basisLine(basis)}
          <HelpTip label={`${t.switchAria} 설명`}>{t.latencyNote}</HelpTip>
        </p>
        {other && (
          <p className="text-sm text-slate-500">
            {t.otherLine(
              basis.selected === "steady" ? t.whole : t.steady,
              other.rps.toFixed(1),
              other.p95_ms,
              floorPct(other.error_rate * 100),
            )}
          </p>
        )}
      </div>
    </div>
  );
}
