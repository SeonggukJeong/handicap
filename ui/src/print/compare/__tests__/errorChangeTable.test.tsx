import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { buildErrorTable, type ErrorTableModel } from "../errorTable";
import { stepPairs } from "../errorCells";
import { ErrorChangeTable } from "../components/ErrorChangeTable";
import { sceneModel } from "./scene";
import type { ReportStepSpec, StepSpec } from "./fixtures";

const S = (id: string, name: string, over: Partial<StepSpec> = {}): StepSpec => ({
  id,
  name,
  ...over,
});
const R = (id: string, counts: Record<string, number>, errors = 0): ReportStepSpec => ({
  id,
  counts,
  errors,
});

function build(
  bSteps: StepSpec[],
  bRep: ReportStepSpec[],
  aSteps: StepSpec[],
  aRep: ReportStepSpec[],
): ErrorTableModel {
  const before = sceneModel({ id: "b", steps: bSteps, rep: bRep });
  const after = sceneModel({ id: "a", steps: aSteps, rep: aRep });
  return buildErrorTable({ before, after, pairs: stepPairs(before, after), incomparable: false });
}

// 시안 「4. 단계별 오류 변화」
function mock(): ErrorTableModel {
  const names = ["로그인", "민원 목록", "민원 상세", "첨부 업로드", "신청 제출"];
  const asserted = (i: number) => i === 1 || i === 2 || i === 4;
  const bSteps = names.map((n, i) =>
    asserted(i) ? S(`s${i + 1}`, n, { assert: [200] }) : S(`s${i + 1}`, n),
  );
  const aSteps = names.map((n, i) =>
    asserted(i) || i === 3 ? S(`s${i + 1}`, n, { assert: [200] }) : S(`s${i + 1}`, n),
  );
  return build(
    bSteps,
    [
      R("s1", { "200": 10000 }),
      R("s2", { "200": 9640, "429": 360 }, 360),
      R("s3", { "200": 9880, "404": 120 }, 120),
      R("s4", { "200": 9400, "502": 600 }, 0),
      R("s5", { "200": 6808, "503": 2880, "504": 312 }, 3192),
    ],
    aSteps,
    [
      R("s1", { "200": 10000 }),
      R("s2", { "200": 9640, "429": 360 }, 360),
      R("s3", { "200": 9952, "404": 48 }, 48),
      R("s4", { "200": 10000 }, 0),
      R("s5", { "200": 9976, "504": 24 }, 24),
    ],
  );
}

function renderTable(m: ErrorTableModel, from = 0, to = m.rows.length, measure = false) {
  const view = render(<ErrorChangeTable model={m} from={from} to={to} measure={measure} />);
  const rows = [...view.container.querySelectorAll("tbody tr")] as HTMLElement[];
  const cells = (r: number) => [...rows[r]!.querySelectorAll("td")] as HTMLElement[];
  return { ...view, rows, cells };
}

