import type { Report } from "../api/schemas";
import { reportLatencyRule, reportStatusRule } from "../api/schemas";
import { ko } from "../i18n/ko";

/** 상태 코드 규칙·응답 시간 규칙 차이 안내 — 둘 다 다르면 한 문장만. */
export function ruleNotice(reports: Array<Pick<Report, "run">>): string | null {
  const status = reports.map((r) => reportStatusRule(r));
  const latency = reports.map((r) => reportLatencyRule(r));
  const statusDiffers = !status.every((x) => x === status[0]);
  const latencyDiffers = !latency.every((x) => x === latency[0]);
  if (statusDiffers && latencyDiffers) return ko.compare.bothRulesNotice;
  if (statusDiffers) return ko.compare.statusRuleNotice;
  if (latencyDiffers) return ko.compare.latencyRuleNotice;
  return null;
}
