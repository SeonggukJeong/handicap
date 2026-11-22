import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";
import { resolveDrop } from "../../../scenario/reorder";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const S1 = "01HX0000000000000000000001";
const S2 = "01HX0000000000000000000002";
const B1 = "01HX0000000000000000000009";

const HTTP = (id: string, name: string) => `    - id: "${id}"
      name: ${name}
      type: http
      request:
        method: GET
        url: "http://x/${name}"
`;

const BODY = `steps:
  - id: "${B1}"
    name: 조회
    type: http
    request:
      method: GET
      url: "http://x/main"
`;

const WITH_SETUP = `version: 1
name: x
setup:
  steps:
${HTTP(S1, "준비 요청")}${BODY}`;

const GROUP_NAME = "준비 스텝 — VU마다 한 번만 실행";

describe("FlowOutline 준비 구획", () => {
  beforeEach(reset);

  it("준비 스텝이 있으면 구획 머리 줄 둘과 준비 행이 본 스텝 행보다 앞에 나온다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const group = screen.getByRole("group", { name: GROUP_NAME });
    expect(screen.getByText("본 스텝 — 반복 실행")).toBeInTheDocument();
    expect(within(group).getAllByRole("option")).toHaveLength(1);
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual([
      "스텝: 준비 요청",
      "스텝: 조회",
    ]);
  });

  it("준비 스텝이 없으면 머리 줄이 없다", () => {
    useScenarioEditor.getState().loadFromString(`version: 1\nname: x\n${BODY}`);
    render(<FlowOutline />);
    expect(screen.queryByRole("group", { name: GROUP_NAME })).not.toBeInTheDocument();
    expect(screen.queryByText("본 스텝 — 반복 실행")).not.toBeInTheDocument();
  });

  it("준비 행을 누르면 선택된다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: "스텝: 준비 요청" });
    await userEvent.click(row);
    expect(useScenarioEditor.getState().selectedStepId).toBe(S1);
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("준비 행에는 끌기 손잡이가 없다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const setupRow = screen.getByRole("option", { name: "스텝: 준비 요청" });
    const mainRow = screen.getByRole("option", { name: "스텝: 조회" });
    expect(within(setupRow).queryByRole("button")).not.toBeInTheDocument();
    expect(within(mainRow).getByRole("button")).toBeInTheDocument();
  });

  it("넓게 보기에서 준비 행을 누르면 onActivateStep이 불린다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    const spy = vi.fn();
    render(<FlowOutline wide onActivateStep={spy} />);
    await userEvent.click(screen.getByRole("option", { name: "스텝: 준비 요청" }));
    expect(spy).toHaveBeenCalledWith(S1);
  });

  it("준비 행도 Enter로 선택된다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    screen.getByRole("option", { name: "스텝: 준비 요청" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(useScenarioEditor.getState().selectedStepId).toBe(S1);
  });

  it("준비 행은 data-step-id를 항상 단다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    expect(screen.getByRole("option", { name: "스텝: 준비 요청" })).toHaveAttribute(
      "data-step-id",
      S1,
    );
  });

  it("본 스텝이 없고 준비 스텝만 있어도 그려진다", () => {
    useScenarioEditor
      .getState()
      .loadFromString(`version: 1\nname: x\nsetup:\n  steps:\n${HTTP(S2, "준비 요청")}steps: []\n`);
    render(<FlowOutline />);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(
      screen.getByText(
        "HTTP 스텝을 추가해 시작하세요. 스텝은 부하 중 반복 실행될 HTTP 요청 1개입니다.",
      ),
    ).toBeInTheDocument();
  });

  it("끌기 계산은 준비 스텝 id를 모른다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    const model = useScenarioEditor.getState().model!;
    expect(resolveDrop(model.steps, B1, S1, "below")).toBeNull();
  });

  it("A1의 읽기 전용 줄은 없다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    expect(screen.queryByText(/YAML 보기에서 확인/)).not.toBeInTheDocument();
  });
});
