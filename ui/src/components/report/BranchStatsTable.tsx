import { Fragment, useState } from "react";
import type { IfBreakdown } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";

type IfMeta = { name: string };
type Props = { breakdown: IfBreakdown[]; meta: Map<string, IfMeta> };

/** Display order: then (0) < elif_n (1+n) < else < none. SQL returns branches in
 *  lexicographic TEXT order, which is not the authoring order — re-sort here. */
function branchRank(branch: string): number {
  if (branch === "then") return 0;
  if (branch.startsWith("elif_")) {
    const n = Number(branch.slice("elif_".length));
    return Number.isFinite(n) ? 1 + n : 1_000;
  }
  if (branch === "else") return 1_000_000;
  if (branch === "none") return 1_000_001;
  return 999_999;
}

function branchLabel(branch: string): string {
  return branch === "none" ? "(미매치)" : branch;
}

export function BranchStatsTable({ breakdown, meta }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (breakdown.length === 0) return null;

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <PageSection ariaLabel={ko.report.branchDecisionsLabel} title={ko.report.branchDecisionsTitle}>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{ko.report.colIfNode}</th>
            <th className="py-2 pr-4 font-medium">{ko.report.colDecisions}</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((b) => {
            const m = meta.get(b.step_id);
            const isOpen = open.has(b.step_id);
            const total = b.branches.reduce((acc, x) => acc + x.count, 0);
            const sorted = [...b.branches].sort(
              (x, y) => branchRank(x.branch) - branchRank(y.branch),
            );
            return (
              <Fragment key={b.step_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={ko.report.toggleBranchBreakdown(m?.name ?? b.step_id)}
                      onClick={() => toggle(b.step_id)}
                      className="mr-1 text-slate-500"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    {m?.name ?? b.step_id} <span className="text-slate-400">(if)</span>
                  </td>
                  <td className="py-2 pr-4">{total}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-slate-50">
                    <td colSpan={2} className="px-6 py-2">
                      <table className="text-xs">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="pr-4 text-left">{ko.report.colBranch}</th>
                            <th className="pr-4 text-left">{ko.report.colDecisionsInner}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((x) => (
                            <tr key={x.branch}>
                              <td className="pr-4 font-mono" data-testid="branch-label">
                                {branchLabel(x.branch)}
                              </td>
                              <td className="pr-4">{x.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </PageSection>
  );
}
