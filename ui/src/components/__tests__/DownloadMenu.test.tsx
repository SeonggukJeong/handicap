import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { DownloadMenu } from "../DownloadMenu";

function setup() {
  const onA = vi.fn();
  const onB = vi.fn();
  render(
    <DownloadMenu
      label="내려받기"
      items={[
        { label: "A", onSelect: onA },
        { label: "B", onSelect: onB },
      ]}
    />,
  );
  return { onA, onB };
}

describe("DownloadMenu", () => {
  it("renders a closed menu-button trigger", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "내려받기" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("opens on click and reveals the items", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    expect(screen.getByRole("button", { name: "내려받기" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("calls onSelect and closes when an item is clicked", async () => {
    const user = userEvent.setup();
    const { onA } = setup();
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    await user.click(screen.getByRole("menuitem", { name: "A" }));
    expect(onA).toHaveBeenCalledOnce();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("opens via keyboard (ArrowDown) and focuses the first item", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("moves focus with ArrowDown / ArrowUp", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}"); // open + focus A
    await user.keyboard("{ArrowDown}"); // focus B
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
    await user.keyboard("{ArrowUp}"); // focus A
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("activates an item with Enter and closes", async () => {
    const user = userEvent.setup();
    const { onA } = setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onA).toHaveBeenCalledOnce();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    setup();
    const trigger = screen.getByRole("button", { name: "내려받기" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(trigger).toHaveFocus();
  });

  it("closes on outside pointer down", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DownloadMenu label="내려받기" items={[{ label: "A", onSelect: vi.fn() }]} />
        <button>바깥</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "내려받기" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "바깥" }));
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("opens via keyboard (ArrowUp) and focuses the last item", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
  });

  it("wraps focus at the ends with ArrowDown / ArrowUp", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}"); // open + focus A (index 0)
    await user.keyboard("{ArrowDown}"); // focus B (index 1)
    await user.keyboard("{ArrowDown}"); // wrap to A (index 0)
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
    await user.keyboard("{ArrowUp}"); // wrap to B (index 1)
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
  });

  it("jumps to first/last with Home and End", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}"); // open + focus A
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("closes on Tab", async () => {
    const user = userEvent.setup();
    setup();
    screen.getByRole("button", { name: "내려받기" }).focus();
    await user.keyboard("{ArrowDown}"); // open
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await user.keyboard("{Tab}");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });
});
