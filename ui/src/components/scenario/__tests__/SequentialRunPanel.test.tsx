import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SequentialTrace, StepTrace } from "../../../api/schemas";
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

describe("SequentialRunPanel", () => {
  const noop = () => {};
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
