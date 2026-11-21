import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { Report } from "../../../api/schemas";
import { PX_PER_MM } from "../../paginate";
import type { Heights } from "../../buildPrintDoc";
import { CompareDocument } from "../CompareDocument";
import {
  CMP_IDS,
  CMP_LAST_LEVEL,
  buildCompareDoc,
  compareSheetBlocks,
  compareStandardBlocks,
  compareSummaryBlocks,
  type CompareDoc,
} from "../buildCompareDoc";
import { sceneModel, type SceneRun } from "./scene";

const NOON = Date.UTC(2026, 10, 6, 12, 0, 0);
const BEFORE: Partial<Report["summary"]> = {
  count: 1000,
  errors: 26,
  rps: 240,
  mean_ms: 840,
  p95_ms: 2400,
  p99_ms: 3000,
};
const AFTER: Partial<Report["summary"]> = {
  count: 1000,
  errors: 3,
  rps: 252,
  mean_ms: 620,
  p95_ms: 1600,
  p99_ms: 1800,
};
const STEPS = [{ id: "s1", name: "접수", assert: [200] }];

function makeDoc(b: Partial<SceneRun> = {}, a: Partial<SceneRun> = {}): CompareDoc {
  const before = sceneModel({
    id: "01HBEFORE000abc111",
    summary: BEFORE,
    meta: { label: "릴리즈 전" },
    ...b,
  });
  const after = sceneModel({
    id: "01HAFTER0000def222",
    summary: AFTER,
    meta: { label: "릴리즈 후" },
    ...a,
  });
  return buildCompareDoc({ before, after, fallbackScenarioName: null, now: NOON });
}

function renderDoc(
  doc: CompareDoc,
  kind: "standard" | "summary" = "standard",
  onLadder?: (level: number) => void,
) {
  const view = render(<CompareDocument doc={doc} kind={kind} onLadder={onLadder} />);
  const root = view.container.querySelector(".p-doc") as HTMLElement;
  return { ...view, root };
}

async function ready(root: HTMLElement) {
  await waitFor(() => expect(root).toHaveAttribute("data-layout-ready", "true"));
}

/** jsdom은 레이아웃이 없다 — data-measure 값으로 높이(mm)를 정한다. */
function spyHeights(mmFor: (id: string) => number) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const h = mmFor(this.getAttribute("data-measure") ?? "") * PX_PER_MM;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: h,
      width: 0,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const starDoc = () =>
  makeDoc(
    {
      steps: [{ id: "s1", name: "접수" }],
      rep: [{ id: "s1", counts: { "200": 9400, "502": 600 }, errors: 0 }],
    },
    { steps: STEPS, rep: [{ id: "s1", counts: { "200": 10000 }, errors: 0 }] },
  );

const kpiRow = (container: HTMLElement, name: string) => {
  const kpi = container.querySelector(".p-cmp-kpi") as HTMLElement;
  return within(kpi).getByText(name).closest("tr") as HTMLElement;
};

afterEach(() => vi.restoreAllMocks());

