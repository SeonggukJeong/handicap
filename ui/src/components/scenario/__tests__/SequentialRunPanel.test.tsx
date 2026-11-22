import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SequentialTrace, StepTrace } from "../../../api/schemas";
import type { Step } from "../../../scenario/model";
import { SequentialRunPanel, defaultExpandedRow } from "../SequentialRunPanel";
import { ko } from "../../../i18n/ko";

function httpStep(url: string, error: string | null = null): StepTrace {
  return {
    step_id: "01HX0000000000000000000010",
    kind: "http",
    loop_index: null,
    branch: null,
    request: { method: "GET", url, headers: {}, body: null },
    response: error
      ? null
      : {
          status: 200,
          latency_ms: 3,
          download_ms: null,
          headers: {},
          set_cookies: [],
          body: "ok",
          body_truncated: false,
        },
    extracted: {},
    unbound_vars: [],
    error,
  };
}
function rowTrace(url: string, ok: boolean) {
  return {
    ok,
    total_ms: 7,
    steps: [httpStep(url, ok ? null : "boom")],
    final_vars: {},
    truncated: false,
    error: null,
  };
}
const seq: SequentialTrace = {
  ok: false,
  truncated: true,
  total_ms: 21,
  rows: [
    { row_index: 0, trace: rowTrace("http://x/a0", true) },
    { row_index: 1, trace: rowTrace("http://x/a1", false) },
    { row_index: 2, trace: rowTrace("http://x/a2", true) },
  ],
};

describe("defaultExpandedRow", () => {
  it("첫 실패 행을 고른다", () => {
    expect(defaultExpandedRow(seq)).toBe(1);
  });
  it("전부 성공이면 첫 행", () => {
    const green = {
      ...seq,
      rows: seq.rows.map((r) => ({ ...r, trace: { ...r.trace, ok: true } })),
    };
    expect(defaultExpandedRow(green)).toBe(0);
  });
  it("빈 rows면 null", () => {
    expect(defaultExpandedRow({ ...seq, rows: [] })).toBeNull();
  });
});

