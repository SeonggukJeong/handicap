import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { HelpTip } from "../HelpTip";
import { Modal } from "../Modal";
import { TIP_WIDTH_PX } from "../helpTipPos";

describe("HelpTip", () => {
  it("기본은 닫힘 — 버튼만 보이고 popover는 없다", () => {
    render(<HelpTip label="p95 설명">정의</HelpTip>);
    const btn = screen.getByRole("button", { name: "p95 설명" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("클릭으로 열리고 다시 클릭하면 닫힌다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="p95 설명">전체 요청의 95%</HelpTip>);
    const btn = screen.getByRole("button", { name: "p95 설명" });
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent("전체 요청의 95%");
    await user.click(btn);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("ESC로 닫힌다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("키보드(Tab → Enter)로 열린다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    await user.tab();
    expect(screen.getByRole("button", { name: "설명" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("바깥 클릭(pointerdown)으로 닫힌다", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <HelpTip label="설명">내용</HelpTip>
        <button type="button">다른 버튼</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "다른 버튼" }));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("aria-controls가 열린 popover의 id와 연결된다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    await user.click(btn);
    const note = screen.getByRole("note");
    expect(note.getAttribute("id")).toBeTruthy();
    expect(btn).toHaveAttribute("aria-controls", note.getAttribute("id"));
  });

  it("popover는 portal로 body에 붙는다 — 루트 span의 자손이 아니다", async () => {
    const user = userEvent.setup();
    const { container } = render(<HelpTip label="설명">내용</HelpTip>);
    const root = container.querySelector("span")!;
    await user.click(screen.getByRole("button", { name: "설명" }));
    const note = screen.getByRole("note");
    expect(root.contains(note)).toBe(false);
    expect(note.parentElement).toBe(document.body);
  });

  it("fixed 위치·폭·높이 상한 — 앵커 rect 기준", async () => {
    const user = userEvent.setup();
    const { container } = render(<HelpTip label="설명">내용</HelpTip>);
    const root = container.querySelector("span")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 116,
      top: 50,
      bottom: 66,
      width: 16,
      height: 16,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    await user.click(screen.getByRole("button", { name: "설명" }));
    const note = screen.getByRole("note");
    expect(note.style.position).toBe("fixed");
    expect(note.style.top).toBe("70px");
    expect(note.style.left).toBe("100px");
    expect(note.style.width).toBe(`${TIP_WIDTH_PX}px`);
    expect(note.style.overflowY).toBe("auto");
  });

  it("아래 공간이 부족하면 실측 높이로 위로 뒤집힌다(re-measure)", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const isNote = this.getAttribute("role") === "note";
        return (
          isNote
            ? {
                left: 0,
                right: 224,
                top: 0,
                bottom: 200,
                width: 224,
                height: 200,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              }
            : {
                left: 100,
                right: 116,
                top: 700,
                bottom: 716,
                width: 16,
                height: 16,
                x: 100,
                y: 700,
                toJSON: () => ({}),
              }
        ) as DOMRect;
      });
    try {
      render(<HelpTip label="설명">내용</HelpTip>);
      await user.click(screen.getByRole("button", { name: "설명" }));
      // 아래 = 716+4 = 720, 720+200 > 768-8 → 위 = 700-4-200 = 496 (re-measure 없으면 720px)
      expect(screen.getByRole("note").style.top).toBe("496px");
    } finally {
      spy.mockRestore();
    }
  });

  it("모달 안이면 popover가 그 다이얼로그 안에 붙는다(aria-modal 범위 유지)", async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={vi.fn()} title="모달">
        <HelpTip label="설명">내용</HelpTip>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note").parentElement).toBe(screen.getByRole("dialog"));
  });

  it("aria-modal 없는 평범한 role=dialog 안이면 body로 간다", async () => {
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="비모달">
        <HelpTip label="설명">내용</HelpTip>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    expect(screen.getByRole("note").parentElement).toBe(document.body);
  });

  it("모달 안에서 popover가 열려 있으면 ESC는 popover만 닫는다 — 모달 유지", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="모달">
        <HelpTip label="설명">내용</HelpTip>
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("popover 안 pointerdown은 닫지 않는다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    await user.click(screen.getByRole("button", { name: "설명" }));
    fireEvent.pointerDown(screen.getByRole("note"));
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("바깥 스크롤·리사이즈는 닫고, popover 자체 스크롤은 유지한다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    await user.click(btn);
    fireEvent.scroll(screen.getByRole("note"));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(btn);
    fireEvent.scroll(document);
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(btn);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("열림 동안만 버튼 aria-describedby가 popover id를 가리킨다", async () => {
    const user = userEvent.setup();
    render(<HelpTip label="설명">내용</HelpTip>);
    const btn = screen.getByRole("button", { name: "설명" });
    expect(btn).not.toHaveAttribute("aria-describedby");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-describedby", screen.getByRole("note").id);
    await user.click(btn);
    expect(btn).not.toHaveAttribute("aria-describedby");
  });

  it("popover 본문 클릭은 React 트리 조상의 onClick으로 버블하지 않는다", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <HelpTip label="설명">내용</HelpTip>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "설명" }));
    onRowClick.mockClear(); // 버튼 클릭 자체의 버블은 기존 동작
    await user.click(screen.getByRole("note"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
