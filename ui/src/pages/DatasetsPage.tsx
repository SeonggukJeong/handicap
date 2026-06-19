import { useState } from "react";
import { useDatasets, useDeleteDataset } from "../api/hooks";
import { Button } from "../components/Button";
import { UploadPanel } from "../components/datasets/UploadPanel";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

export function DatasetsPage() {
  const { data, isLoading, error } = useDatasets();
  const del = useDeleteDataset();
  const [delError, setDelError] = useState<string | null>(null);

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
        <p role="alert" className="mt-4 text-sm text-red-600">
          삭제 실패: {delError}
        </p>
      )}

      <section aria-label="dataset list" className="mt-8">
        {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
        {error && (
          <p className="text-red-600">{ko.common.failedToLoad((error as Error).message)}</p>
        )}
        {data && data.datasets.length === 0 && (
          <EmptyState body={ko.empty.datasets} action={<p>{ko.empty.datasetsCta}</p>} />
        )}
        {data && data.datasets.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Columns</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{d.name}</td>
                  <td className="py-2 pr-4 text-slate-600">{d.columns.join(", ")}</td>
                  <td className="py-2 pr-4">{d.row_count}</td>
                  <td className="py-2 pr-4">
                    <Button
                      variant="danger"
                      onClick={() => handleDelete(d.id)}
                      disabled={del.isPending}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
