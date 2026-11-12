import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConditionRow } from "../ConditionRow";
import type { Condition } from "../../../api/monitors";
import { ko } from "../../../i18n/ko";

const INIT: Condition = {
  step_id: "01HZZZZZZZZZZZZZZZZZZZZZA1",
  source: "body",
  path: "$.resultCode",
  op: "eq",
  value: "0000",
  ignore_case: false,
  trim: false,
};

function setup(over: Partial<Condition> = {}, hint?: "volatile" | "secret" | null) {
  const onSubmit = vi.fn();
  render(
    <ConditionRow
      initial={{ ...INIT, ...over }}
      mode="create"
      hint={hint}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  );
  return { onSubmit, user: userEvent.setup() };
}

describe("ConditionRow", () => {
  it("hint_selects_the_matching_note", () => {
    const noop = () => {};
    const { unmount } = render(
      <ConditionRow initial={INIT} mode="create" hint="secret" onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.getByText(ko.monitor.condSecretHint)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.condVolatileHint)).not.toBeInTheDocument();
    unmount();
    const v = render(
      <ConditionRow initial={INIT} mode="create" hint="volatile" onSubmit={noop} onCancel={noop} />,
    );
    expect(screen.getByText(ko.monitor.condVolatileHint)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.condSecretHint)).not.toBeInTheDocument();
    v.unmount();
    setup({}, null);
    expect(screen.queryByText(ko.monitor.condVolatileHint)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.condSecretHint)).not.toBeInTheDocument();
  });

  it("exists keeps the value input but disabled", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(ko.monitor.condOp), "exists");
    const input = screen.getByLabelText(ko.monitor.condValue);
    expect(input).toBeDisabled();
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "—");
  });

  it("one_of shows the candidates placeholder", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(ko.monitor.condOp), "one_of");
    const input = screen.getByLabelText(ko.monitor.condValue);
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("placeholder", "0000, 0020");
  });

  it("symbol options carry spoken accessible names", () => {
    setup();
    expect(screen.getByRole("option", { name: ko.monitor.condOpSpoken.gte })).toHaveValue("gte");
    expect(ko.monitor.condOpSpoken.gte).toBe("이상");
    expect(screen.getByRole("option", { name: "같음" })).toHaveValue("eq");
  });

  it("one_of with only blank candidates blocks submit and shows the error", async () => {
    const { user, onSubmit } = setup({ op: "one_of", value: " , " });
    expect(screen.getByRole("button", { name: ko.monitor.condConfirm })).toBeDisabled();
    expect(screen.getByText(ko.monitor.condErrOneOf)).toBeInTheDocument();
    await user.type(screen.getByLabelText(ko.monitor.condValue), "a");
    expect(screen.getByRole("button", { name: ko.monitor.condConfirm })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: ko.monitor.condConfirm }));
    expect(onSubmit).toHaveBeenCalled();
  });
});
