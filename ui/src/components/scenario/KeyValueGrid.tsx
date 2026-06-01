import { useEffect, useId, useRef, useState } from "react";
import type { BulkFormat } from "../../scenario/kvBulk";
import { findCommonHeader, type CommonHeader } from "../../scenario/commonHeaders";
import { BulkEditPanel } from "./BulkEditPanel";

interface Row {
  key: string;
  value: string;
}

interface KeyValueGridProps {
  entries: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Re-seed drafts only when this changes (pass step.id) — NOT on every entries change. */
  resetKey: string;
  bulkFormat: BulkFormat;
  /** Singular noun for aria-labels, e.g. "header" / "form field". */
  itemLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyText?: string;
  /** When provided, enables the "자주 쓰는 헤더" menu + key-field datalist seeding. */
  commonKeys?: CommonHeader[];
}

function toRows(entries: Record<string, string>): Row[] {
  return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

function toRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "") continue; // empty-key rows are excluded from the committed map (kept in draft)
    out[k] = r.value; // last-wins
  }
  return out;
}

export function KeyValueGrid({
  entries,
  onChange,
  resetKey,
  bulkFormat,
  itemLabel,
  keyPlaceholder,
  valuePlaceholder,
  emptyText,
  commonKeys,
}: KeyValueGridProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(entries));
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const datalistId = useId();
  const hasCommon = !!commonKeys && commonKeys.length > 0;

  // Focus management (spec §3-1 / §6). The add-row key field keeps focus after an
  // add so the user can type the next entry; a menu pick moves focus to the affected
  // row's value field. The pick case needs an effect because the target row may be
  // newly appended (its <input> isn't mounted until the next render).
  const newKeyRef = useRef<HTMLInputElement>(null);
  const valueRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [pickFocusIdx, setPickFocusIdx] = useState<number | null>(null);

  useEffect(() => {
    if (pickFocusIdx === null) return;
    valueRefs.current[pickFocusIdx]?.focus();
    setPickFocusIdx(null);
  }, [pickFocusIdx]);

  // Re-seed drafts ONLY when the selected step changes (mirror ExtractEditor).
  // Re-seeding on an `entries` deep-compare would clobber in-progress edits (spec R2).
  useEffect(() => {
    setRows(toRows(entries));
    setNewKey("");
    setNewValue("");
    setBulkOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(toRecord(next));
  };
  const commitRows = () => onChange(toRecord(rows)); // onBlur — rows already reflects keystrokes

  const updateValue = (idx: number, value: string) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, value } : r)));
  };

  const updateKey = (idx: number, key: string) => {
    setRows((rs) =>
      rs.map((r, i) => {
        if (i !== idx) return r;
        const match = hasCommon ? findCommonHeader(key) : undefined;
        const value = match && r.value.trim() === "" ? match.value : r.value; // best-effort seed
        return { ...r, key, value };
      }),
    );
  };

  const onNewKeyChange = (key: string) => {
    setNewKey(key);
    if (hasCommon) {
      const match = findCommonHeader(key);
      if (match && newValue.trim() === "") setNewValue(match.value); // best-effort seed
    }
  };

  const addRow = () => {
    const k = newKey.trim();
    if (!k) return;
    commit([...rows, { key: k, value: newValue }]);
    setNewKey("");
    setNewValue("");
    newKeyRef.current?.focus(); // spec §3-1: keep focus on the add-row key for the next entry
  };

  const pickCommon = (h: CommonHeader) => {
    const idx = rows.findIndex((r) => r.key.trim().toLowerCase() === h.name.toLowerCase());
    if (idx >= 0) {
      if (rows[idx].value.trim() !== "") return; // A3: don't clobber a user value
      commit(rows.map((r, i) => (i === idx ? { ...r, value: h.value } : r)));
      setPickFocusIdx(idx); // spec §6: focus the seeded value field
    } else {
      commit([...rows, { key: h.name, value: h.value }]);
      setPickFocusIdx(rows.length); // spec §6: focus the appended row's value field
    }
  };

  if (bulkOpen) {
    return (
      <BulkEditPanel
        entries={toRecord(rows)}
        format={bulkFormat}
        onApply={(next) => {
          commit(toRows(next));
          setBulkOpen(false);
        }}
        onCancel={() => setBulkOpen(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex gap-2 justify-end">
        {hasCommon && <CommonHeaderMenu options={commonKeys!} onPick={pickCommon} />}
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
          onClick={() => setBulkOpen(true)}
        >
          Bulk Edit
        </button>
      </div>

      {hasCommon && (
        <datalist id={datalistId}>
          {commonKeys!.map((h) => (
            <option key={h.name} value={h.name} />
          ))}
        </datalist>
      )}

      <ul className="flex flex-col gap-1">
        {rows.map((r, idx) => (
          <li key={idx} className="flex gap-2 items-center">
            <input
              aria-label={`${itemLabel} key ${idx}`}
              list={hasCommon ? datalistId : undefined}
              className="w-32 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
              value={r.key}
              onChange={(e) => updateKey(idx, e.target.value)}
              onBlur={commitRows}
            />
            <span className="text-slate-400 text-xs">=</span>
            <input
              ref={(el) => {
                valueRefs.current[idx] = el;
              }}
              aria-label={`${itemLabel} value ${idx}`}
              className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs"
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => updateValue(idx, e.target.value)}
              onBlur={commitRows}
            />
            <button
              type="button"
              aria-label={`Remove ${itemLabel} ${r.key}`}
              className="text-slate-500 hover:text-red-600 shrink-0"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
            >
              ×
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-xs text-slate-400 italic">{emptyText ?? "No entries"}</li>
        )}
      </ul>

      <div className="flex gap-2 mt-1">
        <input
          ref={newKeyRef}
          aria-label={`new ${itemLabel} key`}
          list={hasCommon ? datalistId : undefined}
          className="w-32 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder={keyPlaceholder}
          value={newKey}
          onChange={(e) => onNewKeyChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRow();
          }}
        />
        <span className="text-slate-400 text-xs">=</span>
        <input
          aria-label={`new ${itemLabel} value`}
          className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-xs"
          placeholder={valuePlaceholder}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addRow();
          }}
        />
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={addRow}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function CommonHeaderMenu({
  options,
  onPick,
}: {
  options: CommonHeader[];
  onPick: (h: CommonHeader) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded"
        onClick={() => setOpen((o) => !o)}
      >
        자주 쓰는 헤더 ▾
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="자주 쓰는 헤더"
          className="absolute right-0 z-10 mt-1 max-h-60 w-56 overflow-auto bg-white border border-slate-300 rounded shadow text-xs"
        >
          {options.map((h) => (
            <li key={h.name}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="block w-full text-left px-3 py-1 hover:bg-slate-100 font-mono"
                onClick={() => {
                  setOpen(false);
                  onPick(h);
                }}
              >
                {h.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
