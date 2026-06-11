import { useId } from "react";
import type { Verdict } from "../api/schemas";
import { METRIC_LABEL, fmt } from "./report/verdictFormat";
import { usePopover } from "./usePopover";
import { ko } from "../i18n/ko";

const POPOVER_WIDTH_PX = 256; // w-64 — 클래스와 lockstep (기준 행이 ⓘ 본문보다 길다)

const BADGE_CLASS = "inline-block rounded px-2 py-0.5 text-xs font-medium";

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  if (!verdict) return <span className="text-slate-400">—</span>;
  if (verdict.passed)
    return <span className={`${BADGE_CLASS} bg-emerald-200 text-emerald-900`}>PASS</span>;
  return <FailBadge verdict={verdict} />;
}

/** FAIL 사유 popover (§7.5) — hover title 대신 클릭 토글(터치·키보드 접근성).
 *  값 포맷은 VerdictPanel과 공유하는 fmt/METRIC_LABEL — 같은 run의 표/배지 단일 소스. */
function FailBadge({ verdict }: { verdict: Verdict }) {
  const { open, alignRight, rootRef, toggle } = usePopover(POPOVER_WIDTH_PX);
  const id = useId();
  const failed = verdict.criteria.filter((c) => !c.passed);

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className={`${BADGE_CLASS} bg-red-200 text-red-900 cursor-pointer hover:bg-red-300`}
      >
        FAIL
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={`absolute top-5 z-20 block w-64 whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
        >
          <span className="mb-1 block font-medium">{ko.report.failReasonTitle}</span>
          {failed.map((c) => (
            <span key={c.metric} className="block">
              {METRIC_LABEL[c.metric] ?? c.metric} {fmt(c.metric, c.actual)}{" "}
              {c.direction === "max" ? ">" : "<"} {fmt(c.metric, c.threshold)}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
