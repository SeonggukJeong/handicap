import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type StairReport } from "../../../../api/schemas";
import { StairCurveChart } from "../StairCurveChart";
import { StairBandChart } from "../StairBandChart";
import { buildBandSeries } from "../stairBandSeries";
import { StairResultSection } from "../StairResultSection";
import { ko } from "../../../../i18n/ko";
import { STAIR_STATE_COLOR } from "../stairColors";
import { stateLabel } from "../stairFormat";

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

  it("가장 높은 점이 위 테두리(y=28)에서 떨어져 라벨이 plot 안에 든다", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    const cys = dots(container).map((e) => Number(e.getAttribute("cy")));
    expect(Math.min(...cys)).toBeGreaterThan(28 + 10);
  });

  it("50계단이면 의미 있는 점(knee·상태 전환 첫 점·최대)에만 라벨, 6계단은 전부", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...golden.steps[0],
      index: i,
      target: i + 2,
      state: (i >= 30 ? "saturated" : "ok") as StairReport["steps"][number]["state"],
      knee: i === 20,
      p99_us: (10 + i) * 1000,
      p50_us: 5000,
    }));
    const big = render(<StairCurveChart steps={many} width={900} height={260} />);
    const pointTexts = (c: HTMLElement) =>
      Array.from(c.querySelectorAll("text")).filter((t) => t.getAttribute("fill") === "#334155");
    const texts = pointTexts(big.container);
    expect(dots(big.container)).toHaveLength(50);
    expect(texts).toHaveLength(3);
    const small = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    expect(pointTexts(small.container)).toHaveLength(7);
  });

  it("세로축 제목은 svg 밖 가로 캡션, 회전 축 라벨 없음, 점 라벨은 흰 테두리", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    const cap = screen.getByText(c.axisMs);
    expect(cap.closest("svg")).toBeNull();
    expect(container.querySelector('text[transform*="rotate"]')).toBeNull();
    const label = Array.from(container.querySelectorAll("text")).find(
      (t) => t.getAttribute("fill") === "#334155",
    );
    expect(label?.getAttribute("stroke")).toBe("#ffffff");
    expect(label?.getAttribute("paint-order")).toBe("stroke");
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

  it("가로축 단위 라벨 「목표 (req/s)」", () => {
    const { container } = render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    const texts = Array.from(container.querySelectorAll("svg text")).map((e) => e.textContent);
    expect(texts).toContain(c.axisTarget);
  });

  it("확인 못 한 실패 점은 「확인 못 함」 라벨 + 속 빈 점(튄 계단과 구별)", () => {
    const st = mk();
    st.steps[5] = { ...st.steps[5], state: "unconfirmed" };
    st.steps[6] = { ...st.steps[6], state: "not_measured" };
    const { container } = render(<StairCurveChart steps={st.steps} width={600} height={260} />);
    expect(c.labelUnconfirmed).toBe("확인 못 함");
    const svgText = Array.from(container.querySelectorAll("svg text")).map((e) => e.textContent);
    expect(svgText.some((t) => t?.includes(c.labelUnconfirmed))).toBe(true);
    expect(svgText.some((t) => t?.includes(c.labelSpike))).toBe(true);
    const un = dots(container).find((e) => e.getAttribute("data-state") === "unconfirmed")!;
    const spike = dots(container).find((e) => e.getAttribute("data-state") === "spike")!;
    expect(un.getAttribute("fill")).toBe("#ffffff");
    expect(un.getAttribute("stroke")).toBe(STAIR_STATE_COLOR.unconfirmed);
    expect(spike.getAttribute("fill")).toBe(STAIR_STATE_COLOR.spike);
  });

  it("점 색 범례: 정상·튄 계단·포화·확인 못 한 실패", () => {
    render(<StairCurveChart steps={golden.steps} width={600} height={260} />);
    const legend = screen.getByRole("list", { name: c.legendStatesLabel });
    for (const s of ["ok", "spike", "saturated"] as const) {
      const item = within(legend).getByText(stateLabel(s)).closest("li")!;
      const sw = item.querySelector('span[aria-hidden="true"]') as HTMLElement;
      expect(sw).toHaveStyle({ backgroundColor: STAIR_STATE_COLOR[s] });
    }
    const un = within(legend).getByText(stateLabel("unconfirmed")).closest("li")!;
    const unSw = un.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(unSw).toHaveStyle({ borderColor: STAIR_STATE_COLOR.unconfirmed });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(4);
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

  it("가장 높은 1초 p99 점이 위 테두리(y=8)에서 떨어져 그려진다", () => {
    const seconds = golden.seconds.map((x, i) =>
      i === 3 ? { ...x, count: 5, p99_us: 5_300_000 } : x,
    );
    const { container } = render(
      <StairBandChart
        seconds={seconds}
        bands={golden.bands}
        targetLine={golden.target_line}
        steps={golden.steps}
        width={800}
        height={300}
      />,
    );
    const cys = Array.from(container.querySelectorAll('[data-testid="stair-p99-dot"]'), (e) =>
      Number(e.getAttribute("cy")),
    );
    expect(Math.min(...cys)).toBeGreaterThan(8 + 10);
  });

  it("세로축 제목 두 개는 svg 밖 가로 캡션, 회전 축 라벨 없음", () => {
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
    expect(screen.getByText(c.axisRps).closest("svg")).toBeNull();
    expect(screen.getByText(c.axisP99).closest("svg")).toBeNull();
    expect(container.querySelector('text[transform*="rotate"]')).toBeNull();
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
