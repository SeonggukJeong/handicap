import { ko } from "../i18n/ko";
import {
  DATE_PRESETS,
  EMPTY_FILTER,
  DEFAULT_SORT,
  MODE_KEYS,
  STATUS_KEYS,
  VERDICT_KEYS,
  SORT_FIELDS,
  hasActiveControls,
  type DatePreset,
  type ModeKey,
  type RunFilter,
  type SortField,
  type SortKey,
  type StatusKey,
  type VerdictKey,
} from "../runs/runFilterSort";

const VERDICT_LABEL: Record<VerdictKey, string> = {
  pass: ko.runFilter.verdictPass,
  fail: ko.runFilter.verdictFail,
  none: ko.runFilter.verdictNone,
};
const STATUS_LABEL: Record<StatusKey, string> = {
  pending: ko.runFilter.statusPending,
  running: ko.runFilter.statusRunning,
  completed: ko.runFilter.statusCompleted,
  failed: ko.runFilter.statusFailed,
  aborted: ko.runFilter.statusAborted,
};
const MODE_LABEL: Record<ModeKey, string> = {
  closed_fixed: ko.runFilter.modeClosedFixed,
  closed_curve: ko.runFilter.modeClosedCurve,
  open_fixed: ko.runFilter.modeOpenFixed,
  open_curve: ko.runFilter.modeOpenCurve,
};
const DATE_LABEL: Record<DatePreset, string> = {
  all: ko.runFilter.dateAll,
  today: ko.runFilter.dateToday,
  "7d": ko.runFilter.date7d,
  "30d": ko.runFilter.date30d,
};
// eslint-disable-next-line react-refresh/only-export-components
export const SORT_FIELD_LABEL: Record<SortField, string> = {
  created: ko.runSort.fieldCreated,
  duration: ko.runSort.fieldDuration,
  vu: ko.runSort.fieldVu,
  verdict: ko.runSort.fieldVerdict,
  status: ko.runSort.fieldStatus,
};

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

type Props = {
  filter: RunFilter;
  sort: SortKey[];
  total: number;
  shown: number;
  onChange: (next: { filter: RunFilter; sort: SortKey[] }) => void;
};

export function RunListControls({ filter, sort, total, shown, onChange }: Props) {
  const setFilter = (f: RunFilter) => onChange({ filter: f, sort });
  const setSort = (s: SortKey[]) => onChange({ filter, sort: s });
  const active = hasActiveControls(filter, sort);

  return (
    <div className="mb-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Chips
          label={ko.runFilter.verdictLabel}
          options={VERDICT_KEYS}
          selected={filter.verdicts}
          labelOf={(k) => VERDICT_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, verdicts: toggle(filter.verdicts, k) })}
        />
        <Chips
          label={ko.runFilter.statusLabel}
          options={STATUS_KEYS}
          selected={filter.statuses}
          labelOf={(k) => STATUS_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, statuses: toggle(filter.statuses, k) })}
        />
        <Chips
          label={ko.runFilter.modeLabel}
          options={MODE_KEYS}
          selected={filter.modes}
          labelOf={(k) => MODE_LABEL[k]}
          onToggle={(k) => setFilter({ ...filter, modes: toggle(filter.modes, k) })}
        />
        <DateFilter filter={filter} onChange={setFilter} />
      </div>

      <SortBuilder sort={sort} onChange={setSort} />

      {active && (
        <div className="flex items-center gap-3">
          <span className="text-slate-600">{ko.runFilter.count(shown, total)}</span>
          <button
            type="button"
            onClick={() => onChange({ filter: EMPTY_FILTER, sort: DEFAULT_SORT })}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-50"
          >
            {ko.runFilter.reset}
          </button>
        </div>
      )}
    </div>
  );
}

function Chips<T extends string>({
  label,
  options,
  selected,
  labelOf,
  onToggle,
}: {
  label: string;
  options: readonly T[];
  selected: T[];
  labelOf: (k: T) => string;
  onToggle: (k: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{label}:</span>
      {options.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt)}
            className={[
              "rounded border px-2 py-0.5",
              on
                ? "border-accent-500 bg-accent-50 text-accent-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            ].join(" ")}
          >
            {labelOf(opt)}
          </button>
        );
      })}
    </div>
  );
}

