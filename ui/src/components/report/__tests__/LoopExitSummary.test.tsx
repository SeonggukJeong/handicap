import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LoopExitSummary } from "../LoopExitSummary";
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
  truncated: 3,
  retriedStepIds: [],
  rows: [],
  ...over,
});

describe("LoopExitSummary", () => {
  it("한 loop 풀이 줄", () => {
    render(<LoopExitSummary views={[view()]} />);
    expect(screen.getByRole("listitem").textContent).toBe(
      "조건 반복 「주문 재시도」 — 진입 1,200 · 재시도 612 (본문 실행의 33.8%) · 중단 12 · 마치지 못함 3",
    );
  });
  it("truncated 0이면 마치지 못함 없음, exhausted 0도 표시", () => {
    const { rerender } = render(<LoopExitSummary views={[view({ truncated: 0, exhausted: 0 })]} />);
    const li = screen.getByRole("listitem");
    expect(li).not.toHaveTextContent(/마치지 못함/);
    expect(li).toHaveTextContent(/· 중단 0/);
    rerender(<LoopExitSummary views={[view({ truncated: 3 })]} />);
    expect(screen.getByRole("listitem")).toHaveTextContent(/마치지 못함 3/);
  });
  it("두 loop는 두 줄, 묶음은 이름 있는 list", () => {
    render(<LoopExitSummary views={[view(), view({ stepId: "L2", name: "다른" })]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "조건 반복 풀이" })).toBeInTheDocument();
  });
  it("도움말 버튼은 하나이고 네 문장을 보인다", async () => {
    const user = userEvent.setup();
    render(<LoopExitSummary views={[view(), view({ stepId: "L2", name: "다른" })]} />);
    const btns = screen.getAllByRole("button", { name: "조건 반복 풀이 도움말" });
    expect(btns).toHaveLength(1);
    await user.click(btns[0]);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("진입 = ");
    expect(note).toHaveTextContent("재시도 = ");
    expect(note).toHaveTextContent("중단 = ");
    expect(note).toHaveTextContent("마치지 못함 = ");
    // 앞 스텝 값이 없어 반복 안 요청을 못 보내 끝난 경우도 마치지 못함이다(blank-var-url-guard).
    expect(note).toHaveTextContent(
      "앞 스텝 값이 없어 요청을 보내지 못해 조건 반복 도중에 끊긴 횟수.",
    );
  });
  it("빈 배열이면 아무것도 그리지 않는다", () => {
    const { container } = render(<LoopExitSummary views={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
