import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { ValidationBanner } from "../ValidationBanner";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FA1";

const EMPTY_URL_YAML = `version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`;

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("ValidationBanner", () => {
  it("문제 0건이면 렌더하지 않는다", () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: "x"\nsteps: []\n');
    render(<ValidationBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("빈 URL 스텝을 나열하고 클릭 시 해당 스텝 선택 + 캔버스 탭 전환", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.getState().setActiveTab("yaml");
    render(<ValidationBanner />);

    expect(screen.getByText(ko.editor.problemsBannerTitle(1))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /"ping" 스텝의 URL이 비어/ }));
    expect(useScenarioEditor.getState().selectedStepId).toBe(ULID_A);
    expect(useScenarioEditor.getState().activeTab).toBe("canvas");
  });

  it("게이트 에러는 스텝 항목을 숨기고 한국어 매핑 + YAML 탭 유도 버튼만 보인다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML); // 모델엔 빈 URL 스텝 존재
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner />);

    // stale 모델 기준 스텝 선택은 거짓 정보 — 스텝 문제 버튼이 없어야 한다 (spec §5.4)
    expect(screen.queryByRole("button", { name: /"ping"/ })).not.toBeInTheDocument();
    // 게이트 행 자체도 비클릭 — 배너의 유일한 버튼은 "YAML 탭에서 확인"이어야 한다
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(ko.editor.gateRequired("steps.0.request.url"))).toBeInTheDocument();
    expect(screen.getByText(ko.editor.problemGateIntro)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.problemGateAction }));
    expect(useScenarioEditor.getState().activeTab).toBe("yaml");
  });
});
