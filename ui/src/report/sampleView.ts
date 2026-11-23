import { reportSample, type Report, type ReportSampleName } from "../api/schemas";
import { ko } from "../i18n/ko";

export type SampleView = {
  /** 실제로 받은 표본 */
  selected: ReportSampleName;
  default: ReportSampleName;
  split: boolean;
  /** split && selected !== default */
  switched: boolean;
  /** switched면 표본 이름, 아니면 null */
  tag: string | null;
};

export function sampleName(s: ReportSampleName): string {
  const t = ko.report.sample;
  if (s === "passed") return t.passed;
  if (s === "failed") return t.failed;
  return t.allShort;
}

export function sampleView(report: Pick<Report, "sample">): SampleView {
  const { selected, default: def, split } = reportSample(report);
  const switched = split && selected !== def;
  return { selected, default: def, split, switched, tag: switched ? sampleName(selected) : null };
}

/** 그 표본에 값이 없을 때의 낱말. failed는 오류 0건이면 noFailed, 아니면 noFailedMeasured. */
export function noLatencyWord(s: ReportSampleName, errors: number): string {
  const t = ko.report.sample;
  if (s === "failed") return errors === 0 ? t.noFailed : t.noFailedMeasured;
  if (s === "all") return t.noMeasured;
  return t.noSample;
}
