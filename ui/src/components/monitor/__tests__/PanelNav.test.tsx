import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelNav } from "../PanelNav";
import { ko } from "../../../i18n/ko";
import type { PanelConfig } from "../../../api/monitors";

function p(id: string, title: string): PanelConfig {
  return { id, title } as PanelConfig;
}

describe("PanelNav", () => {
  const panels = [p("A", "제목"), p("B", ""), p("C", "셋")];

  it("lists numbered items with no-title fallback and error mark", () => {
    render(
      <PanelNav
        panels={panels}
        expanded={new Set()}
        errors={{ B: "x" }}
        onJump={vi.fn()}
        onJumpActions={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: ko.monitor.navTitle })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 제목" })).toBeInTheDocument();
    const second = screen.getByRole("button", { name: /^2 \(제목 없음\)/ });
    expect(second).toHaveTextContent("⚠");
    expect(screen.getByRole("button", { name: "3 셋" })).not.toHaveTextContent("⚠");
    // textContent includes aria-hidden nodes, so assert the accessible name too.
    expect(second).toHaveAccessibleName(new RegExp(ko.monitor.navPanelError));
    expect(screen.getByRole("button", { name: "3 셋" })).toHaveAccessibleName("3 셋");
    expect(screen.getByRole("button", { name: "1 제목" })).not.toHaveAccessibleName(
      new RegExp(ko.monitor.navPanelError),
    );
  });

  it("marks expanded panels with aria-current", () => {
    render(
      <PanelNav
        panels={panels}
        expanded={new Set(["C"])}
        errors={{}}
        onJump={vi.fn()}
        onJumpActions={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "3 셋" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "1 제목" })).not.toHaveAttribute("aria-current");
  });

  it("calls onJump with the id and onJumpActions", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const onJumpActions = vi.fn();
    render(
      <PanelNav
        panels={panels}
        expanded={new Set()}
        errors={{}}
        onJump={onJump}
        onJumpActions={onJumpActions}
      />,
    );
    await user.click(screen.getByRole("button", { name: "3 셋" }));
    expect(onJump).toHaveBeenCalledWith("C");
    await user.click(screen.getByRole("button", { name: ko.monitor.navJumpActions }));
    expect(onJumpActions).toHaveBeenCalledTimes(1);
  });
});
