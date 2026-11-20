import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupDialog } from "../GroupDialog";
import { ko } from "../../../i18n/ko";

const g = ko.scenarioGroups;

function setup(over: Partial<Parameters<typeof GroupDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <GroupDialog
      open
      title={g.assign}
      text={g.assignOneText}
      initial={null}
      names={["A", "B"]}
      onSubmit={onSubmit}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSubmit, onClose, ...utils };
}

describe("GroupDialog", () => {
  it("seeds the field from initial", () => {
    setup({ initial: "서비스A" });
    expect(screen.getByLabelText(g.fieldLabel)).toHaveValue("서비스A");
    expect(screen.getByText(g.assignOneText)).toBeInTheDocument();
  });

  it("submits the normalized value", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(g.fieldLabel), "  새 그룹 ");
    await user.click(screen.getByRole("button", { name: g.apply }));
    expect(onSubmit).toHaveBeenCalledWith("새 그룹");
  });

  it("submits null when emptied", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initial: "A" });
    await user.clear(screen.getByLabelText(g.fieldLabel));
    await user.click(screen.getByRole("button", { name: g.apply }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it("shows too-long error and disables apply", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(g.fieldLabel), "가".repeat(41));
    expect(screen.getByText(g.errTooLong)).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: g.apply });
    expect(apply).toBeDisabled();
    await user.click(apply);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows forbidden error", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText(g.fieldLabel), "a\u0007b");
    expect(screen.getByText(g.errForbidden)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: g.apply })).toBeDisabled();
  });

  it("shows the server error as an alert", () => {
    setup({ error: "boom" });
    expect(screen.getByRole("alert")).toHaveTextContent(g.failed("boom"));
  });

  it("disables apply while pending", () => {
    setup({ pending: true });
    expect(screen.getByRole("button", { name: g.apply })).toBeDisabled();
  });

  it("calls onClose from cancel", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: ko.common.cancel }));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-seeds from the new initial on reopen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const props = {
      title: g.assign,
      text: g.assignOneText,
      names: [],
      onSubmit,
      onClose: () => {},
    };
    const { rerender } = render(<GroupDialog open initial="A" {...props} />);
    await user.type(screen.getByLabelText(g.fieldLabel), "zzz");
    rerender(<GroupDialog open={false} initial="A" {...props} />);
    rerender(<GroupDialog open initial="B" {...props} />);
    expect(screen.getByLabelText(g.fieldLabel)).toHaveValue("B");
  });
});
