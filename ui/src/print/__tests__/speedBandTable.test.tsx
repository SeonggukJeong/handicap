import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { SpeedBandTable, SpeedNotes, SpeedTableTitle } from "../components/SpeedBandTable";
import { MEASURE_IDS } from "../buildPrintDoc";
import { ko } from "../../i18n/ko";
import { build, case1Input, case4Input, case7Input } from "./speedFixtures";

const bodyRows = (c: HTMLElement) => Array.from(c.querySelectorAll("tbody tr"));
const text = (el: Node | null | undefined) => el?.textContent ?? "";

describe("SpeedBandTable", () => {
  it("세 구간 표: 머리·행·total을 그린다", () => {
    const m = build(case1Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} />);
    const heads = within(container).getAllByRole("columnheader");
    expect(heads).toHaveLength(6);
    expect(heads.map((h) => text(h.firstChild))).toEqual([
      ko.print.speed.colStep,
      ko.print.speed.colBar,
      "1초 미만",
      "1초–3초",
      "3초 초과",
      ko.print.speed.colFail,
    ]);
    expect(text(heads[4])).toContain("기준 넘음");
    expect(text(heads[5])).toContain("막대와 별개");
    const rows = bodyRows(container);
    expect(rows).toHaveLength(m.rows.length);
    expect(rows).toHaveLength(6);
    const r5 = rows[4];
    expect(r5.classList.contains("p-speed-row--bad")).toBe(true);
    expect(rows[3].classList.contains("p-speed-row--bad")).toBe(false);
    const cells5 = r5.querySelectorAll("td");
    expect(text(cells5[0])).toBe("✕ ⑤ 신청 제출");
    expect(text(cells5[cells5.length - 1])).toBe("✕ 26.6%");
    expect(cells5[cells5.length - 1].classList.contains("p-bad")).toBe(true);
    // ④ 초과 칸은 ▲ 주황
    const over4 = rows[3].querySelectorAll("td")[4];
    expect(text(over4)).toBe("▲ 32.0%");
    expect(over4.classList.contains("p-warn")).toBe(true);
    // 막대: ① 로그인 = 96% + 4%
    const segs = rows[0].querySelectorAll(".p-speed-seg");
    expect(segs).toHaveLength(2);
    expect((segs[0] as HTMLElement).style.width).toBe("96%");
    expect((segs[1] as HTMLElement).style.width).toBe("4%");
    expect(segs[0].classList.contains("p-speed-seg--fast")).toBe(true);
    expect(segs[1].classList.contains("p-speed-seg--within")).toBe(true);
    // ⑤ 막대 3조각, 마지막은 over
    const segs5 = r5.querySelectorAll(".p-speed-seg");
    expect(segs5).toHaveLength(3);
    expect(segs5[2].classList.contains("p-speed-seg--over")).toBe(true);
    expect((segs5[2] as HTMLElement).style.width).toBe("3%");
    // total
    const total = rows[5];
    expect(total.classList.contains("p-speed-row--total")).toBe(true);
    expect(text(total.querySelector("td"))).toBe("전체 요청");
  });

  it("합친 칸은 colSpan 2", () => {
    const m = build(case7Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} />);
    const row = bodyRows(container)[0];
    const tds = row.querySelectorAll("td");
    expect(tds).toHaveLength(5);
    expect(tds[2].colSpan).toBe(2);
    expect(text(tds[2])).toBe("800ms 이내 91.0%");
    expect(text(tds[0])).toContain("이 단계 기준 800ms");
    // 합치지 않은 행은 6칸
    expect(bodyRows(container)[1].querySelectorAll("td")).toHaveLength(6);
  });

  it("실패 칸의 별표는 글자 바로 뒤에 붙는다", () => {
    const m = build(case7Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} />);
    const row4 = bodyRows(container)[3];
    const cells = row4.querySelectorAll("td");
    expect(text(cells[cells.length - 1])).toBe("✕ 0.7%*");
  });

  it("두 구간 표는 구간 열이 둘", () => {
    const m = build(case4Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} />);
    const heads = within(container).getAllByRole("columnheader");
    expect(heads).toHaveLength(5);
    expect(text(heads[2].firstChild)).toBe("800ms 이내");
    expect(bodyRows(container)[0].querySelectorAll("td")).toHaveLength(5);
  });

  it("막대 없는 행은 —", () => {
    const m = build(case7Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} />);
    const row = bodyRows(container)[5];
    expect(row.querySelectorAll(".p-speed-seg")).toHaveLength(0);
    const tds = Array.from(row.querySelectorAll("td"));
    expect(tds.map((t) => text(t))).toEqual(["⑥ 로그아웃", "—", "—", "—", "—", "—"]);
    expect(row.querySelectorAll("td.p-muted").length).toBeGreaterThanOrEqual(5);
  });

  it("from/to로 잘라 그리고 머리줄은 항상 있다", () => {
    const m = build(case1Input());
    const { container } = render(<SpeedBandTable model={m} from={2} to={4} />);
    expect(container.querySelector("thead")).not.toBeNull();
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(text(rows[0].querySelector("td"))).toBe("③ 민원 상세");
    expect(text(rows[1].querySelector("td"))).toBe("④ 첨부 업로드");
  });

  it("measure면 data-measure id가 행·머리마다 붙는다", () => {
    const m = build(case1Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={m.rows.length} measure />);
    for (const r of m.rows) {
      expect(
        container.querySelector(`[data-measure="${MEASURE_IDS.speedRowId(r.key)}"]`),
      ).not.toBeNull();
    }
    expect(container.querySelector(`[data-measure="${MEASURE_IDS.speedHeader}"]`)).not.toBeNull();
    const plain = render(<SpeedBandTable model={m} from={0} to={2} />);
    expect(plain.container.querySelector("[data-measure]")).toBeNull();
  });

  it("긴 이름은 2절 표와 같은 이름 칸 클래스(p-name)를 쓴다", () => {
    const m = build(case1Input());
    const { container } = render(<SpeedBandTable model={m} from={0} to={1} />);
    expect(container.querySelector("tbody td .p-name")).not.toBeNull();
  });
});

