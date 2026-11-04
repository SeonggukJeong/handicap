import type { PanelConfig } from "../api/monitors";
import { ko } from "../i18n/ko";

/** One-line summary shown in a collapsed panel card header. */
export function panelSummary(
  p: PanelConfig,
  scenarioName: string | undefined,
  opts?: { solo?: boolean; stepName?: string },
): string {
  if (opts?.stepName !== undefined) {
    return [
      `스텝: ${opts.stepName}`,
      `제한 ${p.timeout_seconds}초`,
      ko.monitor.summaryConds(p.conditions.length),
    ].join(" · ");
  }
  const base = [
    scenarioName ?? ko.monitor.noScenario,
    ko.monitor.summaryInterval(p.interval_seconds),
    ko.monitor.summaryConds(p.conditions.length),
    ko.monitor.summaryDisplays(p.display_items.length),
  ];
  if (opts?.solo) return ["단독 실행", ...base, "시나리오 전체"].join(" · ");
  return base.join(" · ");
}
