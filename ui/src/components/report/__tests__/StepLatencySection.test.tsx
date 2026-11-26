import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ko } from "../../../i18n/ko";
import type { Report } from "../../../api/schemas";
import { sparkPath } from "../../../report/sparkPath";
import { StepLatencySection } from "../StepLatencySection";

function st(mean_us: number) {
  return {
    min_us: 0,
    mean_us,
    max_us: mean_us,
    stdev_us: 0,
    p50_us: 0,
    p90_us: 0,
    p95_us: 0,
    p99_us: 0,
    capped: false,
  };
}

function rep(capped: boolean): Report {
  return {
    steps: [
      { step_id: "A", stats: st(100000) },
      { step_id: "B", stats: st(80000) },
      { step_id: "C" },
    ],
    windows: [
      { ts_second: 100, step_id: "A", n: 1, mean_us: 287300 },
      { ts_second: 101, step_id: "A", n: 1, mean_us: 100000 },
      { ts_second: 100, step_id: "B", n: 1, mean_us: 120000 },
      { ts_second: 101, step_id: "B", n: 0 },
      { ts_second: 102, step_id: "B", n: 1, mean_us: 60000, ...(capped ? { capped: true } : {}) },
    ],
  } as unknown as Report;
}
const names = new Map([
  ["A", "스텝A"],
  ["B", "스텝B"],
  ["C", "스텝C"],
]);

describe("StepLatencySection", () => {
  it("기본 접힘 → 펼치면 카드·안내·같은 눈금 경로", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <StepLatencySection report={rep(false)} stepNames={names} marks={null} firstTs={100} />,
    );
    const btn = screen.getByRole("button", { name: ko.report.stepLatency.toggle });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("svg").length).toBe(0);
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("svg").length).toBe(3);
    expect(screen.getByTitle("스텝B")).toHaveTextContent("스텝B");
    expect(screen.getByText(/0–300 ms/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.report.stepLatency.viewGrid })).toBeNull();
    expect(screen.getByText(ko.report.stepLatency.noData)).toBeInTheDocument();
    const card = screen.getByTitle("스텝B").parentElement as HTMLElement;
    const d = within(card).getByTestId("spark-line").getAttribute("d");
    expect(d).toBe(
      sparkPath(
        [
          { x: 0, y: 120 },
          { x: 1, y: null },
          { x: 2, y: 60 },
        ],
        { xMax: 2, yMax: 300, x0: 0, x1: 300, yTop: 2, yBottom: 78 },
      ),
    );
  });
  it("capped 창이 있을 때만 hintCapped", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <StepLatencySection report={rep(false)} stepNames={names} marks={null} firstTs={100} />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.stepLatency.toggle }));
    expect(screen.queryByText(ko.report.stepLatency.hintCapped)).toBeNull();
    unmount();
    render(<StepLatencySection report={rep(true)} stepNames={names} marks={null} firstTs={100} />);
    await user.click(screen.getByRole("button", { name: ko.report.stepLatency.toggle }));
    expect(screen.getByText(ko.report.stepLatency.hintCapped)).toBeInTheDocument();
  });
  it("steps가 비면 카드 0개", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <StepLatencySection
        report={{ steps: [], windows: [] } as unknown as Report}
        stepNames={new Map()}
        marks={null}
        firstTs={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.stepLatency.toggle }));
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
  it("안내의 눈금 최댓값은 자리 구분 쉼표 (60000 -> 0–60,000 ms)", async () => {
    const user = userEvent.setup();
    const report = {
      steps: [{ step_id: "A", stats: st(60000000) }],
      windows: [{ ts_second: 100, step_id: "A", n: 1, mean_us: 60000000, capped: true }],
    } as unknown as Report;
    render(
      <StepLatencySection
        report={report}
        stepNames={new Map([["A", "스텝A"]])}
        marks={null}
        firstTs={100}
      />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.stepLatency.toggle }));
    expect(screen.getByText(/0–60,000 ms/)).toBeInTheDocument();
  });
  it("평균이 하나도 없으면 눈금 안내 문장을 그리지 않고 카드는 「응답 시간 없음」", async () => {
    const user = userEvent.setup();
    const report = {
      steps: [{ step_id: "A" }],
      windows: [{ ts_second: 100, step_id: "A", n: 0 }],
    } as unknown as Report;
    render(
      <StepLatencySection
        report={report}
        stepNames={new Map([["A", "스텝A"]])}
        marks={null}
        firstTs={100}
      />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.stepLatency.toggle }));
    expect(screen.queryByText(/같은 세로 눈금/)).toBeNull();
    expect(screen.getByText(ko.report.stepLatency.noData)).toBeInTheDocument();
  });
});
