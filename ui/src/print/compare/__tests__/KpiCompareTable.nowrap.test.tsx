import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { ko } from "../../../i18n/ko";
import type { CompareDoc } from "../buildCompareDoc";
import type { MetricRow } from "../change";
import { KpiCompareTable } from "../components/KpiCompareTable";

const cutRow: MetricRow = {
  key: "max_ms",
  name: "최대 응답 시간",
  hint: "",
  before: 1840,
  after: 60000,
  beforeText: "1,840ms",
  afterText: "60초 이상",
  cls: "worse",
  major: false,
  standardOnly: false,
  isNew: false,
  pct: null,
  arrow: "▲",
  changeText: ko.print.cmp.change.cutNoPct,
  wordText: "나빠짐",
  barBefore: 0.03,
  barAfter: 1,
};
const doc = { rows: [cutRow] } as unknown as CompareDoc;

const css = readFileSync(nodePath.resolve(__dirname, "../../print.css"), "utf8");

describe("비교 핵심 지표 표 — 잘린 값의 글자는 한 줄 (라이브: 「▲ 변화율 계산 불가」가 두 줄로 접혔다)", () => {
  for (const bars of [true, false]) {
    it(`변화 칸 글자 span에 p-nowrap이 있다 (bars=${bars})`, () => {
      const { container } = render(<KpiCompareTable doc={doc} no="2" bars={bars} standard />);
      const lead = container.querySelector(
        ".p-cmp-kpi tbody td:nth-child(4) > span",
      ) as HTMLElement;
      expect(lead.textContent).toBe(`▲ ${ko.print.cmp.change.cutNoPct}`);
      expect(lead).toHaveClass("p-nowrap");
    });
  }

  it("p-nowrap 규칙이 white-space: nowrap이다", () => {
    expect(css).toMatch(/\.p-root \.p-nowrap \{\s*white-space: nowrap;\s*\}/);
  });

  // 8.3pt = 2.928mm. 「▲ 변화율 계산 불가」 ≈ 9.98em(글자 1em 폭 + letter-spacing 0.12em 가정) = 29.2mm,
  // 칸 안쪽 = 폭 − 패딩 3.6mm − 테두리 0.26mm. 「30.0초 이상」 굵게 ≈ 6.4em×1.08 = 20.2mm.
  it("표 열 폭이 그 글자를 담는다 (막대 있는 표)", () => {
    const { container } = render(<KpiCompareTable doc={doc} no="2" bars standard />);
    const w = Array.from(container.querySelectorAll("colgroup col")).map((c) =>
      parseFloat((c as HTMLElement).style.width),
    );
    expect(w).toEqual([34, 25, 25, 36, 60]);
    expect(w.reduce((a, b) => a + b, 0)).toBe(180);
  });
});
