import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepLatencyRows, StepLatencyTitle } from "../components/StepLatencyAppendix";
import { sparkPath } from "../../report/sparkPath";
import { ko } from "../../i18n/ko";
import type { StepLatModel } from "../stepLatencyAppendix";
import type { ChartModel } from "../chartModel";

const model = (capped: boolean): StepLatModel => {
  const cards = [
    { title: "① 로그인", hasData: true, bins: [10, null, 30] as (number | null)[] },
    { title: "② 조회", hasData: false, bins: [null, null, null] as (number | null)[] },
    { title: "③ 주문", hasData: true, bins: [5, 5, 5] as (number | null)[] },
  ];
  return {
    cards,
    pairs: [
      [cards[0], cards[1]],
      [cards[2], null],
    ],
    yTicks: [0, 20, 40],
    capped,
    points: [1, 3, 5],
  };
};
const chart = { durationSec: 6, timeTicks: [0, 6] } as unknown as ChartModel;

describe("StepLatencyAppendix", () => {
  it("카드 제목·없음 표시·선 경로", () => {
    const { container } = render(
      <StepLatencyRows model={model(false)} chart={chart} from={0} to={2} />,
    );
    expect(screen.getByText("① 로그인")).toBeTruthy();
    expect(screen.getByText(ko.print.stepLat.noData)).toBeTruthy();
    const box = { xMax: 6, yMax: 40, x0: 6, x1: 84, yTop: 2, yBottom: 22 };
    const want = [
      sparkPath(
        [
          { x: 1, y: 10 },
          { x: 3, y: null },
          { x: 5, y: 30 },
        ],
        box,
      ),
      sparkPath(
        [
          { x: 1, y: 5 },
          { x: 3, y: 5 },
          { x: 5, y: 5 },
        ],
        box,
      ),
    ];
    const got = [...container.querySelectorAll("path[data-steplat-line]")].map((p) =>
      p.getAttribute("d"),
    );
    expect(got).toEqual(want);
    expect(container.querySelectorAll("svg").length).toBe(3);
  });
  it("제목 블록: 캡션과 capped 줄", () => {
    const a = render(<StepLatencyTitle model={model(true)} title="부록. X" continued={false} />);
    expect(a.container.textContent).toContain("부록. X");
    expect(a.container.textContent).toContain(ko.print.stepLat.caption("40"));
    expect(a.container.textContent).toContain(ko.print.latencyChart.capped);
    a.unmount();
    const b = render(<StepLatencyTitle model={model(false)} title="부록. X" continued={false} />);
    expect(b.container.textContent).not.toContain(ko.print.latencyChart.capped);
  });
});
