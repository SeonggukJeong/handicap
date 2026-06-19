import type { Verdict } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { METRIC_LABEL, fmt } from "./verdictFormat";

// step-level criterion 행은 대상 스텝 *이름*을 보여준다. ReportView가 넘기는 stepMeta
// (Map<id,{id,name,method,url}>)와 구조 호환되게 최소 `{name}`만 요구한다. 미주입이면
// 행의 target은 raw id로 폴백(다른 컨슈머 하위호환).
type StepMeta = Map<string, { name: string }>;

export function VerdictPanel({ verdict, steps }: { verdict: Verdict; steps?: StepMeta }) {
  return (
    <section aria-label={ko.report.verdictSectionLabel} className="mb-6 rounded border p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold mb-2">{ko.report.verdictSloTitle}</h3>
        <span
          className={[
            "inline-block rounded px-2 py-0.5 text-xs font-medium",
            verdict.passed ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900",
          ].join(" ")}
        >
          {verdict.passed ? ko.report.verdictPass : ko.report.verdictFail}
        </span>
      </div>
      <table className="text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pr-4">{ko.report.verdictMetric}</th>
            <th className="pr-4">{ko.report.verdictThreshold}</th>
            <th className="pr-4">{ko.report.verdictActual}</th>
            <th>{ko.report.verdictResult}</th>
          </tr>
        </thead>
        <tbody>
          {verdict.criteria.map((r, idx) => {
            // target 있으면 step명(없으면 raw id로 폴백) 접두. null/undefined/absent 모두 falsy.
            const stepName = r.target ? (steps?.get(r.target)?.name ?? r.target) : null;
            return (
              // 같은 metric이 여러 target(또는 fixed-field+step)에 나오면 key={metric} 충돌 →
              // metric+target+idx 합성으로 유일 키.
              <tr key={`${r.metric}-${r.target ?? ""}-${idx}`}>
                <td className="pr-4">
                  {stepName && <span className="text-slate-400">{stepName} · </span>}
                  {METRIC_LABEL[r.metric] ?? r.metric}
                </td>
                <td className="pr-4">
                  {r.direction === "max" ? "≤" : "≥"} {fmt(r.metric, r.threshold)}
                </td>
                <td className="pr-4">{fmt(r.metric, r.actual)}</td>
                <td
                  className={r.passed ? "text-emerald-700" : "text-red-700"}
                  title={r.passed ? "pass" : "fail"}
                >
                  {r.passed ? "✓" : "✗"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
