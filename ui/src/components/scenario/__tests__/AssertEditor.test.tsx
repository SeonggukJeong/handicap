import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { AssertEditor } from "../AssertEditor";
import { useScenarioEditor } from "../../../scenario/store";
import type { HttpStep } from "../../../scenario/model";

const ID1 = "01HX0000000000000000000001";
const ID2 = "01HX0000000000000000000002";

function yamlOf(assert1: string, assert2 = "    assert: [{ status: any }]") {
  return `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "${ID1}"
    name: "a"
    type: http
    request:
      method: GET
      url: "/a"
${assert1}
  - id: "${ID2}"
    name: "b"
    type: http
    request:
      method: GET
      url: "/b"
${assert2}
`;
}

function load(assert1: string, assert2?: string) {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(yamlOf(assert1, assert2));
  useScenarioEditor.getState().select(ID1);
}

function Host({ id = ID1 }: { id?: string }) {
  const model = useScenarioEditor((s) => s.model);
  const step = model!.steps.find((s) => s.id === id) as HttpStep;
  return <AssertEditor step={step} />;
}

const yamlText = () => useScenarioEditor.getState().yamlText;
const stepAssert = (id = ID1) => {
  const st = useScenarioEditor.getState().model!.steps.find((s) => s.id === id) as HttpStep;
  return st.assert;
};
const radio = (name: string) => screen.getByRole("radio", { name });

describe("AssertEditor — 방식 단추", () => {
  beforeEach(() => window.localStorage.clear());

  it("검사 없음: 「400 이상은 오류」 선택 + 기본 안내 글", () => {
    load("    assert: []");
    render(<Host />);
    expect(screen.getByRole("radiogroup", { name: "상태 코드 검사 방식" })).toBeInTheDocument();
    expect(radio("400 이상은 오류")).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(
        "따로 적지 않아도 400 이상(4xx·5xx) 응답은 오류로 셉니다. 399까지는 통과입니다.",
      ),
    ).toBeInTheDocument();
  });

  it("「적은 코드만 통과」 → status: 200, 칩과 빼기 단추", async () => {
    const user = userEvent.setup();
    load("    assert: []");
    render(<Host />);
    await user.click(radio("적은 코드만 통과"));
    expect(yamlText()).toContain("- status: 200");
    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "200 빼기" })).toBeInTheDocument();
    expect(
      screen.getByText("적은 코드 가운데 하나를 받으면 통과입니다. 그 밖의 코드는 오류로 셉니다."),
    ).toBeInTheDocument();
  });

  it("이미 고른 방식을 다시 눌러도 아무것도 쓰지 않는다", async () => {
    const user = userEvent.setup();
    load("    assert: []");
    render(<Host />);
    const before = yamlText();
    await user.click(radio("400 이상은 오류"));
    expect(yamlText()).toBe(before);
  });

  it("「보지 않음」 → status: any + 주의 안내", async () => {
    const user = userEvent.setup();
    load("    assert: []");
    render(<Host />);
    await user.click(radio("보지 않음"));
    expect(yamlText()).toContain("- status: any");
    const note = screen.getByText(
      "이 스텝은 어떤 상태 코드를 받아도 오류로 세지 않습니다. 4xx·5xx를 받으면 리포트가 따로 알려 줍니다.",
    );
    expect(note).toHaveClass("text-amber-800");
  });

  it("방식을 오가면 마지막 코드 목록이 돌아온다(화살표 키도)", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: [201, 409] }]");
    render(<Host />);
    await user.click(radio("보지 않음"));
    await user.click(radio("적은 코드만 통과"));
    expect(yamlText()).toContain("status: [ 201, 409 ]");
    radio("적은 코드만 통과").focus();
    await user.keyboard("{ArrowRight}"); // 보지 않음
    expect(stepAssert()).toEqual([{ kind: "status_any" }]);
    await user.keyboard("{ArrowLeft}"); // 적은 코드만 통과
    expect(yamlText()).toContain("status: [ 201, 409 ]");
  });

  it("코드를 기억한 적이 없는 스텝은 [200]", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: any }]");
    render(<Host />);
    await user.click(radio("적은 코드만 통과"));
    expect(stepAssert()).toEqual([{ kind: "status", codes: [200] }]);
  });
});

describe("AssertEditor — 코드 칩·추가", () => {
  beforeEach(() => window.localStorage.clear());

  it("409 추가 → [200, 409], 같은 코드(200)는 목록 그대로", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: 200 }]");
    render(<Host />);
    const input = screen.getByPlaceholderText("예: 201");
    await user.type(input, "409");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(yamlText()).toContain("status: [ 200, 409 ]");
    await user.type(screen.getByPlaceholderText("예: 201"), "200");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(stepAssert()).toEqual([{ kind: "status", codes: [200, 409] }]);
  });

  it.each(["99", "600", "1.5", ""])("칸이 %j이면 「추가」 비활성", async (v) => {
    const user = userEvent.setup();
    load("    assert: [{ status: 200 }]");
    render(<Host />);
    if (v) await user.type(screen.getByPlaceholderText("예: 201"), v);
    expect(screen.getByRole("button", { name: "추가" })).toBeDisabled();
  });

  it("201 입력 후 Enter로 추가", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: 200 }]");
    render(<Host />);
    await user.type(screen.getByPlaceholderText("예: 201"), "201{Enter}");
    expect(stepAssert()).toEqual([{ kind: "status", codes: [200, 201] }]);
  });

  it("코드 64개면 올바른 새 코드를 넣어도 추가 비활성, Enter도 아무것도 쓰지 않는다", async () => {
    const user = userEvent.setup();
    const codes = Array.from({ length: 64 }, (_, i) => 200 + i);
    load(`    assert: [{ status: [${codes.join(", ")}] }]`);
    render(<Host />);
    const input = screen.getByPlaceholderText("예: 201");
    await user.type(input, "599");
    expect(screen.getByRole("button", { name: "추가" })).toBeDisabled();
    const before = yamlText();
    await user.type(input, "{Enter}");
    expect(yamlText()).toBe(before);
  });

  it("마지막 코드까지 빼면 assert: [] 이고 기본 방식이 선택된다", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: [200, 409] }]");
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "200 빼기" }));
    await user.click(screen.getByRole("button", { name: "409 빼기" }));
    expect(stepAssert()).toEqual([]);
    expect(radio("400 이상은 오류")).toHaveAttribute("aria-checked", "true");
  });

  it("YAML [200, 200]을 열면 칩은 하나, YAML은 그대로", () => {
    load("    assert: [{ status: [200, 200] }]");
    const before = yamlText();
    render(<Host />);
    expect(screen.getAllByText("200")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "200 빼기" })).toHaveLength(1);
    expect(yamlText()).toBe(before);
  });
});

