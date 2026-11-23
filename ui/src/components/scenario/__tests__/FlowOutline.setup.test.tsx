import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";
import { resolveDrop } from "../../../scenario/reorder";
import { setupSteps } from "../../../scenario/model";
import { ko } from "../../../i18n/ko";

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

  it("준비 행에도 끌기 손잡이가 있다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const setupRow = screen.getByRole("option", { name: "스텝: 준비 요청" });
    const mainRow = screen.getByRole("option", { name: "스텝: 조회" });
    expect(
      within(setupRow).getByRole("button", { name: ko.editor.dragHandleAria("준비 요청") }),
    ).toBeInTheDocument();
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

  it("끌기 계산이 준비 스텝을 안다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    const model = useScenarioEditor.getState().model!;
    expect(model.steps).toHaveLength(1);
    expect(resolveDrop(model.steps, B1, S1, "below", setupSteps(model))).toEqual({
      kind: "reparent",
      stepId: B1,
      target: { parentId: null, band: "setup", index: 1 },
    });
  });

  it("준비가 있으면 상자 안에 추가 버튼이 있고 아래 줄에는 없다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    expect(useScenarioEditor.getState().model).not.toBeNull();
    render(<FlowOutline />);
    const box = screen.getByRole("group", { name: GROUP_NAME });
    expect(within(box).getByRole("button", { name: "+ 준비 스텝" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "+ 준비 스텝" })).toHaveLength(1);
  });

  it("상자 안 추가 버튼: 준비 구획 끝에 새 스텝이 생기고 선택된다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const box = screen.getByRole("group", { name: GROUP_NAME });
    await userEvent.click(within(box).getByRole("button", { name: "+ 준비 스텝" }));
    const st = useScenarioEditor.getState();
    const list = setupSteps(st.model!);
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe(st.selectedStepId);
    expect(list[1].name).toBe("Setup 2");
  });

  it("준비가 없으면 아래 버튼 줄에 추가 버튼이 있다", async () => {
    useScenarioEditor.getState().loadFromString(`version: 1\nname: x\n${BODY}`);
    expect(useScenarioEditor.getState().model).not.toBeNull();
    render(<FlowOutline />);
    expect(screen.queryByRole("group", { name: GROUP_NAME })).not.toBeInTheDocument();
    const btns = screen.getAllByRole("button", { name: "+ 준비 스텝" });
    expect(btns).toHaveLength(1);
    await userEvent.click(btns[0]);
    const list = setupSteps(useScenarioEditor.getState().model!);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Setup 1");
    expect(screen.getByRole("group", { name: GROUP_NAME })).toBeInTheDocument();
  });

  it("YAML 오류 상태에서 추가 버튼을 눌러도 준비 스텝이 안 생긴다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    useScenarioEditor.getState().setPendingYamlText("version: [");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    render(<FlowOutline />);
    const box = screen.getByRole("group", { name: GROUP_NAME });
    await userEvent.click(within(box).getByRole("button", { name: "+ 준비 스텝" }));
    expect(setupSteps(useScenarioEditor.getState().model!)).toHaveLength(1);
  });

  it("준비 행의 손잡이를 움직이지 않고 눌러도 순서와 YAML은 안 바뀐다", async () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    const before = useScenarioEditor.getState().yamlText;
    const user = userEvent.setup();
    const row = screen.getByRole("option", { name: "스텝: 준비 요청" });
    await user.click(
      within(row).getByRole("button", { name: ko.editor.dragHandleAria("준비 요청") }),
    );
    const st = useScenarioEditor.getState();
    expect(setupSteps(st.model!).map((s) => s.id)).toEqual([S1]);
    expect(st.yamlText).toBe(before);
  });

  it("A1의 읽기 전용 줄은 없다", () => {
    useScenarioEditor.getState().loadFromString(WITH_SETUP);
    render(<FlowOutline />);
    expect(screen.queryByText(/YAML 보기에서 확인/)).not.toBeInTheDocument();
  });
});
