import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { floorPct } from "./format";
import type { LoopExitView } from "./loopExitView";

export function RetryBadge() {
  return (
    <span className="ml-2 inline-block shrink-0 whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800">
      {ko.report.loopExit.badge}
    </span>
  );
}

export function LoopExitSummary({ views }: { views: LoopExitView[] }) {
  if (views.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="-mt-3 mb-6 flex items-start gap-1 text-sm text-slate-700">
      <ul aria-label={t.summaryLabel} className="min-w-0 space-y-1">
        {views.map((v) => (
          <li key={v.stepId} className="break-words">
            {t.summaryLine(
              v.name,
              n(v.entered),
              n(v.retries),
              floorPct(v.retryPct),
              n(v.exhausted),
            )}
            {v.truncated > 0 && t.summaryTruncated(n(v.truncated))}
          </li>
        ))}
      </ul>
      <HelpTip label={t.summaryHelpLabel}>
        <span className="block">{t.summaryHelpEntered}</span>
        <span className="block">{t.summaryHelpRetries}</span>
        <span className="block">{t.summaryHelpExhausted}</span>
        <span className="block">{t.summaryHelpTruncated}</span>
      </HelpTip>
    </div>
  );
}
