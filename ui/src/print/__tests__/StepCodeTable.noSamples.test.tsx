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
  return { ...r, status: stepStatus(r, null, null) };
};

const p95Cell = (r: RankedRow): string => {
  const { container } = render(<StepTable columns={[]} items={[{ kind: "step", row: r }]} />);
  const cells = container.querySelectorAll("tbody tr td");
  return cells[2].textContent ?? "";
};

describe("StepTable 95% 응답 시간 칸 — 표본이 없는 단계", () => {
  it("요청을 전부 보내지 않은 단계는 「1ms 미만」이 아니라 「–」", () => {
    const text = p95Cell(row({ count: 5, errorCount: 5, notSent: 5, p95Ms: 0 }));
    expect(text).toBe(ko.print.fmt.noTarget);
    expect(text).not.toBe(ko.print.fmt.msUnderOne);
  });

  const noResponse = (n: number) => [{ code: 0, count: n, cls: "counted" as const }];

  // 보냈지만 응답을 못 받은 요청(시간 초과·거부)은 실패까지 걸린 시간을 잰 것이다 — 찍는다.
  it("전부 시간 초과인 단계는 기다린 시간을 찍는다", () => {
    const text = p95Cell(row({ count: 5, errorCount: 5, perCode: noResponse(5), p95Ms: 30000 }));
    expect(text).toBe("30.0초");
  });

  it("전부 곧바로 거부된 단계는 잰 값(1ms 미만)을 찍는다", () => {
    const text = p95Cell(row({ count: 5, errorCount: 5, perCode: noResponse(5), p95Ms: 0 }));
    expect(text).toBe(ko.print.fmt.msUnderOne);
  });

  it("보내지 않음과 응답 없음이 섞였으면 보낸 요청의 시간을 찍는다", () => {
    const text = p95Cell(
      row({ count: 5, errorCount: 5, notSent: 2, perCode: noResponse(3), p95Ms: 120 }),
    );
    expect(text).toBe("0.12초");
  });

  it("응답을 하나라도 받았으면 잰 값을 찍는다", () => {
    const perCode = [...noResponse(4), { code: 200, count: 1, cls: "plain" as const }];
    expect(p95Cell(row({ count: 5, errorCount: 4, perCode, p95Ms: 120 }))).toBe("0.12초");
  });

  it("일부만 보내지 않았으면 잰 값을 찍는다", () => {
    expect(p95Cell(row({ count: 5, errorCount: 2, notSent: 2, p95Ms: 120 }))).toBe("0.12초");
  });

  it("보낸 요청이 1ms 안에 끝났으면 「1ms 미만」 그대로", () => {
    expect(p95Cell(row({ count: 5, p95Ms: 0 }))).toBe(ko.print.fmt.msUnderOne);
  });
});

describe("StepTable 95% 응답 칸 — 「60초 이상」이 두 줄로 접히지 않는다 (라이브: 「60초 이/상」)", () => {
  it("p95 칸 td에 p-nowrap, 열 폭은 「60초 이상」이 들어가는 19mm", () => {
    const { container } = render(
      <StepTable columns={[]} items={[{ kind: "step", row: row({ count: 5, p95Ms: 60000 }) }]} />,
    );
    const cell = container.querySelectorAll("tbody tr td")[2] as HTMLElement;
    expect(cell.textContent).toBe(ko.print.fmt.capSec);
    expect(cell).toHaveClass("p-nowrap");
    const cols = Array.from(container.querySelectorAll("colgroup col")) as HTMLElement[];
    expect(cols[2].style.width).toBe("19mm");
  });
});
