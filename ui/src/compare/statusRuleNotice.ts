import type { Report } from "../api/schemas";
import { reportStatusRule } from "../api/schemas";
import { ko } from "../i18n/ko";

export function statusRuleNotice(reports: Array<Pick<Report, "run">>): string | null {
  const rules = reports.map((r) => reportStatusRule(r));
  if (rules.every((x) => x === rules[0])) return null;
  return ko.compare.statusRuleNotice;
}
