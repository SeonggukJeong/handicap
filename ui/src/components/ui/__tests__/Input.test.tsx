import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Input } from "../Input";
import { Select } from "../Select";

describe("Input/Select primitives", () => {
  it("Input은 base 토큰 클래스 + 호출자 className을 병합한다", () => {
    render(<Input aria-label="x" className="w-48" />);
    const el = screen.getByLabelText("x");
    expect(el.tagName).toBe("INPUT");
    expect(el.className).toContain("w-48");
    expect(el.className).toContain("rounded-md");
  });

  it("Input은 id/표준 속성을 패스스루한다", () => {
    render(<Input id="vu" aria-invalid="true" defaultValue="2" aria-label="vu" />);
    const el = screen.getByLabelText("vu") as HTMLInputElement;
    expect(el.id).toBe("vu");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.value).toBe("2");
  });

  it("Select는 옵션을 렌더하고 className을 병합한다", () => {
    render(
      <Select aria-label="mode" className="text-sm">
        <option value="a">A</option>
      </Select>,
    );
    const el = screen.getByLabelText("mode");
    expect(el.tagName).toBe("SELECT");
    expect(el.className).toContain("rounded-md");
  });

  it("numeric off → no tabular-nums (default render unchanged)", () => {
    const { container } = render(<Input />);
    expect(container.querySelector("input")!.className).not.toContain("tabular-nums");
  });
  it("numeric on → adds tabular-nums", () => {
    const { container } = render(<Input numeric />);
    expect(container.querySelector("input")!.className).toContain("tabular-nums");
  });
});

describe("size variant", () => {
  it("Input default size renders text-sm, not text-xs", () => {
    render(<Input aria-label="i" />);
    const el = screen.getByLabelText("i");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });
  it("Input size='sm' renders text-xs, not text-sm", () => {
    render(<Input aria-label="i" size="sm" />);
    const el = screen.getByLabelText("i");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
  it("Select default size renders text-sm, not text-xs", () => {
    render(
      <Select aria-label="s">
        <option>a</option>
      </Select>,
    );
    const el = screen.getByLabelText("s");
    expect(el).toHaveClass("text-sm");
    expect(el).not.toHaveClass("text-xs");
  });
  it("Select size='sm' renders text-xs, not text-sm", () => {
    render(
      <Select aria-label="s" size="sm">
        <option>a</option>
      </Select>,
    );
    const el = screen.getByLabelText("s");
    expect(el).toHaveClass("text-xs");
    expect(el).not.toHaveClass("text-sm");
  });
});

describe("compact 밀도 variant (디자인시스템 5차 R1)", () => {
  it("Input compact는 py-0.5를 쓰고 py-1은 없다", () => {
    render(<Input aria-label="c" compact />);
    const el = screen.getByLabelText("c");
    expect(el).toHaveClass("py-0.5");
    expect(el).not.toHaveClass("py-1");
  });

  it("Input 미지정은 py-1 유지 (기존 경로 클래스 집합 불변)", () => {
    render(<Input aria-label="n" />);
    const el = screen.getByLabelText("n");
    expect(el).toHaveClass("py-1");
    expect(el).not.toHaveClass("py-0.5");
  });

  it("compact는 size와 직교 — compact+size=sm 조합", () => {
    render(<Input aria-label="cs" compact size="sm" />);
    const el = screen.getByLabelText("cs");
    expect(el).toHaveClass("py-0.5");
    expect(el).toHaveClass("text-xs");
  });

  it("Select compact는 py-0.5를 쓰고 py-1은 없다 — aria-invalid 클래스는 여전히 없음 (Input BASE 이식 금지)", () => {
    render(
      <Select aria-label="cSel" compact>
        <option>a</option>
      </Select>,
    );
    const el = screen.getByLabelText("cSel");
    expect(el).toHaveClass("py-0.5");
    expect(el).not.toHaveClass("py-1");
    expect(el.className).not.toContain("aria-[invalid=true]");
  });

  it("Select 미지정은 py-1 유지", () => {
    render(
      <Select aria-label="nSel">
        <option>a</option>
      </Select>,
    );
    expect(screen.getByLabelText("nSel")).toHaveClass("py-1");
  });
});
