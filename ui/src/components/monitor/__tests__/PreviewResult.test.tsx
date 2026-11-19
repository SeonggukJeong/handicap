import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewResult } from "../PreviewResult";
import type { DisplayItem, PreviewResult as Preview } from "../../../api/monitors";
import { ko } from "../../../i18n/ko";

const STEP = "01HZZZZZZZZZZZZZZZZZZZZZA1";

function preview(body: string, headers: Record<string, string> = {}, truncated = false): Preview {
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
            body_truncated: truncated,
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
    expect(screen.getByText(ko.common.jsonUnwrappedNotice)).toBeInTheDocument();
  });

  it("plain_object_has_no_unwrap_notice", () => {
    setup(preview('{"code":1}'));
    expect(add("code")).toBeInTheDocument();
    expect(screen.queryByText(ko.common.jsonUnwrappedNotice)).not.toBeInTheDocument();
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

  it("truncated_text_body_hides_body_text_condition_button", () => {
    const body = "x".repeat(700);
    const { unmount } = render(
      <PreviewResult preview={preview(body, {}, true)} stepNames={{}} onAddCondition={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: ko.monitor.condAddBodyText }),
    ).not.toBeInTheDocument();
    unmount();
    render(
      <PreviewResult preview={preview(body, {}, false)} stepNames={{}} onAddCondition={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: ko.monitor.condAddBodyText })).toBeInTheDocument();
  });

  it("secret_name_display_shows_note_and_keeps_button_enabled", async () => {
    const { user } = setup(preview('{"session_id":"s","name":"n"}'));
    await user.click(add("session_id"));
    const note = screen.getByText(ko.monitor.displaySecretNote);
    expect(chooseDisplay()).toBeEnabled();
    expect(note.id).not.toBe("");
    expect(chooseDisplay().getAttribute("aria-describedby")).toBe(note.id);
  });

  it("header_secret_name_shows_note_but_auth_header_shows_only_reason", async () => {
    const { user } = setup(preview("{}", { "X-Api-Key": "k", Authorization: "Bearer z" }));
    await user.click(add(ko.monitor.condTargetHeader("X-Api-Key")));
    expect(screen.getByText(ko.monitor.displaySecretNote)).toBeInTheDocument();
    expect(chooseDisplay()).toBeEnabled();
    await user.click(add(ko.monitor.condTargetHeader("Authorization")));
    expect(screen.getByText(ko.monitor.displayAuthHeader)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.displaySecretNote)).not.toBeInTheDocument();
  });

  it("plain_name_display_has_no_secret_note", async () => {
    const { user } = setup(preview('{"session_id":"s","name":"n"}'));
    await user.click(add("name"));
    expect(screen.queryByText(ko.monitor.displaySecretNote)).not.toBeInTheDocument();
    expect(chooseDisplay()).toBeEnabled();
  });

  it("full_display_shows_only_max_reason_not_secret_note", async () => {
    const items: DisplayItem[] = [
      { step_id: STEP, source: "status", path: "" },
      { step_id: STEP, source: "body", path: "$.zzz" },
    ];
    const { user } = setup(preview('{"session_id":"s","name":"n"}'), { displayItems: items });
    await user.click(add("session_id"));
    expect(screen.getByText(ko.monitor.displayMax)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.displaySecretNote)).not.toBeInTheDocument();
  });

  it("secret_name_condition_is_not_empty_without_comparison_value", async () => {
    const { user } = setup(preview('{"session_id":"s","name":"n"}'));
    await user.click(add("session_id"));
    await user.click(chooseCond());
    expect(screen.getByLabelText(ko.monitor.condOp)).toHaveValue("not_empty");
    expect(screen.getByLabelText(ko.monitor.condValue)).toHaveValue("");
    expect(screen.getByText(ko.monitor.condSecretHint)).toBeInTheDocument();
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

describe("PreviewResult onlyStepId", () => {
  const STEP2 = "01HZZZZZZZZZZZZZZZZZZZZZB1";
  it("only_step_id_limits_add_buttons", () => {
    const p = preview("");
    const first = p.trace!.steps[0];
    p.trace!.steps = [first, { ...first, step_id: STEP2 }];
    render(
      <PreviewResult
        preview={p}
        stepNames={{ [STEP]: "로그인", [STEP2]: "조회" }}
        onAddCondition={vi.fn()}
        onAddDisplay={vi.fn()}
        onlyStepId={STEP2}
      />,
    );
    const statusAdd = ko.monitor.condAddAria(ko.monitor.condTargetStatus);
    expect(screen.getAllByRole("button", { name: statusAdd })).toHaveLength(1);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).queryByRole("button", { name: statusAdd })).not.toBeInTheDocument();
    expect(within(rows[1]).getByRole("button", { name: statusAdd })).toBeInTheDocument();
  });
});

