import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResponseBodyTree } from "../ResponseBodyTree";

describe("ResponseBodyTree", () => {
  it("scalar leaves get +추출, containers do not (R1,R6)", () => {
    render(
      <ResponseBodyTree value={{ data: { token: "abc" }, items: [1, 2] }} onCreate={() => {}} />,
    );
    // scalars: token, items[0]=1, items[1]=2 → 3 buttons (objects/arrays none)
    expect(screen.getAllByRole("button", { name: "+추출" })).toHaveLength(3);
  });

  it("creates a body extract with generated path + edited var (R8)", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ data: { token: "abc" } }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    const input = screen.getByRole("textbox", { name: "추출 변수명" });
    expect(input).toHaveValue("token"); // prefilled from leaf key
    await user.clear(input);
    await user.type(input, "authToken");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "authToken", from: "body", path: "$.data.token" });
  });

  it("array element path uses index + nearest object key as var", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ items: [{ sku: "A-1" }] }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    expect(screen.getByRole("textbox", { name: "추출 변수명" })).toHaveValue("sku");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "sku", from: "body", path: "$.items[0].sku" });
  });

  it("root scalar uses $ and default var (R6 §3③)", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={"justastring"} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    expect(screen.getByRole("textbox", { name: "추출 변수명" })).toHaveValue("value");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "value", from: "body", path: "$" });
  });

  it("+추출 버튼은 accent 토큰(indigo→accent)", () => {
    render(<ResponseBodyTree value={{ data: { token: "abc" } }} onCreate={vi.fn()} />);
    const extractBtn = screen.getByRole("button", { name: "+추출" }); // 단일 스칼라=1개
    expect(extractBtn).toHaveClass("bg-accent-600"); // 이주 전 RED (현 bg-indigo-600)
  });

  it("cancel closes the confirm row without calling onCreate", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ token: "abc" }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("textbox", { name: "추출 변수명" })).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
