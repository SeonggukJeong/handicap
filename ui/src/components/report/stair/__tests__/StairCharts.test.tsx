import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type StairReport } from "../../../../api/schemas";
import { StairCurveChart } from "../StairCurveChart";
import { StairBandChart } from "../StairBandChart";
import { buildBandSeries } from "../stairBandSeries";
import { StairResultSection } from "../StairResultSection";
import { ko } from "../../../../i18n/ko";

const golden = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);
const mk = (): StairReport => structuredClone(golden);
const c = ko.report.stair.chart;

function dots(container: HTMLElement) {
  return Array.from(container.querySelectorAll<SVGElement>('[data-testid="stair-dot"]'));
}

describe("StairCurveChart", () => {
  it("점 개수 = 측정된 계단 수, 상태별 색, knee 고리 1개", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    const d = dots(container);
    expect(d).toHaveLength(7);
    const byState = (s: string) => d.filter((e) => e.getAttribute("data-state") === s);
    expect(byState("ok")).toHaveLength(4);
    expect(byState("saturated")).toHaveLength(2);
    expect(byState("ok")[0].getAttribute("fill")).toBe("#10b981");
    expect(byState("spike")[0].getAttribute("fill")).toBe("#f59e0b");
    expect(byState("saturated")[0].getAttribute("fill")).toBe("#ef4444");
    expect(container.querySelectorAll('[data-testid="stair-knee"]')).toHaveLength(1);
  });

  it("측정 안 된 계단은 점을 그리지 않는다", () => {
    const st = mk();
    st.steps[5] = { ...st.steps[5], state: "not_measured", p99_us: 0, p50_us: 0 };
    const { container } = render(<StairCurveChart steps={st.steps} width={600} height={260} />);
    expect(dots(container)).toHaveLength(6);
  });

  it("점 라벨 「튐」「포화」와 달성률 줄, 범례", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    expect(container.textContent).toContain(c.labelSpike);
    expect(container.textContent).toContain(c.labelSaturated);
    expect(container.textContent).toContain(c.labelKnee);
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByText(c.legendP99)).toBeInTheDocument();
    expect(screen.getByText(c.legendP50)).toBeInTheDocument();
  });

  it("포화 지점부터 옅은 빨강 배경 1개", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    expect(container.querySelectorAll(".recharts-reference-area-rect")).toHaveLength(1);
  });
});

describe("StairBandChart", () => {
  it("띠 rect 수 = bands 수, 목표선 path 존재, 범례", () => {
    const { container } = render(
      <StairBandChart
        seconds={golden.seconds}
        bands={golden.bands}
        targetLine={golden.target_line}
        steps={golden.steps}
        width={800}
        height={300}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-area-rect")).toHaveLength(
      golden.bands.length,
    );
    expect(container.querySelector(".stair-target-line .recharts-line-curve")).not.toBeNull();
    expect(screen.getByText(c.legendTarget)).toBeInTheDocument();
    expect(screen.getByText(c.legendLaunched)).toBeInTheDocument();
    expect(screen.getByText(c.legendP99Right)).toBeInTheDocument();
  });

  it("count 0 초에는 p99 점이 없다", () => {
    const { container } = render(
      <StairBandChart
        seconds={golden.seconds}
        bands={golden.bands}
        targetLine={golden.target_line}
        steps={golden.steps}
        width={800}
        height={300}
      />,
    );
    const nonEmpty = golden.seconds.filter((s) => s.count > 0).length;
    expect(nonEmpty).toBeLessThan(golden.seconds.length);
    expect(container.querySelectorAll('[data-testid="stair-p99-dot"]')).toHaveLength(nonEmpty);
  });

  it("buildBandSeries: count 0·빠진 초의 p99는 null(보간 없음)", () => {
    const rows = buildBandSeries([
      { offset_s: 0, launched: 10, count: 5, p99_us: 2000 },
      { offset_s: 1, launched: 10, count: 0, p99_us: 0 },
      { offset_s: 3, launched: 10, count: 5, p99_us: 4000 },
    ]);
    expect(rows.map((r) => r.p99_ms)).toEqual([2, null, null, 4]);
    expect(rows[2].launched).toBeNull();
  });
});

describe("StairResultSection 차트 배치", () => {
  it("머리말 → 곡선 → 표 → 띠 순서", () => {
    render(<StairResultSection stair={golden} />);
    const curve = screen.getByRole("img", { name: c.curveLabel });
    const table = screen.getByRole("table", { name: "계단 표" });
    const band = screen.getByRole("img", { name: c.bandLabel });
    const pos = (a: Node, b: Node) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(pos(curve, table)).toBeTruthy();
    expect(pos(table, band)).toBeTruthy();
  });
});
