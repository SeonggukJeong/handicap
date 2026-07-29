import { Modal } from "../Modal";
import { Button } from "../Button";
import { ko } from "../../i18n/ko";
import { type Step } from "../../scenario/model";
import { describeStepRef, STEP_REF_BADGE_CLASS } from "./stepRefLabel";

/**
 * 사용중(참조 ≥ 1)인 선언 변수의 삭제 확인 다이얼로그.
 * 목록 항목은 **비대화형**이다 — 여기서 스텝으로 점프하면 삭제 흐름이 끊기고,
 * 점프는 이미 변수 행의 "N개 스텝에서 사용" 팝오버가 담당한다.
 * 초기 포커스는 Modal 기본(패널)을 그대로 둔다 — 파괴적 액션이라 [삭제] autofocus 금지.
 */
export function DeleteVariableDialog({
  open,
  name,
  refIds,
  steps,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
  refIds: string[];
  steps: Step[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={ko.editor.varDeleteTitle}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-700">{ko.editor.varDeleteBody(name, refIds.length)}</p>
        <ul
          aria-label={ko.editor.varDeleteUsageListAria}
          tabIndex={0}
          className="max-h-64 overflow-auto rounded-md border border-slate-200 p-1 text-xs"
        >
          {refIds.map((id) => {
            const d = describeStepRef(steps, id);
            return (
              <li key={id} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-slate-700">
                {d.badge && (
                  <span className={`${STEP_REF_BADGE_CLASS} ${d.badge.colorClass}`}>
                    {d.badge.text}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate" title={d.label}>
                  {d.label}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {ko.common.cancel}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {ko.common.delete}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
