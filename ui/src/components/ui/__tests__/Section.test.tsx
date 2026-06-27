import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Section } from "../Section";

describe("Section", () => {
  it("번호·제목·badge를 렌더하고 non-collapsible이면 children을 항상 보인다", () => {
    render(
      <Section index={1} title="부하 정의" badge={<span>필수</span>}>
        <input aria-label="vu" />
      </Section>,
    );
    expect(screen.getByText("부하 정의")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByLabelText("vu")).toBeInTheDocument();
  });

  it("collapsible: open=false면 children 미렌더 + hint 노출, 토글 호출", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <Section title="판정·고급" collapsible open={false} onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.queryByLabelText("slo")).not.toBeInTheDocument();
    expect(screen.getByText("3개 설정됨")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /판정·고급/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <Section title="판정·고급" collapsible open onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.getByLabelText("slo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /판정·고급/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
