import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GroupBox } from "../GroupBox";
import { ko } from "../../../i18n/ko";

const group = { id: "g1", scenario_id: "", environment_id: null, interval_seconds: 10 };

function renderBox(error?: string) {
  render(
    <GroupBox
      group={group}
      number={1}
      scenarios={[]}
      environments={[]}
      expanded
      error={error}
      canRemove
      canAddPanel
      onToggle={vi.fn()}
      onChange={vi.fn()}
      onAddPanel={vi.fn()}
      onRemove={vi.fn()}
    >
      <div />
    </GroupBox>,
  );
}

describe("GroupBox", () => {
  it("scenario_field_error_for_scenario_required", () => {
    renderBox(ko.monitor.scenarioRequired);
    expect(screen.getByText(ko.monitor.scenarioRequired)).toBeInTheDocument();
    expect(screen.getByLabelText(ko.monitor.scenario)).toHaveAttribute("aria-invalid", "true");
  });

  it("unrelated_error_shows_no_scenario_field_error", () => {
    renderBox("칸이 없는 점검 묶음입니다");
    expect(screen.getByText("⚠ 칸이 없는 점검 묶음입니다")).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.scenarioRequired)).not.toBeInTheDocument();
    expect(screen.getByLabelText(ko.monitor.scenario)).not.toHaveAttribute("aria-invalid");
  });
});
