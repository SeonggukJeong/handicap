import { useState } from "react";
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

function Harness({ initial }: { initial: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <GroupDialog
        open={open}
        title={g.assign}
        text={g.assignOneText}
        initial={initial}
        names={[]}
        onSubmit={() => {}}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("GroupDialog", () => {
  it("focuses the field on open so typing goes in, and focus returns to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<Harness initial={null} />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    await user.click(trigger);
    const field = screen.getByLabelText(g.fieldLabel);
    expect(document.activeElement).toBe(field);
    await user.keyboard("새 그룹");
    expect(field).toHaveValue("새 그룹");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses an already-filled field on open", async () => {
    const user = userEvent.setup();
    render(<Harness initial="서비스A" />);
    await user.click(screen.getByRole("button", { name: "trigger" }));
    expect(document.activeElement).toBe(screen.getByLabelText(g.fieldLabel));
  });

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

  it("keeps a half-typed draft when initial changes while open, reseeds on reopen", async () => {
    const user = userEvent.setup();
    const props = {
      title: g.assign,
      text: g.assignOneText,
      names: [],
      onSubmit: () => {},
      onClose: () => {},
    };
    const { rerender } = render(<GroupDialog open initial="A" {...props} />);
    await user.type(screen.getByLabelText(g.fieldLabel), "zzz");
    rerender(<GroupDialog open initial="B" {...props} />);
    expect(screen.getByLabelText(g.fieldLabel)).toHaveValue("Azzz");
    rerender(<GroupDialog open={false} initial="B" {...props} />);
    rerender(<GroupDialog open initial="B" {...props} />);
    expect(screen.getByLabelText(g.fieldLabel)).toHaveValue("B");
  });

  it("Enter submits valid input once with the normalized value", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(g.fieldLabel), " 새 그룹 {Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("새 그룹");
  });

  it("Enter does not submit invalid input", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText(g.fieldLabel), "가".repeat(41) + "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter does not submit while pending", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ pending: true });
    await user.type(screen.getByLabelText(g.fieldLabel), "x{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("two mounted instances do not share ids", () => {
    render(
      <>
        <GroupDialog
          open
          title="a"
          text="t"
          initial={null}
          names={["A"]}
          onSubmit={() => {}}
          onClose={() => {}}
        />
        <GroupDialog
          open
          title="b"
          text="t"
          initial={null}
          names={["A"]}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </>,
    );
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
