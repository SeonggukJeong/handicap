import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HeaderTable } from "../HeaderTable";
import { JsonValueTree } from "../JsonValueTree";
import { BodyViewer } from "../BodyBlock";
import { copyText } from "../copyText";
import { ko } from "../../../i18n/ko";

// 응답 헤더·본문 값 줄: 줄 어디를 눌러도 그 줄의 버튼과 같은 동작, 줄 안에서 드래그하면
// 선택한 글자를 바로 복사하고 「복사됨」을 보인다(사용자 요청 2026-11-20).

function mockClipboard(impl: (t: string) => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}
function mockExecCommand(result: boolean) {
  const fn = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { value: fn, configurable: true });
  return fn;
}
/** Select the whole text of `el` (as a mouse drag would) and release the mouse on it. */
function dragSelect(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(el, { clientX: 100, clientY: 100 });
  fireEvent.click(el);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("HeaderTable 줄 클릭·드래그 복사", () => {
  const rows: [string, string][] = [
    ["a", "1"],
    ["x-trace", "abc-123"],
  ];
  let onClick: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    onClick = vi.fn();
  });
  const renderTable = (expanded?: { rowKey: string; content: React.ReactNode }) =>
    render(
      <HeaderTable
        title="응답 헤더"
        rows={rows}
        action={{ label: "추출", ariaLabelFor: (k) => `${k} 추출`, onClick }}
        expanded={expanded}
      />,
    );

  it("값 글자를 누르면 그 줄의 버튼과 같은 동작", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByText("abc-123"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith("x-trace");
  });

  it("이름 글자를 눌러도 같은 동작", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByText("x-trace"));
    expect(onClick).toHaveBeenCalledWith("x-trace");
  });

  it("버튼을 누르면 한 번만 동작(줄 클릭과 겹치지 않음)", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("button", { name: "x-trace 추출" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("버튼이 있는 줄만 눌리는 줄로 표시", () => {
    renderTable();
    expect(screen.getByText("abc-123").closest("tr")).toHaveClass("cursor-pointer");
  });

  it("드래그 선택 → 복사·「복사됨」, 추출 동작은 안 함", async () => {
    const writeText = mockClipboard();
    renderTable();
    await act(async () => dragSelect(screen.getByText("abc-123")));
    expect(writeText).toHaveBeenCalledWith("abc-123");
    expect(onClick).not.toHaveBeenCalled();
    expect(await screen.findAllByText(ko.common.copied)).not.toHaveLength(0);
  });

  it("복사 실패 → 「복사됨」 대신 실패 안내", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    mockExecCommand(false);
    renderTable();
    await act(async () => dragSelect(screen.getByText("abc-123")));
    expect(await screen.findAllByText(ko.common.copyFailed)).not.toHaveLength(0);
    expect(screen.queryByText(ko.common.copied)).not.toBeInTheDocument();
  });

  it("펼친 확인 줄 안의 글자를 드래그하면 복사하지 않음", async () => {
    const writeText = mockClipboard();
    renderTable({ rowKey: "a", content: <span>확인 상자 글자</span> });
    await act(async () => dragSelect(screen.getByText("확인 상자 글자")));
    expect(writeText).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("버튼 없는 표는 줄 클릭·드래그 복사 없음", async () => {
    const writeText = mockClipboard();
    render(<HeaderTable title="요청 헤더" rows={rows} />);
    expect(screen.getByText("abc-123").closest("tr")).not.toHaveClass("cursor-pointer");
    await act(async () => dragSelect(screen.getByText("abc-123")));
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("JsonValueTree 값 줄 클릭·드래그 복사", () => {
  const renderTree = () =>
    render(
      <JsonValueTree
        value={{ data: { token: "eyJabc" } }}
        actionLabel="+추출"
        renderConfirm={(leaf) => <span>confirm:{leaf.path}</span>}
      />,
    );

  it("값 글자를 누르면 확인 상자가 열림", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByText(/eyJabc/));
    expect(screen.getByText("confirm:$.data.token")).toBeInTheDocument();
  });

  it("묶음 머리 줄(data: {…})은 눌러도 반응 없음", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByText(/data: \{…\}/));
    expect(screen.queryByText(/confirm:/)).not.toBeInTheDocument();
  });

  it("드래그 선택 → 복사, 확인 상자는 안 열림", async () => {
    const writeText = mockClipboard();
    renderTree();
    await act(async () => dragSelect(screen.getByText(/eyJabc/)));
    expect(writeText).toHaveBeenCalledWith('token: "eyJabc"');
    expect(screen.queryByText(/confirm:/)).not.toBeInTheDocument();
    expect(await screen.findAllByText(ko.common.copied)).not.toHaveLength(0);
  });
});

describe("copyText", () => {
  it("클립보드 API가 있으면 그것으로 복사", async () => {
    const writeText = mockClipboard();
    await expect(copyText("hi")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");
  });

  it("클립보드 API가 없으면(http LAN 접속) 옛 방식 복사로", async () => {
    const exec = mockExecCommand(true);
    await expect(copyText("hi")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("옛 방식 복사는 사용자 선택을 되돌려 놓음", async () => {
    mockExecCommand(true);
    const p = document.createElement("p");
    p.textContent = "선택된 글자";
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    await copyText("hi");
    expect(window.getSelection()!.toString()).toBe("선택된 글자");
    p.remove();
  });

  it("둘 다 실패하면 false", async () => {
    mockClipboard(() => Promise.reject(new Error("denied")));
    mockExecCommand(false);
    await expect(copyText("hi")).resolves.toBe(false);
  });
});

describe("BodyViewer 복사 버튼", () => {
  it("클립보드 API가 없고 옛 방식도 실패하면 「복사됨」을 띄우지 않음", async () => {
    mockExecCommand(false);
    render(<BodyViewer body="plain" truncated={false} />);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "복사됨" })).not.toBeInTheDocument();
  });

  it("클립보드 API가 없어도 옛 방식 복사가 되면 「복사됨」", async () => {
    const exec = mockExecCommand(true);
    render(<BodyViewer body="plain" truncated={false} />);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    expect(await screen.findByRole("button", { name: "복사됨" })).toBeInTheDocument();
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
