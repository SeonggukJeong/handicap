import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorChart } from "../components/ErrorChart";
import { markerX } from "../chartModel";
import type { PrintDoc } from "../buildPrintDoc";

const chart = (steady?: { startSec: number; endSec: number }): PrintDoc["chart"] => ({
  durationSec: 60,
  binSeconds: 1,
  bins: [{ startSec: 0, seconds: 1, rps: 10, topErr: 0, otherErr: 0 }],
  topStepId: null,
  hasErrors: false,
  rpsTicks: [0, 10],
  errTicks: [],
  timeTicks: [0, 30, 60],
  markers: [],
  ...(steady ? { steady } : {}),
});

const doc = (c: PrintDoc["chart"]): PrintDoc =>
  ({
    chart: c,
    table: { rows: [] },
    sectionNo: { chart: "3. 시간에 따른 변화" },
    readingLine: "읽는 법",
  }) as unknown as PrintDoc;

describe("ErrorChart steady 점선", () => {
  it("chart.steady가 있으면 data-steady-line 점선 둘이 시작·끝 위치에 선다", () => {
    const { container } = render(<ErrorChart doc={doc(chart({ startSec: 10, endSec: 40 }))} />);
    const lines = [...container.querySelectorAll("line[data-steady-line]")];
    expect(lines).toHaveLength(2);
    expect(Number(lines[0].getAttribute("x1"))).toBeCloseTo(markerX(10, 60), 1);
    expect(Number(lines[1].getAttribute("x1"))).toBeCloseTo(markerX(40, 60), 1);
    for (const l of lines) {
      expect(l.getAttribute("stroke-dasharray")).toBe("3 1.5");
      expect(l.getAttribute("x1")).toBe(l.getAttribute("x2"));
    }
  });

  it("끝 점선은 창의 마지막 구간(bin) 오른쪽 가장자리에 선다", () => {
    const c: PrintDoc["chart"] = {
      ...chart({ startSec: 25, endSec: 60 }),
      bins: [
        { startSec: 58, seconds: 1, rps: 10, topErr: 0, otherErr: 0 },
        { startSec: 59, seconds: 1, rps: 10, topErr: 0, otherErr: 0 },
      ],
    };
    const { container } = render(<ErrorChart doc={doc(c)} />);
    const lines = [...container.querySelectorAll("line[data-steady-line]")];
    const last = c.bins[c.bins.length - 1];
    expect(Number(lines[1].getAttribute("x1"))).toBeCloseTo(
      markerX(last.startSec + last.seconds, c.durationSec),
      1,
    );
  });

  it("chart.steady가 없으면 점선이 없다", () => {
    const { container } = render(<ErrorChart doc={doc(chart())} />);
    expect(container.querySelectorAll("[data-steady-line]")).toHaveLength(0);
  });
});
