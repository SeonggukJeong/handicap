import type { Report } from "../api/schemas";
import { reportSample } from "../api/schemas";
import { ko } from "../i18n/ko";

export function sampleNotice(reports: Array<Pick<Report, "sample">>): string | null {
  const defaults = reports.map((r) => reportSample(r).default);
  if (defaults.every((d) => d === defaults[0])) return null;
  return ko.compare.sampleNotice;
}
