import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoGrowTextarea } from "../AutoGrowTextarea";

describe("AutoGrowTextarea", () => {
  it("renders a textarea with the value and a stable accessible name", () => {
    render(<AutoGrowTextarea value="hello" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveValue("hello");
    expect(ta.tagName).toBe("TEXTAREA");
  });

  it("forwards onChange edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AutoGrowTextarea value="" aria-label="v" onChange={onChange} />);
    await user.type(screen.getByRole("textbox", { name: "v" }), "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("is full-width and merges a caller className (no resize handle)", () => {
    render(<AutoGrowTextarea value="" aria-label="v" className="border" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" });
    expect(ta).toHaveClass("w-full"); // 전폭
    expect(ta).toHaveClass("resize-none"); // 사용자 리사이즈 핸들 없음(자동 성장)
    expect(ta).toHaveClass("border"); // caller className 병합
  });

  it("E: 캡 미만 값은 세로 스크롤바 없음 — overflow-y-auto 제거, overflowY=hidden", () => {
    render(<AutoGrowTextarea value="short" aria-label="v" onChange={() => {}} />);
    const ta = screen.getByRole("textbox", { name: "v" }) as HTMLTextAreaElement;
    expect(ta).not.toHaveClass("overflow-y-auto"); // A의 styled 바가 1줄에서 노출되던 원인 제거
    expect(ta).toHaveClass("resize-none");
    expect(ta).toHaveClass("max-h-40");
    // jsdom scrollHeight=0 → full(0) ≤ MAX(160) → overflowY="hidden"
    expect(ta.style.overflowY).toBe("hidden");
  });
});
