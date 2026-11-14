import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoopExitPanel } from "../LoopExitPanel";
import type { LoopExitView, LoopExitRow } from "../loopExitView";

const row = (kind: LoopExitRow["kind"], pass: number | null, count: number): LoopExitRow => ({
  kind,
  pass,
  count,
  pct: (count / 1200) * 100,
});

const view = (over: Partial<LoopExitView> = {}): LoopExitView => ({
  stepId: "L1",
  name: "주문 재시도",
  maxPasses: 5,
  entered: 1200,
  passes: 1812,
  retries: 612,
  retryPct: 33.77,
  exhausted: 12,
  truncated: 3,
  retriedStepIds: [],
  rows: [
    row("first", 1, 816),
    row("retried", 2, 240),
    row("retried", 3, 114),
    row("retried", 5, 12),
    row("retried", null, 3),
    row("exhausted", null, 12),
    row("truncated", null, 3),
  ],
  ...over,
});

describe("LoopExitPanel", () => {
  it("섹션·소제목", () => {
    render(<LoopExitPanel views={[view()]} />);
    expect(screen.getByRole("region", { name: "조건 반복 회차 분포" })).toBeInTheDocument();
    expect(
      screen.getByText("「주문 재시도」 — 진입 1,200회가 몇 번째 시도에서 끝났나"),
    ).toBeInTheDocument();
  });

  it("줄 라벨 순서", () => {
    render(<LoopExitPanel views={[view()]} />);
    expect(screen.getAllByTestId("loop-exit-row-label").map((e) => e.textContent)).toEqual([
      "1번째",
      "2번째",
      "3번째",
      "5번째",
      "21번째 이후",
      "중단",
      "마치지 못함",
    ]);
  });

  it("값 글자와 막대 접근 이름", () => {
    render(<LoopExitPanel views={[view()]} />);
    expect(screen.getByText("816 · 68.0%")).toBeInTheDocument();
    const bars = screen.getAllByRole("img");
    expect(bars[0]).toHaveAttribute("aria-label", "1번째, 재시도 없이 끝남, 816건, 68.0%");
    expect(bars[1]).toHaveAttribute("aria-label", "2번째, 재시도 후 끝남, 240건, 20.0%");
    expect(bars[5]).toHaveAttribute("aria-label", "중단, 12건, 1.0%");
    expect(bars[6]).toHaveAttribute("aria-label", "마치지 못함, 3건, 0.3%");
  });

  it("막대 채움 폭", () => {
    render(<LoopExitPanel views={[view()]} />);
    const bars = screen.getAllByRole("img");
    const w = (i: number) => parseFloat((bars[i].firstElementChild as HTMLElement).style.width);
    expect(w(0)).toBeCloseTo(68, 5);
    expect(w(1)).toBeCloseTo(20, 5);
  });

  it("중단·마치지 못함 풀이", () => {
    const { rerender } = render(<LoopExitPanel views={[view()]} />);
    expect(
      screen.getByText("최대 5번까지 조건이 풀리지 않아 이번 반복을 끝냄"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("run이 끝나거나 중지되어, 또는 오류로 조건 반복 도중에 끊김"),
    ).toBeInTheDocument();
    rerender(<LoopExitPanel views={[view({ maxPasses: null })]} />);
    expect(
      screen.getByText("최대 횟수까지 조건이 풀리지 않아 이번 반복을 끝냄"),
    ).toBeInTheDocument();
  });

  it("범례는 그 run에 있는 분류만", () => {
    const { container, rerender } = render(<LoopExitPanel views={[view()]} />);
    const legend = () =>
      Array.from(container.querySelectorAll("ul > li")).map((e) => e.textContent);
    expect(legend()).toEqual([
      "1번째 = 재시도 없이 끝남",
      "2번째 이후 = 재시도 후 끝남",
      "중단",
      "마치지 못함",
    ]);
    rerender(<LoopExitPanel views={[view({ rows: [row("first", 1, 1200)] })]} />);
    expect(legend()).toEqual(["1번째 = 재시도 없이 끝남"]);
  });

  it("네 분류의 채움 색이 서로 다르다", () => {
    render(<LoopExitPanel views={[view()]} />);
    const bars = screen.getAllByRole("img");
    const color = (i: number) => (bars[i].firstElementChild as HTMLElement).style.backgroundColor;
    const colors = new Set([color(0), color(1), color(5), color(6)]);
    expect(colors.size).toBe(4);
    expect(color(0)).not.toBe("");
  });

  it("막대 색은 막대 바탕(slate-100) 대비 3:1 이상이고 분류끼리 서로 다르다", () => {
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
    const track = lum([241, 245, 249]);
    const contrast = (rgb: number[]) => {
      const l = lum(rgb);
      return (Math.max(l, track) + 0.05) / (Math.min(l, track) + 0.05);
    };
    render(<LoopExitPanel views={[view()]} />);
    const bars = screen.getAllByRole("img");
    const fills = [0, 1, 5, 6].map(
      (i) => (bars[i].firstElementChild as HTMLElement).style.backgroundColor,
    );
    for (const f of fills) {
      expect(parse(f)).toHaveLength(3);
      expect(contrast(parse(f))).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(fills).size).toBe(4);
  });

  it("빈 views는 아무것도 안 그린다", () => {
    const { container } = render(<LoopExitPanel views={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
