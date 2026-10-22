import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonValueTree, type JsonLeaf } from "../JsonValueTree";
import { HeaderTable } from "../HeaderTable";
import { BodyBlock } from "../BodyBlock";

describe("JsonValueTree", () => {
  it("json_value_tree_custom_action_opens_confirm", async () => {
    const user = userEvent.setup();
    const renderConfirm = vi.fn((leaf: JsonLeaf, close: () => void) => (
      <div>
        <span>confirm:{leaf.path}</span>
        <button type="button" onClick={close}>
          닫기
        </button>
      </div>
    ));
    render(
      <JsonValueTree
        value={{ a: { b: "x" }, n: null }}
        actionLabel="+ 조건"
        actionAriaLabel={(l) => `${l.path} 조건 추가`}
        renderConfirm={renderConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "$.a.b 조건 추가" }));
    expect(screen.getByText("confirm:$.a.b")).toBeInTheDocument();
    expect(renderConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ path: "$.a.b", value: "x", key: "b" }),
      expect.any(Function),
    );
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText("confirm:$.a.b")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$.n 조건 추가" })).toBeInTheDocument();
  });

  it("json_value_tree_without_aria_uses_text_name", () => {
    render(
      <JsonValueTree value={{ a: 1 }} actionLabel="+추출" renderConfirm={() => <span>c</span>} />,
    );
    const btn = screen.getByRole("button", { name: "+추출" });
    expect(btn).not.toHaveAttribute("aria-label");
  });
});

describe("HeaderTable", () => {
  it("header_table_custom_action", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <HeaderTable
        title="헤더"
        rows={[
          ["content-type", "application/json"],
          ["x-a", "1"],
        ]}
        action={{ label: "+ 조건", ariaLabelFor: (k) => `${k} 조건`, onClick }}
      />,
    );
    expect(screen.getAllByText("+ 조건")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "content-type 조건" }));
    expect(onClick).toHaveBeenCalledWith("content-type");
  });
});

describe("BodyBlock", () => {
  it("body_block_long_json_uses_open_label_and_modal_tree", async () => {
    const user = userEvent.setup();
    const body = JSON.stringify({ k: "v".repeat(600) });
    render(
      <BodyBlock
        body={body}
        label="응답 본문"
        tree={{ render: () => <div>TREE-RENDERED</div>, openLabel: "전체 보기·조건" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "전체 보기·조건" }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("TREE-RENDERED")).toBeInTheDocument();
  });

  it("body_block_non_json_shows_fallback_notice", () => {
    render(
      <BodyBlock
        body="plain text"
        label="응답 본문"
        tree={{
          render: () => <div>TREE-RENDERED</div>,
          openLabel: "열기",
          fallbackNotice: (t) => <div>notice:{String(t)}</div>,
        }}
      />,
    );
    expect(screen.getByText("notice:false")).toBeInTheDocument();
    expect(screen.queryByText("TREE-RENDERED")).not.toBeInTheDocument();
  });
});
