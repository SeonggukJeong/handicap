import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ScenarioDefaults } from "../ScenarioDefaults";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
`;

const DEFAULTS_YAML = `version: 1
name: "demo"
default_think_time:
  min_ms: 500
  max_ms: 1000
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
`;

describe("ScenarioDefaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("min/max를 입력하면 YAML에 default_think_time이 쓰이고, 비우면 사라진다", async () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    render(<ScenarioDefaults />);
    // 접이식이므로 먼저 펼친다(제목 버튼 클릭)
    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }),
    );
    const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
    const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);
    fireEvent.change(min, { target: { value: "500" } });
    fireEvent.change(max, { target: { value: "1000" } });
    fireEvent.blur(max);
    expect(useScenarioEditor.getState().model?.default_think_time).toEqual({
      min_ms: 500,
      max_ms: 1000,
    });
    expect(useScenarioEditor.getState().yamlText).toContain("default_think_time");

    fireEvent.change(min, { target: { value: "" } });
    fireEvent.change(max, { target: { value: "" } });
    fireEvent.blur(max);
    expect(useScenarioEditor.getState().model?.default_think_time).toBeUndefined();
    expect(useScenarioEditor.getState().yamlText).not.toContain("default_think_time");
  });

  it("기본 접힘 + 값이 있으면 접힌 상태에 '설정됨' 힌트를 보여준다", () => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    render(<ScenarioDefaults />);
    const btn = screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(ko.editor.defaultThinkSetHint)).toBeInTheDocument();
    // 접힌 상태에선 입력이 렌더되지 않는다
    expect(screen.queryByLabelText(ko.editor.fieldDefaultThinkMin)).not.toBeInTheDocument();
  });

  it("값이 없으면 접힌 상태에 힌트가 없다", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    render(<ScenarioDefaults />);
    expect(screen.queryByText(ko.editor.defaultThinkSetHint)).not.toBeInTheDocument();
  });

  it("케이스2: 커밋된 값에서 한 칸만 비우고 blur하면 no-op(모델 불변, draft 보존)", async () => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    render(<ScenarioDefaults />);
    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }),
    );
    const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
    const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);
    expect(min).toHaveValue(500);
    expect(max).toHaveValue(1000);

    // min만 비우고 blur — 사용자가 입력 중인 상태(한 칸만 빔)이므로 no-op이어야 한다
    fireEvent.change(min, { target: { value: "" } });
    fireEvent.blur(min);

    expect(useScenarioEditor.getState().model?.default_think_time).toEqual({
      min_ms: 500,
      max_ms: 1000,
    });
    // draft도 지워지지 않고 그대로 빈 채 보존(no-op이 draft를 건드리지 않음)
    expect(min).toHaveValue(null);
    expect(max).toHaveValue(1000);
  });

  it("케이스4: min>max 또는 범위밖 값을 커밋하려 하면 모델은 불변이고 draft가 마지막 커밋값으로 되돌아간다", async () => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    render(<ScenarioDefaults />);
    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }),
    );
    const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
    const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);

    // min > max
    fireEvent.change(min, { target: { value: "900" } });
    fireEvent.change(max, { target: { value: "100" } });
    fireEvent.blur(max);

    expect(useScenarioEditor.getState().model?.default_think_time).toEqual({
      min_ms: 500,
      max_ms: 1000,
    });
    expect(min).toHaveValue(500);
    expect(max).toHaveValue(1000);

    // 범위밖(max > 600000)
    fireEvent.change(min, { target: { value: "0" } });
    fireEvent.change(max, { target: { value: "600001" } });
    fireEvent.blur(max);

    expect(useScenarioEditor.getState().model?.default_think_time).toEqual({
      min_ms: 500,
      max_ms: 1000,
    });
    expect(min).toHaveValue(500);
    expect(max).toHaveValue(1000);
  });

  it("F2: model.default_think_time이 외부(store 직접 mutate)에서 바뀌면 draft가 재시드된다", () => {
    useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
    render(<ScenarioDefaults />);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(ko.editor.scenarioDefaultsTitle) }),
    );
    const min = screen.getByLabelText(ko.editor.fieldDefaultThinkMin);
    const max = screen.getByLabelText(ko.editor.fieldDefaultThinkMax);
    expect(min).toHaveValue(500);
    expect(max).toHaveValue(1000);

    act(() => {
      useScenarioEditor.getState().setDefaultThinkTime({ min_ms: 200, max_ms: 300 });
    });

    expect(min).toHaveValue(200);
    expect(max).toHaveValue(300);
  });
});
