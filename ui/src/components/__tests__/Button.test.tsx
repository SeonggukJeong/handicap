import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "../Button";

describe("Button", () => {
  it("primary는 accent 배경(앱 전역 액센트)", () => {
    render(<Button>실행</Button>);
    expect(screen.getByRole("button", { name: "실행" }).className).toContain("bg-accent-600");
  });
  it("secondary는 흰 배경·테두리 유지(0-diff)", () => {
    render(<Button variant="secondary">취소</Button>);
    const c = screen.getByRole("button", { name: "취소" }).className;
    expect(c).toContain("bg-white");
    expect(c).toContain("border-slate-300");
  });
  it("danger는 red 유지(0-diff)", () => {
    render(<Button variant="danger">삭제</Button>);
    expect(screen.getByRole("button", { name: "삭제" }).className).toContain("bg-red-600");
  });
});
