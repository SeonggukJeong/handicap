import { useState } from "react";
import { Link } from "react-router-dom";
import { usePoolWorkers, usePatchPoolWorker, useExcludePoolWorker } from "../api/hooks";
import type { PoolWorkerSummary } from "../api/pool";
import { ko } from "../i18n/ko";

// ── Small primitives ──────────────────────────────────────────────────────────

type ConfirmDialogProps = {
  title: string;
  body: string;
  hint?: string;
  warn?: string;
  destructive?: boolean;
  error?: string | null;
  pending?: boolean;
  onProceed: () => void;
  onCancel: () => void;
};

function ConfirmDialog({
  title,
  body,
  hint,
  warn,
  destructive,
  error,
  pending,
  onProceed,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      role={destructive ? "alertdialog" : "dialog"}
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    >
      <div className="w-96 rounded-lg border border-slate-200 bg-white p-5 shadow-lg">
        <p className="mb-2 font-semibold text-slate-800">{title}</p>
        <p className="mb-3 text-sm text-slate-600">{body}</p>
        {hint ? <p className="mt-2 text-xs text-amber-700">{hint}</p> : null}
        {warn ? (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{warn}</p>
        ) : null}
        {error ? (
          <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            {ko.workers.cancel}
          </button>
          <button
            type="button"
            onClick={onProceed}
            disabled={pending}
            className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed ${
              destructive ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {pending ? ko.workers.pending : ko.workers.confirmProceed}
          </button>
        </div>
      </div>
    </div>
  );
}

type EditModalProps = {
  title: string;
  note: string;
  hint?: string;
  inputType?: "number" | "text";
  initialValue: string;
  error?: string | null;
  pending?: boolean;
  onApply: (val: string) => void;
  onCancel: () => void;
};

function EditModal({
  title,
  note,
  hint,
  inputType = "text",
  initialValue,
  error,
  pending,
  onApply,
  onCancel,
}: EditModalProps) {
  const [val, setVal] = useState(initialValue);
  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    >
      <div className="w-80 rounded-lg border border-slate-200 bg-white p-5 shadow-lg">
        <p className="mb-3 font-semibold text-slate-800">{title}</p>
        <input
          type={inputType}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="mb-2 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          aria-label={title}
        />
        <p className="mb-4 text-xs text-slate-500">{note}</p>
        {hint ? <p className="mt-2 text-xs text-amber-700">{hint}</p> : null}
        {error ? (
          <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            {ko.workers.cancel}
          </button>
          <button
            type="button"
            onClick={() => onApply(val)}
            disabled={pending}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? ko.workers.pending : ko.workers.apply}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Per-row actions menu ──────────────────────────────────────────────────────

type ActiveDialog =
  | { type: "drain" }
  | { type: "exclude" }
  | { type: "capacity" }
  | { type: "label" };

// F2: DRY helper — wires onSelect to both onClick and onKeyDown (Enter/Space).
type MenuItemProps = {
  onSelect: () => void;
  className?: string;
  children: React.ReactNode;
};

function MenuItem({ onSelect, className, children }: MenuItemProps) {
  return (
    <li
      role="menuitem"
      tabIndex={0}
      className={className ?? "cursor-pointer px-3 py-1.5 text-sm hover:bg-slate-50"}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </li>
  );
}

type RowActionsProps = {
  worker: PoolWorkerSummary;
  // F1: page-level single-open-menu identity
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onActionError: (msg: string) => void;
};

function RowActions({ worker, isOpen, onToggle, onClose, onActionError }: RowActionsProps) {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const patch = usePatchPoolWorker();
  const exclude = useExcludePoolWorker();

  const closeAll = () => {
    onClose();
    setDialog(null);
    setActionError(null);
  };

  return (
    <td className="py-2 pr-2 relative">
      <button
        type="button"
        aria-label={ko.workers.actionsLabel}
        onClick={onToggle}
        className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100"
      >
        ⋯
      </button>

      {isOpen ? (
        <>
          {/* backdrop: closes this menu on outside click */}
          <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
          <ul
            role="menu"
            className="absolute right-0 z-50 mt-1 min-w-[8rem] rounded border border-slate-200 bg-white py-1 shadow-lg"
          >
            {worker.drained ? (
              <MenuItem
                onSelect={() => {
                  onClose();
                  patch.mutate(
                    { id: worker.worker_id, body: { drained: false } },
                    {
                      onError: (e: Error) => onActionError(ko.workers.actionError(e.message)),
                    },
                  );
                }}
              >
                {ko.workers.undrain}
              </MenuItem>
            ) : (
              <MenuItem
                onSelect={() => {
                  onClose();
                  setActionError(null);
                  setDialog({ type: "drain" });
                }}
              >
                {ko.workers.drain}
              </MenuItem>
            )}
            <MenuItem
              onSelect={() => {
                onClose();
                setActionError(null);
                setDialog({ type: "capacity" });
              }}
            >
              {ko.workers.editCapacity}
            </MenuItem>
            <MenuItem
              onSelect={() => {
                onClose();
                setActionError(null);
                setDialog({ type: "label" });
              }}
            >
              {ko.workers.editLabel}
            </MenuItem>
            <MenuItem
              onSelect={() => {
                onClose();
                setActionError(null);
                setDialog({ type: "exclude" });
              }}
              className="cursor-pointer px-3 py-1.5 text-sm text-red-600 hover:bg-slate-50"
            >
              {ko.workers.exclude}
            </MenuItem>
          </ul>
        </>
      ) : null}

      {dialog?.type === "drain" ? (
        <ConfirmDialog
          title={ko.workers.drainConfirmTitle}
          body={ko.workers.drainConfirmBody}
          hint={!worker.stable ? ko.workers.ephemeralHint : undefined}
          error={actionError}
          pending={patch.isPending}
          onProceed={() => {
            setActionError(null);
            patch.mutate(
              { id: worker.worker_id, body: { drained: true } },
              {
                onSuccess: closeAll,
                onError: (e: Error) => setActionError(ko.workers.actionError(e.message)),
              },
            );
          }}
          onCancel={closeAll}
        />
      ) : null}

      {dialog?.type === "exclude" ? (
        <ConfirmDialog
          title={ko.workers.excludeConfirmTitle}
          body={ko.workers.excludeConfirmBody}
          warn={
            // The server always sets run_id on busy pool workers (L6).
            // The `&& worker.run_id` guard only suppresses the warning in the
            // impossible busy+null edge case — purely defensive, safe to keep.
            worker.busy && worker.run_id ? ko.workers.excludeBusyWarn(worker.run_id) : undefined
          }
          destructive
          error={actionError}
          pending={exclude.isPending}
          onProceed={() => {
            setActionError(null);
            exclude.mutate(
              { id: worker.worker_id, reason: "" },
              {
                onSuccess: closeAll,
                onError: (e: Error) => setActionError(ko.workers.actionError(e.message)),
              },
            );
          }}
          onCancel={closeAll}
        />
      ) : null}

      {dialog?.type === "capacity" ? (
        <EditModal
          title={ko.workers.editCapacity}
          note={ko.workers.capacityApplyNote}
          hint={!worker.stable ? ko.workers.ephemeralHint : undefined}
          inputType="number"
          initialValue={worker.capacity_override != null ? String(worker.capacity_override) : ""}
          error={actionError}
          pending={patch.isPending}
          onApply={(val) => {
            if (val === "") {
              // Intentional clear: send null to remove the override.
              setActionError(null);
              patch.mutate(
                { id: worker.worker_id, body: { capacity_override: null } },
                {
                  onSuccess: closeAll,
                  onError: (e: Error) => setActionError(ko.workers.actionError(e.message)),
                },
              );
            } else {
              const n = Number(val);
              if (Number.isFinite(n)) {
                // Valid number: set the override.
                setActionError(null);
                patch.mutate(
                  { id: worker.worker_id, body: { capacity_override: n } },
                  {
                    onSuccess: closeAll,
                    onError: (e: Error) => setActionError(ko.workers.actionError(e.message)),
                  },
                );
              }
              // Non-finite (NaN / ±Infinity from garbage input): do nothing.
              // The modal stays open and no PATCH is issued, preventing a silent clear.
            }
          }}
          onCancel={closeAll}
        />
      ) : null}

      {dialog?.type === "label" ? (
        <EditModal
          title={ko.workers.editLabel}
          note={ko.workers.labelApplyNote}
          hint={!worker.stable ? ko.workers.ephemeralHint : undefined}
          inputType="text"
          initialValue={worker.label ?? ""}
          error={actionError}
          pending={patch.isPending}
          onApply={(val) => {
            setActionError(null);
            patch.mutate(
              { id: worker.worker_id, body: { label: val === "" ? null : val } },
              {
                onSuccess: closeAll,
                onError: (e: Error) => setActionError(ko.workers.actionError(e.message)),
              },
            );
          }}
          onCancel={closeAll}
        />
      ) : null}
    </td>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function WorkerDashboardPage() {
  const { data, isLoading, isError } = usePoolWorkers();
  // F1: page-level single-open-menu identity — at most one row menu open at a time
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  if (isLoading)
    return (
      <p role="status" className="text-slate-500">
        {ko.common.loading}
      </p>
    );
  if (isError) return <p role="alert">{ko.workers.loadError}</p>;
  if (!data) return null;

  if (!data.pool_mode)
    return (
      <section>
        <h1 className="text-lg font-semibold mb-4">{ko.workers.title}</h1>
        <p className="text-slate-600">{ko.workers.emptyNotPool}</p>
        <p className="mt-2 text-sm text-slate-500">{ko.workers.runbookHint}</p>
      </section>
    );

  const idle = data.workers.filter((w) => !w.busy).length;
  const busy = data.workers.length - idle;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">{ko.workers.title}</h1>
      </div>
      <p className="text-sm text-slate-500 mb-1">{ko.workers.subtitle}</p>
      <p className="text-sm text-slate-700 mb-4">{ko.workers.countSummary(idle, busy)}</p>
      {bannerError ? (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between rounded bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span>{bannerError}</span>
          <button
            type="button"
            aria-label={ko.workers.bannerDismiss}
            onClick={() => setBannerError(null)}
            className="ml-3 text-red-600 hover:underline"
          >
            {ko.workers.bannerDismiss}
          </button>
        </div>
      ) : null}
      {data.workers.length === 0 ? (
        <p className="text-slate-600">{ko.workers.emptyNoWorkers}</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4">{ko.workers.colHostname}</th>
              <th className="py-2 pr-4">{ko.workers.colWorkerId}</th>
              <th className="py-2 pr-4">{ko.workers.colStatus}</th>
              <th className="py-2 pr-4">{ko.workers.colCapacity}</th>
              <th className="py-2 pr-4">{ko.workers.colLabel}</th>
              <th className="py-2 pr-4">{ko.workers.colLastSeen}</th>
              <th className="py-2">{ko.workers.actionsLabel}</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map((w) => {
              const isStale =
                w.last_seen_secs_ago > data.heartbeat_interval_seconds &&
                w.last_seen_secs_ago < data.stale_timeout_seconds;
              return (
                <tr key={w.worker_id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">
                    {w.hostname || "—"}
                    {w.drained ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {ko.workers.drainedBadge}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs" title={w.worker_id}>
                    {w.worker_id}
                    {!w.stable ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-600">
                        {ko.workers.ephemeralBadge}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    {w.busy ? (
                      <>
                        {ko.workers.statusBusy}
                        {w.run_id ? (
                          <Link
                            to={`/runs/${w.run_id}`}
                            className="ml-1 text-blue-600 hover:underline"
                          >
                            ({w.run_id})
                          </Link>
                        ) : null}
                      </>
                    ) : (
                      ko.workers.statusIdle
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {w.capacity_override != null
                      ? ko.workers.capacityManual(w.capacity_override)
                      : w.capacity_vus}
                  </td>
                  <td className="py-2 pr-4 text-slate-500">{w.label ?? ""}</td>
                  <td className="py-2 pr-4">
                    {ko.workers.secsAgo(w.last_seen_secs_ago)}
                    {isStale ? (
                      <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {ko.workers.stale}
                      </span>
                    ) : null}
                  </td>
                  <RowActions
                    worker={w}
                    isOpen={openMenuId === w.worker_id}
                    onToggle={() =>
                      setOpenMenuId((prev) => (prev === w.worker_id ? null : w.worker_id))
                    }
                    onClose={() => setOpenMenuId(null)}
                    onActionError={setBannerError}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
