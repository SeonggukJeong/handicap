import { useState } from "react";
import { parseBulk, formatEntries, type BulkFormat } from "../../scenario/kvBulk";

interface BulkEditPanelProps {
  entries: Record<string, string>;
  format: BulkFormat;
  onApply: (next: Record<string, string>) => void;
  onCancel: () => void;
}

export function BulkEditPanel({ entries, format, onApply, onCancel }: BulkEditPanelProps) {
  const [text, setText] = useState(() => formatEntries(entries, format));
  const { entries: parsed, skipped } = parseBulk(text, format);
  const hint =
    format === "form"
      ? "한 줄에 key=value, 또는 a=1&b=2 처럼 &로 연결. urlencoded 값은 자동으로 디코딩됩니다."
      : "한 줄에 Header: Value.";

  return (
    <div className="flex flex-col gap-1 min-w-0" aria-label="bulk edit">
      <textarea
        aria-label="bulk edit text"
        className="w-full min-w-0 h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <p className="text-xs text-slate-400">{hint}</p>
      {skipped > 0 && <p className="text-xs text-amber-700">구분자 없는 줄 {skipped}개 건너뜀</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={() => onApply(parsed)}
        >
          Apply
        </button>
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
