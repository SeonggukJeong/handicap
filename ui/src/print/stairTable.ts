import type { StairReport, StairState, StairStep } from "../api/schemas";
import { ko } from "../i18n/ko";
import { formatHms } from "../monitor/time";
import {
  errorRateText,
  formatCount,
  formatMs,
  reasonTexts,
  showsNumbers,
  stateLabel,
} from "../components/report/stair/stairFormat";

const DASH = "—";

export type StairPrintRow = {
  index: number;
  state: StairState;
  /** 화면 표와 같은 11칸(마지막 = 판정 이름). */
  cells: string[];
  reasons: string[];
};

export type StairPrintModel = { columns: string[]; rows: StairPrintRow[] };

export function buildStairRows(stair: StairReport): StairPrintModel {
  const c = ko.report.stair.cols;
  const columns = [
    c.index,
    c.target,
    c.achieved,
    c.throughput,
    c.p50,
    c.p95,
    c.p99,
    c.errorRate,
    c.dropped,
    c.window,
    c.state,
  ];
  const rows = stair.steps.map((s): StairPrintRow => {
    const measured = showsNumbers(s.state);
    const dash = (v: string): string => (measured ? v : DASH);
    return {
      index: s.index,
      state: s.state,
      cells: [
        String(s.index + 1),
        s.target.toLocaleString("en-US"),
        measured && s.achieved != null ? formatCount(s.achieved) : DASH,
        dash(formatCount(s.throughput_rps)),
        dash(formatMs(s.p50_us)),
        dash(formatMs(s.p95_us)),
        dash(formatMs(s.p99_us)),
        dash(errorRateText(s.error_rate)),
        measured && s.dropped != null ? s.dropped.toLocaleString("en-US") : DASH,
        dash(`${formatHms(s.measure_start_ms)}–${formatHms(s.measure_end_ms)}`),
        stateLabel(s.state),
      ],
      reasons: reasonTexts(stair, s),
    };
  });
  return { columns, rows };
}

export function discardWarningSteps(stair: StairReport): StairStep[] {
  return stair.steps.filter((s) => s.discard_warning && s.head_p99_ratio != null);
}
