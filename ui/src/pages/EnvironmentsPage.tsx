import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useUpdateEnvironment,
} from "../api/hooks";
import { getEnvironment, type EnvironmentInput } from "../api/environments";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

type VarRow = { key: string; value: string };
const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

export function EnvironmentsPage() {
  const { data, isLoading, error } = useEnvironments();
  const createEnv = useCreateEnvironment();
  const updateEnv = useUpdateEnvironment();
  const deleteEnv = useDeleteEnvironment();
  const qc = useQueryClient();

  const [mode, setMode] = useState<"none" | "new" | "edit">("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<VarRow[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // Delete errors surface here (outside the form), since the form is hidden when
  // mode === "none" — mirrors DatasetsPage's `delError` banner.
  const [delError, setDelError] = useState<string | null>(null);

  function startNew() {
    setMode("new");
    setEditingId(null);
    setName("");
    setRows([]);
    setNewKey("");
    setNewValue("");
    setFormError(null);
  }

  // Imperative load on Edit (mirrors RunDialog.loadPreset) — avoids a reseed-effect race.
  async function startEdit(id: string) {
    setFormError(null);
    try {
      const env = await qc.fetchQuery({
        queryKey: queryKeys.environment(id),
        queryFn: () => getEnvironment(id),
      });
      setMode("edit");
      setEditingId(id);
      setName(env.name);
      setRows(Object.entries(env.vars).map(([key, value]) => ({ key, value })));
      setNewKey("");
      setNewValue("");
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  function buildInput(): EnvironmentInput | null {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("이름을 입력하세요");
      return null;
    }
    const vars: Record<string, string> = {};
    for (const { key, value } of rows) {
      const k = key.trim();
      if (k) vars[k] = value;
    }
    return { name: trimmed, vars };
  }

  function save() {
    const input = buildInput();
    if (!input) return;
    setFormError(null);
    const done = {
      onSuccess: () => setMode("none"),
      onError: (e: Error) => setFormError(e.message),
    };
    if (mode === "edit" && editingId) {
      updateEnv.mutate({ id: editingId, input }, done);
    } else {
      createEnv.mutate(input, done);
    }
  }

  function handleDelete(id: string) {
    setDelError(null);
    if (!window.confirm("이 환경을 삭제할까요? (저장된 run/preset 설정은 스냅샷이라 영향 없음)"))
      return;
    deleteEnv.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  }

  const reservedWarn = rows.map((r) => r.key.trim()).filter((k) => RESERVED.has(k));
  const saving = createEnv.isPending || updateEnv.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.nav.environments}</h2>
        {mode === "none" && <Button onClick={startNew}>{ko.pages.newEnvironment}</Button>}
      </div>

      {mode !== "none" && (
        <section
          aria-label="environment form"
          className="mb-8 border border-slate-200 rounded-md p-4 bg-white"
        >
          <h3 className="text-md font-semibold mb-3">
            {mode === "edit" ? ko.pages.editEnvironment : ko.pages.newEnvironment}
          </h3>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">Name</span>
            <input
              aria-label="environment name"
              className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="staging"
            />
          </label>

          <h4 className="text-sm font-semibold text-slate-700 mb-2">Variables</h4>
          <ul className="flex flex-col gap-2">
            {rows.map((entry, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <input
                  aria-label={`var key ${idx}`}
                  className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                  value={entry.key}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)),
                    )
                  }
                />
                <span className="text-slate-400 text-sm">=</span>
                <input
                  aria-label={`var value ${idx}`}
                  className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
                  value={entry.value}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)),
                    )
                  }
                />
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label={`Remove var ${entry.key || idx}`}
                  className="text-slate-500 hover:text-red-600 text-sm"
                >
                  ×
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="text-xs text-slate-400 italic">No variables</li>}
          </ul>

          <div className="flex items-center gap-2 mt-2">
            <input
              aria-label="new var key"
              className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
              placeholder="BASE_URL"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <span className="text-slate-400 text-sm">=</span>
            <input
              aria-label="new var value"
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
              placeholder="value (e.g. https://staging.example)"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const k = newKey.trim();
                if (!k) return;
                setRows((prev) => [...prev, { key: k, value: newValue }]);
                setNewKey("");
                setNewValue("");
              }}
              disabled={newKey.trim().length === 0}
              className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {reservedWarn.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              예약된 시스템 변수명({reservedWarn.join(", ")})은 런타임에 시스템 값으로 해석되어 이
              환경 값이 무시됩니다.
            </p>
          )}
          {formError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {formError}
            </p>
          )}

          <div className="flex gap-2 mt-4">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          삭제 실패: {delError}
        </p>
      )}

      <section aria-label="environment list">
        {isLoading && <p className="text-slate-500">{ko.common.loading}</p>}
        {error && (
          <p className="text-red-600">{ko.common.failedToLoad((error as Error).message)}</p>
        )}
        {data && data.length === 0 && mode === "none" && (
          <EmptyState
            body={ko.empty.environments}
            action={
              <button
                type="button"
                onClick={startNew}
                className="text-slate-700 underline hover:text-slate-900"
              >
                {ko.empty.environmentsCta} →
              </button>
            }
          />
        )}
        {data && data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Variables</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{e.name}</td>
                  <td className="py-2 pr-4">{e.var_count}</td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(e.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleDelete(e.id)}
                      disabled={deleteEnv.isPending}
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
