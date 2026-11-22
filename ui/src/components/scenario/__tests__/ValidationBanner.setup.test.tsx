import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { ValidationBanner } from "../ValidationBanner";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";

const HTTP = (url: string) => `    - id: ${ID}
      name: 로그인
      type: http
      request:
        method: POST
        url: "${url}"
`;

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("ValidationBanner 준비 스텝", () => {
  it("id 겹침은 선택 연결 없는 일반 글자로, YAML 오류 안내 없이 나온다", () => {
    const yaml = `version: 1
name: s
setup:
  steps:
${HTTP("http://x/login")}steps:
  - id: ${ID}
    name: 조회
    type: http
    request:
      method: GET
      url: "http://x/o"
`;
    useScenarioEditor.getState().loadFromString(yaml);
    render(<ValidationBanner />);
    const msg = screen.getByText(ko.editor.problemDuplicateStepId(ID));
    expect(msg.tagName).toBe("SPAN");
    expect(msg.closest("button")).toBeNull();
    expect(screen.queryByText(ko.editor.problemGateIntro)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.problemGateAction })).toBeNull();
  });

  it("준비 스텝 항목을 누르면 그 스텝이 선택된다", async () => {
    useScenarioEditor
      .getState()
      .loadFromString(`version: 1\nname: s\nsetup:\n  steps:\n${HTTP("/login")}steps: []\n`);
    render(<ValidationBanner />);
    await userEvent.click(
      screen.getByRole("button", { name: ko.editor.problemUrlNeedsScheme("로그인") }),
    );
    expect(useScenarioEditor.getState().selectedStepId).toBe(ID);
  });

  it("스킴 없는 준비 스텝 URL도 경고한다", () => {
    useScenarioEditor
      .getState()
      .loadFromString(`version: 1\nname: s\nsetup:\n  steps:\n${HTTP("/login")}steps: []\n`);
    render(<ValidationBanner />);
    expect(screen.getByText(ko.editor.problemUrlNeedsScheme("로그인"))).toBeInTheDocument();
  });
});
