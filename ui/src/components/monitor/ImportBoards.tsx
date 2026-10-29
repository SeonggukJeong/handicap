import { useRef, useState, type ChangeEvent } from "react";
import {
  analyzeImport,
  applyImport,
  ImportConflictError,
  MAX_IMPORT_BYTES,
  type BoardAnalysis,
  type ImportResult,
} from "../../api/monitorTransfer";
import { readTextFile } from "../../api/readTextFile";
import { Modal } from "../Modal";
import { ImportConflictList } from "./ImportConflictList";
import { ko } from "../../i18n/ko";

const BTN =
  "rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50";

type Problem = { kind: "error"; message: string } | { kind: "conflicts"; boards: BoardAnalysis[] };

export function ImportBoards({ onDone }: { onDone: (r: ImportResult) => void }) {
  const t = ko.monitor.transfer;
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // same file can be re-selected
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setProblem({ kind: "error", message: t.tooLarge });
      return;
    }
    setBusy(true);
    try {
      const text = await readTextFile(file);
      const analysis = await analyzeImport(text);
      const conflicts = analysis.boards.filter((b) => b.conflict);
      if (conflicts.length > 0) {
        setProblem({ kind: "conflicts", boards: conflicts });
        return;
      }
      onDone(await applyImport(text));
    } catch (err) {
      if (err instanceof ImportConflictError) {
        setProblem({ kind: "conflicts", boards: err.boards });
      } else {
        setProblem({ kind: "error", message: (err as Error).message });
      }
    } finally {
      setBusy(false);
    }
  };

  const close = () => setProblem(null);

  return (
    <>
      <button
        type="button"
        className={BTN}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {t.importFromFile}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onFile(e)}
      />
      {problem?.kind === "error" && (
        <Modal open onClose={close} title={t.errorTitle}>
          <p className="break-words text-sm">{problem.message}</p>
          <div className="mt-4 flex justify-end">
            <button type="button" className={BTN} onClick={close}>
              {t.close}
            </button>
          </div>
        </Modal>
      )}
      {problem?.kind === "conflicts" && (
        <Modal open onClose={close} title={t.conflictTitle}>
          <p className="mb-2 text-sm">{t.conflictLead}</p>
          <ImportConflictList boards={problem.boards} />
          <p className="mt-3 text-sm text-slate-600">{t.conflictNote}</p>
          <div className="mt-4 flex justify-end">
            <button type="button" className={BTN} onClick={close}>
              {t.close}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
