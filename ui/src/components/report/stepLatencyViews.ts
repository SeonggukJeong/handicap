import { ko } from "../../i18n/ko";
import type { StepLatencySeries } from "../../report/stepLatencySeries";
import { StepLatencyGrid } from "./StepLatencyGrid";
import type { SteadyMarks } from "./steadyMarks";

export type StepLatencyView = "grid";

export type StepLatencyViewProps = {
  series: StepLatencySeries[];
  yMax: number;
  xMax: number;
  marks: SteadyMarks | null;
};

/** 보기 표 — 새 보기는 항목 하나 + 컴포넌트 하나로 더해진다(R-A6). */
export const STEP_LATENCY_VIEWS: Record<
  StepLatencyView,
  { label: string; Component: (p: StepLatencyViewProps) => JSX.Element }
> = {
  grid: { label: ko.report.stepLatency.viewGrid, Component: StepLatencyGrid },
};
