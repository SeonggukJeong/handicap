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
  it("기본 경로(무 weight·무 className) 클래스 문자열 정확 동일 — byte-identical 락 (spec R2/리뷰 F1)", () => {
    render(<Badge>선택</Badge>);
    expect(screen.getByText("선택").className).toBe(
      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold bg-slate-100 text-slate-600",
    );
  });
  it("weight=medium은 font-medium 렌더 + font-semibold 부재", () => {
    render(
      <Badge tone="warn" weight="medium">
        드레인 중
      </Badge>,
    );
    const el = screen.getByText("드레인 중");
    expect(el.className).toContain("font-medium");
    expect(el.className).not.toContain("font-semibold");
    expect(el.className).toContain("bg-amber-100");
  });
  it("className은 끝에 append (trailing space 없이)", () => {
    render(
      <Badge weight="medium" className="ml-2">
        임시
      </Badge>,
    );
    expect(screen.getByText("임시").className).toBe(
      "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-600 ml-2",
    );
  });
});
