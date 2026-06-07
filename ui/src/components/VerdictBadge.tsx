import type { Verdict } from "../api/schemas";
import { fmt } from "./report/verdictFormat";

/** 실패한 기준만 "metric actual (>|<) threshold"로 요약(FAIL tooltip). 값 포맷은
 *  VerdictPanel과 공유하는 fmt()로 — 같은 run의 표/배지가 값을 다르게 보이지 않게. */
function failSummary(v: Verdict): string {
  return v.criteria
    .filter((c) => !c.passed)
    .map(
      (c) =>
        `${c.metric} ${fmt(c.metric, c.actual)} ${c.direction === "max" ? ">" : "<"} ${fmt(c.metric, c.threshold)}`,
    )
    .join(", ");
}

export function VerdictBadge({ verdict }: { verdict?: Verdict | null }) {
  if (!verdict) return <span className="text-slate-400">—</span>;
  const pass = verdict.passed;
  return (
    <span
      title={pass ? undefined : failSummary(verdict)}
      className={[
        "inline-block rounded px-2 py-0.5 text-xs font-medium",
        pass ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
      ].join(" ")}
    >
      {pass ? "PASS" : "FAIL"}
    </span>
  );
}
