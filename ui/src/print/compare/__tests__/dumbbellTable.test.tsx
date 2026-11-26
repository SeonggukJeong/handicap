import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { buildDumbbell as buildDumbbellFromPairs } from "../dumbbell";
import { stepPairs } from "../errorCells";
import { DumbbellLegend, DumbbellTable, DumbbellTitle } from "../components/DumbbellTable";
import type { RunModel } from "../runModel";
import { mkStats } from "./fixtures";
import { sceneModel } from "./scene";

const buildDumbbell = (before: RunModel, after: RunModel) =>
  buildDumbbellFromPairs(before, after, stepPairs(before, after));

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
  const view = render(
    <DumbbellTable id="cmp:db" model={m} from={from} to={to} measure={measure} />,
  );
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

  it("점·화살촉 색: 이전 회색, 좋아짐 파랑, 나빠짐 빨강", () => {
    const { rows } = renderTable();
    const fills = (i: number, sel: string) =>
      [...rows[i]!.querySelectorAll(sel)].map((e) => e.getAttribute("fill"));
    // 행 4: 1.2초 → 3.4초(느려짐, 화살표) · 행 5: 4.8초 → 0.4초(빨라짐, 화살표) · 행 3: 좁은 느려짐
    expect(fills(4, "circle")).toEqual(["#9aa1ad", "#b42318"]);
    expect(fills(4, "path")).toEqual(["#b42318"]);
    expect(rows[4]!.querySelector("line")!.getAttribute("stroke")).toBe("#b42318");
    expect(fills(5, "circle")).toEqual(["#9aa1ad", "#3b4bc8"]);
    expect(fills(5, "path")).toEqual(["#3b4bc8"]);
    expect(fills(3, "circle")).toEqual(["#9aa1ad", "#b42318"]);
    expect(fills(3, "path")).toEqual(["#b42318"]);
  });

  it("첫 줄: 이전 부분은 회색 그대로, 이후 값(퍼센트 포함)만 굵게 분류 색", () => {
    const { rows } = renderTable();
    const first = (i: number) => rows[i]!.querySelector("td:nth-child(3) > div") as HTMLElement;
    const worse = first(4);
    expect(worse.textContent).toBe("1.2초 → 3.4초 (+183%)");
    expect(worse.querySelector("b.p-cmp-bad")!.textContent).toBe("3.4초 (+183%)");
    expect(worse.firstChild!.textContent).toBe("1.2초 → ");
    expect(first(2).querySelector("b.p-cmp-ok")!.textContent).toBe("0.95초 (−14%)");
    expect(first(0).querySelector("b")).toBeNull();
    expect(first(0).textContent).toBe("1.0초 → 1.0초");
  });

  it("한쪽에만 있는 행의 첫 줄에는 색 입힌 부분이 없다", () => {
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
    for (const r of rows) expect(r.querySelector("td:nth-child(3) > div b")).toBeNull();
  });

  it("글자 칸: 첫 줄 이전 → 이후, 둘째 줄 낱말(색 클래스)·기준 교차", () => {
    const { rows } = renderTable(model());
    const last = rows[4]!.querySelectorAll("td")[2]!;
    expect(last.textContent).toContain("1.2초 → 3.4초 (+183%)");
    const word = (i: number, cls: string) =>
      rows[i]!.querySelector(`td:nth-child(3) > div:nth-child(2) b.${cls}`)?.textContent;
    expect(word(4, "p-cmp-bad")).toBe("느려짐");
    expect(word(2, "p-cmp-ok")).toBe("빨라짐");
    expect(word(0, "p-cmp-same")).toBe("= 비슷");
  });
});

