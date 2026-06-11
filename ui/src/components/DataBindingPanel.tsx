import { useEffect, useMemo, useState } from "react";
import { useDataset, useDatasets } from "../api/hooks";
import type { BindingPolicy, DataBinding, Mapping } from "../api/schemas";
import { flattenHttpSteps, type Scenario } from "../scenario/model";
import { scanFlowVars } from "../scenario/scanVars";

type Props = {
  scenario: Scenario;
  /** Optional saved binding to re-hydrate the panel from (run/preset prefill).
   *  The parent remounts this panel (via React key) when the prefill source
   *  changes, so this is read once per mount. */
  initialBinding?: DataBinding | null;
  onChange: (b: DataBinding | null) => void;
  onValidityChange: (ok: boolean, reasons: string[]) => void;
};

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

export function DataBindingPanel({ scenario, initialBinding, onChange, onValidityChange }: Props) {
  const datasets = useDatasets();
  const [selectedId, setSelectedId] = useState<string>(initialBinding?.dataset_id ?? "");
  const dataset = useDataset(selectedId || undefined);
  const [policy, setPolicy] = useState<BindingPolicy>(initialBinding?.policy ?? "per_vu");
  const [rows, setRows] = useState<MappingRow[]>(() =>
    seedRows(scanFlowVars(scenario), initialBinding),
  );
  // Track which vars have been auto-matched for the current dataset selection.
  const [autoMatchedFor, setAutoMatchedFor] = useState<string>("");
  // Track which vars were auto-matched (for badge rendering).
  const [autoMatchedVars, setAutoMatchedVars] = useState<Set<string>>(new Set());

  // Compute the set of vars this scenario references via {{var}} syntax.
  const scannedVars = useMemo(() => scanFlowVars(scenario), [scenario]);

  // Compute the set of vars available from other sources (scenario.variables + extracts).
  const availableElsewhere = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const k of Object.keys(scenario.variables)) s.add(k);
    for (const step of flattenHttpSteps(scenario.steps)) {
      for (const e of step.extract) s.add(e.var);
    }
    return s;
  }, [scenario]);

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
      onChange(null);
      onValidityChange(true, []);
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

    onChange({ dataset_id: selectedId, policy, mappings });

    // Validity checks with reason collection.
    const mappedVars = new Set(mappings.map((m) => m.var));

    // Uncovered: scanned var that is not mapped and not provided elsewhere.
    const uncovered = [...scannedVars].filter(
      (v) => !mappedVars.has(v) && !availableElsewhere.has(v),
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

    onValidityChange(reasons.length === 0, reasons);
  }, [
    selectedId,
    policy,
    rows,
    scannedVars,
    availableElsewhere,
    columnSet,
    datasetGone,
    onChange,
    onValidityChange,
  ]);

  // For rendering: is this row's var uncovered (blocking) when a dataset is selected?
  function isUncovered(r: MappingRow): boolean {
    if (!selectedId) return false;
    const isMapped =
      (r.sourceKind === "column" && !!r.column) ||
      (r.sourceKind === "literal" && r.literalValue !== "");
    return !isMapped && !availableElsewhere.has(r.varName);
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
  const showBanner =
    !!selectedId &&
    (policy === "iter_sequential" || policy === "iter_random" || policy === "unique");

  return (
    <section aria-label="Data binding" className="mb-3">
      <h4 className="text-sm font-semibold text-slate-700 mb-2">Data binding</h4>

      {/* Dataset selector */}
      <div className="mb-3">
        <label className="block text-sm text-slate-600 mb-1" htmlFor="binding-dataset">
          Dataset
        </label>
        <select
          id="binding-dataset"
          aria-label="dataset"
          className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
          value={selectedId}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setAutoMatchedFor("");
            setAutoMatchedVars(new Set());
          }}
        >
          <option value="">— 없음 (바인딩 없이 실행) —</option>
          {datasets.isLoading && <option disabled>Loading…</option>}
          {datasets.data?.datasets.map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.name} ({ds.row_count}행)
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
              const hasError = uncovered || stale;

              return (
                <li key={idx} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {/* Var name: read-only badge for scanned vars, editable for manual */}
                    {row.manual ? (
                      <input
                        aria-label="mapping var name"
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
                        aria-label={`source for ${row.varName || "var"}`}
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
                        aria-label={`literal value for ${row.varName || "var"}`}
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
                      aria-label={`Remove mapping for ${row.varName || idx}`}
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
                    <p className="ml-32 text-xs text-red-600">선택한 컬럼이 현재 데이터셋에 없음</p>
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
            <label className="block text-sm text-slate-600 mb-1" htmlFor="binding-policy">
              Policy
            </label>
            <select
              id="binding-policy"
              aria-label="policy"
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
                  {rowCount !== undefined ? `(${rowCount}행)` : ""}을 워커 메모리에 적재합니다.
                  상한은 controller <code>--dataset-max-rows</code>
                  (Helm <code>controller.datasetMaxRows</code>).
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