describe("SequentialRunPanel 준비 구간", () => {
  const noop = () => {};
  const S_ID = "01HX0000000000000000000091";
  const steps: Step[] = [
    {
      id: S_ID,
      name: "준비 요청",
      type: "http",
      request: { method: "GET", url: "http://x/setup", headers: {} },
      assert: [],
      extract: [],
    },
  ];
  const setupRow = (error: string | null = null): StepTrace => ({
    ...httpStep("http://x/setup", error),
    step_id: S_ID,
    section: "setup",
  });
  const SETUP_TITLE = "준비 스텝 — 첫 행 앞에 한 번 실행";
  const FAIL = "준비 스텝이 실패해 본 스텝을 실행하지 않았습니다";

  it("준비 행을 행 목록 위에 한 번 보인다", () => {
    render(
      <SequentialRunPanel
        seq={{ ...seq, setup_steps: [setupRow()] }}
        steps={steps}
        requestedRows={3}
        expandedRow={0}
        onExpandRow={noop}
      />,
    );
    const title = screen.getByText(SETUP_TITLE);
    const setupName = screen.getByText("준비 요청");
    expect(
      title.compareDocumentPosition(setupName) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const row1 = screen.getByRole("button", { name: /행 1/ });
    expect(setupName.compareDocumentPosition(row1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("준비 요청")).toHaveLength(1);
  });

  it("준비 목록의 마지막 행은 굵은 구분선만 그리고 얇은 테두리와 겹치지 않는다", () => {
    render(
      <SequentialRunPanel
        seq={{ ...seq, setup_steps: [setupRow()] }}
        steps={steps}
        requestedRows={3}
        expandedRow={null}
        onExpandRow={noop}
      />,
    );
    const li = screen.getByText("준비 요청").closest("li")!;
    expect(li).toHaveClass("border-b-2", "border-accent-200");
    expect(li).not.toHaveClass("border-slate-100");
    for (const el of document.querySelectorAll("*")) {
      expect(el.classList.contains("border-b-2") && el.classList.contains("border-slate-100")).toBe(
        false,
      );
    }
    expect(document.querySelectorAll(".border-accent-200")).toHaveLength(1);
  });

  it("준비가 실패해 행이 없어도 준비 행과 실패 안내가 나온다", () => {
    render(
      <SequentialRunPanel
        seq={{
          ok: false,
          truncated: false,
          total_ms: 3,
          rows: [],
          setup_steps: [setupRow("boom")],
          setup_failed: true,
        }}
        steps={steps}
        requestedRows={3}
        expandedRow={null}
        onExpandRow={noop}
      />,
    );
    expect(screen.getByText(FAIL)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("뒤에 행이 없으면 준비 행 아래에 굵은 구분선을 그리지 않는다", () => {
    render(
      <SequentialRunPanel
        seq={{
          ok: false,
          truncated: false,
          total_ms: 3,
          rows: [],
          setup_steps: [setupRow("boom")],
          setup_failed: true,
        }}
        steps={steps}
        requestedRows={3}
        expandedRow={null}
        onExpandRow={noop}
      />,
    );
    expect(screen.getByText("준비 요청")).toBeInTheDocument();
    expect(document.querySelectorAll(".border-accent-200")).toHaveLength(0);
  });
});

describe("SequentialRunPanel", () => {
  const noop = () => {};
  it("펼친 행의 trace에 ended_by_loop가 있으면 종료 안내가 뜬다", () => {
    const LP = "01HX00000000000000000000L1";
    const steps: Step[] = [
      {
        id: LP,
        name: "주문 재시도",
        type: "loop",
        repeat: 3,
        while: { left: "{{code}}", op: "eq", right: "WAIT" },
        do: [
          {
            id: "01HX0000000000000000000010",
            name: "조회",
            type: "http",
            request: { method: "GET", url: "http://x/a1", headers: {} },
            assert: [],
            extract: [],
          },
        ],
      },
    ];
    // 최대 횟수로 끝난 trace는 그 loop의 exhausted 판정 줄을 항상 갖는다(엔진 trace.rs).
    const base = rowTrace("http://x/a0", true);
    const judge: SequentialTrace["rows"][number]["trace"]["steps"][number] = {
      step_id: LP,
      kind: "loop",
      loop_index: 2,
      branch: "exhausted",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: [],
      error: null,
    };
    const ended: SequentialTrace = {
      ...seq,
      rows: [
        {
          row_index: 0,
          trace: { ...base, steps: [...base.steps, judge], ended_by_loop: LP },
        },
      ],
    };
    render(
      <SequentialRunPanel
        seq={ended}
        steps={steps}
        requestedRows={1}
        expandedRow={0}
        onExpandRow={noop}
      />,
    );
    expect(
      screen.getAllByText(
        "조건 반복 「주문 재시도」이(가) 최대 횟수까지 풀리지 않아 여기서 끝났습니다.",
      ),
    ).toHaveLength(1);
  });
  it("행 목록: 번호(1-based)·✓/✗·ms + truncated 경고 (R13)", () => {
    render(
      <SequentialRunPanel seq={seq} requestedRows={5} expandedRow={null} onExpandRow={noop} />,
    );
    const panel = screen.getByRole("region", { name: ko.editor.seqResultAria });
    expect(within(panel).getByRole("button", { name: /행 1/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /행 2/ })).toBeInTheDocument();
    // truncated: 요청 5행 중 완료 3행
    expect(within(panel).getByText(ko.editor.seqTruncated(5, 3))).toBeInTheDocument();
  });
  it("expandedRow 행만 스텝 렌더 + 클릭 토글 콜백", async () => {
    const user = userEvent.setup();
    const onExpandRow = vi.fn();
    render(
      <SequentialRunPanel seq={seq} requestedRows={3} expandedRow={1} onExpandRow={onExpandRow} />,
    );
    // 펼친 행(행 2)의 스텝 URL 노출, 다른 행 URL 미노출
    expect(screen.getByText(/a1/)).toBeInTheDocument();
    expect(screen.queryByText(/a0/)).not.toBeInTheDocument();
    // 펼친 행 재클릭 → null(접기)
    await user.click(screen.getByRole("button", { name: /행 2/ }));
    expect(onExpandRow).toHaveBeenCalledWith(null);
    // 다른 행 클릭 → 그 행 row_index
    await user.click(screen.getByRole("button", { name: /행 3/ }));
    expect(onExpandRow).toHaveBeenCalledWith(2);
  });
});
