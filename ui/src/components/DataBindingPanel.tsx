import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataset, useDatasets } from "../api/hooks";
import type { BindingPolicy, DataBinding, Mapping } from "../api/schemas";
import { type Scenario } from "../scenario/model";
import { scanFlowVars, collectProducedVars } from "../scenario/scanVars";
import { ko } from "../i18n/ko";

type Props = {
  scenario: Scenario;
  /** Optional saved bindings to re-hydrate the panel from (run/preset prefill).
   *  The parent remounts this panel (via React key) when the prefill source
   *  changes, so this is read once per mount. A legacy single binding is passed
   *  as a one-element array. */
  initialBindings?: DataBinding[];
  onChange: (bindings: DataBinding[]) => void;
  onValidityChange: (ok: boolean, reasons: string[]) => void;
};

/** Structural equality via JSON serialization — used to skip redundant setState
 *  when a child re-emits a freshly-built-but-equal object/array (loop avoidance).
 *  Inputs are small, JSON-safe (DataBinding / string[]). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Return a copy of `obj` without `key` (immutable delete). */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k];
  }
  return out;
}

type SourceKind = "none" | "column" | "literal";

type MappingRow = {
  varName: string;
  sourceKind: SourceKind;
  /** column name when sourceKind === "column" */
  column: string;
  /** literal value when sourceKind === "literal" */
  literalValue: string;
  /** true if this row was added manually by the user (var name is editable) */
  manual: boolean;
};

function makeRow(varName: string, manual = false): MappingRow {
  return { varName, sourceKind: "none", column: "", literalValue: "", manual };
}

function applyMapping(row: MappingRow, m: Mapping | undefined): MappingRow {
  if (!m) return row;
  if (m.kind === "column") return { ...row, sourceKind: "column", column: m.column };
  return { ...row, sourceKind: "literal", literalValue: m.value };
}

/** Build the initial mapping rows: one per scanned var (seeded from initialBinding
 *  if present), plus manual rows for any mapped var the scan didn't surface. */
function seedRows(vars: Iterable<string>, initial: DataBinding | null | undefined): MappingRow[] {
  const byVar = new Map((initial?.mappings ?? []).map((m) => [m.var, m]));
  const scanned = new Set(vars);
  const out: MappingRow[] = [];
  for (const v of scanned) out.push(applyMapping(makeRow(v), byVar.get(v)));
  for (const m of initial?.mappings ?? []) {
    if (!scanned.has(m.var)) out.push(applyMapping(makeRow(m.var, true), m));
  }
  return out;
}

let cardSeq = 0;
function nextCardId(): string {
  cardSeq += 1;
  return `bind-${cardSeq}`;
}

type CardState = { id: string; initial: DataBinding | null; defaultOpen: boolean };

/** Build the panel's initial card list. An empty seed still renders one (empty)
 *  card so the user immediately sees the scenario's variables to map. The first
 *  card is expanded by default (primary editor); additional seeded cards expand
 *  only when they carry a dataset (collapsed-with-no-value otherwise). */
function seedCards(initial: DataBinding[] | undefined): CardState[] {
  if (initial && initial.length > 0) {
    return initial.map((b, i) => ({
      id: nextCardId(),
      initial: b,
      defaultOpen: i === 0 || !!b.dataset_id,
    }));
  }
  return [{ id: nextCardId(), initial: null, defaultOpen: true }];
}

