import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { BulkEditPanel } from "../BulkEditPanel";

describe("BulkEditPanel", () => {
  it("prepopulates the textarea with current entries (Postman style)", () => {
    render(
      <BulkEditPanel
        entries={{ "Content-Type": "application/json", Accept: "*/*" }}
        format="header"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByLabelText("일괄 편집 텍스트") as HTMLTextAreaElement;
    expect(ta.value).toBe("Content-Type: application/json\nAccept: */*");
  });

  it("Apply replaces the whole set (deleted lines are dropped)", async () => {
    const onApply = vi.fn();
    render(
      <BulkEditPanel
        entries={{ A: "1", B: "2" }}
        format="header"
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    const ta = screen.getByLabelText("일괄 편집 텍스트");
    // Replace the whole content with a single line (use fireEvent to avoid
    // userEvent key-descriptor parsing of ':' / braces).
    fireEvent.change(ta, { target: { value: "A: 9\nC: 3" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith({ A: "9", C: "3" }); // B dropped
  });

  it("shows a skip hint for separator-less lines", () => {
    render(<BulkEditPanel entries={{}} format="header" onApply={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("일괄 편집 텍스트"), {
      target: { value: "A: 1\ngarbage" },
    });
    expect(screen.getByText(/1개 건너뜀/)).toBeInTheDocument();
  });

  it("form Apply decodes urlencoded values", async () => {
    const onApply = vi.fn();
    render(<BulkEditPanel entries={{}} format="form" onApply={onApply} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("일괄 편집 텍스트"), {
      target: { value: "name=John+Doe&city=New%20York" },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith({ name: "John Doe", city: "New York" });
  });

  it("Cancel calls onCancel and not onApply", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<BulkEditPanel entries={{}} format="header" onApply={onApply} onCancel={onCancel} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "취소" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("일괄편집 textarea는 accent 포커스 링(프리미티브)을 쓴다", () => {
    render(<BulkEditPanel entries={{}} format="header" onApply={vi.fn()} onCancel={vi.fn()} />);
    const ta = screen.getByLabelText("일괄 편집 텍스트");
    expect(ta).toHaveClass("focus:ring-accent-500/30"); // 이주 전 RED
    expect(ta).toHaveClass("rounded-md");
    expect(ta).toHaveClass("text-xs"); // size='sm' 밀도 보존
  });
});
