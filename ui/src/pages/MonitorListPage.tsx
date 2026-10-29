import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listBoards } from "../api/monitors";
import {
  downloadBoardFile,
  exportBoards,
  exportFileName,
  type ImportResult,
} from "../api/monitorTransfer";
import { Callout } from "../components/ui/Callout";
import { EmptyState } from "../components/EmptyState";
import { ImportBoards } from "../components/monitor/ImportBoards";
import { ImportResultCallout } from "../components/monitor/ImportResultCallout";
import { ko } from "../i18n/ko";
import { MONITOR_LIST_KEY } from "../monitor/keys";

const MAX_EXPORT = 50;
const BTN =
  "rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50";

export function MonitorListPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: MONITOR_LIST_KEY,
    queryFn: listBoards,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const t = ko.monitor.transfer;
  // Export order = order shown in the list, not click order.
  const chosen = (data ?? []).filter((b) => selected.has(b.id));
  const allSelected = !!data && data.length > 0 && chosen.length === data.length;
  const tooMany = chosen.length > MAX_EXPORT;

  // Partial selection -> indeterminate (DOM property, not a JSX attribute).
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = chosen.length > 0 && !allSelected;
    }
  }, [chosen.length, allSelected]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onExport = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const text = await exportBoards(chosen.map((b) => b.id));
      await downloadBoardFile(exportFileName(chosen.map((b) => b.name)), text);
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const onImported = (r: ImportResult) => {
    setResult(r);
    void qc.invalidateQueries({ queryKey: MONITOR_LIST_KEY });
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{ko.monitor.listTitle}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <ImportBoards onDone={onImported} />
          <button
            type="button"
            className={BTN}
            disabled={chosen.length === 0 || tooMany || exporting}
            onClick={() => void onExport()}
          >
            {t.exportSelected(chosen.length)}
          </button>
          <Link
            to="/monitors/new"
            className="inline-flex items-center justify-center rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
          >
            {ko.monitor.newBoard}
          </Link>
        </div>
      </div>
      <div className="mb-6 text-right text-xs text-slate-500">
        {tooMany && <p className="text-red-700">{t.tooManyToExport}</p>}
        <p>{t.plaintextNotice}</p>
      </div>

      {result && <ImportResultCallout result={result} />}
      {exportError && (
        <Callout variant="error" role="alert" className="mb-4">
          {exportError}
        </Callout>
      )}
      {isLoading && <p className="text-sm text-slate-500">{ko.monitor.loading}</p>}
      {error && (
        <Callout variant="error" role="alert">
          {ko.monitor.loadError((error as Error).message)}
        </Callout>
      )}
      {data && data.length === 0 && <EmptyState body={ko.monitor.emptyList} />}
      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="w-8 py-2 pr-2 font-medium">
                <input
                  type="checkbox"
                  aria-label={t.selectAll}
                  ref={selectAllRef}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(data.map((b) => b.id)))
                  }
                />
              </th>
              <th className="py-2 pr-4 font-medium">{ko.monitor.colName}</th>
              <th className="py-2 pr-4 font-medium">{ko.monitor.colPanels}</th>
              <th className="py-2 pr-4 font-medium">{ko.monitor.colState}</th>
              <th className="py-2 font-medium">
                <span className="sr-only">{ko.monitor.openDisplay}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className="border-b border-slate-100">
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    aria-label={t.selectBoard(b.name)}
                    checked={selected.has(b.id)}
                    onChange={() => toggle(b.id)}
                  />
                </td>
                <td className="py-2 pr-4">
                  <Link to={`/monitors/${b.id}`} className="text-accent-700 hover:underline">
                    {b.name}
                  </Link>
                </td>
                <td className="py-2 pr-4">{ko.monitor.panelCount(b.config.panels.length)}</td>
                <td className="py-2 pr-4">
                  {b.enabled ? ko.monitor.enabledOn : ko.monitor.enabledOff}
                </td>
                <td className="py-2 text-right">
                  <Link
                    to={`/monitors/${b.id}/display`}
                    className="text-accent-700 hover:underline"
                  >
                    {ko.monitor.openDisplay}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