export function DataBindingPanel({ scenario, initialBindings, onChange, onValidityChange }: Props) {
  const [cards, setCards] = useState<CardState[]>(() => seedCards(initialBindings));
  // Per-card emitted binding (null = card has no dataset selected → not bound).
  const [bindingById, setBindingById] = useState<Record<string, DataBinding | null>>({});
  // Per-card validity reasons (from each card's own checks: uncovered / stale / gone).
  const [reasonsById, setReasonsById] = useState<Record<string, string[]>>({});

  // Deep-equal guards: each BindingCard re-emits a freshly-built binding object /
  // reasons array on its own re-renders. Without these guards setState would create
  // a new state object every time even when nothing changed → re-render → the card's
  // emit effect (whose deps include these callbacks) re-fires → infinite loop (the
  // documented "Maximum update depth" trap). The callbacks are stable (useCallback,
  // []) and skip the update when the serialized value is unchanged.
  const handleCardChange = useCallback((id: string, b: DataBinding | null) => {
    setBindingById((prev) => {
      if (sameJson(prev[id] ?? null, b)) return prev;
      return { ...prev, [id]: b };
    });
  }, []);
  const handleCardValidity = useCallback((id: string, reasons: string[]) => {
    setReasonsById((prev) => {
      if (sameJson(prev[id] ?? [], reasons)) return prev;
      return { ...prev, [id]: reasons };
    });
  }, []);

  // Ref to the always-present "데이터셋 추가" button so focus can be moved there
  // after a card is removed (a11y: avoid dropping focus to <body>).
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const addCard = useCallback(() => {
    // The user explicitly asked for a new dataset → open it for immediate editing.
    setCards((prev) => [...prev, { id: nextCardId(), initial: null, defaultOpen: true }]);
  }, []);

  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
    setBindingById((prev) => (id in prev ? omitKey(prev, id) : prev));
    setReasonsById((prev) => (id in prev ? omitKey(prev, id) : prev));
    // a11y: move focus to the add button so it stays inside the panel (not <body>).
    addBtnRef.current?.focus();
  }, []);

  // Aggregate: emit the array of bound cards (in card order) + the union of per-card
  // reasons plus the cross-card duplicate-variable warning. The server makes the
  // final 400 (Task 5) — this is the client-side mirror of the same rule/message.
  const bindings = useMemo(
    () => cards.map((c) => bindingById[c.id]).filter((b): b is DataBinding => b != null),
    [cards, bindingById],
  );

  const dupReasons = useMemo(() => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const b of bindings) {
      for (const m of b.mappings) {
        if (seen.has(m.var)) {
          if (!dups.includes(m.var)) dups.push(m.var);
        } else {
          seen.add(m.var);
        }
      }
    }
    return dups.map((v) => ko.binding.dupVar(v));
  }, [bindings]);

  // Emit onChange / onValidityChange whenever the aggregate changes.
  useEffect(() => {
    onChange(bindings);
    const reasons = [...cards.flatMap((c) => reasonsById[c.id] ?? []), ...dupReasons];
    onValidityChange(reasons.length === 0, reasons);
  }, [bindings, cards, reasonsById, dupReasons, onChange, onValidityChange]);

  // Vars already mapped by a *prior* card — surfaced as a conflict hint inside the card.
  const claimedVarsByCard = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    const seen = new Set<string>();
    for (const c of cards) {
      out[c.id] = new Set(seen);
      const b = bindingById[c.id];
      if (b) for (const m of b.mappings) seen.add(m.var);
    }
    return out;
  }, [cards, bindingById]);

  // Vars covered by *all other* cards (sibling bindings) — so a card doesn't flag a
  // var as "uncovered" when a different dataset binding supplies it (the multi-binding
  // analog of the Slice 8c extract/scenario.variables false-alarm trap). Passed as a
  // STABLE sorted newline-joined string (not a Set, whose identity changes every render)
  // so it can safely sit in the card's emit-effect deps without reopening the re-render
  // loop. Newline (not space) delimiter: a manual var name can contain a space.
  // O(N²) over cards × cards, but N ≤ MAX_BINDINGS (8) — negligible.
  const coveredByOthers = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of cards) {
      const vars = new Set<string>();
      for (const other of cards) {
        if (other.id === c.id) continue;
        const b = bindingById[other.id];
        if (b) for (const m of b.mappings) vars.add(m.var);
      }
      out[c.id] = [...vars].sort().join("\n");
    }
    return out;
  }, [cards, bindingById]);

  return (
    <section aria-label={ko.binding.sectionTitle} className="mb-3">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.binding.sectionTitle}</h4>

      <div className="flex flex-col gap-3">
        {cards.map((card, idx) => (
          <BindingCard
            key={card.id}
            id={card.id}
            index={idx + 1}
            scenario={scenario}
            initialBinding={card.initial}
            defaultOpen={card.defaultOpen}
            removable={cards.length > 1}
            conflictingVars={claimedVarsByCard[card.id] ?? EMPTY_SET}
            coveredByOthers={coveredByOthers[card.id] ?? ""}
            onChange={handleCardChange}
            onValidityChange={handleCardValidity}
            onRemove={removeCard}
          />
        ))}
      </div>

      {dupReasons.length > 0 && (
        <ul role="alert" className="mt-2 list-disc pl-5 text-xs text-red-600">
          {dupReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <button
        ref={addBtnRef}
        type="button"
        onClick={addCard}
        className="mt-3 px-2 py-1 text-sm border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
      >
        + {ko.binding.addDataset}
      </button>
    </section>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

type CardProps = {
  id: string;
  index: number;
  scenario: Scenario;
  initialBinding: DataBinding | null;
  defaultOpen: boolean;
  removable: boolean;
  /** vars already mapped by an earlier card (cross-card conflict hint). */
  conflictingVars: ReadonlySet<string>;
  /** vars covered by all OTHER cards, space-joined sorted (stable string so it can
   *  sit in the emit-effect deps). Suppresses this card's "uncovered" false-alarm. */
  coveredByOthers: string;
  // Stable parent callbacks keyed by card id (avoids the inline-arrow re-render loop).
  onChange: (id: string, b: DataBinding | null) => void;
  onValidityChange: (id: string, reasons: string[]) => void;
  onRemove: (id: string) => void;
};

/** A single dataset→variable binding editor. Owns the dataset/policy/mapping-row
 *  state for one binding; the parent aggregates many of these into a Profile's
 *  `data_bindings` array. Rendered as a collapsible disclosure (ScenarioSnapshot
 *  idiom): auto-expanded when seeded with a dataset, collapsed otherwise. */
function BindingCard({
  id,
  index,
  scenario,
  initialBinding,
  defaultOpen,
  removable,
  conflictingVars,
  coveredByOthers,
  onChange,
  onValidityChange,
  onRemove,
}: CardProps) {
  // Bind the parent's id-keyed callbacks to this card's id once. The parent callbacks
  // are stable (useCallback, []), so these wrappers are stable for the card lifetime —
  // keeping the emit effect's deps from changing every render (loop avoidance).
  const emitChange = useCallback((b: DataBinding | null) => onChange(id, b), [id, onChange]);
  const emitValidity = useCallback(
    (reasons: string[]) => onValidityChange(id, reasons),
    [id, onValidityChange],
  );
  const datasets = useDatasets();
  const [selectedId, setSelectedId] = useState<string>(initialBinding?.dataset_id ?? "");
  const dataset = useDataset(selectedId || undefined);
  const [policy, setPolicy] = useState<BindingPolicy>(initialBinding?.policy ?? "per_vu");
  const [rows, setRows] = useState<MappingRow[]>(() =>
    seedRows(scanFlowVars(scenario), initialBinding),
  );
  // Collapsible disclosure (ScenarioSnapshot idiom). The parent decides the initial
  // open state: the primary (first) card and any seeded-with-dataset / just-added
  // card start expanded; extra empty cards start collapsed (collapsed-with-no-value).
  const [open, setOpen] = useState<boolean>(defaultOpen);
  // Track which vars have been auto-matched for the current dataset selection.
  const [autoMatchedFor, setAutoMatchedFor] = useState<string>("");
  // Track which vars were auto-matched (for badge rendering).
  const [autoMatchedVars, setAutoMatchedVars] = useState<Set<string>>(new Set());

  // Compute the set of vars this scenario references via {{var}} syntax.
  const scannedVars = useMemo(() => scanFlowVars(scenario), [scenario]);

  // scenario.variables + 모든 extract(분기 포함)로 채워지는 var 집합 (공유 collectProducedVars).
  const availableElsewhere = useMemo<Set<string>>(() => collectProducedVars(scenario), [scenario]);

  // Reconstruct the sibling-covered var set from the stable space-joined string. A var
  // supplied by another binding card is NOT "uncovered" here (Slice 8c false-alarm trap,
  // multi-binding flavor). Memoized on the stable string → no new identity per render.
  const coveredByOthersSet = useMemo<Set<string>>(
    () => new Set(coveredByOthers ? coveredByOthers.split("\n") : []),
    [coveredByOthers],
  );

  // Seed rows from scanned vars whenever the scenario changes.
  // Merge: keep existing row state for vars that still exist, add new ones.
  useEffect(() => {
    setRows((prev) => {
      const prevByVar = new Map(prev.map((r) => [r.varName, r]));
      const next: MappingRow[] = [];
      for (const v of scannedVars) {
        next.push(prevByVar.get(v) ?? makeRow(v));
      }
      // Keep manual rows the user added.
      for (const r of prev) {
        if (r.manual) next.push(r);
      }
      return next;
    });
    // Reset auto-match tracking when the scenario changes.
    setAutoMatchedFor("");
    setAutoMatchedVars(new Set());
  }, [scannedVars]);

  const columns = useMemo(() => dataset.data?.columns ?? [], [dataset.data]);
  const columnSet = useMemo(() => new Set(columns), [columns]);

  // The selected dataset failed to load (deleted out from under a preset, spec §6 #14).
  const datasetGone = !!selectedId && dataset.isError;

  // Auto-match: when a dataset is selected (and columns are loaded), default each row
  // whose var name equals a column name to that column — once per dataset selection.
  useEffect(() => {
    if (!selectedId || columns.length === 0) return;
    // Key that identifies "this dataset + columns combo" — avoid re-running on every
    // unrelated state change.
    const matchKey = selectedId + ":" + columns.join(",");
    if (autoMatchedFor === matchKey) return;
    const newlyMatched = new Set<string>();
    setRows((prev) =>
      prev.map((r) => {
        if (r.sourceKind !== "none") return r; // user already chose a source
        if (columnSet.has(r.varName)) {
          newlyMatched.add(r.varName);
          return { ...r, sourceKind: "column", column: r.varName };
        }
        return r;
      }),
    );
    setAutoMatchedVars(newlyMatched);
    setAutoMatchedFor(matchKey);
  }, [selectedId, columns, columnSet, autoMatchedFor]);

  // Emit onChange / onValidityChange whenever relevant state changes.
  useEffect(() => {
    if (!selectedId) {
      emitChange(null);
      emitValidity([]);
      return;
    }

    // Build complete mappings from rows that have a real source.
    const mappings: DataBinding["mappings"] = [];
    for (const r of rows) {
      if (r.sourceKind === "column" && r.column) {
        mappings.push({ kind: "column", var: r.varName, column: r.column });
      } else if (r.sourceKind === "literal") {
        mappings.push({ kind: "literal", var: r.varName, value: r.literalValue });
      }
    }

    emitChange({ dataset_id: selectedId, policy, mappings });

    // Validity checks with reason collection.
    const mappedVars = new Set(mappings.map((m) => m.var));

    // Uncovered: scanned var that is not mapped here, not provided by scenario
    // vars/extracts, and not supplied by another binding card.
    const uncovered = [...scannedVars].filter(
      (v) => !mappedVars.has(v) && !availableElsewhere.has(v) && !coveredByOthersSet.has(v),
    );

    // Stale column: chosen column no longer exists in the current dataset.
    const staleCols = rows.filter(
      (r) => r.sourceKind === "column" && r.column && !columnSet.has(r.column),
    );

    const reasons: string[] = [
      ...uncovered.map((v) => `{{${v}}} 변수의 열을 선택하거나 매핑을 추가하세요`),
      ...(datasetGone
        ? ["이 프리셋의 데이터셋이 삭제되었습니다 — 다시 선택하세요"]
        : staleCols.map(
            (r) => `{{${r.varName}}}에 선택한 열(${r.column})이 현재 데이터셋에 없습니다`,
          )),
    ];

    emitValidity(reasons);
  }, [
    selectedId,
    policy,
    rows,
    scannedVars,
    availableElsewhere,
    coveredByOthersSet,
    columnSet,
    datasetGone,
    emitChange,
    emitValidity,
  ]);

  // For rendering: is this row's var uncovered (blocking) when a dataset is selected?
  function isUncovered(r: MappingRow): boolean {
    if (!selectedId) return false;
    const isMapped =
      (r.sourceKind === "column" && !!r.column) ||
      (r.sourceKind === "literal" && r.literalValue !== "");
    return !isMapped && !availableElsewhere.has(r.varName) && !coveredByOthersSet.has(r.varName);
  }

  function isStaleColumn(r: MappingRow): boolean {
    return !!selectedId && r.sourceKind === "column" && !!r.column && !columnSet.has(r.column);
  }

  function updateRow(idx: number, patch: Partial<MappingRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function addManualRow() {
    setRows((prev) => [...prev, makeRow("", true)]);
  }

  const rowCount = dataset.data?.row_count;
  const selectedName = datasets.data?.datasets.find((d) => d.id === selectedId)?.name;
  const mappedCount = rows.filter(
    (r) => (r.sourceKind === "column" && !!r.column) || r.sourceKind === "literal",
  ).length;
  const showBanner =
    !!selectedId &&
    (policy === "iter_sequential" || policy === "iter_random" || policy === "unique");

  return (
    <div className="rounded border border-slate-200 bg-white">
      {/* Card header: disclosure toggle (ScenarioSnapshot 이디엄) + summary + remove */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex-1 min-w-0 text-left text-sm font-medium text-slate-700 hover:underline"
        >
          {open ? "▾" : "▸"} {ko.binding.cardLabel(index)}
          <span className="ml-2 text-xs font-normal text-slate-500">
            {selectedName
              ? ko.binding.collapsedSummary(selectedName, mappedCount) +
                (rowCount !== undefined ? ` · ${ko.binding.rowCount(rowCount)}` : "")
              : ko.binding.collapsedUnset}
          </span>
        </button>
        {removable && (
          <button
            type="button"
            onClick={() => onRemove(id)}
            aria-label={ko.binding.removeBinding(index)}
            className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
          >
            ✕
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-slate-100 px-3 py-3">
          {/* Dataset selector */}
          <div className="mb-3">
            <label
              className="block text-sm text-slate-600 mb-1"
              htmlFor={`binding-dataset-${index}`}
            >
              {ko.binding.datasetLabel}
            </label>
            <select
              id={`binding-dataset-${index}`}
              aria-label={ko.binding.datasetLabel}
              className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setAutoMatchedFor("");
                setAutoMatchedVars(new Set());
              }}
            >
              <option value="">— 없음 (바인딩 없이 실행) —</option>
              {datasets.isLoading && <option disabled>{ko.common.loading}</option>}
              {datasets.data?.datasets.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name} ({ko.binding.rowCount(ds.row_count)})
                </option>
              ))}
            </select>
          </div>

          {datasetGone && (
            <p role="alert" className="mb-3 text-sm text-amber-700">
              이 프리셋의 데이터셋이 삭제되었습니다 — 다시 선택하세요.
            </p>
          )}

          {/* Scanned var rows — always visible so user sees what variables the scenario uses.
              Source selects only make sense once a dataset is chosen. */}
          {rows.length > 0 && (
            <div className="mb-3">
              <span className="text-xs font-medium text-slate-600 block mb-2">변수 매핑</span>
              <ul className="flex flex-col gap-2">
                {rows.map((row, idx) => {
                  const uncovered = !row.manual && isUncovered(row);
                  const stale = isStaleColumn(row);
                  const isMapped =
                    (row.sourceKind === "column" && !!row.column) ||
                    (row.sourceKind === "literal" && row.literalValue !== "");
                  const conflict = !!selectedId && isMapped && conflictingVars.has(row.varName);
                  const hasError = uncovered || stale || conflict;

                  return (
                    <li key={idx} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        {/* Var name: read-only badge for scanned vars, editable for manual */}
                        {row.manual ? (
                          <input
                            aria-label={ko.binding.mappingVarNameAria}
                            className="w-28 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                            placeholder="var_name"
                            value={row.varName}
                            onChange={(e) => updateRow(idx, { varName: e.target.value })}
                          />
                        ) : (
                          <span
                            className={`w-28 shrink-0 truncate font-mono text-xs px-2 py-1 rounded ${
                              hasError
                                ? "text-red-700 bg-red-50 border border-red-300"
                                : "text-slate-600 bg-slate-50 border border-slate-200"
                            }`}
                            title={row.varName}
                          >
                            {row.varName}
                          </span>
                        )}
                        {autoMatchedVars.has(row.varName) && row.sourceKind === "column" && (
                          <span className="ml-1 rounded bg-emerald-50 px-1 text-xs text-emerald-700">
                            자동 연결됨
                          </span>
                        )}

                        {/* Source select — only interactive when a dataset is selected */}
                        {selectedId ? (
                          <select
                            aria-label={ko.binding.sourceForAria(row.varName || "")}
                            className={`flex-1 min-w-0 border rounded px-2 py-1 text-sm ${
                              stale ? "border-red-400" : "border-slate-300"
                            }`}
                            value={
                              row.sourceKind === "none"
                                ? "none"
                                : row.sourceKind === "literal"
                                  ? "__literal__"
                                  : row.column
                            }
                            onChange={(e) => {
                              const v = e.target.value;
                              // 사용자가 직접 소스를 바꾸면 "자동 연결됨" 배지 제거
                              setAutoMatchedVars((prev) => {
                                if (!prev.has(row.varName)) return prev;
                                const n = new Set(prev);
                                n.delete(row.varName);
                                return n;
                              });
                              if (v === "none") {
                                updateRow(idx, { sourceKind: "none", column: "" });
                              } else if (v === "__literal__") {
                                updateRow(idx, { sourceKind: "literal", column: "" });
                              } else {
                                updateRow(idx, { sourceKind: "column", column: v });
                              }
                            }}
                          >
                            <option value="none">— 없음 —</option>
                            {columns.map((col) => (
                              <option key={col} value={col}>
                                {col}
                                {dataset.data?.sample?.[0]?.[col] !== undefined
                                  ? ` (예: ${dataset.data.sample[0][col]})`
                                  : ""}
                              </option>
                            ))}
                            <option value="__literal__">literal…</option>
                          </select>
                        ) : (
                          <span className="flex-1 min-w-0 text-xs text-slate-400 italic px-2">
                            데이터셋 선택 후 매핑 가능
                          </span>
                        )}

                        {/* Literal value input */}
                        {selectedId && row.sourceKind === "literal" && (
                          <input
                            aria-label={ko.binding.literalForAria(row.varName || "")}
                            className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1 text-sm"
                            placeholder="고정 값"
                            value={row.literalValue}
                            onChange={(e) => updateRow(idx, { literalValue: e.target.value })}
                          />
                        )}

                        {/* Remove button */}
                        <button
                          type="button"
                          onClick={() => removeRow(idx)}
                          aria-label={ko.binding.removeMappingAria(row.varName || idx)}
                          className="shrink-0 text-slate-500 hover:text-red-600 text-sm"
                        >
                          ×
                        </button>
                      </div>

                      {/* Error hints (only when dataset is selected) */}
                      {uncovered && (
                        <p className="ml-32 text-xs text-red-600">
                          매핑되지 않음 — 시나리오 기본값/추출/env로 제공되거나 매핑돼야 함
                        </p>
                      )}
                      {stale && (
                        <p className="ml-32 text-xs text-red-600">
                          선택한 컬럼이 현재 데이터셋에 없음
                        </p>
                      )}
                      {conflict && !stale && !uncovered && (
                        <p className="ml-32 text-xs text-red-600">
                          {ko.binding.dupVar(row.varName)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Controls shown only when a dataset is selected */}
          {selectedId && (
            <>
              {/* + 추가 button for manual rows */}
              <button
                type="button"
                onClick={addManualRow}
                className="mb-3 px-2 py-1 text-sm border border-slate-300 rounded text-slate-600 hover:bg-slate-50"
              >
                + 추가
              </button>

              {/* Policy selector */}
              <div className="mb-3">
                <label
                  className="block text-sm text-slate-600 mb-1"
                  htmlFor={`binding-policy-${index}`}
                >
                  {ko.binding.policyLabel}
                </label>
                <select
                  id={`binding-policy-${index}`}
                  aria-label={ko.binding.policyLabel}
                  className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
                  value={policy}
                  onChange={(e) => setPolicy(e.target.value as BindingPolicy)}
                >
                  <option value="per_vu">per_vu — VU마다 한 행 (고정)</option>
                  <option value="iter_sequential">iter_sequential — 반복마다 순차 행</option>
                  <option value="iter_random">iter_random — 반복마다 랜덤 행</option>
                  <option value="unique">unique — 행마다 1회 소비, 소진 시 VU 종료</option>
                </select>
              </div>

              {/* per-iteration / unique warning banner */}
              {showBanner && (
                <div
                  role="alert"
                  className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  {policy === "unique" ? (
                    <>
                      unique 정책은 데이터셋 전체를 워커별로 분할해 각 행을 1회만 사용합니다. 소진된
                      VU는 종료되고 부하(RPS)는 그 시점부터 감소합니다. (행 수 ≥ 워커 수 필요)
                    </>
                  ) : (
                    <>
                      per-iteration 정책은 전체 데이터셋
                      {rowCount !== undefined ? `(${ko.binding.rowCount(rowCount)})` : ""}을 워커
                      메모리에 적재합니다. 상한은 controller <code>--dataset-max-rows</code>
                      (Helm <code>controller.datasetMaxRows</code>).
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
