import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Verdict } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { VerdictBadge } from "../../VerdictBadge";
import { VerdictPanel } from "../VerdictPanel";

const NO_SAMPLE: Verdict = {
  passed: false,
  criteria: [
    {
      metric: "p95_ms",
      direction: "max",
      threshold: 3000,
      actual: 0,
      passed: false,
      no_sample: true,
    },
    { metric: "error_rate", direction: "max", threshold: 0.01, actual: 1, passed: false },
  ],
};

describe("판정 표시 — 통과한 요청이 없는 기준", () => {
  it("판정 표: 실측 칸은 「통과한 요청 없음」이고 0 ms는 어디에도 없다", () => {
    render(<VerdictPanel verdict={NO_SAMPLE} />);
    expect(screen.getByText("통과한 요청 없음")).toBeInTheDocument();
    expect(screen.getByText(ko.report.sample.noSample)).toBeInTheDocument();
    expect(screen.queryByText("0 ms")).not.toBeInTheDocument();
    expect(screen.getByText("100.00%")).toBeInTheDocument();
  });

  it("판정 배지 툴팁: 「통과한 요청 없음」이고 0 ms는 없다", async () => {
    const user = userEvent.setup();
    render(<VerdictBadge verdict={NO_SAMPLE} />);
    await user.click(screen.getByRole("button", { name: ko.report.verdictFail }));
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("p95 통과한 요청 없음");
    expect(note).not.toHaveTextContent("0 ms");
    expect(note).toHaveTextContent("Error rate 100.00% > 1.00%");
  });

  it("no_sample이 없는 행은 지금처럼 숫자", () => {
    render(
      <VerdictPanel
        verdict={{
          passed: true,
          criteria: [
            { metric: "p95_ms", direction: "max", threshold: 500, actual: 300, passed: true },
          ],
        }}
      />,
    );
    expect(screen.getByText("300 ms")).toBeInTheDocument();
    expect(screen.queryByText("통과한 요청 없음")).not.toBeInTheDocument();
  });
});
