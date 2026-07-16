import { Fragment, useId, useState } from "react";
import { useDatasets, useDeleteDataset } from "../api/hooks";
import { Button } from "../components/Button";
import { Callout } from "../components/ui/Callout";
import { UploadPanel } from "../components/datasets/UploadPanel";
import { DatasetRowsPreview } from "../components/datasets/DatasetRowsPreview";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

export function DatasetsPage() {
  const { data, isLoading, error } = useDatasets();
  const del = useDeleteDataset();
  const [delError, setDelError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 행마다 다른 미리보기 region id — 토글의 aria-controls 연결용(a11y fold-in, TestRunDatasetSection과 동일 이디엄).
  const previewIdBase = useId();

  async function handleDelete(id: string) {
    setDelError(null);
    try {
      const r = await del.mutateAsync({ id });
      if (!r.deleted) {
        const names = r.presets.map((p) => p.name).join(", ");
        if (
          window.confirm(
            `${r.presets.length}개 프리셋이 이 데이터셋을 참조 중입니다 (${names}). 그래도 삭제할까요?`,
          )
        ) {
          await del.mutateAsync({ id, force: true });
        }
      }
    } catch (e) {
      setDelError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.nav.datasets}</h2>
      </div>

      <UploadPanel />

      {delError && (
        <Callout variant="error" role="alert" className="mt-4">
          삭제 실패: {delError}
        </Callout>
      )}

      <section aria-label={ko.dataset.listAria} className="mt-8">
        {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
        {error && (
          <Callout variant="error">{ko.common.failedToLoad((error as Error).message)}</Callout>
        )}
        {data && data.datasets.length === 0 && (
          <EmptyState body={ko.empty.datasets} action={<p>{ko.empty.datasetsCta}</p>} />
        )}
        {data && data.datasets.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">{ko.dataset.colName}</th>
                <th className="py-2 pr-4">{ko.dataset.colColumns}</th>
                <th className="py-2 pr-4">{ko.dataset.colRows}</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => {
                const isExpanded = expandedId === d.id;
                const rowPreviewId = `${previewIdBase}-${d.id}`;
                return (
                  <Fragment key={d.id}>
                    <tr className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium">{d.name}</td>
                      <td className="py-2 pr-4 text-slate-600">{d.columns.join(", ")}</td>
                      <td className="py-2 pr-4">{d.row_count}</td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            aria-expanded={isExpanded}
                            aria-controls={isExpanded ? rowPreviewId : undefined}
                            onClick={() => setExpandedId(isExpanded ? null : d.id)}
                          >
                            {ko.dataset.previewToggle}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => handleDelete(d.id)}
                            disabled={del.isPending}
                          >
                            {ko.common.delete}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={4} className="p-0">
                          <DatasetRowsPreview
                            id={rowPreviewId}
                            datasetId={d.id}
                            name={d.name}
                            columns={d.columns}
                            rowCount={d.row_count}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
