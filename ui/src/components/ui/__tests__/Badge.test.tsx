import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "../Badge";

describe("Badge", () => {
  it("텍스트를 렌더하고 tone 클래스를 적용한다", () => {
    render(<Badge tone="accent">추천</Badge>);
    const el = screen.getByText("추천");
    expect(el.className).toContain("bg-accent-50");
  });
  it("기본 tone은 neutral", () => {
    render(<Badge>선택</Badge>);
    expect(screen.getByText("선택").className).toContain("bg-slate-100");
  });
});