const norm = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("ErrorChangeTable", () => {
  it("머리 2행: 1행에 colSpan 5 묶음 하나, 2행에 코드 칸 5개", () => {
    const { container } = renderTable(mock());
    const heads = container.querySelectorAll("thead tr");
    expect(heads).toHaveLength(2);
    const spans = heads[0]!.querySelectorAll("th[colspan]");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.getAttribute("colspan")).toBe("5");
    expect(norm(spans[0]!)).toBe("응답 코드별 건수 (이전 → 이후, 둘 중 한쪽이라도 나온 코드만)");
    const second = [...heads[1]!.querySelectorAll("th")];
    expect(second).toHaveLength(5);
    expect(second.map(norm).some((t) => t.includes("503") && t.includes("서버가 바쁨"))).toBe(true);
    const first = [...heads[0]!.querySelectorAll("th")];
    expect(first.filter((t) => t.getAttribute("rowspan") === "2")).toHaveLength(3);
  });

  it("칸 폭: 단계 34mm · 오류율 26mm · 코드 열 균등(합 103mm) · 변화 17mm", () => {
    const { container } = renderTable(mock());
    const cols = [...container.querySelectorAll("colgroup col")] as HTMLElement[];
    expect(cols).toHaveLength(8);
    const w = cols.map((c) => c.style.width);
    expect(w[0]).toBe("34mm");
    expect(w[1]).toBe("26mm");
    expect(w[7]).toBe("17mm");
    expect(new Set(w.slice(2, 7)).size).toBe(1);
    expect(parseFloat(w[2]!) * 5).toBeCloseTo(103, 1);
  });

  it("④ 행 502 칸은 별 포함 글자 `600* → 0`이고 바탕색 클래스가 없다", () => {
    const { cells } = renderTable(mock());
    const c = cells(3);
    // 단계 · 오류율 · 404 · 429 · 502 · 503 · 504 · 변화
    expect(norm(c[4]!)).toBe("600* → 0");
    expect(c[4]!.className).not.toMatch(/p-cmp-err-cell--/);
    expect(norm(c[1]!)).toBe("0.0%* → 0.0%");
  });

  it("① 행 코드 칸은 전부 '–', 바탕색 없음", () => {
    const { cells } = renderTable(mock());
    const c = cells(0);
    for (let i = 2; i <= 6; i++) {
      expect(norm(c[i]!)).toBe("–");
      expect(c[i]!.className).not.toMatch(/p-cmp-err-cell--/);
      expect(c[i]!.className).not.toContain("p-muted");
    }
  });

  it("바탕 클래스: 줄면 down · 같으면 flat · 늘면 up", () => {
    const { cells } = renderTable(mock());
    expect(cells(2)[2]!).toHaveClass("p-cmp-err-cell--down");
    expect(norm(cells(2)[2]!)).toBe("120 → 48");
    expect(cells(1)[3]!).toHaveClass("p-cmp-err-cell--flat");
    expect(norm(cells(1)[3]!)).toBe("360 → 360");
    const up = build(
      [S("s1", "A", { assert: [200] })],
      [R("s1", { "200": 90, "500": 10 }, 10)],
      [S("s1", "A", { assert: [200] })],
      [R("s1", { "200": 70, "500": 30 }, 30)],
    );
    expect(renderTable(up).cells(0)[2]!).toHaveClass("p-cmp-err-cell--up");
  });

  it("이후 숫자만 굵게, 두 조각은 각각 줄바꿈 없는 조각", () => {
    const { cells } = renderTable(mock());
    const cell = cells(4)[5]!;
    expect(norm(cell)).toBe("2,880 → 0");
    expect(cell.querySelector("b")!.textContent).toBe("0");
    expect(cell.querySelectorAll(".p-cmp-err-piece")).toHaveLength(2);
    expect(norm(cells(4)[1]!)).toBe("31.9% → 0.2%");
  });

  it("변화 칸: ⑤ '▼ 좋아짐', ② '남은 문제', ④ 참고용", () => {
    const { cells } = renderTable(mock());
    const last = (r: number) => cells(r)[7]!;
    expect(norm(last(4))).toContain("▼ 좋아짐");
    expect(last(4).querySelector(".p-cmp-ok")).not.toBeNull();
    expect(norm(last(1))).toContain("남은 문제");
    expect(norm(last(1))).toContain("비슷");
    expect(norm(last(3))).toBe("참고용");
    expect(last(3).querySelector(".p-cmp-same")).not.toBeNull();
  });

  it("단계 칸: 이름은 2줄 clamp, 메모는 small", () => {
    const { cells } = renderTable(mock());
    expect(cells(3)[0]!.querySelector(".p-cmp-clamp2")!.textContent).toContain("첨부 업로드");
    const only = build(
      [S("s1", "A")],
      [R("s1", { "200": 10 })],
      [S("s2", "B")],
      [R("s2", { "200": 10 })],
    );
    expect(renderTable(only).cells(0)[0]!.querySelector("small")).not.toBeNull();
  });

  it("코드 열이 0개면 묶음 머리 없이 머리 1행, 칸은 3개", () => {
    const m = build(
      [S("s1", "A")],
      [R("s1", { "200": 10 })],
      [S("s1", "A")],
      [R("s1", { "200": 10 })],
    );
    expect(m.cols).toHaveLength(0);
    const { container, cells } = renderTable(m);
    expect(container.querySelectorAll("thead tr")).toHaveLength(1);
    expect(container.querySelector("th[colspan]")).toBeNull();
    expect(container.querySelectorAll("colgroup col")).toHaveLength(3);
    expect(cells(0)).toHaveLength(3);
  });

  it("from=1,to=3이면 행 2개, 측정 id는 전체 인덱스(measure일 때만)", () => {
    const m = mock();
    const on = renderTable(m, 1, 3, true);
    expect(on.rows).toHaveLength(2);
    expect(on.rows.map((r) => r.getAttribute("data-measure"))).toEqual([
      "cmp:err:row:1",
      "cmp:err:row:2",
    ]);
    expect(on.container.querySelector("thead")!.getAttribute("data-measure")).toBe(
      "cmp:err:header",
    );
    on.unmount();
    const off = renderTable(m, 1, 3, false);
    expect(off.container.querySelector("[data-measure]")).toBeNull();
  });

  it("한쪽에만 있는 단계의 건수 칸은 없는 쪽이 '–'이고 바탕색이 없다", () => {
    const m = build(
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "200": 10 }), R("s2", { "500": 120, "200": 1 }, 120)],
      [S("s1", "A")],
      [R("s1", { "200": 10 })],
    );
    const idx = m.rows.findIndex((r) => r.stepId === "s2");
    const code = renderTable(m).cells(idx)[2]!;
    expect(norm(code)).toBe("120 → –");
    expect(code.className).not.toMatch(/p-cmp-err-cell--/);
  });
});
