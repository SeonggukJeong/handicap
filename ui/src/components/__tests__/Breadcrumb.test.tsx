import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "../Breadcrumb";

function renderCrumbs(items: Array<{ label: string; to?: string }>) {
  return render(
    <MemoryRouter>
      <Breadcrumb items={items} />
    </MemoryRouter>,
  );
}

describe("Breadcrumb", () => {
  it("마지막 전 항목은 링크, 마지막 항목은 aria-current=page 텍스트", () => {
    renderCrumbs([
      { label: "시나리오", to: "/" },
      { label: "demo", to: "/scenarios/S1" },
      { label: "실행 목록" },
    ]);
    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "시나리오" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "demo" })).toHaveAttribute("href", "/scenarios/S1");
    const current = screen.getByText("실행 목록");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "실행 목록" })).toBeNull();
  });

  it("to 없는 중간 항목은 일반 텍스트(aria-current 없음)", () => {
    renderCrumbs([{ label: "시나리오", to: "/" }, { label: "이름없음" }, { label: "끝" }]);
    expect(screen.getByText("이름없음")).not.toHaveAttribute("aria-current");
  });

  it("빈 items면 아무것도 렌더하지 않는다", () => {
    const { container } = renderCrumbs([]);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("마지막 항목은 to가 있어도 링크가 아니라 aria-current=page 텍스트", () => {
    renderCrumbs([
      { label: "시나리오", to: "/" },
      { label: "끝", to: "/somewhere" },
    ]);
    expect(screen.queryByRole("link", { name: "끝" })).toBeNull();
    expect(screen.getByText("끝")).toHaveAttribute("aria-current", "page");
  });
});
