import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { buildDumbbell } from "../dumbbell";
import { DumbbellTable } from "../components/DumbbellTable";
import { sceneModel } from "./scene";

const prof = (criteria?: Record<string, unknown>) => ({
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  ...(criteria ? { criteria } : {}),
});

function runOf(id: string, p95s: number[], criteria?: Record<string, unknown>) {
  const steps = p95s.map((_, i) => ({ id: `s${i + 1}`, name: `단계${i + 1}` }));
  const rep = p95s.map((p, i) => ({
    id: `s${i + 1}`,
    counts: { "200": 10 },
    errors: 0,
    p95: p,
  }));
  return sceneModel({ id, steps, rep, profile: prof(criteria) });
}

// 시안 6사례: merged · merged · tri(빨라짐) · tri(느려짐) · arrow · arrow
const PAIRS: Array<[number, number]> = [
  [1000, 1000],
  [1000, 1040],
  [1100, 950],
  [1000, 1150],
  [1200, 3400],
  [4800, 400],
];

function model(criteria?: Record<string, unknown>) {
  return buildDumbbell(
    runOf(
      "b",
      PAIRS.map((p) => p[0]),
      criteria,
    ),
    runOf(
      "a",
      PAIRS.map((p) => p[1]),
      criteria,
    ),
  );
}

function renderTable(m = model(), from = 0, to = m.rows.length, measure = false) {
  const view = render(<DumbbellTable model={m} from={from} to={to} measure={measure} />);
  const rows = [...view.container.querySelectorAll("tbody tr")] as HTMLElement[];
  return { ...view, rows };
}

const count = (el: Element, sel: string) => el.querySelectorAll(sel).length;

describe("DumbbellTable", () => {
  it("행 6개, 모양마다 선·화살촉·점 개수가 다르다", () => {
    const { rows } = renderTable();
    expect(rows).toHaveLength(6);
    const svg = (i: number) => rows[i]!.querySelector("svg") as SVGElement;
    // merged
    expect([count(svg(0), "line"), count(svg(0), "path"), count(svg(0), "circle")]).toEqual([
      0, 0, 1,
    ]);
    // tri
    expect([count(svg(2), "line"), count(svg(2), "path"), count(svg(2), "circle")]).toEqual([
      0, 1, 2,
    ]);
    // arrow
    expect([count(svg(4), "line"), count(svg(4), "path"), count(svg(4), "circle")]).toEqual([
      1, 1, 2,
    ]);
    expect([count(svg(5), "line"), count(svg(5), "path"), count(svg(5), "circle")]).toEqual([
      1, 1, 2,
    ]);
  });

  it("single 행은 점 하나뿐이고 화살촉이 없다", () => {
    const m = buildDumbbell(
      sceneModel({
        id: "b",
        steps: [{ id: "x", name: "가" }],
        rep: [{ id: "x", counts: { "200": 10 }, errors: 0, p95: 900 }],
      }),
      sceneModel({
        id: "a",
        steps: [{ id: "y", name: "나" }],
        rep: [{ id: "y", counts: { "200": 10 }, errors: 0, p95: 800 }],
      }),
    );
    const { rows } = renderTable(m);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const svg = r.querySelector("svg") as SVGElement;
      expect([count(svg, "circle"), count(svg, "path"), count(svg, "line")]).toEqual([1, 0, 0]);
    }
  });

  it("각 행의 그림 칸에 눈금마다 세로선이 있고 SVG에는 눈금선이 없다", () => {
    const m = model();
    expect(m.ticks).toHaveLength(6);
    const { rows } = renderTable(m);
    for (const r of rows) {
      expect(count(r, "i.p-cmp-db-grid")).toBe(6);
      const svg = r.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("role")).toBe("img");
      expect(svg.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("모든 SVG 숫자 속성이 유한하다(NaN 없음)", () => {
    const { container } = renderTable();
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
    expect(container.innerHTML).not.toContain("undefined");
  });

  it("기준선이 있으면 모든 행에 i.p-cmp-db-base와 머리줄 글자, 없으면 0개", () => {
    const withBase = renderTable(model({ max_p95_ms: 3000 }));
    for (const r of withBase.rows) expect(count(r, "i.p-cmp-db-base")).toBe(1);
    expect(withBase.container.querySelector("thead")!.textContent).toContain("기준 3초");
    withBase.unmount();

    const without = renderTable();
    for (const r of without.rows) expect(count(r, "i.p-cmp-db-base")).toBe(0);
    expect(without.container.querySelector("thead")!.textContent).not.toContain("기준");
  });

  it("머리줄 SVG는 두 줄이다: 기준선 글자 y 9, 눈금 글자 y 21", () => {
    const { container } = renderTable(model({ max_p95_ms: 3000 }));
    const svg = container.querySelector("thead svg") as SVGElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 352 26");
    const texts = [...svg.querySelectorAll("text")];
    const base = texts.filter((t) => t.textContent === "기준 3초");
    expect(base).toHaveLength(1);
    expect(base[0]!.getAttribute("y")).toBe("9");
    expect(base[0]!.getAttribute("text-anchor")).toBe("start");
    const ticks = texts.filter((t) => t !== base[0]);
    expect(ticks.map((t) => t.getAttribute("y"))).toEqual(Array(6).fill("21"));
    expect(ticks.every((t) => t.getAttribute("text-anchor") === "middle")).toBe(true);
  });

  it("기준선 글자가 오른쪽 끝을 넘으면 end로 붙인다", () => {
    const m = buildDumbbell(
      runOf("b", [3000], { max_p95_ms: 3000 }),
      runOf("a", [3000], { max_p95_ms: 3000 }),
    );
    expect(m.baseline).not.toBeNull();
    const wide = { ...m, baseline: { ...m.baseline!, x: 340 } };
    const { container } = renderTable(wide);
    const t = [...container.querySelectorAll("thead svg text")].find(
      (x) => x.textContent === "기준 3초",
    )!;
    expect(t.getAttribute("text-anchor")).toBe("end");
  });

  it("from=2,to=4면 행 2개이고 data-measure는 measure일 때만 전체 인덱스", () => {
    const a = renderTable(model(), 2, 4, true);
    expect(a.rows).toHaveLength(2);
    expect(a.rows.map((r) => r.getAttribute("data-measure"))).toEqual([
      "cmp:db:row:2",
      "cmp:db:row:3",
    ]);
    expect(a.container.querySelector("thead")!.getAttribute("data-measure")).toBe("cmp:db:header");
    a.unmount();
    const b = renderTable(model(), 2, 4, false);
    expect(b.container.querySelector("[data-measure]")).toBeNull();
  });

  it("글자 칸: 첫 줄 이전 → 이후, 둘째 줄 낱말(색 클래스)·기준 교차", () => {
    const { rows } = renderTable(model());
    const last = rows[4]!.querySelectorAll("td")[2]!;
    expect(last.textContent).toContain("1.2초 → 3.4초 (+183%)");
    expect(last.querySelector("b.p-cmp-bad")?.textContent).toBe("느려짐");
    expect(rows[2]!.querySelector("td:nth-child(3) b.p-cmp-ok")?.textContent).toBe("빨라짐");
    expect(rows[0]!.querySelector("td:nth-child(3) b.p-cmp-same")?.textContent).toBe("= 비슷");
  });
});
