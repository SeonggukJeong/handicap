import { describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VarUsagePopover, computePos } from "../VarUsagePopover";
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

function mockAnchor(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect;
  return el;
}
function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
}

describe("computePos (순수)", () => {
  it("① 아래 공간 충분 → 앵커 바로 아래(top=bottom+4)", () => {
    setViewport(1000, 900);
    const a = mockAnchor({ left: 100, right: 140, top: 100, bottom: 120 });
    expect(computePos(a, 154)).toEqual({ top: 124, left: 100 });
  });
  it("② 아래 부족·위 여유 → 위로 flip flush(top=r.top-4-h)", () => {
    setViewport(560, 560);
    const a = mockAnchor({ left: 100, right: 140, top: 470, bottom: 490 });
    // below=494, below+154=648 > 552(=innerH-8) → 아래 부족; above=312≥8 → flip; bottom=312+154=466=r.top-4 flush
    expect(computePos(a, 154)).toEqual({ top: 312, left: 100 });
  });
  it("③ 아래·위 둘 다 부족 → clamp [8, innerH-h-8]", () => {
    setViewport(400, 200);
    const a = mockAnchor({ left: 50, right: 90, top: 100, bottom: 120 });
    const { top } = computePos(a, 154);
    expect(top).toBe(38); // innerH-h-8 = 200-154-8
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(200 - 154 - 8);
  });
  it("④ 우측 넘침 → 우측정렬 후 좌우 clamp [8, innerW-W-8]", () => {
    setViewport(300, 900);
    const a = mockAnchor({ left: 200, right: 240, top: 100, bottom: 120 });
    // left+240=440 > 292(=innerW-8) → right-align: right-240=0 → clamp max(8, min(0, 52))=8
    expect(computePos(a, 154).left).toBe(8);
  });
});
