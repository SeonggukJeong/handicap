import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameGroupDialog } from "../RenameGroupDialog";
import { ko } from "../../../i18n/ko";

const g = ko.scenarioGroups;

function setup(over: Partial<Parameters<typeof RenameGroupDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <RenameGroupDialog
      open
      name="A"
      counts={{ A: 3, B: 9 }}
      onSubmit={onSubmit}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSubmit, onClose };
}

const field = () => screen.getByLabelText(g.fieldLabel);

describe("RenameGroupDialog", () => {
  it("starts with the rename button, disabled while unchanged", () => {
    setup();
    expect(screen.getByText(g.renameText("A"))).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: g.renameOk });
    expect(btn).toBeDisabled();
  });

  it("shows merge hint and merge button for an existing group", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(field(), "B");
    const hint = screen.getByText(g.mergeHint(3, 9));
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toContain("3개");
    expect(hint.textContent).toContain("9개");
    await user.click(screen.getByRole("button", { name: g.mergeOk }));
    expect(onSubmit).toHaveBeenCalledWith("B");
  });

  it("shows no hint for a new name", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(field(), "C");
    expect(screen.queryByText(/이미 있는 그룹/)).toBeNull();
    await user.click(screen.getByRole("button", { name: g.renameOk }));
    expect(onSubmit).toHaveBeenCalledWith("C");
  });

  it("disables the button when empty or equal to the current name", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(field(), "A");
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
    await user.clear(field());
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });

  it("judges the merge on the normalized value", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(field(), "  B ");
    expect(screen.getByText(g.mergeHint(3, 9))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: g.mergeOk }));
    expect(onSubmit).toHaveBeenCalledWith("B");
  });

  it("shows the same reasons as GroupDialog for 41 chars and forbidden chars", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(field(), "가".repeat(41));
    expect(screen.getByText(g.errTooLong)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
    await user.clear(field());
    await user.type(field(), "a\u0007b");
    expect(screen.getByText(g.errForbidden)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });

  it("shows the server error as an alert and disables while pending", () => {
    setup({ error: "x", pending: true });
    expect(screen.getByRole("alert")).toHaveTextContent(g.failed("x"));
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });
});
