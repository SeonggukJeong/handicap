import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const HTTP = (id: string, name: string) => `    - id: "${id}"
      name: ${name}
      type: http
      request:
        method: GET
        url: "http://x/${name}"
`;

const BODY = `steps:
  - id: "01HX0000000000000000000009"
    name: main
    type: http
    request:
      method: GET
      url: "http://x/main"
`;

describe("FlowOutline 준비 스텝 한 줄", () => {
  beforeEach(reset);

  it("준비 스텝 2개면 안내 한 줄이 나온다", () => {
    const yaml = `version: 1
name: x
setup:
  steps:
${HTTP("01HX0000000000000000000001", "a")}${HTTP("01HX0000000000000000000002", "b")}${BODY}`;
    useScenarioEditor.getState().loadFromString(yaml);
    render(<FlowOutline />);
    expect(
      screen.getByText("준비 스텝 2개 — YAML 보기에서 확인할 수 있습니다"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /스텝: a/ })).not.toBeInTheDocument();
  });

  it("준비 스텝이 없으면 줄이 없다", () => {
    useScenarioEditor.getState().loadFromString(`version: 1\nname: x\n${BODY}`);
    render(<FlowOutline />);
    expect(screen.queryByText(/YAML 보기에서 확인할 수 있습니다/)).not.toBeInTheDocument();
  });
});
