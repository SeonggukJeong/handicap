import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { Report } from "../../../api/schemas";
import { PX_PER_MM } from "../../paginate";
import type { Heights } from "../../buildPrintDoc";
import { CompareDocument } from "../CompareDocument";
import { VerdictRow } from "../components/HeadlineBox";
import {
  CMP_IDS,
  CMP_LAST_LEVEL,
  buildCompareDoc,
  compareSheetBlocks,
  compareStandardBlocks,
  compareSummaryBlocks,
  type CompareDoc,
} from "../buildCompareDoc";
import { baseProfile } from "./fixtures";
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

const CRIT_PROFILE = { ...baseProfile, criteria: { max_p95_ms: 3000 } };
const crit = (passed: boolean) => ({
  metric: "p95_ms",
  direction: "max" as const,
  threshold: 3000,
  actual: passed ? 1600 : 3500,
  passed,
});

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
    expect(vbox.textContent).toContain("주요 지표 5개 중");
    expect(vbox.textContent).toContain("4개 좋아짐 · 1개 비슷");
    expect(vbox.textContent).toContain("0개 나빠짐");

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

  it("결과 상자와 요약 문장은 한 .p-cmp-verdict 안에 나란히 있다", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    const verdict = container.querySelector(".p-page .p-cmp-verdict") as HTMLElement;
    expect(verdict.querySelector(".p-cmp-vbox")).not.toBeNull();
    expect(verdict.querySelector(".p-cmp-summary")).not.toBeNull();
    expect(verdict.querySelectorAll(".p-cmp-summary li").length).toBe(makeDoc().lines.length);
  });

  it("종합 블록(cmp:headline)은 제목만, 결과 상자는 줄 블록 쪽에 있다", async () => {
    const { container, root } = renderDoc(makeDoc());
    const head = container.querySelector('.p-sheet [data-measure="cmp:headline"]') as HTMLElement;
    expect(head.textContent).toContain("1. 종합");
    expect(head.querySelector(".p-cmp-vbox")).toBeNull();
    const full = container.querySelector('.p-sheet [data-measure="cmp:lines:full"]') as HTMLElement;
    expect(full.querySelector(".p-cmp-verdict .p-cmp-vbox")).not.toBeNull();
    expect(full.querySelector(".p-cmp-verdict .p-cmp-summary")).not.toBeNull();
    await ready(root);
  });

  it("절 제목: 번호 칸(.p-cmp-no)이 '1. '이고 제목 글은 그 뒤의 따로 된 글 마디다", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    const h2 = screen.getByRole("heading", { name: "1. 종합" });
    expect(h2.textContent).toBe("1. 종합");
    const no = h2.querySelector(".p-cmp-no") as HTMLElement;
    expect(no.textContent).toBe("1. ");
    expect(h2.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(h2.lastChild?.textContent).toBe("종합");
    expect(container.querySelector(".p-sign")?.closest(".p-block")?.className).toBe("p-block");
  });

  it("남은 문제 상자: 항목이 있을 때만 ▲, 없음·비교 불가에는 없다", async () => {
    const a = renderDoc({ ...makeDoc(), issues: ["문제 하나"] });
    await ready(a.root);
    expect(screen.getByRole("heading", { name: /남은 문제/, level: 2 }).textContent).toContain("▲");
    expect(a.container.querySelector(".p-cmp-issues .p-cmp-warn")).toBeNull();
    a.unmount();

    const b = renderDoc(makeDoc());
    await ready(b.root);
    expect(
      within(screen.getByRole("heading", { name: /남은 문제/, level: 2 })).queryByText("▲"),
    ).toBeNull();
    b.unmount();

    const c = renderDoc(makeDoc({ summary: { count: 0, errors: 0, rps: 0 } }));
    await ready(c.root);
    expect(
      within(screen.getByRole("heading", { name: /남은 문제/, level: 2 })).queryByText("▲"),
    ).toBeNull();
  });

  it("결과 상자 개수: 세 부분이 클래스 있는 따로 요소, 판정 변화는 줄바꿈 없는 한 요소", async () => {
    const { root, container } = renderDoc(
      makeDoc(
        { profile: CRIT_PROFILE, verdict: { passed: false, criteria: [crit(false)] } },
        { profile: CRIT_PROFILE, verdict: { passed: true, criteria: [crit(true)] } },
      ),
    );
    await ready(root);
    const small = container.querySelector(".p-cmp-vbox-small") as HTMLElement;
    expect(small.querySelector(".p-cmp-vbox-total")?.textContent).toBe("주요 지표 5개 중");
    expect(small.querySelector("b.p-cmp-ok")?.textContent).toBe("4개 좋아짐");
    expect(small.querySelector("b.p-cmp-same")?.textContent).toBe("1개 비슷");
    expect(small.querySelector("b.p-cmp-bad")?.textContent).toBe("0개 나빠짐");
    const change = small.querySelector(".p-cmp-vbox-verdict") as HTMLElement;
    expect(change.textContent).toBe("판정 ✕ → ●");
    expect(small.querySelectorAll(".p-cmp-vbox-verdict")).toHaveLength(1);
  });

  it("결과 상자: 판정 신호가 없으면 판정 변화 줄이 없고, 비교 불가는 안내 글 그대로", async () => {
    const a = renderDoc(makeDoc());
    await ready(a.root);
    expect(a.container.querySelector(".p-cmp-vbox-verdict")).toBeNull();
    expect(a.container.querySelector(".p-cmp-vbox-small b.p-cmp-ok")).not.toBeNull();
    a.unmount();
    const b = renderDoc(makeDoc({ summary: { count: 0, errors: 0, rps: 0 } }));
    await ready(b.root);
    const small = b.container.querySelector(".p-cmp-vbox-small") as HTMLElement;
    expect(small.textContent).toBe("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다");
    expect(small.querySelector("b")).toBeNull();
  });

  it("공정 비교 카드 넷의 제목이 글로 있다", async () => {
    const doc = makeDoc();
    const { root, container } = renderDoc(doc);
    await ready(root);
    const cards = [...container.querySelectorAll(".p-cmp-fair > div")];
    expect(cards.length).toBe(4);
    doc.fairness.cards.forEach((c, i) => expect(cards[i].textContent).toContain(c.title));
    expect(doc.fairness.cards.map((c) => c.title)).toEqual([
      "부하 조건",
      "환경 변수",
      "시나리오 내용",
      "판정 기준",
    ]);
  });

  it("실행 판정 글자의 색은 글자 모양이 아니라 판정 종류로 정해진다", async () => {
    const base = makeDoc();
    const doc: CompareDoc = {
      ...base,
      before: { ...base.before, verdictKind: "fail", verdictText: "가나다" },
      after: { ...base.after, verdictKind: "pass", verdictText: "라마바" },
    };
    const { root, container } = renderDoc(doc);
    await ready(root);
    const runs = container.querySelectorAll(".p-page .p-cmp-run");
    expect(runs[0].querySelector(".p-cmp-bad")?.textContent).toBe("가나다");
    expect(runs[1].querySelector(".p-cmp-ok")?.textContent).toBe("라마바");
  });

  it("절 번호는 1–7", async () => {
    const { root } = renderDoc(makeDoc());
    await ready(root);
    for (const t of [
      "1. 종합",
      "2. 핵심 지표 비교",
      "3. 단계별 95% 응답시간 변화",
      "4. 단계별 오류 변화",
      "5. 시간에 따른 변화 — 겹쳐 보기",
      "6. 측정 조건 대조",
      "7. 남은 문제",
    ]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
  });

  it("꼬리말에 제목·측정 번호·쪽 번호", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    const foot = container.querySelector(".p-page .p-foot") as HTMLElement;
    expect(foot.textContent).toContain("이전·이후 비교 · #abc111 → #def222");
    expect(foot.textContent).toContain("1 / 1");
  });

  it("꼬리말: 긴 제목은 제목 칸만 말줄임되고 측정 번호·가운데 글·쪽 번호는 따로 줄지 않는 칸", async () => {
    const long = "아주 긴 시나리오 이름 ".repeat(12).trim();
    const { root, container } = renderDoc(
      makeDoc(
        { yaml: `version: 1\nname: "${long}"\nsteps: []\n` },
        { yaml: `version: 1\nname: "${long}"\nsteps: []\n` },
      ),
    );
    await ready(root);
    const foot = container.querySelector(".p-page .p-foot") as HTMLElement;
    const left = foot.children[0] as HTMLElement;
    expect(left).toHaveClass("p-cmp-foot-left");
    const title = left.querySelector(".p-cmp-foot-title") as HTMLElement;
    const ids = left.querySelector(".p-cmp-foot-ids") as HTMLElement;
    expect(title.textContent).toBe(`${long} 이전·이후 비교`);
    expect(ids.textContent).toBe(" · #abc111 → #def222");
    expect(title.contains(ids)).toBe(false);
    expect(foot.children[1]).toHaveClass("p-cmp-foot-fixed");
    expect(foot.children[1].textContent).toBe("Handicap 부하 테스트 도구로 생성");
    expect(foot.children[2]).toHaveClass("p-cmp-foot-fixed");
    expect(foot.children[2].textContent).toBe("1 / 1");
  });

  it("짝 상자의 판정 줄: 판정한 측정은 '판정 ' 뒤에 낱말, 판정 안 함은 앞말 없이", async () => {
    const { root, container } = renderDoc(
      makeDoc(
        { profile: CRIT_PROFILE, verdict: { passed: false, criteria: [crit(false)] } },
        {
          summary: { count: 0, errors: 0, rps: 0 },
          meta: { label: "릴리즈 후", status: "failed" },
        },
      ),
    );
    await ready(root);
    const runs = container.querySelectorAll(".p-page .p-cmp-run");
    expect(runs[0].textContent).toMatch(/ · 판정 ✕ 부적합$/);
    expect(runs[1].querySelector(".p-cmp-same")?.textContent).toBe("판정 안 함");
    expect(runs[1].textContent).toMatch(/ · 판정 안 함$/);
    expect(runs[1].textContent).not.toMatch(/판정\s*판정/);
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
    const big = vbox.querySelector(".p-cmp-vbox-big") as HTMLElement;
    expect(big.textContent).toBe("※ 참고용");
    expect(vbox.textContent).not.toContain("개선");
    expect(vbox.textContent).not.toContain("악화");
    expect(vbox.querySelector(".p-cmp-vbox-ref")?.textContent).toBe("조건이 달라 단정하지 않음");
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
        parts: [{ text: "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다." }],
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

  it("요약 문장: 판정 낱말은 판정 색의 <b>, 값은 굵게, 단계·측정 이름 속 <b>는 글자 그대로", async () => {
    const steps = [{ id: "s1", name: "<b>접수</b>", assert: [200] }];
    const { root, container } = renderDoc(
      makeDoc(
        {
          steps,
          profile: CRIT_PROFILE,
          verdict: { passed: false, criteria: [crit(false)] },
          rep: [{ id: "s1", counts: { "200": 900, "503": 100 }, errors: 26 }],
          meta: { label: "<b>전</b>" },
        },
        {
          steps,
          profile: CRIT_PROFILE,
          verdict: { passed: true, criteria: [crit(true)] },
          rep: [{ id: "s1", counts: { "200": 1000 }, errors: 3 }],
        },
      ),
    );
    await ready(root);
    const items = container.querySelectorAll(".p-page .p-cmp-summary li");
    const first = [...items[0].querySelectorAll("b")];
    expect(first.map((b) => [b.className, b.textContent])).toEqual([
      ["p-cmp-bad", "✕ 부적합"],
      ["p-cmp-ok", "● 적합"],
    ]);
    expect(items[0].textContent).toBe(
      "판정이 ✕ 부적합 → ● 적합으로 바뀌었습니다. 기준 1개를 모두 지켰습니다.",
    );
    const second = [...items[1].querySelectorAll("b")];
    expect(second.map((b) => [b.className, b.textContent])).toEqual([
      ["", "오류율 2.6% → 0.3%"],
      ["", "503 서버가 바쁨 100건이 0건"],
    ]);
    expect(items[1].textContent).toContain("'① <b>접수</b>'의 ");
    expect(items[1].querySelectorAll("b")).toHaveLength(2);
    const run = container.querySelector(".p-page .p-cmp-run") as HTMLElement;
    expect(run.querySelector(".p-cmp-runlabel")?.textContent).toBe('"<b>전</b>"');
    expect(run.querySelector(".p-cmp-runlabel b")).toBeNull();
  });

  it("조건 대조 표가 쪽을 넘으면 (이어짐) 제목이 붙고 서명란은 한 번", async () => {
    spyHeights((id) => (id.startsWith("cmp:cond:row:") ? 60 : 5));
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    expect(container.querySelectorAll(".p-page").length).toBeGreaterThan(1);
    expect(screen.getByRole("heading", { name: "6. 측정 조건 대조 (이어짐)" })).toBeInTheDocument();
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

describe("CompareDocument 오류 변화 절", () => {
  it("측정 시트에 오류 표의 제목·머리·행이 있다", async () => {
    const { container, root } = renderDoc(makeDoc());
    for (const id of ["cmp:err:title", "cmp:err:header", "cmp:err:row:0"]) {
      expect(container.querySelector(`.p-sheet [data-measure="${id}"]`), id).not.toBeNull();
    }
    await ready(root);
  });

  it("쪽에 4절 제목과 오류 표가 있다", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    expect(screen.getByRole("heading", { name: "4. 단계별 오류 변화" })).toBeInTheDocument();
    expect(container.querySelector(".p-page table.p-cmp-err")).not.toBeNull();
  });

  it("각주가 있으면 cmp:err:notes가 p-cmp-b--note 블록으로 측정되고 쪽에 그려진다", async () => {
    const base = makeDoc();
    const doc: CompareDoc = {
      ...base,
      errors: { ...base.errors, notes: ["* 각주 한 줄", "둘째 줄"] },
    };
    const { container, root } = renderDoc(doc);
    expect(container.querySelector('.p-sheet [data-measure="cmp:err:notes"]')).not.toBeNull();
    await ready(root);
    const notes = [...container.querySelectorAll(".p-page .p-cmp-note")];
    const mine = notes.filter((n) => ["* 각주 한 줄", "둘째 줄"].includes(n.textContent ?? ""));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.closest(".p-block")).toHaveClass("p-cmp-b--note");
  });

  it("요약판에는 오류 절이 없다", async () => {
    const { root } = renderDoc(makeDoc(), "summary");
    await ready(root);
    expect(screen.queryByText(/단계별 오류 변화/)).toBeNull();
  });
});

describe("CompareDocument 덤벨 절", () => {
  it("측정 시트에 덤벨 표의 제목·머리·행·범례가 있다", async () => {
    const { container, root } = renderDoc(makeDoc());
    for (const id of ["cmp:db:title", "cmp:db:header", "cmp:db:row:0", "cmp:db:legend"]) {
      expect(container.querySelector(`.p-sheet [data-measure="${id}"]`), id).not.toBeNull();
    }
    await ready(root);
  });

  it("쪽에 3절 제목·덤벨 표·범례(p-cmp-b--note)가 있고 조건 대조는 6절", async () => {
    const { root, container } = renderDoc(makeDoc());
    await ready(root);
    expect(
      screen.getByRole("heading", { name: "3. 단계별 95% 응답시간 변화" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "6. 측정 조건 대조" })).toBeInTheDocument();
    expect(container.querySelector(".p-page table.p-cmp-db")).not.toBeNull();
    const legend = container.querySelector(".p-page .p-cmp-db-legend") as HTMLElement;
    expect(legend.closest(".p-block")).toHaveClass("p-cmp-b--note");
  });

  it("단계가 없으면 덤벨 절이 없고 번호를 당긴다", async () => {
    const { root } = renderDoc(makeDoc({ steps: [], rep: [] }, { steps: [], rep: [] }));
    await ready(root);
    expect(screen.queryByText(/단계별 95% 응답시간 변화/)).toBeNull();
    expect(screen.queryByText(/단계별 오류 변화/)).toBeNull();
    expect(screen.getByRole("heading", { name: "4. 측정 조건 대조" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "5. 남은 문제" })).toBeInTheDocument();
  });

  it("요약판에는 덤벨 절이 없다", async () => {
    const { root } = renderDoc(makeDoc(), "summary");
    await ready(root);
    expect(screen.queryByText(/단계별 95% 응답시간 변화/)).toBeNull();
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
    const lines = [
      {
        id: 1 as const,
        text: "본문",
        parts: [{ text: "본문" }],
        reasons: [{ side: "이전", text: "사유" }],
      },
    ];
    const { root, container } = renderDoc({ ...makeDoc(), issues, lines }, "summary");
    await ready(root);
    const box = container.querySelector(".p-cmp-issues") as HTMLElement;
    expect(box.querySelectorAll("li").length).toBe(5);
    expect(within(box).getByText("외 2개 — 표준판 참조")).toBeInTheDocument();
    expect(box.querySelector("li > span")).toHaveClass("p-cmp-clamp2");
    expect(container.querySelector(".p-cmp-reason")).toHaveClass("p-cmp-clamp1");
  });

  it("요약판 깊은 칸: 쪽에 한 줄 공정 비교·짧은 요약·결과 상자·지표 6행·남은 문제가 있다", async () => {
    spyHeights((id) =>
      id === "cmp:kpi:bars" || id === "cmp:lines:full" || id === "cmp:cards" ? 200 : 20,
    );
    const onLadder = vi.fn();
    const doc = makeDoc();
    const { root, container } = renderDoc(doc, "summary", onLadder);
    await ready(root);
    await waitFor(() => expect(onLadder).toHaveBeenLastCalledWith(4));
    const page = container.querySelector(".p-page") as HTMLElement;
    expect(container.querySelectorAll(".p-page").length).toBe(1);
    expect(page.querySelector(".p-cmp-fairline")?.textContent).toBe(doc.fairness.oneLine);
    expect(page.querySelector(".p-cmp-fair")).toBeNull();
    const verdict = page.querySelector(".p-cmp-verdict") as HTMLElement;
    expect(verdict.querySelector(".p-cmp-vbox")).not.toBeNull();
    const shown = [...verdict.querySelectorAll(".p-cmp-summary li")].map((li) => li.textContent);
    expect(shown.length).toBe(doc.lines.filter((l) => l.id === 1 || l.id === 4).length);
    expect(shown[0]).toContain(doc.lines.find((l) => l.id === 1)?.text);
    expect(page.querySelectorAll(".p-cmp-kpi tbody tr").length).toBe(6);
    expect(page.querySelector(".p-cmp-bar")).toBeNull();
    expect(page.querySelector(".p-cmp-issues")).not.toBeNull();
  });

  it("줄 수 자르기 클래스는 요약판에만 붙는다", async () => {
    const issues = ["문제 하나"];
    const lines = [
      {
        id: 1 as const,
        text: "본문",
        parts: [{ text: "본문" }],
        reasons: [{ side: "이전", text: "사유" }],
      },
    ];
    const clampSel = [
      ".p-cmp-runlabel",
      ".p-cmp-fairline",
      ".p-cmp-starnote",
      ".p-cmp-issues li > span",
      ".p-cmp-reason",
    ];
    const base = starDoc();
    expect(base.starNote).not.toBeNull();
    const doc = { ...base, issues, lines };
    const sum = renderDoc(doc, "summary");
    await ready(sum.root);
    // 한 줄 공정 비교는 깊은 칸에서만 그려지므로 같은 글 요소를 표준판 카드와 구분해 따로 확인한다.
    for (const sel of clampSel.filter((x) => x !== ".p-cmp-fairline")) {
      expect(sum.container.querySelector(`.p-page ${sel}`), sel).toHaveClass(
        sel === ".p-cmp-issues li > span" ? "p-cmp-clamp2" : "p-cmp-clamp1",
      );
    }
    sum.unmount();
    const std = renderDoc(doc, "standard");
    await ready(std.root);
    for (const sel of clampSel.filter((x) => x !== ".p-cmp-fairline")) {
      const el = std.container.querySelector(`.p-page ${sel}`);
      expect(el, sel).not.toBeNull();
      expect(el?.className ?? "", sel).not.toMatch(/p-cmp-clamp/);
    }
  });

  it("한 줄 공정 비교도 요약판에서만 한 줄로 자른다", async () => {
    spyHeights((id) =>
      id === "cmp:kpi:bars" || id === "cmp:lines:full" || id === "cmp:cards" ? 200 : 20,
    );
    const { root, container } = renderDoc(makeDoc(), "summary");
    await ready(root);
    await waitFor(() =>
      expect(container.querySelector(".p-page .p-cmp-fairline")).toHaveClass("p-cmp-clamp1"),
    );
  });

  it("요약판(높이 미측정, 0칸): 결과 상자와 요약 문장이 한 .p-cmp-verdict 안에 있다", async () => {
    const { root, container } = renderDoc(makeDoc(), "summary");
    await ready(root);
    const verdict = container.querySelector(".p-page .p-cmp-verdict") as HTMLElement;
    expect(verdict.querySelector(".p-cmp-vbox")).not.toBeNull();
    expect(verdict.querySelector(".p-cmp-summary")).not.toBeNull();
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

describe("CompareDocument 응답 속도 구간 비교 절", () => {
  const OVERALL = {
    slow_ms: 3000,
    basis: "p95" as const,
    own: false,
    fast: 580,
    within: 330,
    over: 90,
  };
  const speedDoc = (): CompareDoc => {
    const d = makeDoc();
    const before = sceneModel({ id: "01HBEFORE000abc111", summary: BEFORE });
    const after = sceneModel({ id: "01HAFTER0000def222", summary: AFTER });
    const sp = (m: typeof before) => ({
      ...m,
      report: { ...m.report, speed_bands: { overall: OVERALL, steps: [] } },
    });
    expect(d.speed).toBeNull();
    return buildCompareDoc({
      before: sp(before),
      after: sp(after),
      fallbackScenarioName: null,
      now: NOON,
    });
  };

  it("있으면 6절 제목·표(p-cmp-b--section 블록)가 그려지고 조건 대조는 7절", async () => {
    const { container, root } = renderDoc(speedDoc());
    expect(container.querySelector('.p-sheet [data-measure="cmp:speed"]')).not.toBeNull();
    await ready(root);
    expect(
      screen.getByRole("heading", { name: "6. 응답 속도 구간 비교 (전체 요청)" }),
    ).toBeInTheDocument();
    const table = container.querySelector(".p-page table.p-cmp-spd") as HTMLElement;
    expect(table).not.toBeNull();
    expect(table.closest(".p-block")).toHaveClass("p-cmp-b--section");
    expect(screen.getByRole("heading", { name: "7. 측정 조건 대조" })).toBeInTheDocument();
    expect(container.querySelector(".p-page")?.innerHTML).not.toContain("NaN");
  });

  it("없으면 6절은 측정 조건 대조", async () => {
    const { root } = renderDoc(makeDoc());
    await ready(root);
    expect(screen.getByRole("heading", { name: "6. 측정 조건 대조" })).toBeInTheDocument();
    expect(screen.queryByText(/응답 속도 구간 비교/)).toBeNull();
  });
});

describe("CompareDocument 겹쳐 보기 절", () => {
  it("측정 시트에 cmp:overlay가 있고 쪽에 5절 제목·그림(p-cmp-b--section 블록)이 그려진다", async () => {
    const { container, root } = renderDoc(makeDoc());
    expect(container.querySelector('.p-sheet [data-measure="cmp:overlay"]')).not.toBeNull();
    await ready(root);
    expect(
      screen.getByRole("heading", { name: "5. 시간에 따른 변화 — 겹쳐 보기" }),
    ).toBeInTheDocument();
    const svg = container.querySelector(".p-page svg.p-cmp-ov") as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.closest(".p-block")).toHaveClass("p-cmp-b--section");
    expect(container.querySelector(".p-page")?.innerHTML).not.toContain("NaN");
  });

  it("요약판에는 겹쳐 보기가 없다", async () => {
    const { root } = renderDoc(makeDoc(), "summary");
    await ready(root);
    expect(screen.queryByText(/겹쳐 보기/)).toBeNull();
  });
});

describe("HeadlineBox 준비 실패 수 줄(5번)", () => {
  const withSetup = (failed: number) => (m: ReturnType<typeof sceneModel>) => ({
    ...m,
    report: { ...m.report, setup: { ok: 10, failed, interrupted: 0, steps: [] } },
  });
  const setupDoc = () =>
    buildCompareDoc({
      before: withSetup(0)(sceneModel({ id: "01HBEFORE000abc111", summary: BEFORE })),
      after: withSetup(3)(sceneModel({ id: "01HAFTER0000def222", summary: AFTER })),
      fallbackScenarioName: null,
      now: NOON,
    });
  const LINE = "준비에 실패한 사용자가 0명에서 3명으로 늘었습니다.";
  const itemsOf = (c: HTMLElement) =>
    [...c.querySelectorAll(".p-cmp-summary li")].map((li) => li.textContent);

  it("긴 판에는 li로 그려지고 key 경고가 없다", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = setupDoc();
    expect(doc.lines.some((l) => l.id === 5)).toBe(true);
    const { container } = render(<VerdictRow doc={doc} short={false} clamp={false} />);
    expect(itemsOf(container)).toContain(LINE);
    expect(err).not.toHaveBeenCalled();
  });

  it("짧은 판에는 그려지지 않는다", () => {
    const { container } = render(<VerdictRow doc={setupDoc()} short clamp={false} />);
    expect(itemsOf(container)).not.toContain(LINE);
    expect(itemsOf(container).length).toBeGreaterThan(0);
  });
});
