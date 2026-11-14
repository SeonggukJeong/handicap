import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoopRetryNotice } from "../LoopRetryNotice";
import type { LoopExitView } from "../loopExitView";

const view = (over: Partial<LoopExitView> = {}): LoopExitView => ({
  stepId: "L1",
  name: "주문 재시도",
  maxPasses: 5,
  entered: 1200,
  passes: 1812,
  retries: 612,
  retryPct: 33.77,
  exhausted: 12,
  truncated: 0,
  retriedStepIds: [],
  rows: [],
  ...over,
});

const TAIL = "해당 스텝과 전체 응답 시간·초당 요청 수에는 재시도 응답이 포함돼 있습니다.";

describe("LoopRetryNotice", () => {
  it("재시도 + 중단 줄", () => {
    render(<LoopRetryNotice views={[view()]} />);
    const region = screen.getByRole("region", { name: "조건 반복 해석 주의" });
    expect(region).toHaveTextContent("해석 주의 · 조건 반복의 재시도가 섞여 있습니다");
    expect(screen.getByRole("listitem").textContent).toBe(
      "「주문 재시도」: 본문 실행 1,812회 중 612회(33.8%)가 재시도 · 최대 횟수에 걸려 중단된 반복 12건",
    );
    expect(region).toHaveTextContent(TAIL);
  });

  it("중단 0이면 중단 문구 없음", () => {
    const { rerender } = render(<LoopRetryNotice views={[view({ exhausted: 0 })]} />);
    expect(screen.getByRole("listitem")).not.toHaveTextContent(/최대 횟수에 걸려/);
    rerender(<LoopRetryNotice views={[view()]} />);
    expect(screen.getByRole("listitem")).toHaveTextContent(/최대 횟수에 걸려 중단된 반복 12건/);
  });

  it("repeat: 1 — 중단만, 꼬리 없음", () => {
    render(
      <LoopRetryNotice
        views={[
          view({
            name: "X",
            maxPasses: 1,
            entered: 100,
            passes: 100,
            retries: 0,
            retryPct: 0,
            exhausted: 5,
          }),
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: "조건 반복 해석 주의" });
    expect(region).toHaveTextContent("해석 주의 · 최대 횟수에서 중단된 조건 반복이 있습니다");
    expect(screen.getByRole("listitem").textContent).toBe(
      "「X」: 최대 횟수에 걸려 중단된 반복 5건",
    );
    expect(region).not.toHaveTextContent(TAIL);
  });

  it("대상 5개 → 줄 3개 + 외 2개", () => {
    const vs = [1, 2, 3, 4, 5].map((i) =>
      view({ stepId: `L${i}`, name: `n${i}`, retryPct: 10 * i, retries: i }),
    );
    render(<LoopRetryNotice views={vs} />);
    const items = screen.getAllByRole("listitem").map((e) => e.textContent ?? "");
    expect(items).toHaveLength(4);
    expect(items[0]).toContain("「n5」");
    expect(items[1]).toContain("「n4」");
    expect(items[2]).toContain("「n3」");
    expect(items[3]).toBe("외 2개 조건 반복");
  });

  it("대상 0개면 아무것도 안 그린다", () => {
    const { container } = render(
      <LoopRetryNotice views={[view({ retries: 0, retryPct: 0, exhausted: 0 })]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