function DateFilter({ filter, onChange }: { filter: RunFilter; onChange: (f: RunFilter) => void }) {
  const isCustom = !!(filter.dateFrom || filter.dateTo);
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-500">{ko.runFilter.dateLabel}:</span>
      <select
        aria-label={ko.runFilter.dateLabel}
        value={isCustom ? "custom" : filter.datePreset}
        onChange={(e) => {
          if (e.target.value === "custom") return;
          onChange({
            ...filter,
            datePreset: e.target.value as DatePreset,
            dateFrom: null,
            dateTo: null,
          });
        }}
        className="rounded border border-slate-300 bg-white px-2 py-0.5"
      >
        {isCustom && <option value="custom">{ko.runFilter.dateCustom}</option>}
        {DATE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {DATE_LABEL[p]}
          </option>
        ))}
      </select>
      <input
        type="date"
        aria-label={ko.runFilter.dateFromAria}
        value={filter.dateFrom ?? ""}
        onChange={(e) => onChange({ ...filter, dateFrom: e.target.value || null })}
        className="rounded border border-slate-300 bg-white px-1 py-0.5"
      />
      <span className="text-slate-400">~</span>
      <input
        type="date"
        aria-label={ko.runFilter.dateToAria}
        value={filter.dateTo ?? ""}
        onChange={(e) => onChange({ ...filter, dateTo: e.target.value || null })}
        className="rounded border border-slate-300 bg-white px-1 py-0.5"
      />
    </div>
  );
}

function SortBuilder({ sort, onChange }: { sort: SortKey[]; onChange: (s: SortKey[]) => void }) {
  const used = new Set(sort.map((k) => k.field));
  const firstUnused = SORT_FIELDS.find((f) => !used.has(f));

  const setField = (idx: number, field: SortField) =>
    onChange(sort.map((k, i) => (i === idx ? { ...k, field } : k)));
  const toggleDir = (idx: number) =>
    onChange(sort.map((k, i) => (i === idx ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k)));
  const remove = (idx: number) => onChange(sort.filter((_, i) => i !== idx));
  const move = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= sort.length) return;
    const next = [...sort];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-slate-500">{ko.runSort.label}:</span>
      {sort.map((k, idx) => {
        const label = SORT_FIELD_LABEL[k.field];
        return (
          <div
            key={k.field}
            className="flex items-center gap-0.5 rounded border border-slate-300 bg-white px-1 py-0.5"
          >
            <span className="text-slate-400">{idx + 1}</span>
            <select
              aria-label={ko.runSort.fieldSelectAria(idx + 1)}
              value={k.field}
              onChange={(e) => setField(idx, e.target.value as SortField)}
              className="bg-transparent"
            >
              {SORT_FIELDS.filter((f) => f === k.field || !used.has(f)).map((f) => (
                <option key={f} value={f}>
                  {SORT_FIELD_LABEL[f]}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={ko.runSort.toggleDirAria(label)}
              onClick={() => toggleDir(idx)}
              className="px-1 text-slate-600 hover:text-slate-900"
            >
              {k.dir === "asc" ? "▲" : "▼"}
            </button>
            <button
              type="button"
              aria-label={ko.runSort.moveUpAria(label)}
              disabled={idx === 0}
              onClick={() => move(idx, -1)}
              className="px-1 text-slate-500 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={ko.runSort.moveDownAria(label)}
              disabled={idx === sort.length - 1}
              onClick={() => move(idx, 1)}
              className="px-1 text-slate-500 disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={ko.runSort.removeKeyAria(label)}
              onClick={() => remove(idx)}
              className="px-1 text-slate-500 hover:text-red-600"
            >
              ×
            </button>
          </div>
        );
      })}
      {firstUnused && (
        <button
          type="button"
          onClick={() => onChange([...sort, { field: firstUnused, dir: "desc" }])}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-600 hover:bg-slate-50"
        >
          + {ko.runSort.add}
        </button>
      )}
    </div>
  );
}
