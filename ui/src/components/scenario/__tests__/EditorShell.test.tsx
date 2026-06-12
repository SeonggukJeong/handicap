import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../../i18n/ko";
import { EditorShell } from "../EditorShell";
import { useScenarioEditor } from "../../../scenario/store";

// YAML 탭 전환 시 Monaco 본체 import를 피한다(워커 모킹 불요 — 컴포넌트째 mock).
vi.mock("../MonacoYamlView", () => ({ MonacoYamlView: () => <div data-testid="yaml-view" /> }));

describe("EditorShell", () => {
  it.todo("loads the initialYaml into the store on mount");
  it.todo("calls onChange with the current yamlText whenever it changes");
  it.todo("hides the inspector when the YAML tab is active");
});

describe("EditorShell YAML tab placeholder (U3)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("U3: YAML 탭에서 스텝 설정 패널 자리는 한국어 안내를 보여준다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByText(/캔버스 탭에서 사용할 수 있습니다/)).toBeInTheDocument();
  });
});

describe("EditorShell 검증 배너 (U4)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("문제 있는 시나리오 로드 시 상단에 시나리오 문제 요약 배너가 보인다", () => {
    const yaml = `version: 1
name: s
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA1
    name: ping
    request:
      method: GET
      url: ""
`;
    render(<EditorShell initialYaml={yaml} />);
    expect(screen.getByRole("status", { name: ko.editor.problemsBannerAria })).toBeInTheDocument();
  });
});
