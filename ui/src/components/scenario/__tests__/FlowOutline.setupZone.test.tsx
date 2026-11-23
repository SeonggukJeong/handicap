import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const B1 = "01HX0000000000000000000B01";
const B2 = "01HX0000000000000000000B02";

const YAML_NO_SETUP = `version: 1
name: x
steps:
  - id: "${B1}"
    name: 첫째
    type: http
    request:
      method: GET
      url: "http://x/a"
  - id: "${B2}"
    name: 둘째
    type: http
    request:
      method: GET
      url: "http://x/b"
`;

// 연기 확인용 — jsdom은 치수 0·끌기 이동 없음이라 놓을 자리 동작을 밟지 못한다.
describe("FlowOutline 준비 놓을 자리 (연기 확인)", () => {
  beforeEach(reset);

  it("준비 없는 시나리오: 끌지 않는 동안 놓을 자리가 없다", () => {
    useScenarioEditor.getState().loadFromString(YAML_NO_SETUP);
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    expect(useScenarioEditor.getState().model).not.toBeNull();
    render(<FlowOutline />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByText(ko.editor.setupDropHint)).not.toBeInTheDocument();
  });

  it("준비 없는 시나리오: 첫 본 행의 손잡이를 누르기만 하면 아무것도 안 바뀐다", async () => {
    useScenarioEditor.getState().loadFromString(YAML_NO_SETUP);
    expect(useScenarioEditor.getState().model).not.toBeNull();
    const before = useScenarioEditor.getState().yamlText;
    render(<FlowOutline />);
    await userEvent.click(screen.getByRole("button", { name: ko.editor.dragHandleAria("첫째") }));
    expect(useScenarioEditor.getState().yamlText).toBe(before);
    expect(useScenarioEditor.getState().model?.setup).toBeUndefined();
    expect(screen.queryByText(ko.editor.setupDropHint)).not.toBeInTheDocument();
  });
});
