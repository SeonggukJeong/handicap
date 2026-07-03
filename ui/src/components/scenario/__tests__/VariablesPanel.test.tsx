import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariablesPanel } from "../VariablesPanel";
import { useScenarioEditor } from "../../../scenario/store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

describe("VariablesPanel", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("model이 null이어도 getSnapshot 캐싱 경고 없이 빈 상태를 렌더한다", () => {
    reset(); // beforeEach의 resetEmpty()를 되돌려 model: null 유지(EditorShell pre-load 윈도 재현)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<VariablesPanel />);
      expect(screen.getByText("변수 없음")).toBeInTheDocument();
      const snapshotWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("getSnapshot should be cached")),
      );
      expect(snapshotWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("lists variables and adds one via the two-field row", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    expect(screen.getByText("변수 없음")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("new_var"), "base");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("base");
  });

  it("removes a variable", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "x");
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: "tok 변수 제거" }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("tok");
  });

  it("U3: 변수 표기 치트시트 popover — 3분류(흐름/환경/시스템)를 연다/ESC로 닫는다", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    const tip = screen.getByRole("button", { name: "변수 표기 도움말" });
    await user.click(tip);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("흐름 변수");
    expect(note).toHaveTextContent("${ENV}");
    expect(note).toHaveTextContent("${vu_id}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("R1/R2: 값을 전폭 textarea로 렌더하고 편집을 store에 커밋한다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "abc");
    render(<VariablesPanel />);
    const ta = screen.getByRole("textbox", { name: "tok 값" });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta).toHaveClass("w-full");
    await user.type(ta, "d");
    expect(useScenarioEditor.getState().model!.variables.tok).toBe("abcd");
  });

  it("R1: 변수명은 truncate + title 로 전폭 표시한다", () => {
    useScenarioEditor.getState().setVariable("a_very_long_variable_name", "v");
    render(<VariablesPanel />);
    const name = screen.getByText("a_very_long_variable_name");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "a_very_long_variable_name");
  });

  it("R4: 사용되는 변수는 'N개 스텝에서 사용', 안 쓰이는 변수는 '미사용' 힌트를 보인다", () => {
    // {{used}}를 한 http 스텝의 url에서 참조하는 시나리오 + 미참조 변수 {{lonely}}
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables:
  used: "u"
  lonely: "l"
steps:
  - id: "01HX0000000000000000000001"
    name: s
    type: http
    request:
      method: GET
      url: "/x?q={{used}}"
    assert:
      - status: 200
`);
    render(<VariablesPanel />);
    expect(screen.getByText("1개 스텝에서 사용")).toBeInTheDocument();
    expect(screen.getByText("미사용")).toBeInTheDocument();
  });
});

describe("VariablesPanel — newKey input adopts primitive Input (design-system-editor)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("newKey input uses primitive Input with accent focus-ring class", () => {
    render(<VariablesPanel />);
    const newKey = screen.getByPlaceholderText("new_var");
    expect(newKey).toHaveClass("focus:ring-accent-500/30"); // Input BASE — RED before migration
    expect(newKey).toHaveClass("font-mono"); // mono preserved
  });
});
