/**
 * InsertTemplateModal — 저장된 스텝 템플릿 목록에서 선택해 현재 시나리오에 삽입.
 * 부모가 `{open && <InsertTemplateModal onClose={...} />}` 로 조건부 마운트.
 */
import { useState } from "react";
import { useDeleteStepTemplate, useStepTemplates } from "../../api/hooks";
import { getStepTemplate } from "../../api/stepTemplates";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { newStepId } from "../../scenario/ulid";
import { prepareTemplateInsertion } from "../../scenario/yamlDoc";

interface Props {
  onClose: () => void;
}

export function InsertTemplateModal({ onClose }: Props) {
  const list = useStepTemplates();
  const del = useDeleteStepTemplate();
  const insertTemplateSteps = useScenarioEditor((s) => s.insertTemplateSteps);
  const select = useScenarioEditor((s) => s.select);

  const [error, setError] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);

  const templates = list.data ?? [];

  const handleInsert = async (id: string) => {
    setError(null);
    setInserting(true);
    try {
      const tpl = await getStepTemplate(id);
      const prep = prepareTemplateInsertion(tpl.steps_yaml, newStepId);
      if (!prep.ok) {
        setError(`${ko.stepTemplates.incompatible}: ${prep.error}`);
        return;
      }
      const firstId = insertTemplateSteps({
        preparedYaml: prep.preparedYaml,
        firstId: prep.firstId,
      });
      select(firstId);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      void list.refetch();
    } finally {
      setInserting(false);
    }
  };

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(ko.stepTemplates.deleteConfirm(name))) return;
    del.mutate(id);
  };

  return (
    <Modal open title={ko.stepTemplates.insertTitle} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {del.error && (
          <p role="alert" className="text-sm text-red-600">
            {(del.error as Error).message}
          </p>
        )}

        {list.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

        {list.error && (
          <p role="alert" className="text-sm text-red-600">
            {(list.error as Error).message}
          </p>
        )}

        {!list.isLoading && !list.error && templates.length === 0 && (
          <p className="text-sm text-slate-500">{ko.stepTemplates.empty}</p>
        )}

        {templates.length > 0 && (
          <ul className="flex flex-col gap-2">
            {templates.map((tpl) => (
              <li
                key={tpl.id}
                className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{tpl.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {ko.stepTemplates.stepCount(tpl.step_count)}
                    {tpl.description ? ` · ${tpl.description}` : ""}
                    {" · "}
                    {new Date(tpl.updated_at).toLocaleString()}
                  </p>
                </div>
                <div className="ml-2 flex shrink-0 gap-2">
                  <Button onClick={() => void handleInsert(tpl.id)} disabled={inserting}>
                    {ko.stepTemplates.insertAction}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleDelete(tpl.id, tpl.name)}
                    disabled={del.isPending}
                  >
                    {ko.stepTemplates.deleteAction}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {ko.stepTemplates.cancel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
