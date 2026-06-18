import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useStepTemplates,
  useUpdateStepTemplate,
  useDeleteStepTemplate,
} from "../api/hooks";
import { getStepTemplate, StepTemplateConflictError } from "../api/stepTemplates";
import { parseStepsFragment } from "../scenario/yamlDoc";
import type { Step } from "../scenario/model";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

function stepSummary(s: Step): string {
  const label = ko.stepTemplates.typeLabel[s.type] ?? s.type;
  if (s.type === "http") return `${s.name} (${label}) · ${s.request.method} ${s.request.url}`;
  return `${s.name} (${label})`;
}

function Preview({ stepsYaml }: { stepsYaml: string }) {
  const parsed = parseStepsFragment(stepsYaml);
  if ("error" in parsed) {
    return <pre className="text-xs bg-slate-50 p-2 rounded overflow-auto">{stepsYaml}</pre>;
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {parsed.steps.map((s) => (
        <li key={s.id} className="font-mono text-xs">
          {stepSummary(s)}
        </li>
      ))}
    </ul>
  );
}

export function TemplatesPage() {
  const { data, isLoading, error } = useStepTemplates();
  const updateTpl = useUpdateStepTemplate();
  const deleteTpl = useDeleteStepTemplate();
  const qc = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stepsYaml, setStepsYaml] = useState(""); // R2: held to resend unchanged
  const [formError, setFormError] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  const startEdit = async (id: string) => {
    setFormError(null);
    try {
      const tpl = await qc.fetchQuery({
        queryKey: queryKeys.stepTemplate(id),
        queryFn: () => getStepTemplate(id),
      });
      setEditingId(id);
      setName(tpl.name);
      setDescription(tpl.description);
      setStepsYaml(tpl.steps_yaml);
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const save = () => {
    if (!editingId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("이름을 입력하세요");
      return;
    }
    setFormError(null);
    updateTpl.mutate(
      {
        id: editingId,
        input: { name: trimmed, description: description.trim(), steps_yaml: stepsYaml },
      },
      {
        onSuccess: () => setEditingId(null),
        onError: (e: Error) =>
          setFormError(e instanceof StepTemplateConflictError ? e.message : e.message),
      },
    );
  };

  const handleDelete = (id: string, tplName: string) => {
    setDelError(null);
    if (!window.confirm(ko.stepTemplates.deleteConfirm(tplName))) return;
    deleteTpl.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.nav.stepTemplates}</h2>
      </div>

      {editingId && (
        <section
          aria-label="template form"
          className="mb-8 border border-slate-200 rounded-md p-4 bg-white"
        >
          <h3 className="text-md font-semibold mb-3">{ko.pages.editStepTemplate}</h3>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">{ko.stepTemplates.colName}</span>
            <input
              aria-label={ko.stepTemplates.colName}
              className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">{ko.stepTemplates.colDescription}</span>
            <input
              aria-label={ko.stepTemplates.colDescription}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="min-w-0 mb-3">
            <legend className="text-sm font-medium mb-1">{ko.stepTemplates.previewLegend}</legend>
            <Preview stepsYaml={stepsYaml} />
          </fieldset>
          {formError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {formError}
            </p>
          )}
          <div className="flex gap-2 mt-4">
            <Button onClick={save} disabled={updateTpl.isPending}>
              {updateTpl.isPending ? ko.stepTemplates.saveProgress : ko.stepTemplates.save}
            </Button>
            <Button variant="secondary" onClick={() => setEditingId(null)}>
              {ko.stepTemplates.cancel}
            </Button>
          </div>
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {ko.stepTemplates.deleteFailed(delError)}
        </p>
      )}

      <section aria-label="template list">
        {isLoading && <p className="text-slate-500">Loading…</p>}
        {error && (
          <p className="text-red-600">{ko.stepTemplates.loadFailed((error as Error).message)}</p>
        )}
        {data && data.length === 0 && !editingId && <EmptyState body={ko.empty.stepTemplates} />}
        {data && data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">{ko.stepTemplates.colName}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colSteps}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colDescription}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colUpdated}</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{t.name}</td>
                  <td className="py-2 pr-4">{t.step_count}</td>
                  <td className="py-2 pr-4">{t.description}</td>
                  <td className="py-2 pr-4">{new Date(t.updated_at).toLocaleString()}</td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(t.id)}>
                      {ko.stepTemplates.editAction}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleDelete(t.id, t.name)}
                      disabled={deleteTpl.isPending}
                    >
                      {ko.stepTemplates.deleteAction}
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
