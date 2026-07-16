import { useState } from "react";
import { DATASET_ROWS_PAGE_SIZE, useDatasetRows } from "../../api/hooks";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { Callout } from "../ui/Callout";
import { ko } from "../../i18n/ko";

interface Props {
  datasetId: string;
  name: string;
  columns: string[];
  rowCount: number;
}

/** 저장된 데이터셋 행 미리보기 — DatasetsPage 확장 행 안에서 렌더 (spec §4.4). */
export function DatasetRowsPreview({ datasetId, name, columns, rowCount }: Props) {
  const [offset, setOffset] = useState(0);
  const [jumpDraft, setJumpDraft] = useState("");
  const { data, error, isLoading, isPlaceholderData } = useDatasetRows(datasetId, offset);

  // placeholder 일관성(R5·R6): 번호·범위는 응답 기준, total은 응답 ?? 목록 메타
  const total = data?.total ?? rowCount;
  const respOffset = data?.offset ?? offset;
  const rows = data?.rows ?? [];

  const prevDisabled = offset === 0 || isPlaceholderData;
  const nextDisabled = offset + DATASET_ROWS_PAGE_SIZE >= total || isPlaceholderData;

  function jump() {
    const n = Number(jumpDraft);
    if (!jumpDraft.trim() || !Number.isFinite(n)) return;
    setOffset(Math.min(Math.max(Math.floor(n) - 1, 0), Math.max(total - 1, 0)));
  }

  return (
    <section
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
          <div className="mb-2 flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {ko.dataset.rowsRange(respOffset + 1, respOffset + rows.length, total)}
            </span>
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                jump();
              }}
            >
              <label className="text-slate-600" htmlFor={`jump-${datasetId}`}>
                {ko.dataset.jumpLabel}
              </label>
              <Input
                id={`jump-${datasetId}`}
                type="number"
                min={1}
                size="sm"
                numeric
                className="w-24"
                value={jumpDraft}
                onChange={(e) => setJumpDraft(e.target.value)}
              />
              <Button type="submit" variant="secondary">
                {ko.dataset.jumpGo}
              </Button>
            </form>
            <Button
              variant="secondary"
              disabled={prevDisabled}
              onClick={() => setOffset(Math.max(offset - DATASET_ROWS_PAGE_SIZE, 0))}
            >
              {ko.dataset.prevPage}
            </Button>
            <Button
              variant="secondary"
              disabled={nextDisabled}
              onClick={() => setOffset(offset + DATASET_ROWS_PAGE_SIZE)}
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
                {rows.map((row, i) => (
                  <tr key={respOffset + i} className="border-b border-slate-100">
                    <td className="px-2 py-1 tabular-nums text-slate-400">{respOffset + i + 1}</td>
                    {columns.map((c) => (
                      <td key={c} className="max-w-xs truncate px-2 py-1" title={row[c] ?? ""}>
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
