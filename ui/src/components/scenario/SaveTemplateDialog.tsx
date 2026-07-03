/**
 * SaveTemplateDialog — "템플릿으로 저장" 다이얼로그.
 * 부모가 `{open && <SaveTemplateDialog onClose={...} />}` 로 조건부 마운트
 * (열 때마다 fresh state — open prop 없음).
 */
import { useState } from "react";
import { useCreateStepTemplate, useUpdateStepTemplate } from "../../api/hooks";
import { StepTemplateConflictError } from "../../api/stepTemplates";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { Input } from "../ui/Input";
import { Callout } from "../ui/Callout";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { topAncestorIndex } from "../../scenario/model";
import { extractStepsYaml } from "../../scenario/yamlDoc";

interface Props {
  onClose: () => void;
}

export function SaveTemplateDialog({ onClose }: Props) {
  const doc = useScenarioEditor((s) => s.doc);
  const model = useScenarioEditor((s) => s.model);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);

  const steps = model?.steps ?? [];

  // 기본 체크: 선택 스텝의 최상위 조상만, 없으면 전체
  const defaultCheckedIndex = topAncestorIndex(steps, selectedStepId);
  const initialChecked = steps.map((_, i) =>
    defaultCheckedIndex === null ? true : i === defaultCheckedIndex,
  );

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [checked, setChecked] = useState<boolean[]>(() => initialChecked);

  // 409 conflict 상태: null = 없음, string = conflictId (덮어쓰기 가능)
  const [conflictId, setConflictId] = useState<string | null>(null);
  // conflict 감지 당시의 이름 — 이름이 바뀌면 conflict 무효화
  const [conflictName, setConflictName] = useState<string | null>(null);
  // 비-conflict 에러 메시지 (네트워크 실패, conflictId null인 409 등)
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateStepTemplate();
  const updateMutation = useUpdateStepTemplate();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const checkedCount = checked.filter(Boolean).length;
  const canSave = name.trim().length > 0 && checkedCount > 0;

  // 이름 변경 시 conflict 무효화 + 비-conflict 에러 클리어
  const handleNameChange = (next: string) => {
    setName(next);
    setError(null);
    if (conflictId !== null && next.trim() !== conflictName) {
      setConflictId(null);
      setConflictName(null);
    }
  };

  const buildStepsYaml = (): string => {
    if (!doc) return "";
    const indices: number[] = [];
    checked.forEach((c, i) => {
      if (c) indices.push(i);
    });
    return extractStepsYaml(doc, indices);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const stepsYaml = buildStepsYaml();
    const input = { name: trimmedName, description: description.trim(), steps_yaml: stepsYaml };

    setError(null);
    try {
      if (conflictId !== null) {
        // 덮어쓰기 경로
        await updateMutation.mutateAsync({ id: conflictId, input });
      } else {
        await createMutation.mutateAsync(input);
      }
      onClose();
    } catch (e) {
      if (e instanceof StepTemplateConflictError && e.conflictId !== null) {
        setConflictId(e.conflictId);
        setConflictName(trimmedName);
        return;
      }
      setConflictId(null);
      setError((e as Error).message);
    }
  };

  const showOverwriteConfirm = conflictId !== null && name.trim() === conflictName;

  const stepLabel = (i: number): string => {
    const s = steps[i];
    if (!s) return ko.stepTemplates.unnamedStep(i + 1);
    return `${s.name} (${ko.stepTemplates.typeLabel[s.type] ?? s.type})`;
  };

  return (
    <Modal open title={ko.stepTemplates.saveTitle} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* 이름 */}
        <div className="flex flex-col gap-1">
          <label htmlFor="tpl-name" className="text-sm font-medium">
            {ko.stepTemplates.nameLabel}
          </label>
          <Input
            id="tpl-name"
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder={ko.stepTemplates.namePlaceholder}
          />
        </div>

        {/* 설명 */}
        <div className="flex flex-col gap-1">
          <label htmlFor="tpl-desc" className="text-sm font-medium">
            {ko.stepTemplates.descriptionLabel}
          </label>
          <Input
            id="tpl-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* 스텝 체크박스 목록 */}
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-medium">{ko.stepTemplates.stepsLegend}</legend>
          <div className="flex flex-col gap-1">
            {steps.map((s, i) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked[i] ?? false}
                  onChange={(e) => {
                    const next = [...checked];
                    next[i] = e.target.checked;
                    setChecked(next);
                  }}
                />
                {stepLabel(i)}
              </label>
            ))}
          </div>
        </fieldset>

        {/* 409 덮어쓰기 확인 */}
        {showOverwriteConfirm && (
          <Callout variant="warn">
            {ko.stepTemplates.overwriteConfirm(conflictName ?? name.trim())}
          </Callout>
        )}

        {/* 비-conflict 에러 배너 */}
        {error && (
          <Callout variant="error" role="alert">
            {error}
          </Callout>
        )}

        {/* 액션 버튼 */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            {ko.stepTemplates.cancel}
          </Button>
          {showOverwriteConfirm ? (
            <Button onClick={() => void handleSave()} disabled={!canSave || isPending}>
              {isPending ? ko.stepTemplates.saving : ko.stepTemplates.overwriteAction}
            </Button>
          ) : (
            <Button onClick={() => void handleSave()} disabled={!canSave || isPending}>
              {isPending ? ko.stepTemplates.saving : ko.stepTemplates.saveAction}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
