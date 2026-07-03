import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("빈 URL 스텝을 나열하고 클릭 시 해당 스텝을 선택한다 (탭 전환 없음)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    render(<ValidationBanner />);

    expect(screen.getByText(ko.editor.problemsBannerTitle(1))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /"ping" 스텝의 URL이 비어/ }));
    expect(useScenarioEditor.getState().selectedStepId).toBe(ULID_A);
  });

  it("배너는 role=status + aria-label + Callout warn 캐넌 클래스(rounded-md/bg-amber-50)로 렌더된다", () => {
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    render(<ValidationBanner />);
    const banner = screen.getByRole("status", { name: ko.editor.problemsBannerAria });
    expect(banner).toHaveClass("rounded-md");
    expect(banner).toHaveClass("bg-amber-50");
  });

  it("게이트 에러는 스텝 항목을 숨기고 한국어 매핑 + YAML 모달 열기 버튼만 보인다", async () => {
    const user = userEvent.setup();
    const onOpenYaml = vi.fn();
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner onOpenYaml={onOpenYaml} />);

    expect(screen.queryByRole("button", { name: /"ping"/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(ko.editor.gateRequired("steps.0.request.url"))).toBeInTheDocument();
    expect(screen.getByText(ko.editor.problemGateIntro)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.problemGateAction }));
    expect(onOpenYaml).toHaveBeenCalledTimes(1);
  });

  it("yamlError 상태면 편집 차단 안내를 렌더한다 (R4)", () => {
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML);
    useScenarioEditor.setState({ yamlError: "steps.0.request.url: Required" });
    render(<ValidationBanner />);
    expect(screen.getByText(ko.editor.editBlockedWhileInvalid)).toBeInTheDocument();
  });

  it("step 문제만 있고 yamlError가 없으면 편집 차단 안내는 없다 (R4)", () => {
    useScenarioEditor.getState().loadFromString(EMPTY_URL_YAML); // 빈 URL=step 문제, yamlError=null
    render(<ValidationBanner />);
    expect(screen.queryByText(ko.editor.editBlockedWhileInvalid)).not.toBeInTheDocument();
  });
});
