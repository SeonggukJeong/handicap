import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ko } from "../../i18n/ko";
import { StatsPrintTable, StatsTableTitle } from "../components/StatsPrintTable";
import type { StatsModel, StatsRow } from "../statsTable";

const cells = (...v: string[]): string[] => v;
const r = (
  label: string,
  c = cells("31", "52", "47", "71", "88", "140", "402", "19"),
): StatsRow => ({
  label,
  cells: c,
});

const model = (rows: StatsRow[]): StatsModel => ({
  rows,
  total: r("모든 단계", cells("350µs", "52", "41", "98", "120", "310", "1,840", "980")),
  caption: ko.print.stats.caption("통과한 요청"),
  cappedNote: false,
});

const TITLE = "3. 단계별 응답 시간 통계";

describe("StatsPrintTable", () => {
  it("접근 이름은 title, 머리 아홉 칸 글자 == ko.print.stats.cols", () => {
    render(<StatsPrintTable title={TITLE} model={model([r("1 로그인")])} from={0} to={2} />);
    expect(screen.getByRole("table", { name: TITLE })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      ...ko.print.stats.cols,
    ]);
  });

  it("「모든 단계」 행이 마지막, 숫자 칸은 오른쪽 맞춤 표시", () => {
    const { container } = render(
      <StatsPrintTable title={TITLE} model={model([r("1 로그인"), r("2 목록")])} from={0} to={3} />,
    );
    const trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(3);
    expect(trs[2].children[0].textContent).toBe("모든 단계");
    expect(trs[2]).toHaveClass("p-stats-row--total");
    expect(trs[0]).not.toHaveClass("p-stats-row--total");
    expect(trs[2].children[1].textContent).toBe("350µs");
    expect(trs[2].children[7].textContent).toBe("1,840");
    expect(trs[0].children[0]).toHaveClass("p-l");
    expect(trs[0].children[1]).toHaveClass("p-stats-num");
  });

  it("from/to로 자른 조각은 그 행만 그린다(합계 행은 마지막 조각에만)", () => {
    const m = model([r("1 가"), r("2 나"), r("3 다")]);
    const { container, rerender } = render(
      <StatsPrintTable title={TITLE} model={m} from={1} to={2} />,
    );
    let trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(1);
    expect(trs[0].textContent).toContain("2 나");
    rerender(<StatsPrintTable title={TITLE} model={m} from={2} to={4} />);
    trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(2);
    expect(trs[0].textContent).toContain("3 다");
    expect(trs[1].children[0].textContent).toBe("모든 단계");
  });

  it("측정 시트에서는 행마다 data-measure(합계 행 = 마지막 색인)와 머리", () => {
    const { container } = render(
      <StatsPrintTable
        title={TITLE}
        model={model([r("1 가"), r("2 나")])}
        from={0}
        to={3}
        measure
      />,
    );
    for (const i of [0, 1, 2]) {
      expect(container.querySelector(`[data-measure="stats:row:${i}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-measure="stats:row:3"]')).toBeNull();
    expect(container.querySelector('[data-measure="stats:header"]')).not.toBeNull();
  });

  it("「–」 칸은 그대로 대시", () => {
    const { container } = render(
      <StatsPrintTable
        title={TITLE}
        model={model([r("1 가", Array(8).fill(ko.print.fmt.noTarget))])}
        from={0}
        to={1}
      />,
    );
    expect(container.querySelector("tbody tr")!.children[3].textContent).toBe("–");
  });
});

describe("StatsTableTitle", () => {
  it("처음 조각: h2 + 캡션", () => {
    const { container } = render(
      <StatsTableTitle title={TITLE} caption="통과한 요청 기준" continued={false} />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      /^3\. 단계별 응답 시간 통계$/,
    );
    expect(container.querySelector(".p-stats-caption")?.textContent).toBe("통과한 요청 기준");
  });

  it("이어짐 조각: 제목에 (이어짐), 캡션 없음", () => {
    const { container } = render(<StatsTableTitle title={TITLE} caption="x" continued />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      `${TITLE}${ko.print.section.continued}`,
    );
    expect(container.querySelector(".p-stats-caption")).toBeNull();
  });
});
