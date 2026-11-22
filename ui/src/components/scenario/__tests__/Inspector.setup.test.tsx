import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const S1 = "01HX0000000000000000000001";
const B1 = "01HX0000000000000000000009";
const B2 = "01HX000000000000000000000A";
const L1 = "01HX000000000000000000000L";
const C1 = "01HX000000000000000000000C";

const HTTP = (id: string, name: string, extra = "") => `    - id: "${id}"
      name: ${name}
      type: http
      request:
        method: GET
        url: "http://x/${name}"
${extra}`;

const WITH_SETUP = `version: 1
name: x
setup:
  steps:
${HTTP(S1, "준비 요청")}steps:
${HTTP(B1, "조회")}`;

const TWO_MAIN = `version: 1
name: x
steps:
${HTTP(B1, "조회")}${HTTP(B2, "목록")}`;

const ONE_MAIN = `version: 1
name: x
steps:
${HTTP(B1, "조회")}`;

const WITH_LOOP = `version: 1
name: x
steps:
  - id: "${L1}"
    name: 반복
    type: loop
    repeat: 2
    do:
${HTTP(C1, "안쪽").replace(/^ {4}/gm, "      ")}`;

const DEFAULT_EXTRACT = `      extract:
        - var: tok
          from: body
          path: "$.t"
          default: "none"
`;

const st = () => useScenarioEditor.getState();

describe("Inspector 준비 스텝", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reset();
  });

  it("준비 스텝을 고르면 Inspector가 열리고 이름을 고치면 YAML에 반영된다", async () => {
    st().loadFromString(WITH_SETUP);
    st().select(S1);
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    expect(input).toHaveValue("준비 요청");
    fireEvent.change(input, { target: { value: "새 준비" } });
    fireEvent.blur(input);
    expect(st().model?.setup?.steps[0].name).toBe("새 준비");
    expect(st().yamlText).toContain("새 준비");
  });

  it("준비 스텝에는 ↑↓가 없고 안내 줄과 「본 스텝으로 옮기기」가 있다", () => {
    st().loadFromString(WITH_SETUP);
    st().select(S1);
    render(<Inspector />);
    expect(screen.queryByTitle(ko.common.moveUp)).not.toBeInTheDocument();
    expect(screen.queryByTitle(ko.common.moveDown)).not.toBeInTheDocument();
    const hint = screen.getByText("VU마다 한 번만 실행됩니다.");
    expect(within(hint).getByText("준비")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "본 스텝으로 옮기기" })).toBeInTheDocument();
  });

  it("「본 스텝으로 옮기기」를 누르면 본 스텝이 되고 버튼이 바뀐다", async () => {
    const user = userEvent.setup();
    st().loadFromString(WITH_SETUP);
    st().select(S1);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: "본 스텝으로 옮기기" }));
    const m = st().model!;
    expect(m.setup).toBeUndefined();
    expect(m.steps[m.steps.length - 1].id).toBe(S1);
    expect(screen.getByRole("button", { name: "준비 스텝으로 옮기기" })).toBeInTheDocument();
    expect(screen.getByTitle(ko.common.moveUp)).toBeInTheDocument();
    expect(screen.getByTitle(ko.common.moveDown)).toBeInTheDocument();
  });

  it("최상위 본 http 스텝에는 「준비 스텝으로 옮기기」가 있다", async () => {
    const user = userEvent.setup();
    st().loadFromString(TWO_MAIN);
    st().select(B1);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: "준비 스텝으로 옮기기" }));
    const steps = st().model!.setup!.steps;
    expect(steps[steps.length - 1].id).toBe(B1);
  });

  it("loop 안의 http 스텝과 컨테이너에는 옮기기 버튼이 없다", () => {
    st().loadFromString(WITH_LOOP);
    st().select(C1);
    const { unmount } = render(<Inspector />);
    expect(screen.queryByRole("button", { name: "준비 스텝으로 옮기기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "본 스텝으로 옮기기" })).not.toBeInTheDocument();
    unmount();
    st().select(L1);
    render(<Inspector />);
    expect(screen.queryByRole("button", { name: "준비 스텝으로 옮기기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "본 스텝으로 옮기기" })).not.toBeInTheDocument();
  });

  it("깨진 YAML 버퍼 중에는 옮기기 버튼이 잠긴다", () => {
    st().loadFromString(TWO_MAIN);
    st().select(B1);
    render(<Inspector />);
    act(() => {
      st().setPendingYamlText("steps: [unclosed");
      st().commitPendingYaml();
    });
    expect(st().yamlError).not.toBeNull();
    expect(screen.getByRole("button", { name: "준비 스텝으로 옮기기" })).toBeDisabled();
  });

  it("깨진 YAML 버퍼 중에는 「본 스텝으로 옮기기」도 잠긴다", () => {
    st().loadFromString(WITH_SETUP);
    st().select(S1);
    render(<Inspector />);
    act(() => {
      st().setPendingYamlText("steps: [unclosed");
      st().commitPendingYaml();
    });
    expect(st().yamlError).not.toBeNull();
    expect(screen.getByRole("button", { name: "본 스텝으로 옮기기" })).toBeDisabled();
  });

  it("본 스텝이 하나뿐이어도 「준비 스텝으로 옮기기」가 눌린다", async () => {
    const user = userEvent.setup();
    st().loadFromString(ONE_MAIN);
    st().select(B1);
    render(<Inspector />);
    const btn = screen.getByRole("button", { name: "준비 스텝으로 옮기기" });
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(st().model!.steps).toEqual([]);
    expect(st().model!.setup!.steps.map((s) => s.id)).toEqual([B1]);
    expect(screen.getByLabelText(ko.editor.fieldName)).toHaveValue("조회");
    expect(screen.getByRole("button", { name: "본 스텝으로 옮기기" })).toBeInTheDocument();
  });

  it("준비 스텝의 추출 기본값 칸 옆에 안 쓰인다는 안내가 나온다", async () => {
    const user = userEvent.setup();
    const setupYaml = `version: 1
name: x
setup:
  steps:
${HTTP(S1, "준비 요청", DEFAULT_EXTRACT)}steps:
${HTTP(B1, "조회", DEFAULT_EXTRACT)}`;
    st().loadFromString(setupYaml);
    st().select(S1);
    const { unmount } = render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const note = screen.getByText("준비 스텝에서는 쓰이지 않습니다");
    expect(note).toBeInTheDocument();
    const defaultRow = screen
      .getByLabelText(ko.editor.extractDefaultAria(0))
      .closest(".items-center");
    expect(defaultRow).not.toContainElement(note);
    unmount();
    st().select(B1);
    render(<Inspector />);
    expect(screen.queryByText("준비 스텝에서는 쓰이지 않습니다")).not.toBeInTheDocument();
  });
});
