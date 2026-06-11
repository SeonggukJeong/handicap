import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariablesPanel } from "../VariablesPanel";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

describe("VariablesPanel", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("lists variables and adds one via the two-field row", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    expect(screen.getByText("변수 없음")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("new_var"), "base");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("base");
  });

  it("removes a variable", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "x");
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: "Remove variable tok" }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("tok");
  });

  it("U3: 변수 표기 치트시트 popover — 3분류(흐름/환경/시스템)를 연다/ESC로 닫는다", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    const tip = screen.getByRole("button", { name: "변수 표기 도움말" });
    await user.click(tip);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("흐름 변수");
    expect(note).toHaveTextContent("${ENV}");
    expect(note).toHaveTextContent("${vu_id}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