describe("CompareDocument 표준판", () => {
  it("머리·종합·카드·지표 표·조건 대조·남은 문제·서명란을 한 쪽에 그린다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, container } = renderDoc(makeDoc());
    expect(root).toHaveAttribute("data-layout-ready", "false");
    await ready(root);
    expect(container.querySelectorAll(".p-page").length).toBe(1);

    const pair = container.querySelector(".p-cmp-pair") as HTMLElement;
    expect(pair.textContent).toContain("이전");
    expect(pair.textContent).toContain("이후");
    expect(pair.textContent).toContain("#abc111");
    expect(pair.textContent).toContain("#def222");
    expect(pair.textContent).toContain('"릴리즈 전"');
    expect(pair.textContent).toContain('"릴리즈 후"');

    const vbox = container.querySelector(".p-cmp-vbox") as HTMLElement;
    expect(vbox.textContent).toContain("개선");
    expect(vbox.textContent).toContain("주요 지표 5개 중 4개 좋아짐 · 1개 비슷 · 0개 나빠짐");

    const kpi = container.querySelector(".p-cmp-kpi") as HTMLElement;
    expect(within(kpi).getAllByRole("row").length).toBe(7);
    const errRow = kpiRow(container, "오류율");
    expect(errRow.textContent).toContain("2.6%");
    expect(errRow.textContent).toContain("0.3%");
    expect(errRow.textContent).toContain("좋아짐");
    expect(errRow.textContent).toContain("▼");

    expect(container.querySelectorAll(".p-cmp-fair > div").length).toBe(4);
    const cond = container.querySelector(".p-cmp-cond") as HTMLElement;
    expect([...cond.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "항목",
      "이전",
      "이후",
    ]);
    expect(screen.getByText("남은 문제 없음")).toBeInTheDocument();
    expect(container.querySelector(".p-sign")).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("절 번호는 1·2·3·4", async () => {
    const { root } = renderDoc(makeDoc());
    await ready(root);
    for (const t of ["1. 종합", "2. 핵심 지표 비교", "3. 측정 조건 대조", "4. 남은 문제"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
  });

  it("꼬리말에 footerLeft와 쪽 번호", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    const foot = container.querySelector(".p-foot") as HTMLElement;
    expect(foot.textContent).toContain("이전·이후 비교 · #abc111 → #def222");
    expect(foot.textContent).toContain("1 / 1");
  });

  it("나빠짐은 색이 아니라 기호와 낱말로도 구분된다", async () => {
    const { root, container } = renderDoc(makeDoc({ summary: AFTER }, { summary: BEFORE }));
    await ready(root);
    const errRow = kpiRow(container, "오류율");
    expect(errRow.textContent).toContain("▲");
    expect(errRow.textContent).toContain("나빠짐");
    expect(container.querySelector(".p-cmp-vbox")?.textContent).toContain("악화");
  });

  it("조건이 달라 참고용이면 회색 변형 상자와 문구", async () => {
    const doc = starDoc();
    expect(doc.headline.reference).toBe(true);
    const { root, container } = renderDoc(doc);
    await ready(root);
    const vbox = container.querySelector(".p-cmp-vbox") as HTMLElement;
    expect(vbox).toHaveClass("p-cmp-vbox--ref");
    expect(vbox.textContent).toContain("조건이 달라 참고용");
  });

  it("각주와 오류율 행의 참고용", async () => {
    const doc = starDoc();
    expect(doc.starNote).not.toBeNull();
    const { root, container } = renderDoc(doc);
    await ready(root);
    expect(kpiRow(container, "오류율").textContent).toContain("참고용");
    expect(container.querySelector(".p-cmp-starnote")?.textContent).toBe(doc.starNote);
  });

  it("한눈에 보기 막대는 행마다 두 개이고 폭이 비율이다", async () => {
    const doc = makeDoc();
    const { root, container } = renderDoc(doc);
    await ready(root);
    const bars = container.querySelectorAll(".p-cmp-kpi .p-cmp-bar");
    expect(bars.length).toBe(12);
    const w = (el: Element) => parseFloat((el as HTMLElement).style.width);
    doc.rows.forEach((r, i) => {
      expect(w(bars[i * 2])).toBeCloseTo(r.barBefore * 100, 1);
      expect(w(bars[i * 2 + 1])).toBeCloseTo(r.barAfter * 100, 1);
    });
    expect(w(bars[0])).toBe(100);
    expect(w(bars[1])).toBeCloseTo(11.5, 1);
  });

  it("남은 문제는 최대 8개 + 외 N개", async () => {
    const issues = Array.from({ length: 10 }, (_, i) => `문제 ${i + 1}`);
    const { root, container } = renderDoc({ ...makeDoc(), issues });
    await ready(root);
    const box = container.querySelector(".p-cmp-issues") as HTMLElement;
    expect(box.querySelectorAll("li").length).toBe(8);
    expect(within(box).getByText("외 2개")).toBeInTheDocument();
    expect(screen.queryByText("남은 문제 없음")).toBeNull();
  });

  it("비교 불가면 남은 문제 상자는 '확인하지 않았다'고 한다(없음이 아니라)", async () => {
    const doc = makeDoc({ summary: { count: 0, errors: 0, rps: 0 } });
    expect(doc.incomparable).toBe(true);
    expect(doc.issues).toEqual([]);
    const { root, container } = renderDoc(doc);
    await ready(root);
    const box = container.querySelector(".p-cmp-issues") as HTMLElement;
    expect(box.textContent).toContain("요청이 실행되지 않은 측정이 있어 확인하지 않았습니다");
    expect(screen.queryByText("남은 문제 없음")).toBeNull();
  });

  it("실패 사유는 사유마다 한 요소로, 글자 그대로 그린다", async () => {
    const lines = [
      {
        id: 1 as const,
        text: "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.",
        reasons: [
          { side: "이전", text: "<b>worker</b> exit 1" },
          { side: "이후", text: "connection refused" },
        ],
      },
    ];
    const { root, container } = renderDoc({ ...makeDoc(), lines });
    await ready(root);
    const reasons = container.querySelectorAll(".p-cmp-reason");
    expect(reasons.length).toBe(2);
    expect(reasons[0].textContent).toBe("이전 측정 사유 <b>worker</b> exit 1");
    expect(reasons[1].textContent).toBe("이후 측정 사유 connection refused");
    expect(container.querySelector(".p-cmp-reason b")).toBeNull();
    expect(reasons[0]).not.toHaveClass("p-cmp-clamp1");
  });

  it("조건 대조 표가 쪽을 넘으면 (이어짐) 제목이 붙고 서명란은 한 번", async () => {
    spyHeights((id) => (id.startsWith("cmp:cond:row:") ? 60 : 5));
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    expect(container.querySelectorAll(".p-page").length).toBeGreaterThan(1);
    expect(screen.getByRole("heading", { name: "3. 측정 조건 대조 (이어짐)" })).toBeInTheDocument();
    expect(container.querySelectorAll(".p-sign").length).toBe(1);
  });

  it("측정 시트는 표준판 블록 전부를 data-measure로 낸다(조건 대조는 제목·머리·행마다)", async () => {
    const doc = makeDoc();
    const { container, root } = renderDoc(doc);
    const measured = new Set(
      [...container.querySelectorAll(".p-sheet [data-measure]")].map((e) =>
        e.getAttribute("data-measure"),
      ),
    );
    const want = compareStandardBlocks(doc, new Map())
      .filter((b) => b.kind === "atomic")
      .map((b) => b.id);
    expect(want).toContain("cmp:issues:8");
    for (const id of want) expect(measured.has(id), id).toBe(true);
    expect(measured.has(CMP_IDS.condTitle)).toBe(true);
    expect(measured.has(CMP_IDS.condHeader)).toBe(true);
    expect(doc.fairness.condRows.length).toBeGreaterThan(0);
    doc.fairness.condRows.forEach((_, i) => expect(measured.has(CMP_IDS.condRowId(i))).toBe(true));
    await ready(root);
  });
});

describe("CompareDocument 요약판", () => {
  it("서명란·조건 대조 표가 없고 절 번호는 1·2·3, 1장", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root, container } = renderDoc(makeDoc(), "summary");
    await ready(root);
    expect(container.querySelector(".p-sign")).toBeNull();
    expect(container.querySelector(".p-cmp-cond")).toBeNull();
    for (const t of ["1. 종합", "2. 핵심 지표 비교", "3. 남은 문제"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".p-page").length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("남은 문제는 최대 5개 + 외 N개 — 표준판 참조, 항목·사유는 줄 수를 자른다", async () => {
    const issues = Array.from({ length: 7 }, (_, i) => `문제 ${i + 1}`);
    const lines = [{ id: 1 as const, text: "본문", reasons: [{ side: "이전", text: "사유" }] }];
    const { root, container } = renderDoc({ ...makeDoc(), issues, lines }, "summary");
    await ready(root);
    const box = container.querySelector(".p-cmp-issues") as HTMLElement;
    expect(box.querySelectorAll("li").length).toBe(5);
    expect(within(box).getByText("외 2개 — 표준판 참조")).toBeInTheDocument();
    expect(box.querySelector("li > span")).toHaveClass("p-cmp-clamp2");
    expect(container.querySelector(".p-cmp-reason")).toHaveClass("p-cmp-clamp1");
  });

  it("측정 시트: 사다리 칸 0..5의 모든 블록 id가 배치 전에 data-measure로 있다", async () => {
    const doc = makeDoc();
    const { container, root } = renderDoc(doc, "summary");
    expect(root).toHaveAttribute("data-layout-ready", "false");
    const measured = new Set(
      [...container.querySelectorAll(".p-sheet [data-measure]")].map((e) =>
        e.getAttribute("data-measure"),
      ),
    );
    const none: Heights = new Map();
    const want = new Set<string>();
    for (let l = 0; l <= CMP_LAST_LEVEL; l++) {
      for (const b of compareSummaryBlocks(doc, none, l)) want.add(b.id);
    }
    expect(want.size).toBeGreaterThan(8);
    for (const id of want) expect(measured.has(id), id).toBe(true);
    expect(
      compareSheetBlocks(doc, "summary")
        .map((b) => b.id)
        .sort(),
    ).toEqual([...want].sort());
    for (const id of ["cmp:kpi:plain", "cmp:lines:short", "cmp:cards:line", "cmp:issues:1"]) {
      expect(measured.has(id), id).toBe(true);
    }
    await ready(root);
  });

  it("넘치면 사다리를 올리고 onLadder로 칸 번호를 알린다", async () => {
    spyHeights((id) => (id === "cmp:kpi:bars" ? 200 : 20));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onLadder = vi.fn();
    const { root, container } = renderDoc(makeDoc(), "summary", onLadder);
    await ready(root);
    await waitFor(() => expect(onLadder).toHaveBeenCalledWith(1));
    expect(container.querySelectorAll(".p-page").length).toBe(1);
    expect(container.querySelector(".p-cmp-bar")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("1장에 못 넣으면 기존과 같은 형식으로 경고하고 그대로 낸다", async () => {
    spyHeights(() => 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { root } = renderDoc(makeDoc(), "summary");
    await ready(root);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[print] summary does not fit one page"),
    );
  });
});
