import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupButton } from "../GroupButton";
import { ko } from "../../../i18n/ko";

const g = ko.scenarioGroups;

function setup(over: Partial<Parameters<typeof GroupButton>[0]> = {}) {
  const onPick = vi.fn().mockResolvedValue(true);
  const onOpenChange = vi.fn();
  render(
    <GroupButton
      group={null}
      names={["A", "B"]}
      onPick={onPick}
      onOpenChange={onOpenChange}
      {...over}
    />,
  );
  return { onPick, onOpenChange };
}

describe("GroupButton", () => {
  it("shows the chip text for a group, with the full name as title (the chip truncates)", () => {
    const long = "가".repeat(40);
    setup({ group: long });
    const chip = screen.getByRole("button", { name: g.chip(long) });
    expect(chip).toHaveAttribute("title", long);
  });

  it("shows 그룹 지정 and never 그룹 없음 when ungrouped", () => {
    setup();
    const chip = screen.getByRole("button", { name: g.assign });
    expect(chip).not.toHaveAttribute("title");
    expect(screen.queryByText(/그룹 없음/)).toBeNull();
  });

  it("opens the dialog, lists names as datalist options, and applies", async () => {
    const user = userEvent.setup();
    const { onPick, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: g.assign }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(g.assignOneText)).toBeInTheDocument();
    const opts = document.querySelectorAll("datalist option");
    expect([...opts].map((o) => o.getAttribute("value"))).toEqual(["A", "B"]);
    await user.type(screen.getByLabelText(g.fieldLabel), "A");
    await user.click(screen.getByRole("button", { name: g.apply }));
    expect(onPick).toHaveBeenCalledWith("A");
  });

  it("closes when onPick resolves true", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: g.assign }));
    await user.click(screen.getByRole("button", { name: g.apply }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("closes when onPick returns true synchronously", async () => {
    const user = userEvent.setup();
    setup({ onPick: () => true });
    await user.click(screen.getByRole("button", { name: g.assign }));
    await user.click(screen.getByRole("button", { name: g.apply }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open when onPick resolves false", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn().mockResolvedValue(false);
    setup({ onPick, error: "boom" });
    await user.click(screen.getByRole("button", { name: g.assign }));
    await user.click(screen.getByRole("button", { name: g.apply }));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(g.failed("boom"));
  });

  it("notifies on cancel", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: g.assign }));
    await user.click(screen.getByRole("button", { name: ko.common.cancel }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
