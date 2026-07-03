import { useEffect, useId, useRef, useState } from "react";
import type { BulkFormat } from "../../scenario/kvBulk";
import { findCommonHeader, type CommonHeader } from "../../scenario/commonHeaders";
import { BulkEditPanel } from "./BulkEditPanel";
import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";

interface Row {
  key: string;
  value: string;
  enabled: boolean;
}

interface KeyValueGridProps {
  entries: Record<string, string>;
  /** Disabled rows (kept but not sent). Default {}. */
  disabledEntries?: Record<string, string>;
  onChange: (active: Record<string, string>, disabled: Record<string, string>) => void;
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

// Active rows render first (top), disabled rows after. A re-enabled row moves to the
// bottom of the active group — order reflects active/disabled grouping, not insertion order.
function toRows(active: Record<string, string>, disabled: Record<string, string>): Row[] {
  return [
    ...Object.entries(active).map(([key, value]) => ({ key, value, enabled: true })),
    ...Object.entries(disabled).map(([key, value]) => ({ key, value, enabled: false })),
  ];
}

function splitRows(rows: Row[]): {
  active: Record<string, string>;
  disabled: Record<string, string>;
} {
  const active: Record<string, string> = {};
  const disabled: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "" || !r.enabled) continue;
    active[k] = r.value; // last-wins
  }
  for (const r of rows) {
    const k = r.key.trim();
    if (k === "" || r.enabled) continue;
    if (k in active) continue; // active wins on collision (one key = one row)
    disabled[k] = r.value;
  }
  return { active, disabled };
}

export function KeyValueGrid({
  entries,
  disabledEntries = {},
  onChange,
  resetKey,
  bulkFormat,
  itemLabel,
  keyPlaceholder,
  valuePlaceholder,
  emptyText,
  commonKeys,
}: KeyValueGridProps) {
  const [rows, setRows] = useState<Row[]>(() => toRows(entries, disabledEntries));
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
    setRows(toRows(entries, disabledEntries));
    setNewKey("");
    setNewValue("");
    setBulkOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const commit = (next: Row[]) => {
    setRows(next);
    const { active, disabled } = splitRows(next);
    onChange(active, disabled);
  };
  const commitRows = () => {
    const { active, disabled } = splitRows(rows);
    onChange(active, disabled);
  };

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
    commit([...rows, { key: k, value: newValue, enabled: true }]);
    setNewKey("");
    setNewValue("");
    newKeyRef.current?.focus(); // spec §3-1: keep focus on the add-row key for the next entry
  };

  const toggleEnabled = (idx: number) => {
    commit(rows.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)));
  };

  const pickCommon = (h: CommonHeader) => {
    const idx = rows.findIndex((r) => r.key.trim().toLowerCase() === h.name.toLowerCase());
    if (idx >= 0) {
      if (rows[idx].value.trim() !== "") return; // A3: don't clobber a user value
      commit(rows.map((r, i) => (i === idx ? { ...r, value: h.value } : r)));
      setPickFocusIdx(idx); // spec §6: focus the seeded value field
    } else {
      commit([...rows, { key: h.name, value: h.value, enabled: true }]);
      setPickFocusIdx(rows.length); // spec §6: focus the appended row's value field
    }
  };

  if (bulkOpen) {
    return (
      <BulkEditPanel
        entries={splitRows(rows).active}
        format={bulkFormat}
        onApply={(nextActive) => {
          const preserved = rows.filter(
            (r) => !r.enabled && r.key.trim() !== "" && !(r.key.trim() in nextActive),
          );
          commit([...toRows(nextActive, {}), ...preserved]);
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
              type="checkbox"
              aria-label={`${itemLabel} enabled ${idx}`}
              className="shrink-0"
              checked={r.enabled}
              onChange={() => toggleEnabled(idx)}
            />
            <div className="w-32 min-w-0">
              <Input
                size="sm"
                aria-label={`${itemLabel} key ${idx}`}
                list={hasCommon ? datalistId : undefined}
                className="min-w-0 font-mono"
                value={r.key}
                onChange={(e) => updateKey(idx, e.target.value)}
                onBlur={commitRows}
              />
            </div>
            <span className="text-slate-400 text-xs">=</span>
            <div className="flex-1 min-w-0">
              <Input
                size="sm"
                ref={(el) => {
                  valueRefs.current[idx] = el;
                }}
                aria-label={`${itemLabel} value ${idx}`}
                className="min-w-0"
                placeholder={valuePlaceholder}
                value={r.value}
                onChange={(e) => updateValue(idx, e.target.value)}
                onBlur={commitRows}
              />
            </div>
            <button
              type="button"
              aria-label={ko.common.removeItemAria(itemLabel, r.key)}
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
        <div className="w-32 min-w-0">
          <Input
            size="sm"
            ref={newKeyRef}
            aria-label={ko.common.newItemKeyAria(itemLabel)}
            list={hasCommon ? datalistId : undefined}
            className="min-w-0 font-mono"
            placeholder={keyPlaceholder}
            value={newKey}
            onChange={(e) => onNewKeyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addRow();
            }}
          />
        </div>
        <span className="text-slate-400 text-xs">=</span>
        <div className="flex-1 min-w-0">
          <Input
            size="sm"
            aria-label={ko.common.newItemValueAria(itemLabel)}
            className="min-w-0"
            placeholder={valuePlaceholder}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addRow();
            }}
          />
        </div>
        <button
          type="button"
          className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={addRow}
        >
          {ko.common.add}
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
