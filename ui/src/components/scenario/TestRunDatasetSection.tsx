import { useEffect, useMemo, useRef, useState } from "react";
import { useDatasets } from "../../api/hooks";
import type { Mapping, TestRunDatasetConfig, TestRunDatasetMode } from "../../api/schemas";
import { Section } from "../ui/Section";
import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { DatasetRowsPreview } from "../datasets/DatasetRowsPreview";
import { ko } from "../../i18n/ko";

export type DatasetDraftState =
  | { kind: "ready"; config: TestRunDatasetConfig; requestedRows: number }
  | { kind: "incomplete"; reason: string };

interface SelectedDataset {
  id: string;
  name: string;
  columns: string[];
  rowCount: number;
}

interface MappingRow {
  column: string;
  var: string;
}

/** 접이식 test-run 데이터셋 구성 섹션(R11/R14/R15, ADR-0047). 접힘 기본이라
 *  `useDatasets`는 본문(펼침) 컴포넌트 안에서만 호출 — 기존 페이지/TestRunSection
 *  RTL의 one-shot fetch 큐를 안 깨는 계약(ui/CLAUDE.md 무조건-훅 함정). */
export function TestRunDatasetSection({
  onChange,
  expectedLeafCount,
  maxRequests,
}: {
  onChange: (state: DatasetDraftState | null) => void;
  expectedLeafCount: number;
  maxRequests: number;
}) {
  // latest-value ref — dep은 state 원자들만 (부모 콜백 identity churn과 무관하게 최신 콜백 사용).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedDataset | null>(null);
  const [mode, setMode] = useState<TestRunDatasetMode>("single_row");
  const [rowIndex, setRowIndex] = useState<number | null>(null);
  const [startRowDraft, setStartRowDraft] = useState("");
  const [rowLimitDraft, setRowLimitDraft] = useState("");
  const [mappingRows, setMappingRows] = useState<MappingRow[] | null>(null);

  const datasetId = selected?.id ?? null;
  const rowCount = selected?.rowCount ?? 0;
  const selectedName = selected?.name ?? "";

  const derived = useMemo<DatasetDraftState | null>(() => {
    if (datasetId == null) return null;
    const mappings: Mapping[] | undefined =
      mappingRows && mappingRows.length > 0
        ? mappingRows.map((r) => ({ kind: "column" as const, var: r.var, column: r.column }))
        : undefined;
    if (mode === "single_row") {
      if (rowIndex == null) return { kind: "incomplete", reason: ko.editor.dsIncompleteRow };
      return {
        kind: "ready",
        requestedRows: 1,
        config: {
          mode,
          bindings: [
            { dataset_id: datasetId, ...(mappings ? { mappings } : {}), row_index: rowIndex },
          ],
        },
      };
    }
    const startN = startRowDraft.trim() === "" ? 0 : Math.floor(Number(startRowDraft)) - 1;
    const limitN = rowLimitDraft.trim() === "" ? null : Math.floor(Number(rowLimitDraft));
    if (
      !Number.isFinite(startN) ||
      startN < 0 ||
      (limitN != null && (!Number.isFinite(limitN) || limitN < 1))
    ) {
      return { kind: "incomplete", reason: ko.editor.dsIncompleteSeq };
    }
    const remaining = Math.max(rowCount - startN, 0);
    return {
      kind: "ready",
      requestedRows: limitN ?? remaining,
      config: {
        mode,
        bindings: [{ dataset_id: datasetId, ...(mappings ? { mappings } : {}) }],
        ...(startRowDraft.trim() !== "" ? { start_row: startN } : {}),
        ...(limitN != null ? { row_limit: limitN } : {}),
      },
    };
  }, [datasetId, mode, rowIndex, startRowDraft, rowLimitDraft, mappingRows, rowCount]);

  useEffect(() => {
    onChangeRef.current(derived);
  }, [derived]);

  function handleSelectDataset(meta: SelectedDataset | null) {
    setSelected(meta);
    setRowIndex(null);
    setStartRowDraft("");
    setRowLimitDraft("");
    setMappingRows(null);
  }

  return (
    <Section
      variant="card"
      collapsible
      open={open}
      onToggle={() => setOpen((o) => !o)}
      title={ko.editor.dsSectionTitle}
      aria-label={ko.editor.dsSectionAria}
      hint={
        datasetId != null
          ? ko.editor.dsSummary(
              selectedName,
              mode === "single_row" ? ko.editor.dsModeSingle : ko.editor.dsModeSeq,
            )
          : undefined
      }
    >
      {open && (
        <DatasetBody
          selected={selected}
          onSelectDataset={handleSelectDataset}
          mode={mode}
          onModeChange={setMode}
          rowIndex={rowIndex}
          onRowIndexChange={setRowIndex}
          startRowDraft={startRowDraft}
          onStartRowDraftChange={setStartRowDraft}
          rowLimitDraft={rowLimitDraft}
          onRowLimitDraftChange={setRowLimitDraft}
          mappingRows={mappingRows}
          onMappingRowsChange={setMappingRows}
          derived={derived}
          expectedLeafCount={expectedLeafCount}
          maxRequests={maxRequests}
        />
      )}
    </Section>
  );
}

