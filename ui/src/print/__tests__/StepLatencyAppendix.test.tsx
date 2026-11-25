import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepLatencyRows, StepLatencyTitle } from "../components/StepLatencyAppendix";
import { sparkPath } from "../../report/sparkPath";
import { ko } from "../../i18n/ko";
import type { StepLatModel } from "../stepLatencyAppendix";
import { fmtElapsed, type ChartModel } from "../chartModel";

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
    const box = { xMax: 6, yMax: 40, x0: 10, x1: 84, yTop: 2, yBottom: 22 };
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
  it("세로 눈금 글자는 x=9에 끝을 맞추고 기준선은 x0(10)부터", () => {
    const { container } = render(
      <StepLatencyRows model={model(false)} chart={chart} from={0} to={1} />,
    );
    const ys = [...container.querySelectorAll("svg text")].filter((t) =>
      ["3", "22.5"].includes(t.getAttribute("y") ?? ""),
    );
    expect(ys.length).toBe(4);
    for (const t of ys) {
      expect(t.getAttribute("x")).toBe("9");
      expect(t.getAttribute("text-anchor")).toBe("end");
    }
    expect(container.querySelector("svg line")?.getAttribute("x1")).toBe("10");
  });
  it("오른쪽 끝(8mm 안) 시간 눈금은 끝 맞춤", () => {
    const c90 = { durationSec: 90, timeTicks: [0, 30, 60, 90] } as unknown as ChartModel;
    const { container } = render(
      <StepLatencyRows model={model(false)} chart={c90} from={0} to={1} />,
    );
    const first = container.querySelector("svg")!;
    const last = [...first.querySelectorAll("text")].find((t) => t.textContent === fmtElapsed(90))!;
    expect(last.getAttribute("text-anchor")).toBe("end");
    expect(last.getAttribute("x")).toBe("84");
    const mid = [...first.querySelectorAll("text")].find((t) => t.textContent === fmtElapsed(30))!;
    expect(mid.getAttribute("text-anchor")).toBe("middle");
  });
  it("끝 시각이 아닌 눈금은 8mm 안이어도 제 자리에서 가운데 맞춤 (330초, 눈금 300)", () => {
    const c330 = {
      durationSec: 330,
      timeTicks: [0, 60, 120, 180, 240, 300],
    } as unknown as ChartModel;
    const { container } = render(
      <StepLatencyRows model={model(false)} chart={c330} from={0} to={1} />,
    );
    const t300 = [...container.querySelector("svg")!.querySelectorAll("text")].find(
      (t) => t.textContent === fmtElapsed(300),
    )!;
    expect(t300.getAttribute("text-anchor")).toBe("middle");
    expect(t300.getAttribute("x")).toBe(String(Math.round((10 + (300 / 330) * 74) * 100) / 100));
  });
});
