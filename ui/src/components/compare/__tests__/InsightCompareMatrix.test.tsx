import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InsightCompareMatrix } from "../InsightCompareMatrix";
import type { Insight } from "../../../api/schemas";
import { runColor, runShortLabel } from "../../../compare/runLabel";
import { ko } from "../../../i18n/ko";

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
    expect(screen.getByText("정보")).toBeInTheDocument(); // slo_pass severity=info → Korean badge
  });

  it("합집합이 비면 빈 상태", () => {
    const reports = [
      { run: { id: "R1" }, insights: [] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText("감지된 인사이트가 없습니다.")).toBeInTheDocument();
  });

  it("헤더 라벨은 labels 미주입 시 runShortLabel로 수렴 (인라인 slice 제거, R5)", () => {
    const reports = [
      { run: { id: "RUNAAAAAA" }, insights: [] },
      { run: { id: "RUNBBBBBB" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText(runShortLabel("RUNAAAAAA"))).toBeInTheDocument();
    expect(screen.getByText(runShortLabel("RUNBBBBBB"))).toBeInTheDocument();
  });

  it("각 run 헤더에 색 스와치(runColor[i])", () => {
    const reports = [
      { run: { id: "RUNAAAAAA" }, insights: [ins({ kind: "slo_pass", severity: "info" })] },
      { run: { id: "RUNBBBBBB" }, insights: [] },
    ];
    const { container } = render(
      <InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />,
    );
    const swatches = container.querySelectorAll('thead span[aria-hidden="true"]');
    expect(swatches).toHaveLength(2);
    expect(swatches[0]).toHaveStyle({ backgroundColor: runColor(0) });
    expect(swatches[1]).toHaveStyle({ backgroundColor: runColor(1) });
  });

  it("섹션 mt-8 통째-교체 lockstep", () => {
    const reports = [
      { run: { id: "R1" }, insights: [] },
      { run: { id: "R2" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByRole("region", { name: ko.insightCompare.title }).className).toBe("mt-8");
  });

  it("nonzero<0.05% pct는 '<0.1%'로 floor (R5)", () => {
    const reports = [
      {
        run: { id: "RUNAAAAAA" },
        insights: [
          ins({
            kind: "status_class",
            severity: "warning",
            status_class: "5xx",
            pct: 0.0003,
            count: 1,
          }),
        ],
      },
      { run: { id: "RUNBBBBBB" }, insights: [] },
    ];
    render(<InsightCompareMatrix reports={reports} stepLabelMap={stepLabelMap} />);
    expect(screen.getByText(/<0\.1%/)).toBeInTheDocument();
  });
});
