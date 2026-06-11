import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { HelpTip } from "../HelpTip";

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
});