describe("PreviewResult loop judge rows", () => {
  const LP = "01HZZZZZZZZZZZZZZZZZZZZZL1";
  const judge = (branch: string, i: number) => ({
    step_id: LP,
    kind: "loop" as const,
    loop_index: i,
    branch,
    request: null,
    response: null,
    extracted: {},
    unbound_vars: [],
    error: null,
  });
  it("loop_rows_show_judge_text_with_loop_name_not_http_shape", () => {
    const p = preview("");
    p.trace!.steps = [p.trace!.steps[0], judge("again", 0), judge("exhausted", 1)];
    render(
      <PreviewResult
        preview={p}
        stepNames={{ [STEP]: "로그인" }}
        loopMeta={{ [LP]: { name: "주문 재시도", maxPasses: 3 } }}
        onAddCondition={vi.fn()}
      />,
    );
    expect(screen.getAllByText("주문 재시도")).toHaveLength(2);
    expect(screen.getByText("1회차")).toBeInTheDocument();
    expect(screen.getByText("조건이 참 → 다시 실행")).toBeInTheDocument();
    expect(screen.getByText("최대 3회 → 이번 반복 종료")).toBeInTheDocument();
    expect(screen.queryByText(LP)).not.toBeInTheDocument();
    // 상태 칸 라벨은 http 행 하나뿐
    expect(screen.getAllByText(ko.monitor.previewStatus)).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: ko.monitor.condAddAria(ko.monitor.condTargetStatus) }),
    ).toHaveLength(1);
  });
  it("loopMeta가 없으면 이름은 step_id", () => {
    const p = preview("");
    p.trace!.steps = [judge("done", 0)];
    render(<PreviewResult preview={p} stepNames={{}} />);
    expect(screen.getByText(LP)).toBeInTheDocument();
  });
});

describe("PreviewResult 보내지 않은 요청", () => {
  const STEP2 = "01HZZZZZZZZZZZZZZZZZZZZZB2";
  it("blocked 스텝은 한국어 문구, 원문은 안 보인다", () => {
    const p = preview("");
    const first = p.trace!.steps[0];
    p.trace!.steps = [
      {
        ...first,
        step_id: STEP2,
        response: null,
        error: "not sent: blank value in url",
        blocked: { vars: ["orderId"], by_step: STEP },
      },
    ];
    render(<PreviewResult preview={p} stepNames={{ [STEP]: "로그인", [STEP2]: "조회" }} />);
    expect(
      screen.getByText("앞 스텝 로그인이(가) orderId 값을 주지 않아 요청을 보내지 않음"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not sent: blank value in url/)).not.toBeInTheDocument();
  });
});

describe("PreviewResult 기본값 사용", () => {
  it("defaulted 스텝에만 「기본값 사용: 이름」 줄이 보인다", () => {
    const p = preview("");
    p.trace!.steps = [{ ...p.trace!.steps[0], defaulted: ["orderId"] }];
    const { unmount } = render(<PreviewResult preview={p} stepNames={{ [STEP]: "로그인" }} />);
    expect(screen.getByText("기본값 사용: orderId")).toBeInTheDocument();
    unmount();
    render(<PreviewResult preview={preview("")} stepNames={{ [STEP]: "로그인" }} />);
    expect(screen.queryByText(/기본값 사용/)).not.toBeInTheDocument();
  });
});

// 누른 `+ 추가` 바로 아래에 선택 상자가 떠야 한다 — 헤더 표 전체 뒤에 뜨면 헤더가 많을 때
// 화면 밖으로 밀려나 "아무 반응이 없다"처럼 보인다(사용자 보고 2026-11-20).
describe("PreviewResult 선택 상자 위치", () => {
  const follows = (a: Node, b: Node) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const HEADERS = { a: "1", "x-trace": "2", z: "3" };

  it("헤더 줄의 + 추가 → 그 줄 바로 다음 줄에 선택 상자", async () => {
    const { user } = setup(preview("", HEADERS));
    const btn = add(ko.monitor.condTargetHeader("x-trace"));
    await user.click(btn);
    const row = btn.closest("tr")!;
    expect(row.nextElementSibling).toContainElement(chooseCond());
    expect(follows(chooseCond(), add(ko.monitor.condTargetHeader("z")))).toBe(true);
  });

  it("상태 코드 + 추가 → 응답 헤더 표보다 앞, 버튼보다 뒤", async () => {
    const { user } = setup(preview("", HEADERS));
    const btn = add(ko.monitor.condTargetStatus);
    await user.click(btn);
    expect(follows(btn, chooseCond())).toBe(true);
    expect(follows(chooseCond(), screen.getByText(ko.monitor.previewHeaders))).toBe(true);
  });

  it("본문 전체 조건 버튼 → 조건 줄이 버튼 뒤", async () => {
    const { user } = setup(preview("plain text", HEADERS));
    const btn = screen.getByRole("button", { name: ko.monitor.condAddBodyText });
    await user.click(btn);
    expect(follows(btn, confirmBtn())).toBe(true);
  });
});
