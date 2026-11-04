import type { PanelConfig } from "../api/monitors";
import { ko } from "../i18n/ko";

/** One-line summary shown in a collapsed panel card header. */
export function panelSummary(
  p: PanelConfig,
  scenarioName: string | undefined,
  opts?: { solo?: boolean; stepName?: string },
): string {
  const m = ko.monitor;
  if (opts?.stepName !== undefined) {
    return [
      m.summaryStep(opts.stepName),
      m.summaryLimit(p.timeout_seconds),
      m.summaryConds(p.conditions.length),
    ].join(" · ");
  }
  const base = [
    scenarioName ?? m.noScenario,
    m.summaryInterval(p.interval_seconds),
    m.summaryConds(p.conditions.length),
    m.summaryDisplays(p.display_items.length),
  ];
  if (opts?.solo) return [m.soloPrefix, ...base, m.wholeScenario].join(" · ");
  return base.join(" · ");
}