describe("DumbbellLegend", () => {
  const dots = (c: HTMLElement) => [...c.querySelectorAll("i.p-cmp-db-sw")] as HTMLElement[];

  it("기준선이 없으면 점 견본 둘, ┊·기준 글자 없음, 접근명은 모델 범례", () => {
    const m = model();
    const { container } = render(<DumbbellLegend model={m} />);
    const root = container.querySelector(".p-cmp-db-legend") as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe(m.legend);
    expect(root.getAttribute("role")).toBe("img");
    expect(m.legend).toBe(
      "회색 점 = 이전 · 파란 점 = 이후 · 화살표 왼쪽 = 빨라짐, 오른쪽 = 느려짐",
    );
    expect(dots(root).map((e) => e.style.background)).toEqual([
      "rgb(154, 161, 173)",
      "rgb(59, 75, 200)",
    ]);
    const spans = [...root.children].map((c) => c.textContent);
    expect(spans[0]).toBe("이전");
    expect(spans[1]).toBe("이후");
    expect(root.textContent).not.toContain("회색 점");
    expect(root.textContent).toContain("화살표 왼쪽 = 빨라짐, 오른쪽 = 느려짐");
    expect(root.textContent).not.toContain("┊");
    expect(root.textContent).not.toContain("기준");
    for (const child of root.children) expect(child.getAttribute("aria-hidden")).toBe("true");
  });

  it("기준선이 있으면 빨강 ┊와 기준 글자가 붙는다", () => {
    const m = model({ max_p95_ms: 3000 });
    const { container } = render(<DumbbellLegend model={m} />);
    const root = container.querySelector(".p-cmp-db-legend") as HTMLElement;
    expect(root.getAttribute("aria-label")).toBe(m.legend);
    expect(dots(root)).toHaveLength(2);
    const mark = root.querySelector("b") as HTMLElement;
    expect(mark.textContent).toBe("┊");
    expect(mark.style.color).toBe("rgb(180, 35, 24)");
    expect(root.textContent).toContain("┊ 기준 3초");
  });
});

describe("평균 덤벨 표", () => {
  const meanRun = (id: string, meanUs: number, capped: boolean) =>
    sceneModel({
      id,
      steps: [{ id: "s1", name: "가" }],
      rep: [
        {
          id: "s1",
          counts: { "200": 10 },
          errors: 0,
          stats: mkStats({ mean_us: meanUs, capped }),
        },
      ],
      profile: prof(),
    });
  const meanModel = (b: number, a: number, bCapped = false, aCapped = false) => {
    const bm = meanRun("b", b, bCapped);
    const am = meanRun("a", a, aCapped);
    return buildDumbbellFromPairs(bm, am, stepPairs(bm, am), "mean");
  };

  it("측정 id가 cmp:dbm: 이고 cmp:db: 로 시작하는 것이 없다", () => {
    const m = meanModel(61_000, 83_000);
    const { container } = render(
      <>
        <DumbbellTitle id="cmp:dbm" title="평균" no="4" continued={false} measure />
        <DumbbellTable id="cmp:dbm" model={m} from={0} to={1} measure />
      </>,
    );
    const ids = [...container.querySelectorAll("[data-measure]")].map((e) =>
      e.getAttribute("data-measure"),
    );
    expect(ids).toEqual(["cmp:dbm:title", "cmp:dbm:header", "cmp:dbm:row:0"]);
    expect(ids.some((id) => id!.startsWith("cmp:db:"))).toBe(false);
  });

  it("제목은 받은 글자를 그린다", () => {
    const { container } = render(
      <DumbbellTitle id="cmp:dbm" title="단계별 평균 응답 시간 변화" no="4" continued={false} />,
    );
    expect(container.textContent).toContain("단계별 평균 응답 시간 변화");
  });

  it("양쪽 값이 있는데 분류가 없는 행(잘림)은 비슷 색·낱말 없이 중립으로 그린다", () => {
    const m = meanModel(30_007_796, 40_000_000, true, false);
    expect(m.rows[0]!.cls).toBeNull();
    const { container } = render(<DumbbellTable id="cmp:dbm" model={m} from={0} to={1} />);
    const row = container.querySelector("tbody tr") as HTMLElement;
    expect(row.querySelector(".p-cmp-same, .p-cmp-ok, .p-cmp-bad")).toBeNull();
    expect(row.textContent).not.toContain("= 비슷");
    expect(row.textContent).toContain("이상");
    const svg = row.querySelector("svg") as SVGElement;
    expect(count(svg, "circle")).toBe(2);
    expect(count(svg, "path")).toBe(0);
  });
});
