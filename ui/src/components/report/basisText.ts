import type { ReportBasis, ReportSampleName } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { sampleName } from "../../report/sampleView";
import { floorPct } from "./format";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function basisLine(basis: ReportBasis): string {
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

export function basisOtherLine(
  basis: ReportBasis,
  sample: ReportSampleName,
  switched = false,
): string | null {
  const t = ko.report.basis;
  const other = basis.other;
  if (!other) return null;
  const noValue = switched
    ? sample === "failed"
      ? other.count === 0 || other.error_rate === 0
      : sample === "all"
        ? other.count === 0
        : other.count === 0 || other.error_rate >= 1
    : sample === "passed" && (other.count === 0 || other.error_rate >= 1);
  const name = basis.selected === "steady" ? t.whole : t.steady;
  return t.otherLine(
    switched ? `${name} (${sampleName(sample)})` : name,
    other.rps.toFixed(1),
    noValue ? null : other.p95_ms,
    floorPct(other.error_rate * 100),
  );
}
