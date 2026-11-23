import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepTable } from "../components/StepCodeTable";
import { stepStatus, type RankedRow } from "../stepStatus";
import type { StepRow } from "../stepTable";
import { ko } from "../../i18n/ko";

const row = (over: Partial<StepRow>): RankedRow => {
  const r: StepRow = {
    index: 0,
    no: "1",
    stepId: "s0",
    name: "단계",
    requestLine: null,
    executed: true,
    count: 5,
    errorCount: 0,
    p95Ms: 0,
    perCode: [],
    cells: {},
    residual: 0,
    residualUncertain: false,
    notSent: 0,
    factsKnown: true,
    ...over,
  };
  return { ...r, status: stepStatus(r, null) };
};

const p95Cell = (r: RankedRow): string => {
  const { container } = render(<StepTable columns={[]} items={[{ kind: "step", row: r }]} />);
  const cells = container.querySelectorAll("tbody tr td");
  return cells[2].textContent ?? "";
};

describe("StepTable 95% 응답시간 칸 — 표본이 없는 단계", () => {
  it("요청을 전부 보내지 않은 단계는 「1ms 미만」이 아니라 「–」", () => {
    const text = p95Cell(row({ count: 5, errorCount: 5, notSent: 5, p95Ms: 0 }));
    expect(text).toBe(ko.print.fmt.noTarget);
    expect(text).not.toBe(ko.print.fmt.msUnderOne);
  });

  it("일부만 보내지 않았으면 잰 값을 찍는다", () => {
    expect(p95Cell(row({ count: 5, errorCount: 2, notSent: 2, p95Ms: 120 }))).toBe("0.12초");
  });

  it("보낸 요청이 1ms 안에 끝났으면 「1ms 미만」 그대로", () => {
    expect(p95Cell(row({ count: 5, p95Ms: 0 }))).toBe(ko.print.fmt.msUnderOne);
  });
});
