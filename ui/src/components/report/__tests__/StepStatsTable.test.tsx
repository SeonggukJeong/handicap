import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { StepStatsTable } from "../StepStatsTable";
import { ko } from "../../../i18n/ko";

describe("StepStatsTable", () => {
  it("renders rows for each step with metadata when available", () => {
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 100,
            error_count: 2,
            status_counts: { "200": 98, "500": 2 },
            p50_ms: 10,
            p95_ms: 50,
            p99_ms: 90,
            loop_breakdown: [],
          },
          {
            step_id: "stepB",
            count: 50,
            error_count: 0,
            status_counts: { "200": 50 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
            loop_breakdown: [],
          },
        ]}
        meta={meta}
      />,
    );
    const region = screen.getByRole("region", { name: /스텝별 통계/ });
    expect(region).toHaveTextContent("login");
    expect(region).toHaveTextContent("POST");
    expect(region).toHaveTextContent("http://x/login");
    expect(region).toHaveTextContent("100");
    expect(region).toHaveTextContent("stepB"); // missing meta → falls back to id
  });

  it("shows a per-loop drill-down when a step has loop_breakdown", async () => {
    const user = userEvent.setup();
    const steps = [
      {
        step_id: "s",
        count: 6,
        error_count: 0,
        status_counts: { "200": 6 },
        p50_ms: 1,
        p95_ms: 2,
        p99_ms: 3,
        loop_breakdown: [
          { loop_index: 0, count: 3, error_count: 0 },
          { loop_index: 1, count: 2, error_count: 0 },
          { loop_index: null, count: 1, error_count: 0 },
        ],
      },
    ];
    const meta = new Map([["s", { id: "s", name: "tick", method: "GET", url: "/items" }]]);
    render(<StepStatsTable steps={steps as never} meta={meta} />);
    expect(screen.queryByText(/loop_index/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /tick|expand|loop/i }));
    // After expand: the drill-down table header and rows should appear
    expect(screen.getByText(/그 외|상한 초과|overflow/i)).toBeInTheDocument();
    // loop_index column header appears only when expanded (wire field name — R3 keep)
    expect(screen.getByText("loop_index")).toBeInTheDocument();
    // 드릴다운 서브테이블 헤더도 ko 카탈로그 경유(영어 requests/errors 잔존 금지, R1)
    expect(screen.getAllByText(ko.report.colRequests).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(ko.report.colErrors).length).toBeGreaterThanOrEqual(2);
  });

  it("renders no drill-down caret when loop_breakdown is empty", () => {
    const steps = [
      {
        step_id: "s",
        count: 6,
        error_count: 0,
        status_counts: {},
        p50_ms: 1,
        p95_ms: 2,
        p99_ms: 3,
        loop_breakdown: [],
      },
    ];
    render(<StepStatsTable steps={steps as never} meta={new Map()} />);
    expect(screen.queryByRole("button", { name: /루프 분해 표시 전환/ })).not.toBeInTheDocument();
  });

  it("shows download columns only when a step has download", () => {
    const emptyMeta = new Map<string, { id: string; name: string; method: string; url: string }>();
    const { rerender } = render(
      <StepStatsTable
        steps={[
          {
            step_id: "s1",
            count: 1,
            error_count: 0,
            status_counts: {},
            p50_ms: 5,
            p95_ms: 9,
            p99_ms: 9,
          },
        ]}
        meta={emptyMeta}
      />,
    );
    expect(screen.queryByText(/다운로드 p50/)).toBeNull();
    rerender(
      <StepStatsTable
        steps={[
          {
            step_id: "s1",
            count: 1,
            error_count: 0,
            status_counts: {},
            p50_ms: 5,
            p95_ms: 9,
            p99_ms: 9,
            download: { count: 1, p50_ms: 3, p95_ms: 7, p99_ms: 7, max_ms: 8 },
          },
        ]}
        meta={emptyMeta}
      />,
    );
    expect(screen.getByText(/다운로드 p50/)).toBeInTheDocument();
    // Download column headers include "ms" unit (consistency with p50 ms / p95 ms / p99 ms)
    expect(screen.getByText("다운로드 p50 ms")).toBeInTheDocument();
    expect(screen.getByText("다운로드 p95 ms")).toBeInTheDocument();
    expect(screen.getByText("다운로드 p99 ms")).toBeInTheDocument();
  });

  it("표 헤더가 한국어이고 p50/p95/p99에 용어 도움말이 있다", async () => {
    const user = userEvent.setup();
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 10,
            error_count: 0,
            status_counts: { "200": 10 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
            loop_breakdown: [],
          },
        ]}
        meta={meta}
      />,
    );
    expect(screen.getAllByText("스텝").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("메서드")).toBeInTheDocument();
    expect(screen.getByText("요청 수")).toBeInTheDocument();
    expect(screen.getByText("에러")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "p95 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("95%");
  });
});
