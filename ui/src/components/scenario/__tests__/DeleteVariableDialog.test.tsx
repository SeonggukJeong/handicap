import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteVariableDialog } from "../DeleteVariableDialog";
import { ko } from "../../../i18n/ko";
import type { Step } from "../../../scenario/model";

const http: Step = {
  id: "h1",
  type: "http",
  name: "로그인",
  request: { method: "POST", url: "/login", headers: {} },
  assert: [],
  extract: [],
};
const ifStep: Step = {
  id: "i1",
  type: "if",
  name: "분기",
  cond: { left: "{{token}}", op: "eq", right: "ok" },
  then: [
    {
      id: "h2",
      type: "http",
      name: "확인",
      request: { method: "GET", url: "/ok", headers: {} },
      assert: [],
      extract: [],
    },
  ],
  elif: [],
  else: [],
};

const setup = (over: Partial<Parameters<typeof DeleteVariableDialog>[0]> = {}) => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <DeleteVariableDialog
      open
      name="token"
      refIds={["h1", "i1"]}
      steps={[http, ifStep]}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onCancel, onConfirm };
};

describe("DeleteVariableDialog", () => {
  it("변수명과 참조 개수를 담은 본문을 렌더한다", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    const body = within(dialog).getByText(ko.editor.varDeleteBody("token", 2));
    expect(body).toBeInTheDocument();
    // ko 포맷터 자기참조 단언 하드닝(ui/CLAUDE.md 공허-11호) — 렌더된 숫자를 따로 확인.
    expect(body.textContent).toContain("token");
    expect(body.textContent).toContain("2");
  });

  it("사용처 목록을 배지+라벨로 렌더한다(http=메서드/이름, if=IF/조건 요약)", () => {
    setup();
    const list = screen.getByRole("list", { name: ko.editor.varDeleteUsageListAria });
    expect(within(list).getByText("POST")).toBeInTheDocument();
    expect(within(list).getByText("로그인")).toBeInTheDocument();
    expect(within(list).getByText("IF")).toBeInTheDocument();
    expect(within(list).getByText("{{token}} eq ok")).toBeInTheDocument();
  });

  it("목록 항목은 클릭 대상이 아니다(점프 어포던스 없음)", () => {
    setup();
    const list = screen.getByRole("list", { name: ko.editor.varDeleteUsageListAria });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
  });

  it("[삭제]는 onConfirm만, [취소]는 onCancel만 부른다", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.delete }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("[취소] 클릭과 ESC 모두 onCancel을 부른다", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("열자마자 포커스가 [삭제] 버튼에 있지 않다(오타 Enter로 삭제되지 않게)", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: ko.editor.varDeleteTitle });
    expect(within(dialog).getByRole("button", { name: ko.common.delete })).not.toHaveFocus();
  });

  it("open=false면 아무것도 렌더하지 않는다", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