describe("AssertEditor — 여러 줄", () => {
  beforeEach(() => window.localStorage.clear());

  it("항상 실패(200 / 201): radiogroup 없이 붉은 알림, 합치기", async () => {
    const user = userEvent.setup();
    load("    assert:\n      - status: 200\n      - status: 201");
    render(<Host />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    const note = screen.getByText(
      "상태 코드 검사가 2줄입니다(200 / 201). 줄을 모두 만족해야 통과라서 이 스텝은 항상 실패합니다.",
    );
    expect(note).toHaveClass("text-red-800");
    await user.click(
      screen.getByRole("button", { name: "「200, 201 가운데 하나면 통과」로 합치기" }),
    );
    expect(yamlText()).toContain("status: [ 200, 201 ]");
    expect(stepAssert()).toEqual([{ kind: "status", codes: [200, 201] }]);
  });

  it("[200, 409] / [200]: 지금은 200만 통과", () => {
    load("    assert:\n      - status: [200, 409]\n      - status: 200");
    render(<Host />);
    const note = screen.getByText(
      "상태 코드 검사가 2줄입니다(200·409 / 200). 지금은 200만 통과합니다.",
    );
    expect(note).toHaveClass("text-amber-800");
    expect(
      screen.getByRole("button", { name: "「200, 409 가운데 하나면 통과」로 합치기" }),
    ).toBeInTheDocument();
  });

  it("200 / 200: 「200만 통과」로 합치기", () => {
    load("    assert:\n      - status: 200\n      - status: 200");
    render(<Host />);
    expect(
      screen.getByText("상태 코드 검사가 2줄입니다(200 / 200). 지금은 200만 통과합니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "「200만 통과」로 합치기" })).toBeInTheDocument();
  });

  it("any / any: 한 줄로 합치면 - status: any", async () => {
    const user = userEvent.setup();
    load("    assert:\n      - status: any\n      - status: any");
    render(<Host />);
    expect(
      screen.getByText(
        "상태 코드 검사가 2줄입니다(보지 않음 / 보지 않음). 지금은 상태 코드를 보지 않습니다.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "「보지 않음」 한 줄로 합치기" }));
    expect(stepAssert()).toEqual([{ kind: "status_any" }]);
  });
});

describe("AssertEditor — 깨진 YAML·손대지 않은 스텝", () => {
  beforeEach(() => window.localStorage.clear());

  it("깨진 YAML에서는 모든 편집 어포던스가 disabled", () => {
    load("    assert: [{ status: [200, 409] }]");
    const { unmount } = render(<Host />);
    act(() => {
      useScenarioEditor.getState().setPendingYamlText("steps: [");
      useScenarioEditor.getState().commitPendingYaml();
    });
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    // 모델은 옛 상태 그대로 — 다시 그린다.
    unmount();
    render(<Host />);
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByRole("button", { name: "추가" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "200 빼기" })).toBeDisabled();
  });

  it("깨진 YAML에서는 합치기도 disabled", () => {
    load("    assert:\n      - status: 200\n      - status: 201");
    act(() => {
      useScenarioEditor.getState().setPendingYamlText("steps: [");
      useScenarioEditor.getState().commitPendingYaml();
    });
    render(<Host />);
    expect(
      screen.getByRole("button", { name: "「200, 201 가운데 하나면 통과」로 합치기" }),
    ).toBeDisabled();
  });

  it("한 스텝만 방식을 바꿔도 다른 스텝의 줄과 주석은 손대지 않는다", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: [200, 200] }]  # 둘", "    assert: [{ status: any }]");
    const untouched = String(parseDocument(useScenarioEditor.getState().yamlText));
    render(<Host id={ID2} />);
    await user.click(radio("적은 코드만 통과"));
    const after = useScenarioEditor.getState().yamlText;
    expect(stepAssert(ID2)).toEqual([{ kind: "status", codes: [200] }]);
    const stepA = (y: string) => y.slice(0, y.indexOf(`id: "${ID2}"`));
    expect(stepA(after)).toBe(stepA(untouched));
    expect(stepA(after)).toContain("# 둘");
    expect(stepA(after)).toContain("[ 200, 200 ]");
  });

  it("스텝을 바꾸면 추가 칸 입력이 비워진다", async () => {
    const user = userEvent.setup();
    load("    assert: [{ status: 200 }]", "    assert: [{ status: 201 }]");
    const { rerender } = render(<Host id={ID1} />);
    await user.type(screen.getByPlaceholderText("예: 201"), "409");
    expect(screen.getByPlaceholderText("예: 201")).toHaveValue(409);
    rerender(<Host id={ID2} />);
    expect(screen.getByPlaceholderText("예: 201")).toHaveValue(null);
  });
});
