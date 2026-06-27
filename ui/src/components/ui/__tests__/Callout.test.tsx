import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Callout } from "../Callout";

describe("Callout", () => {
  it("호출자가 지정한 role을 그대로 단다", () => {
    render(
      <Callout variant="warn" role="status">
        경고
      </Callout>,
    );
    const el = screen.getByRole("status");
    expect(el.textContent).toContain("경고");
    expect(el.className).toContain("bg-amber-50");
  });
  it("role 미지정이면 roleless", () => {
    const { container } = render(<Callout variant="error">오류</Callout>);
    expect(container.querySelector("[role]")).toBeNull();
    expect(screen.getByText("오류").closest("div")!.className).toContain("bg-red-50");
  });
  it("title을 헤더로 렌더한다", () => {
    render(
      <Callout variant="warn" role="status" title="제목">
        본문
      </Callout>,
    );
    expect(screen.getByText("제목").className).toContain("font-medium");
  });
});
