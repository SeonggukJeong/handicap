import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { UnsavedChangesDialog } from "../UnsavedChangesDialog";

describe("UnsavedChangesDialog", () => {
  it("onSave 있으면 3버튼([취소][저장 안 하고 이동][저장 후 이동]) + 본문 (R2)", () => {
    render(
      <UnsavedChangesDialog
        open
        body={ko.editor.unsavedBodyEdit}
        onStay={vi.fn()}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
    expect(screen.getByText(ko.editor.unsavedBodyEdit)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveSave })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.stayEditing })).not.toBeInTheDocument();
  });

  it("onSave 없으면 2버튼([계속 편집][버리고 이동]) (R3)", () => {
    render(
      <UnsavedChangesDialog
        open
        body={ko.editor.discardConfirm}
        onStay={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: ko.editor.stayEditing })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.discardAndLeave })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveSave })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveCancel })).not.toBeInTheDocument();
  });

  it("open=false면 아무것도 렌더하지 않는다", () => {
    render(<UnsavedChangesDialog open={false} body="x" onStay={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("각 버튼이 해당 콜백을 1회 호출한다", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <UnsavedChangesDialog open body="b" onStay={onStay} onDiscard={onDiscard} onSave={onSave} />,
    );
    await user.click(screen.getByRole("button", { name: ko.editor.leaveCancel }));
    await user.click(screen.getByRole("button", { name: ko.editor.leaveDiscard }));
    await user.click(screen.getByRole("button", { name: ko.editor.leaveSave }));
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("non-saving에서 ESC는 onStay를 부른다 (R14 — non-saving 상태 명시)", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    render(
      <UnsavedChangesDialog open body="b" onStay={onStay} onDiscard={vi.fn()} onSave={vi.fn()} />,
    );
    await user.keyboard("{Escape}");
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it("saving 중엔 버튼 3개 disabled + ESC no-op (R13)", async () => {
    const user = userEvent.setup();
    const onStay = vi.fn();
    render(
      <UnsavedChangesDialog
        open
        body="b"
        saving
        onStay={onStay}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeDisabled();
    // 저장 버튼은 saving 중 라벨이 "저장 중…"으로 바뀐다
    expect(screen.getByRole("button", { name: ko.common.saving })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onStay).not.toHaveBeenCalled();
    // 다이얼로그가 여전히 열려 있다
    expect(screen.getByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
  });
});
