import { describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VarUsagePopover } from "../VarUsagePopover";
import type { Step } from "../../../scenario/model";

const s1: Step = {
  id: "s1",
  type: "http",
  name: "로그인",
  request: { method: "GET", url: "/login", headers: {} },
  assert: [],
  extract: [],
};
const s2: Step = {
  id: "s2",
  type: "http",
  name: "주문",
  request: { method: "POST", url: "/orders", headers: {} },
  assert: [],
  extract: [],
};

describe("VarUsagePopover", () => {
  it("renders referencing steps in a body portal and jumps without closing", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const onClose = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    render(
      <VarUsagePopover
        anchor={anchor}
        refIds={["s1", "s2"]}
        steps={[s1, s2]}
        selectedStepId="s2"
        onJump={onJump}
        onClose={onClose}
      />,
    );

    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body); // portal

    expect(within(menu).getByText("로그인")).toBeInTheDocument();
    await user.click(within(menu).getByText("로그인"));
    expect(onJump).toHaveBeenCalledWith("s1");
    expect(onClose).not.toHaveBeenCalled(); // 항목 클릭은 안 닫음

    // active: selectedStepId 항목
    expect(within(menu).getByText("주문").closest("[role=menuitem]")).toHaveAttribute(
      "aria-current",
      "true",
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on an outside pointerdown", () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    render(
      <VarUsagePopover
        anchor={anchor}
        refIds={["s1"]}
        steps={[s1]}
        selectedStepId={null}
        onJump={onJump}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body); // 패널·앵커 둘 다 아닌 바깥 타깃
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on an outside scroll, but ignores scroll inside the panel", () => {
    const onJump = vi.fn();
    const onCloseOuter = vi.fn();
    const anchor1 = document.createElement("button");
    document.body.appendChild(anchor1);

    const { unmount } = render(
      <VarUsagePopover
        anchor={anchor1}
        refIds={["s1"]}
        steps={[s1]}
        selectedStepId={null}
        onJump={onJump}
        onClose={onCloseOuter}
      />,
    );
    fireEvent.scroll(document.body); // 바깥 스크롤
    expect(onCloseOuter).toHaveBeenCalled();
    unmount();

    const onCloseInner = vi.fn();
    const anchor2 = document.createElement("button");
    document.body.appendChild(anchor2);
    render(
      <VarUsagePopover
        anchor={anchor2}
        refIds={["s1"]}
        steps={[s1]}
        selectedStepId={null}
        onJump={onJump}
        onClose={onCloseInner}
      />,
    );
    const menuitem = screen.getByRole("menuitem");
    fireEvent.scroll(menuitem); // 팝오버 내부 스크롤(F2)
    expect(onCloseInner).not.toHaveBeenCalled();
  });
});
