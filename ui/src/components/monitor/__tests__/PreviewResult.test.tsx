import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewResult } from "../PreviewResult";
import type { DisplayItem, PreviewResult as Preview } from "../../../api/monitors";
import { ko } from "../../../i18n/ko";

const STEP = "01HZZZZZZZZZZZZZZZZZZZZZA1";

function preview(body: string, headers: Record<string, string> = {}): Preview {
  return {
    trace: {
      ok: true,
      total_ms: 10,
      steps: [
        {
          step_id: STEP,
          kind: "http",
          loop_index: null,
          branch: null,
          request: null,
          response: {
            status: 200,
            latency_ms: 10,
            download_ms: null,
            headers,
            set_cookies: [],
            body,
            body_truncated: false,
          },
          extracted: {},
          unbound_vars: [],
          error: null,
        },
      ],
      final_vars: {},
      truncated: false,
      error: null,
    },
    result: {
      at_ms: 1,
      verdict: "ok",
      latency_ms: 10,
      reason: null,
      detail: null,
      display: [],
    },
  } as Preview;
}

function setup(p: Preview, opts: { displayItems?: DisplayItem[]; conditionCount?: number } = {}) {
  const onAddDisplay = vi.fn();
  const onAddCondition = vi.fn();
  render(
    <PreviewResult
      preview={p}
      stepNames={{ [STEP]: "로그인" }}
      onAddCondition={onAddCondition}
      conditionCount={opts.conditionCount ?? 0}
      displayItems={opts.displayItems ?? []}
      onAddDisplay={onAddDisplay}
    />,
  );
  return { onAddDisplay, onAddCondition, user: userEvent.setup() };
}
const add = (t: string) => screen.getByRole("button", { name: ko.monitor.condAddAria(t) });
const chooseDisplay = () => screen.getByRole("button", { name: ko.monitor.condChooseDisplay });
const chooseCond = () => screen.getByRole("button", { name: ko.monitor.condChooseCondition });
const confirmBtn = () => screen.getByRole("button", { name: ko.monitor.condConfirm });

