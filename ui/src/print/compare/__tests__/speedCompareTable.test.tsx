import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { Report } from "../../../api/schemas";
import { SpeedCompareTable, SpeedCompareNotes } from "../components/SpeedCompareTable";
import { buildSpeedCompare } from "../speedCompare";
import type { RunModel } from "../runModel";
import { sceneModel } from "./scene";

type Band = NonNullable<Report["speed_bands"]>["overall"];
const b3 = (slow_ms: number): Band => ({
  slow_ms,
  basis: "p95",
  own: false,
  fast: 580,
  within: 330,
  over: 90,
});
const b2 = (slow_ms: number): Band => ({
  slow_ms,
  basis: "p95",
  own: false,
  fast: null,
  within: 910,
  over: 90,
});
function run(id: string, overall: Band, errors = 26): RunModel {
  const m = sceneModel({ id, summary: { count: 1000, errors } });
  return { ...m, report: { ...m.report, speed_bands: { overall, steps: [] } } };
}
const text = (el: Node | null | undefined) => el?.textContent ?? "";

function draw(b: Band, a: Band) {
  const model = buildSpeedCompare(run("b", b), run("a", a))!;
  return {
    model,
    ...render(
      <>
        <SpeedCompareTable model={model} />
        <SpeedCompareNotes model={model} />
      </>,
    ),
  };
}

describe("SpeedCompareTable", () => {
  it("행 둘(이전·이후), 막대 조각 수, 실패 칸, 측정 보고서와 같은 클래스", () => {
    const { container } = draw(b3(3000), b3(3000));
    const table = container.querySelector("table") as HTMLElement;
    expect(table.className).toContain("p-speed");
    expect(table.className).toContain("p-cmp-spd");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(text(rows[0].querySelector("td"))).toContain("이전");
    expect(text(rows[1].querySelector("td"))).toContain("이후");
    expect(rows[0].querySelectorAll("i.p-speed-seg")).toHaveLength(3);
    expect(rows[0].querySelector("i.p-speed-seg--fast")).not.toBeNull();
    const heads = [...container.querySelectorAll("th")].map((h) => text(h.firstChild));
    expect(heads).toEqual(["측정", "응답 속도 비율", "1초 미만", "1초–3초", "3초 초과", "실패"]);
    const fail = rows[0].querySelector("td.p-speed-fail");
    expect(text(fail)).toBe("2.6%");
    expect(rows[0].querySelector("small")).toBeNull();
  });

  it("경계가 다르면 이름 칸에 경계가 붙고 경고 줄은 p-cmp-warn", () => {
    const { container } = draw(b3(3000), b3(2000));
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(text(rows[0].querySelector("td small"))).toBe("3초 기준");
    expect(text(rows[1].querySelector("td small"))).toBe("2초 기준");
    const warn = container.querySelector(".p-cmp-warn");
    expect(text(warn)).toContain("기준이 달라");
    expect(container.querySelectorAll(".p-bad")).toHaveLength(0);
  });

  it("합친 행에는 colSpan=2 칸이 있고 칸 수가 맞다", () => {
    const { container } = draw(b3(3000), b2(3000));
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0].querySelector("td[colspan]")).toBeNull();
    const merged = rows[1].querySelector("td[colspan]") as HTMLElement;
    expect(merged.getAttribute("colspan")).toBe("2");
    expect(text(merged)).toBe("3초 이내 91.0%");
    expect(rows[1].querySelectorAll("i.p-speed-seg")).toHaveLength(2);
    // 이름 + 막대 + 합친 칸(2) + 초과 + 실패 = 6칸 폭
    const width = (tr: Element) =>
      [...tr.children].reduce((n, c) => n + Number(c.getAttribute("colspan") ?? 1), 0);
    expect(width(rows[0])).toBe(width(rows[1]));
  });

  it("두 구간끼리면 칸이 하나 적다", () => {
    const { container } = draw(b2(3000), b2(3000));
    expect(container.querySelectorAll("thead th")).toHaveLength(5);
    expect(container.querySelectorAll("tbody tr")[0].children).toHaveLength(5);
  });

  it("판정 표시가 없다: 통과·미달 낱말, p-bad, p-warn(경고 줄 제외), 안내 상자", () => {
    const { container } = draw(b3(3000), b3(3000));
    expect(container.querySelectorAll(".p-bad")).toHaveLength(0);
    expect(container.querySelectorAll(".p-warn")).toHaveLength(0);
    expect(container.querySelector(".p-speed-rule")).toBeNull();
    expect(container.textContent).not.toContain("통과");
    expect(container.textContent).not.toContain("미달");
    expect(container.textContent).not.toContain("✕");
    expect(container.textContent).not.toContain("NaN");
  });

  it("범례: 같은 색 견본(p-speed-sw)과 구간 이름", () => {
    const { container } = draw(b3(3000), b3(3000));
    const legend = container.querySelector(".p-speed-legend") as HTMLElement;
    expect(legend.querySelectorAll("i.p-speed-sw")).toHaveLength(3);
    expect(text(legend)).toContain("1초–3초");
  });
});
