import { ko } from "../i18n/ko";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * 저장 안 됨 이탈 확인 다이얼로그 (spec 2026-07-12-unsaved-changes-guard §4.3).
 * onSave 있으면 3버튼(편집 페이지), 없으면 2버튼(신규 페이지).
 * saving 중엔 모든 dismiss 경로(버튼·ESC/backdrop/✕)가 봉쇄된다 — in-flight
 * 저장 뒤 stale blocker.proceed()/reset() 레이스를 소스에서 제거(spec §3-8).
 */
export function UnsavedChangesDialog({
  open,
  body,
  saving = false,
  onStay,
  onDiscard,
  onSave,
}: {
  open: boolean;
  body: string;
  saving?: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSave?: () => void;
}) {
  const dismiss = () => {
    if (!saving) onStay();
  };
  return (
    <Modal open={open} onClose={dismiss} title={ko.editor.unsavedTitle}>
      <div className="flex flex-col gap-4">
        <p>{body}</p>
        <div className="flex justify-end gap-2">
          {onSave ? (
            <>
              <Button variant="secondary" onClick={onStay} disabled={saving}>
                {ko.editor.leaveCancel}
              </Button>
              <Button variant="secondary" onClick={onDiscard} disabled={saving}>
                {ko.editor.leaveDiscard}
              </Button>
              <Button onClick={onSave} disabled={saving}>
                {saving ? ko.common.saving : ko.editor.leaveSave}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onStay}>{ko.editor.stayEditing}</Button>
              <Button variant="secondary" onClick={onDiscard}>
                {ko.editor.discardAndLeave}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
