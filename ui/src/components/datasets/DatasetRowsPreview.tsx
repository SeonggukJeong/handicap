import { useState } from "react";
import { DATASET_ROWS_PAGE_SIZES, useDatasetRows } from "../../api/hooks";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Callout } from "../ui/Callout";
import { ko } from "../../i18n/ko";
import { loadPreviewPageSize, savePreviewPageSize } from "./previewPrefs";

interface Props {
  datasetId: string;
  name: string;
  columns: string[];
  rowCount: number;
  /** 전달 시 행 클릭 = 선택(0-based 데이터셋 idx) — test-run 행 선택 재사용 (R12). */
  onSelectRow?: (rowIndex: number) => void;
  selectedRow?: number;
  /** 전달 시 region 루트에 적용 — 호출부 토글 버튼의 aria-controls 연결용(a11y fold-in). */
  id?: string;
}

/** 저장된 데이터셋 행 미리보기 — DatasetsPage 확장 행 안에서 렌더 (spec §4.4). */
export function DatasetRowsPreview({
  datasetId,
  name,
  columns,
  rowCount,
  onSelectRow,
  selectedRow,
  id,
}: Props) {
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(loadPreviewPageSize);
  const [jumpDraft, setJumpDraft] = useState("");
  const { data, error, isLoading, isPlaceholderData } = useDatasetRows(datasetId, offset, pageSize);

  // placeholder 일관성(R5·R6): 번호·범위는 응답 기준, total은 응답 ?? 목록 메타
  const total = data?.total ?? rowCount;
  const respOffset = data?.offset ?? offset;
  const rows = data?.rows ?? [];

  const prevDisabled = offset === 0 || isPlaceholderData;
  const nextDisabled = offset + pageSize >= total || isPlaceholderData;

  function jump() {
    const n = Number(jumpDraft);
    if (!jumpDraft.trim() || !Number.isFinite(n)) return;
    setOffset(Math.min(Math.max(Math.floor(n) - 1, 0), Math.max(total - 1, 0)));
    setJumpDraft("");
  }

  return (
    <section
      id={id}
      aria-label={ko.dataset.previewAria(name)}
      className="my-2 rounded border border-slate-200 bg-slate-50 p-3"
    >
      {isLoading && (
        <p className="text-slate-500" role="status">
          {ko.common.loading}
        </p>
      )}
      {error && (
        <Callout variant="error" role="alert">
          {ko.common.failedToLoad((error as Error).message)}
        </Callout>
      )}
      {data && total === 0 && <p className="text-slate-500">{ko.dataset.noRows}</p>}
      {data && total > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-600">
              {ko.dataset.rowsRange(respOffset + 1, respOffset + rows.length, total)}
            </span>
            <div className="flex items-center gap-1">
              <span className="whitespace-nowrap text-slate-600">{ko.dataset.pageSizeLabel}</span>
              <div className="w-20">
                <Select
                  size="sm"
                  aria-label={ko.dataset.pageSizeLabel}
                  value={String(pageSize)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setPageSize(n);
                    savePreviewPageSize(n);
                  }}
                >
                  {DATASET_ROWS_PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                jump();
              }}
            >
              <label className="whitespace-nowrap text-slate-600" htmlFor={`jump-${datasetId}`}>
                {ko.dataset.jumpLabel}
              </label>
              <div className="w-24">
                <Input
                  id={`jump-${datasetId}`}
                  type="number"
                  min={1}
                  size="sm"
                  numeric
                  value={jumpDraft}
                  onChange={(e) => setJumpDraft(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary" className="whitespace-nowrap">
                {ko.dataset.jumpGo}
              </Button>
            </form>
            <Button
              variant="secondary"
              disabled={prevDisabled}
              className="whitespace-nowrap"
              onClick={() => setOffset(Math.max(offset - pageSize, 0))}
            >
              {ko.dataset.prevPage}
            </Button>
            <Button
              variant="secondary"
              disabled={nextDisabled}
              className="whitespace-nowrap"
              onClick={() => setOffset(offset + pageSize)}
            >
              {ko.dataset.nextPage}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full border border-slate-200 text-sm">
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th className="border-b border-slate-200 px-2 py-1 font-medium text-slate-500">
                    {ko.dataset.rowNumHeader}
                  </th>
                  {columns.map((c) => (
                    <th key={c} className="border-b border-slate-200 px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const rowIdx = respOffset + i;
                  const selected = selectedRow === rowIdx;
                  return (
                    <tr
                      key={rowIdx}
                      className={`border-b border-slate-100${
                        onSelectRow ? " cursor-pointer hover:bg-slate-100" : ""
                      }${selected ? " bg-accent-50" : ""}`}
                      onClick={onSelectRow ? () => onSelectRow(rowIdx) : undefined}
                    >
                      <td className="px-2 py-1 tabular-nums text-slate-400">
                        {onSelectRow ? (
                          <button
                            type="button"
                            aria-label={ko.dataset.selectRowAria(rowIdx + 1)}
                            aria-pressed={selected}
                            className="tabular-nums hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectRow(rowIdx);
                            }}
                          >
                            {rowIdx + 1}
                          </button>
                        ) : (
                          rowIdx + 1
                        )}
                      </td>
                      {columns.map((c) => (
                        <td key={c} className="max-w-xs truncate px-2 py-1" title={row[c] ?? ""}>
                          {row[c] ?? ""}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