describe("SpeedTableTitle", () => {
  it("이어짐 표시와 측정 id", () => {
    const a = render(<SpeedTableTitle continued={false} measure />);
    expect(a.container.querySelector("h2")?.textContent).toBe(ko.print.section.speed);
    expect(a.container.querySelector(`[data-measure="${MEASURE_IDS.speedTitle}"]`)).not.toBeNull();
    const b = render(<SpeedTableTitle continued />);
    expect(b.container.querySelector("h2")?.textContent).toBe(
      `${ko.print.section.speed}${ko.print.section.continued}`,
    );
  });
});

describe("SpeedNotes", () => {
  it("미달이면 안내 상자에 fail 클래스, 단계 줄은 같은 상자, 각주 순서", () => {
    const m = build(case1Input());
    const { container } = render(<SpeedNotes model={m} />);
    const rule = container.querySelector(".p-speed-rule");
    expect(rule?.classList.contains("p-speed-rule--fail")).toBe(true);
    expect(text(rule)).toContain("이 기준은 미달");
    expect(rule?.querySelector("b.p-bad")?.textContent).toBe("이 기준은 미달");
    expect(container.querySelectorAll(".p-speed-legend .p-speed-sw")).toHaveLength(3);
    const notes = Array.from(container.querySelectorAll(".p-speed-note-item"));
    expect(notes).toHaveLength(m.notes.length);
    expect(text(notes[0])).toContain(ko.print.speed.noteBars);
  });

  it("run 줄 없이 단계 줄만 있으면 기본 테두리, 줄은 한 상자 안", () => {
    const m = build(case7Input());
    const { container } = render(<SpeedNotes model={m} />);
    const boxes = container.querySelectorAll(".p-speed-rule");
    expect(boxes).toHaveLength(1);
    expect(boxes[0].classList.contains("p-speed-rule--fail")).toBe(false);
    expect(boxes[0].querySelectorAll(".p-speed-rule-line")).toHaveLength(2);
    const notes = Array.from(container.querySelectorAll(".p-speed-note-item"));
    expect(text(notes[notes.length - 1]).trim()).toBe(ko.print.speed.noteStar);
  });

  it("안내 줄이 없으면 상자도 없다", () => {
    const input = case4Input();
    const m = build({ ...input, criteria: null, failing: null });
    const { container } = render(<SpeedNotes model={{ ...m, rule: null, stepRules: [] }} />);
    expect(container.querySelector(".p-speed-rule")).toBeNull();
  });
});
