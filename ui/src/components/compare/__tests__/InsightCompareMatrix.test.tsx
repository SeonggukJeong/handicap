import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InsightCompareMatrix } from "../InsightCompareMatrix";
import type { Insight } from "../../../api/schemas";

function ins(p: Partial<Insight> & { kind: string; severity: string }): Insight {
  return {
    step_id: undefined,
    metric: undefined,
    value: undefined,
    pct: undefined,
    count: undefined,
    status_class: undefined,
    window_seconds: undefined,
    recommended: undefined,
    cause: undefined,
    recommended_workers: undefined,
    onset_second: undefined,
    ...p,
  } as Insight;
}

const stepLabelMap = new Map<string, string>([["s1", "로그인"]]);

describe("InsightCompareMatrix", () => {
  it("run 합집합으로 행을 만들고 미보유 셀은 —", () => {
    const reports = [
      {
        run: { id: "RUNAAAAAA" },
        insights: [
          ins({ kind: "slowest_step", severity: "info", step_id: "s1", value: 120 }),
          ins({
            kind: "status_class",
            severity: "warning",
            status_class: "5xx",
            pct: 0.1,
            count: 3,
          }),
        ],
      },
      {
        run: { id: "RUNBBBBBB" },
        insights: [ins({ kind: "slowest_step", severity: "info", step_id: "s1", value: 90 })],
      },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);

    expect(screen.getByText(/가장 느린 스텝 · 로그인/)).toBeInTheDocument();
    expect(screen.getByText(/상태 코드 비율 · 5xx/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });

  it("numberless 인사이트(slo_pass)는 배지만(수치 없음)", () => {
    const reports = [
      { run: { id: "R1" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText("SLO 통과")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBe(1);
  });

  it("합집합이 비면 빈 상태", () => {
    const reports = [
      { run: { id: "R1" }, insights: [] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText("감지된 인사이트가 없습니다.")).toBeInTheDocument();
  });
});