describe("PreviewResult", () => {
  it("branch_skipped_label", () => {
    const p = preview("{}");
    p.result = { ...p.result, verdict: "branch_skipped", reason: "x = false" };
    setup(p);
    expect(screen.getByText("분기 제외")).toBeInTheDocument();
  });

  it("wrapped_json_shows_tree_and_notice", () => {
    setup(preview(JSON.stringify('{"code":1}')));
    expect(add("code")).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.previewUnwrapped)).toBeInTheDocument();
  });

  it("plain_object_has_no_unwrap_notice", () => {
    setup(preview('{"code":1}'));
    expect(add("code")).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.previewUnwrapped)).not.toBeInTheDocument();
  });

  it("add_opens_choice_and_display_calls_back", async () => {
    const { user, onAddDisplay } = setup(preview(JSON.stringify('{"code":1}')));
    await user.click(add("code"));
    expect(chooseCond()).toBeInTheDocument();
    await user.click(chooseDisplay());
    expect(onAddDisplay).toHaveBeenCalledWith({ step_id: STEP, source: "body", path: "$.code" });
    expect(
      screen.queryByRole("button", { name: ko.monitor.condChooseDisplay }),
    ).not.toBeInTheDocument();
  });

  it("choose_condition_shows_condition_row", async () => {
    const { user } = setup(preview('{"code":1}'));
    await user.click(add("code"));
    expect(screen.queryByRole("button", { name: ko.monitor.condConfirm })).not.toBeInTheDocument();
    await user.click(chooseCond());
    expect(confirmBtn()).toBeInTheDocument();
  });

  it("status_display_item_uses_empty_path", async () => {
    const { user, onAddDisplay } = setup(preview(""));
    await user.click(add(ko.monitor.condTargetStatus));
    await user.click(chooseDisplay());
    expect(onAddDisplay).toHaveBeenCalledWith({ step_id: STEP, source: "status", path: "" });
  });

  it("auth_header_display_disabled_with_reason", async () => {
    const { user, onAddDisplay } = setup(preview("", { "Set-Cookie": "a=b", "x-trace": "1" }));
    await user.click(add(ko.monitor.condTargetHeader("Set-Cookie")));
    const btn = chooseDisplay();
    expect(btn).toBeDisabled();
    const reason = screen.getByText(ko.monitor.displayAuthHeader);
    expect(reason.id).not.toBe("");
    expect(btn.getAttribute("aria-describedby")).toBe(reason.id);
    await user.click(btn);
    expect(onAddDisplay).not.toHaveBeenCalled();
  });

  it("other_header_display_enabled", async () => {
    const { user, onAddDisplay } = setup(preview("", { "x-trace": "1" }));
    await user.click(add(ko.monitor.condTargetHeader("x-trace")));
    await user.click(chooseDisplay());
    expect(onAddDisplay).toHaveBeenCalledWith({
      step_id: STEP,
      source: "header",
      path: "x-trace",
    });
  });

  it("two_items_disables_display_with_max", async () => {
    const items: DisplayItem[] = [
      { step_id: STEP, source: "status", path: "" },
      { step_id: STEP, source: "body", path: "$.zzz" },
    ];
    const { user } = setup(preview('{"code":1}'), { displayItems: items });
    await user.click(add("code"));
    expect(chooseDisplay()).toBeDisabled();
    expect(screen.getByText(ko.monitor.displayMax)).toBeInTheDocument();
  });

  it("duplicate_disables_display_with_dup", async () => {
    const items: DisplayItem[] = [{ step_id: STEP, source: "body", path: "$.code" }];
    const { user } = setup(preview('{"code":1}'), { displayItems: items });
    await user.click(add("code"));
    expect(chooseDisplay()).toBeDisabled();
    expect(screen.getByText(ko.monitor.displayDup)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.displayMax)).not.toBeInTheDocument();
  });

  it("max_reason_beats_dup_reason", async () => {
    const items: DisplayItem[] = [
      { step_id: STEP, source: "body", path: "$.code" },
      { step_id: STEP, source: "status", path: "" },
    ];
    const { user } = setup(preview('{"code":1}'), { displayItems: items });
    await user.click(add("code"));
    expect(screen.getByText(ko.monitor.displayMax)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.displayDup)).not.toBeInTheDocument();
  });

  it("ten_conditions_do_not_block_display", async () => {
    const { user, onAddDisplay } = setup(preview('{"code":1}'), { conditionCount: 10 });
    await user.click(add("code"));
    expect(chooseDisplay()).toBeEnabled();
    await user.click(chooseDisplay());
    expect(onAddDisplay).toHaveBeenCalledTimes(1);
  });

  it("ten_conditions_still_block_condition_confirm", async () => {
    const { user } = setup(preview('{"code":1}'), { conditionCount: 10 });
    await user.click(add("code"));
    await user.click(chooseCond());
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByText(ko.monitor.condMax)).toBeInTheDocument();
  });

  // Long bodies (> 500 chars) used to repeat the heading on a second line with the
  // char count appended; the count and open button now join the one heading line.
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it("long_json_body_heading_appears_once_with_count_and_open_button", () => {
    const body = JSON.stringify({ k: "v".repeat(600) });
    const { container } = render(
      <PreviewResult preview={preview(body)} stepNames={{}} onAddCondition={vi.fn()} />,
    );
    expect(occurrences(container.textContent ?? "", ko.monitor.previewBodyClickHint)).toBe(1);
    const row = screen.getByRole("button", { name: ko.monitor.previewOpenFullCondition })
      .parentElement as HTMLElement;
    expect(row.textContent).toContain(ko.monitor.previewBodyClickHint);
    expect(row.textContent).toContain(`${body.length.toLocaleString()}자`);
  });

  it("long_text_body_heading_appears_once_above_body_text_button", () => {
    const body = "x".repeat(700);
    const { container } = render(
      <PreviewResult preview={preview(body)} stepNames={{}} onAddCondition={vi.fn()} />,
    );
    expect(occurrences(container.textContent ?? "", ko.monitor.previewBody)).toBe(1);
    const open = screen.getByRole("button", { name: "전체 보기" });
    const row = open.parentElement as HTMLElement;
    expect(row.textContent).toContain(ko.monitor.previewBody);
    expect(row.textContent).toContain("700자");
    const bodyText = screen.getByRole("button", { name: ko.monitor.condAddBodyText });
    expect(row.compareDocumentPosition(bodyText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("short_body_heading_has_no_count", () => {
    const { container } = render(
      <PreviewResult preview={preview('{"code":1}')} stepNames={{}} onAddCondition={vi.fn()} />,
    );
    expect(occurrences(container.textContent ?? "", ko.monitor.previewBodyClickHint)).toBe(1);
    expect(container.textContent).not.toMatch(/\d자/);
  });

  it("body_text_goes_straight_to_condition", async () => {
    const { user } = setup(preview("pong"));
    await user.click(screen.getByRole("button", { name: ko.monitor.condAddBodyText }));
    expect(confirmBtn()).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.monitor.condChooseDisplay }),
    ).not.toBeInTheDocument();
  });
});
