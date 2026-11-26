import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LatencyChart } from "../components/LatencyChart";
import { sparkPath } from "../../report/sparkPath";
import { ko } from "../../i18n/ko";
import { PLOT_X0_MM, PLOT_X1_MM, markerX } from "../chartModel";
import type { PrintDoc } from "../buildPrintDoc";

const K = ko.print.latencyChart;
const model = (capped: boolean): NonNullable<PrintDoc["latencyChart"]> => ({
  bins: [
    { startSec: 0, seconds: 2, meanMs: 10, p95Ms: 20, capped, observed: true },
    { startSec: 2, seconds: 2, meanMs: null, p95Ms: null, capped: false, observed: true },
    { startSec: 4, seconds: 2, meanMs: 30, p95Ms: 40, capped: false, observed: true },
  ],
  yTicks: [0, 20, 40],
  capped,
  p95Label: K.p95Bin,
  binText: "2초",
});
const doc = (m: PrintDoc["latencyChart"]): PrintDoc =>
  ({
    chart: { durationSec: 6, timeTicks: [0, 6], steady: undefined },
    latencyChart: m,
  }) as unknown as PrintDoc;

const box = { xMax: 6, yMax: 40, x0: PLOT_X0_MM, x1: PLOT_X1_MM, yTop: 8, yBottom: 47 };

describe("LatencyChart", () => {
  it("제목·범례·선 둘", () => {
    const { container } = render(<LatencyChart doc={doc(model(false))} />);
    expect(screen.getByText(K.title)).toBeTruthy();
    expect(screen.getByText(K.mean)).toBeTruthy();
    expect(screen.getByText(K.p95Bin)).toBeTruthy();
    const mean = sparkPath(
      [
        { x: 1, y: 10 },
        { x: 3, y: null },
        { x: 5, y: 30 },
      ],
      box,
    );
    const p95 = sparkPath(
      [
        { x: 1, y: 20 },
        { x: 3, y: null },
        { x: 5, y: 40 },
      ],
      box,
    );
    const swatch = screen.getByText(K.mean).querySelector("i");
    expect(swatch?.classList.contains("p-sw--solid")).toBe(true);
    expect(swatch?.classList.contains("p-sw--line")).toBe(false);
    const paths = [...container.querySelectorAll("path[data-latency-line]")];
    expect(paths.map((p) => p.getAttribute("d"))).toEqual([mean, p95]);
  });
  it("capped면 캡션에 안내, 아니면 없음", () => {
    const a = render(<LatencyChart doc={doc(model(true))} />);
    expect(a.container.textContent).toContain(K.capped);
    a.unmount();
    const b = render(<LatencyChart doc={doc(model(false))} />);
    expect(b.container.textContent).not.toContain(K.capped);
    expect(b.container.textContent).toContain(K.caption("2초"));
  });
  it("chart.steady가 있으면 유지 구간 점선 둘이 시작·끝 칸 경계에", () => {
    const d = {
      chart: { durationSec: 6, timeTicks: [0, 6], steady: { startSec: 2, endSec: 5 } },
      latencyChart: model(false),
    } as unknown as PrintDoc;
    const { container } = render(<LatencyChart doc={d} />);
    const lines = [...container.querySelectorAll("line[data-steady-line]")];
    expect(lines).toHaveLength(2);
    const at = (sec: number) => String(Math.round(markerX(sec, 6) * 100) / 100);
    expect(lines.map((l) => l.getAttribute("x1"))).toEqual([at(2), at(5)]);
    for (const l of lines) {
      expect(l.getAttribute("x2")).toBe(l.getAttribute("x1"));
      expect(l.getAttribute("y1")).toBe("8");
      expect(l.getAttribute("y2")).toBe("47");
      expect(l.getAttribute("stroke-dasharray")).toBe("3 1.5");
    }
  });
  it("chart.steady가 없으면 점선이 없다", () => {
    const { container } = render(<LatencyChart doc={doc(model(false))} />);
    expect(container.querySelectorAll("[data-steady-line]")).toHaveLength(0);
  });
  it("초가 없던 칸(observed false)은 건너뛰어 잇는다", () => {
    const m = model(false);
    m.bins[1] = {
      startSec: 2,
      seconds: 2,
      meanMs: null,
      p95Ms: null,
      capped: false,
      observed: false,
    };
    const { container } = render(<LatencyChart doc={doc(m)} />);
    const mean = sparkPath(
      [
        { x: 1, y: 10 },
        { x: 5, y: 30 },
      ],
      box,
    );
    const p95 = sparkPath(
      [
        { x: 1, y: 20 },
        { x: 5, y: 40 },
      ],
      box,
    );
    const paths = [...container.querySelectorAll("path[data-latency-line]")];
    expect(paths.map((p) => p.getAttribute("d"))).toEqual([mean, p95]);
    expect(mean).not.toMatch(/M.*M/);
  });
});
