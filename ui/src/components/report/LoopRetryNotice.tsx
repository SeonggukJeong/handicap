import { ko } from "../../i18n/ko";
import { Callout } from "../ui/Callout";
import { floorPct } from "./format";
import { noticeLoops, type LoopExitView } from "./loopExitView";

const MAX_LINES = 3;

export function LoopRetryNotice({ views }: { views: LoopExitView[] }) {
  const targets = noticeLoops(views);
  if (targets.length === 0) return null;
  const t = ko.report.loopExit;
  const n = (v: number) => v.toLocaleString("en-US");
  const anyRetry = targets.some((v) => v.retries >= 1);
  const shown = targets.slice(0, MAX_LINES);
  const more = targets.length - shown.length;
  return (
    <Callout
      variant="warn"
      role="region"
      aria-label={t.noticeLabel}
      className="mb-6"
      title={anyRetry ? t.noticeHeadRetry : t.noticeHeadExhausted}
    >
      <ul className="list-disc space-y-0.5 pl-5">
        {shown.map((v) => (
          <li key={v.stepId} className="break-words">
            {v.retries >= 1
              ? t.noticeRetryLine(v.name, n(v.passes), n(v.retries), floorPct(v.retryPct)) +
                (v.exhausted >= 1 ? t.noticeExhaustedSuffix(n(v.exhausted)) : "")
              : t.noticeExhaustedOnly(v.name, n(v.exhausted))}
          </li>
        ))}
        {more > 0 && <li>{t.noticeMore(n(more))}</li>}
      </ul>
      {anyRetry && <p className="mt-2">{t.noticeTail}</p>}
    </Callout>
  );
}