function DatasetBody({
  selected,
  onSelectDataset,
  mode,
  onModeChange,
  rowIndex,
  onRowIndexChange,
  startRowDraft,
  onStartRowDraftChange,
  rowLimitDraft,
  onRowLimitDraftChange,
  mappingRows,
  onMappingRowsChange,
  derived,
  expectedLeafCount,
  maxRequests,
}: {
  selected: SelectedDataset | null;
  onSelectDataset: (meta: SelectedDataset | null) => void;
  mode: TestRunDatasetMode;
  onModeChange: (mode: TestRunDatasetMode) => void;
  rowIndex: number | null;
  onRowIndexChange: (idx: number | null) => void;
  startRowDraft: string;
  onStartRowDraftChange: (v: string) => void;
  rowLimitDraft: string;
  onRowLimitDraftChange: (v: string) => void;
  mappingRows: MappingRow[] | null;
  onMappingRowsChange: (rows: MappingRow[] | null) => void;
  derived: DatasetDraftState | null;
  expectedLeafCount: number;
  maxRequests: number;
}) {
  // 훅은 이 Body 컴포넌트(펼침 시에만 마운트) 안에만 — 접힘 중 fetch 0 계약.
  const datasets = useDatasets();
  const list = datasets.data?.datasets ?? [];
  const datasetId = selected?.id ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-600">{ko.editor.dsPickLabel}</span>
        <div className="w-40">
          <Select
            aria-label={ko.editor.dsPickLabel}
            value={datasetId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                onSelectDataset(null);
                return;
              }
              const meta = list.find((d) => d.id === id);
              if (!meta) return;
              onSelectDataset({
                id: meta.id,
                name: meta.name,
                columns: meta.columns,
                rowCount: meta.row_count,
              });
            }}
          >
            <option value="">{ko.editor.dsPickNone}</option>
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {selected && (
        <>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="test-run-dataset-mode"
                checked={mode === "single_row"}
                onChange={() => onModeChange("single_row")}
              />
              {ko.editor.dsModeSingle}
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="test-run-dataset-mode"
                checked={mode === "sequential"}
                onChange={() => onModeChange("sequential")}
              />
              {ko.editor.dsModeSeq}
            </label>
          </div>

          {mode === "single_row" && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-slate-600">{ko.editor.dsRowNumLabel}</span>
                <div className="w-24">
                  <Input
                    type="number"
                    min={1}
                    numeric
                    value={rowIndex == null ? "" : rowIndex + 1}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw.trim() === "") {
                        onRowIndexChange(null);
                        return;
                      }
                      const n = Number(raw);
                      onRowIndexChange(Number.isFinite(n) && n >= 1 ? Math.floor(n) - 1 : null);
                    }}
                  />
                </div>
              </label>
              <DatasetRowsPreview
                datasetId={selected.id}
                name={selected.name}
                columns={selected.columns}
                rowCount={selected.rowCount}
                selectedRow={rowIndex ?? undefined}
                onSelectRow={onRowIndexChange}
              />
            </>
          )}

          {mode === "sequential" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-slate-600">{ko.editor.dsStartRowLabel}</span>
                  <div className="w-24">
                    <Input
                      type="number"
                      min={1}
                      numeric
                      value={startRowDraft}
                      onChange={(e) => onStartRowDraftChange(e.target.value)}
                    />
                  </div>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-slate-600">{ko.editor.dsRowLimitLabel}</span>
                  <div className="w-24">
                    <Input
                      type="number"
                      min={1}
                      numeric
                      value={rowLimitDraft}
                      onChange={(e) => onRowLimitDraftChange(e.target.value)}
                    />
                  </div>
                </label>
              </div>
              {derived?.kind === "ready" &&
                derived.requestedRows * expectedLeafCount > maxRequests && (
                  <span className="text-xs text-amber-700">
                    {ko.editor.dsBudgetHint(derived.requestedRows * expectedLeafCount, maxRequests)}
                  </span>
                )}
            </div>
          )}

          <MappingEditor
            columns={selected.columns}
            mappingRows={mappingRows}
            onChange={onMappingRowsChange}
          />
        </>
      )}
    </div>
  );
}

function MappingEditor({
  columns,
  mappingRows,
  onChange,
}: {
  columns: string[];
  mappingRows: MappingRow[] | null;
  onChange: (rows: MappingRow[] | null) => void;
}) {
  if (mappingRows === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>{ko.editor.dsMappingAuto}</span>
        <button
          type="button"
          className="text-accent-600 hover:underline"
          onClick={() => onChange(columns.map((c) => ({ column: c, var: c })))}
        >
          {ko.editor.dsMappingEdit}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {mappingRows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-32">
            <Select
              aria-label={ko.editor.dsMappingColAria(i)}
              value={row.column}
              onChange={(e) => {
                const next = mappingRows.slice();
                next[i] = { ...row, column: e.target.value };
                onChange(next);
              }}
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-32">
            <Input
              aria-label={ko.editor.dsMappingVarAria(i)}
              value={row.var}
              onChange={(e) => {
                const next = mappingRows.slice();
                next[i] = { ...row, var: e.target.value };
                onChange(next);
              }}
            />
          </div>
          <button
            type="button"
            aria-label={ko.editor.dsMappingRemoveAria(i)}
            onClick={() => {
              const next = mappingRows.filter((_, idx) => idx !== i);
              onChange(next.length === 0 ? null : next);
            }}
            className="text-slate-500 hover:text-red-600"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="self-start text-xs text-accent-600 hover:underline"
        onClick={() => onChange([...mappingRows, { column: columns[0] ?? "", var: "" }])}
      >
        {ko.editor.dsMappingAdd}
      </button>
    </div>
  );
}
