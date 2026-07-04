import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { Textarea } from "../Textarea";

describe("Textarea 프리미티브", () => {
  it("base 토큰(accent 포커스·rounded-md·text-slate-900) + 호출자 className 병합", () => {
    render(<Textarea aria-label="ta" className="h-32 font-mono" />);
    const el = screen.getByLabelText("ta");
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.className).toContain("h-32");
    expect(el.className).toContain("font-mono");
    expect(el).toHaveClass("rounded-md");
    expect(el).toHaveClass("text-slate-900");
    expect(el).toHaveClass("focus:ring-accent-500/30");
    expect(el).toHaveClass("focus:border-accent-500");
  });

  it("표준 속성/aria/value 패스스루", () => {
    render(<Textarea aria-label="t" aria-invalid="true" readOnly rows={4} defaultValue="hi" />);
    const el = screen.getByLabelText("t") as HTMLTextAreaElement;
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.readOnly).toBe(true);
    expect(el.value).toBe("hi");
  });

  it("ref를 실제 textarea DOM 노드로 전달", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="t" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("기본 size는 text-sm(text-xs 아님)", () => {
    render(<Textarea aria-label="t" />);
    const el = screen.getByLabelText("t");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });

  it("size='sm'은 text-xs(text-sm 아님)", () => {
    render(<Textarea aria-label="t" size="sm" />);
    const el = screen.getByLabelText("t");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
});
