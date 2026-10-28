import type { PanelConfig } from "../api/monitors";
import { ko } from "../i18n/ko";

/** One-line summary shown in a collapsed panel card header. */
export function panelSummary(p: PanelConfig, scenarioName: string | undefined): string {
  return [
    scenarioName ?? ko.monitor.noScenario,
    ko.monitor.summaryInterval(p.interval_seconds),
    ko.monitor.summaryConds(p.conditions.length),
    ko.monitor.summaryDisplays(p.display_items.length),
  ].join(" · ");
}
