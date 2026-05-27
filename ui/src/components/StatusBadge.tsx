import type { RunStatus } from "../api/schemas";

const COLORS: Record<RunStatus, string> = {
  pending: "bg-slate-200 text-slate-700",
  running: "bg-blue-200 text-blue-900",
  completed: "bg-emerald-200 text-emerald-900",
  failed: "bg-red-200 text-red-900",
  aborted: "bg-amber-200 text-amber-900",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={["inline-block rounded px-2 py-0.5 text-xs font-medium", COLORS[status]].join(" ")}
    >
      {status}
    </span>
  );
}
