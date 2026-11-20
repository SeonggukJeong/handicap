import { useState } from "react";
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

/** 미리 채워진 지금 이름을 지우고 새로 친다. */
async function retype(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(field());
  await user.type(field(), text);
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <RenameGroupDialog
        open={open}
        name="A"
        counts={{ A: 3 }}
        onSubmit={() => {}}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("RenameGroupDialog", () => {
  it("opens with the current name filled in, the rename button disabled while unchanged", () => {
    setup();
    expect(screen.getByText(g.renameText("A"))).toBeInTheDocument();
    expect(field()).toHaveValue("A");
    const btn = screen.getByRole("button", { name: g.renameOk });
    expect(btn).toBeDisabled();
  });

  it("focuses and selects the field on open so typing replaces the name, and focus returns to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    await user.click(trigger);
    expect(document.activeElement).toBe(field());
    await user.keyboard("C");
    expect(field()).toHaveValue("C");
    expect(screen.getByRole("button", { name: g.renameOk })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: ko.common.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows merge hint and merge button for an existing group", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await retype(user, "B");
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
    await retype(user, "C");
    expect(screen.queryByText(/이미 있는 그룹/)).toBeNull();
    await user.click(screen.getByRole("button", { name: g.renameOk }));
    expect(onSubmit).toHaveBeenCalledWith("C");
  });

  it("disables the button when empty or equal to the current name", async () => {
    const user = userEvent.setup();
    setup();
    await retype(user, " A ");
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
    await user.clear(field());
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });

  it("judges the merge on the normalized value", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await retype(user, "  B ");
    expect(screen.getByText(g.mergeHint(3, 9))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: g.mergeOk }));
    expect(onSubmit).toHaveBeenCalledWith("B");
  });

  it("shows the same reasons as GroupDialog for 41 chars and forbidden chars", async () => {
    const user = userEvent.setup();
    setup();
    await retype(user, "가".repeat(41));
    expect(screen.getByText(g.errTooLong)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
    await retype(user, "a\u0007b");
    expect(screen.getByText(g.errForbidden)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });

  it("shows the server error as an alert and disables while pending", () => {
    setup({ error: "x", pending: true });
    expect(screen.getByRole("alert")).toHaveTextContent(g.failed("x"));
    expect(screen.getByRole("button", { name: g.renameOk })).toBeDisabled();
  });

  it("does not treat Object.prototype names as an existing group", async () => {
    const user = userEvent.setup();
    setup();
    await retype(user, "constructor");
    expect(screen.queryByText(/이미 있는 그룹/)).toBeNull();
    expect(screen.getByRole("button", { name: g.renameOk })).toBeEnabled();
    expect(screen.queryByRole("button", { name: g.mergeOk })).toBeNull();
  });

  it("Enter submits valid input once and ignores invalid input", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await retype(user, "가".repeat(41) + "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await retype(user, " C {Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("C");
  });

  it("Enter does not submit while pending", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ pending: true });
    await retype(user, "C{Enter}");
    expect(field()).toHaveValue("C");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the draft when counts change while open", async () => {
    const user = userEvent.setup();
    const props = { name: "A", onSubmit: () => {}, onClose: () => {} };
    const { rerender } = render(<RenameGroupDialog open counts={{ A: 3 }} {...props} />);
    await retype(user, "zz");
    rerender(<RenameGroupDialog open counts={{ A: 4 }} {...props} />);
    expect(field()).toHaveValue("zz");
  });
});
