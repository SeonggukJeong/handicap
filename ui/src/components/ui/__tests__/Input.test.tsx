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
});
