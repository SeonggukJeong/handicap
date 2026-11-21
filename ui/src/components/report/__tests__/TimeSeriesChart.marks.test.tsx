import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimeSeriesChart } from "../TimeSeriesChart";
import type { SteadyMarks } from "../steadyMarks";

const dataOf = (secs: number[]) => secs.map((t, i) => ({ ts_second: t, value: i + 1 }));
const ELEVEN = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010];

describe("TimeSeriesChart marks", () => {
  it("marks가 있으면 띠 2개와 세로선 2개를 그린다", () => {
    const marks: SteadyMarks = {
      bands: [
        { kind: "ramp", x1: 0, x2: 3 },
        { kind: "discard", x1: 3, x2: 5 },
      ],
      lines: [
        { kind: "start", x: 5 },
        { kind: "end", x: 9 },
      ],
    };
    const { container } = render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={dataOf(ELEVEN)}
        marks={marks}
        width={400}
        height={200}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(2);
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(2);
  });

  it("marks가 없으면 띠·세로선이 없다", () => {
    const { container } = render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={dataOf([1000, 1001, 1002])}
        width={400}
        height={200}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(0);
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(0);
  });

  it("marks_on_missing_second_are_drawn: 데이터에 없는 초의 세로선·띠도 그려진다", () => {
    const marks: SteadyMarks = {
      bands: [{ kind: "ramp", x1: 0, x2: 5 }],
      lines: [
        { kind: "start", x: 5 },
        { kind: "end", x: 10 },
      ],
    };
    const { container } = render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={dataOf([1000, 1001, 1002, 1010, 1011])}
        marks={marks}
        width={400}
        height={200}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(2);
    expect(container.querySelectorAll(".recharts-reference-area").length).toBe(1);
  });

  it("end_line_after_last_data_point_is_drawn: 끝 세로선이 마지막 데이터 초보다 뒤여도 그려진다", () => {
    const marks: SteadyMarks = {
      bands: [],
      lines: [
        { kind: "start", x: 5 },
        { kind: "end", x: 14 },
      ],
    };
    const { container } = render(
      <TimeSeriesChart
        title="RPS"
        yLabel="req/s"
        data={dataOf(ELEVEN)}
        marks={marks}
        width={400}
        height={200}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(2);
  });
});
