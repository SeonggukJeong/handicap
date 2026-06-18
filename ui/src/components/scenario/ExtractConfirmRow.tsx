import { useState } from "react";
import type { Extract } from "../../scenario/model";

/** Rebuild an Extract with a new var, preserving the discriminant explicitly
 *  (spreading a union + overriding widens the type — tsc -b would reject it). */
function withVar(proposed: Extract, v: string): Extract {
  switch (proposed.from) {
    case "body":
      return { var: v, from: "body", path: proposed.path };
    case "header":
      return { var: v, from: "header", name: proposed.name };
    case "cookie":
      return { var: v, from: "cookie", name: proposed.name };
    case "status":
      return { var: v, from: "status" };
  }
}

/** Inline confirm row for creating an extract. PLAIN inline JSX — NO <Modal> and NO
 *  <HelpTip>: both use capture-phase ESC handling, and this row also renders INSIDE
 *  the BodyViewer <Modal>, so a nested modal's ESC would close the outer one
 *  (ui/CLAUDE.md HelpTip-in-Modal trap, R11). */
export function ExtractConfirmRow({
  proposed,
  preview,
  onConfirm,
  onCancel,
}: {
  proposed: Extract;
  preview?: string;
  onConfirm: (extract: Extract) => void;
  onCancel: () => void;
}) {
  const [varName, setVarName] = useState(proposed.var);
  const detail =
    proposed.from === "body"
      ? proposed.path
      : proposed.from === "status"
        ? "status"
        : proposed.name;
  const valid = varName.trim().length > 0;
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded bg-indigo-50 px-2 py-1 text-xs">
      <span className="text-slate-500">변수명</span>
      <input
        aria-label="extract variable name"
        value={varName}
        onChange={(e) => setVarName(e.target.value)}
        className="w-32 rounded border border-slate-300 px-1 py-0.5 font-mono"
      />
      <span className="text-slate-400">←</span>
      <span className="rounded bg-slate-200 px-1 py-0.5">{proposed.from}</span>
      <code className="rounded bg-slate-100 px-1 py-0.5 break-all">{detail}</code>
      {preview !== undefined && (
        <span className="max-w-[12rem] truncate text-slate-400">= {preview}</span>
      )}
      <button
        type="button"
        disabled={!valid}
        onClick={() => onConfirm(withVar(proposed, varName.trim()))}
        className="rounded bg-indigo-600 px-2 py-0.5 text-white disabled:opacity-50"
      >
        추가
      </button>
      <button type="button" onClick={onCancel} className="rounded bg-slate-200 px-2 py-0.5">
        취소
      </button>
    </div>
  );
}
