import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VerdictBadge } from "../VerdictBadge";
import type { Verdict } from "../../api/schemas";
import { ko } from "../../i18n/ko";

const FAIL_VERDICT: Verdict = {
  passed: false,
  criteria: [
    { metric: "p95_ms", direction: "max", threshold: 300, actual: 420, passed: false },
    { metric: "error_rate", direction: "max", threshold: 0.01, actual: 0.05, passed: false },
    { metric: "rps", direction: "min", threshold: 100, actual: 200, passed: true },
  ],
};

describe("VerdictBadge", () => {
  it("renders — for null/undefined", () => {
    render(<VerdictBadge verdict={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("PASS는 비인터랙티브 span (버튼 아님)", () => {
    render(<VerdictBadge verdict={{ passed: true, criteria: [] }} />);
    expect(screen.getByText(ko.report.verdictPass)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("FAIL 클릭 시 미달 기준만 포맷되어 popover로 열린다 (fmt/METRIC_LABEL 공유)", async () => {
    const user = userEvent.setup();
    render(<VerdictBadge verdict={FAIL_VERDICT} />);
    const btn = screen.getByRole("button", { name: ko.report.verdictFail });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn).not.toHaveAttribute("title"); // hover 전용 title 제거(§7.5)
    await user.click(btn);
    const note = screen.getByRole("note");
    // METRIC_LABEL 적용(p95_ms→p95) + fmt 값 포맷 + 통과 기준(rps) 제외
    expect(note).toHaveTextContent("p95 420 ms > 300 ms");
    expect(note).toHaveTextContent("Error rate 5.00% > 1.00%");
    expect(note).not.toHaveTextContent("RPS");
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("ESC와 외부 클릭으로 닫힌다", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <VerdictBadge verdict={FAIL_VERDICT} />
        <button type="button">outside</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: ko.report.verdictFail }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(screen.getByRole("button", { name: ko.report.verdictFail }));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
