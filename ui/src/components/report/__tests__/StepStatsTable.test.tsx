import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { StepStatsTable } from "../StepStatsTable";
import { ko } from "../../../i18n/ko";

// 작업 전 코드가 그린 바깥 표(접힌 상태) — 바이트 그대로 고정. 다시 찍지 말 것.
const OLD_TABLE_HTML = `<table class="min-w-full text-sm"><thead class="border-b border-slate-200 text-left text-slate-600"><tr><th class="py-2 pr-4 font-medium">스텝</th><th class="py-2 pr-4 font-medium">메서드</th><th class="py-2 pr-4 font-medium">URL</th><th class="py-2 pr-4 font-medium">요청 수</th><th class="py-2 pr-4 font-medium">에러</th><th class="py-2 pr-4 font-medium">p50 ms<span class="inline-block"><button type="button" aria-label="p50 설명" aria-expanded="false" class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100">?</button></span></th><th class="py-2 pr-4 font-medium">p95 ms<span class="inline-block"><button type="button" aria-label="p95 설명" aria-expanded="false" class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100">?</button></span></th><th class="py-2 pr-4 font-medium">p99 ms<span class="inline-block"><button type="button" aria-label="p99 설명" aria-expanded="false" class="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 align-middle text-[10px] leading-none text-slate-500 hover:bg-slate-100">?</button></span></th></tr></thead><tbody><tr class="border-b border-slate-100"><td class="py-2 pr-4 font-medium"><button type="button" aria-expanded="false" aria-label="주문 루프 분해 표시 전환" class="mr-1 text-slate-500">▸</button>주문<span class="ml-2 inline-block shrink-0 whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 align-middle text-xs font-medium text-amber-800">재시도 포함</span></td><td class="py-2 pr-4 font-mono text-xs">GET</td><td class="py-2 pr-4 font-mono text-xs break-all">/a</td><td class="py-2 pr-4">10</td><td class="py-2 pr-4">0</td><td class="py-2 pr-4">1</td><td class="py-2 pr-4">2</td><td class="py-2 pr-4">3</td></tr><tr class="border-b border-slate-100"><td class="py-2 pr-4 font-medium">결제</td><td class="py-2 pr-4 font-mono text-xs">POST</td><td class="py-2 pr-4 font-mono text-xs break-all">/b</td><td class="py-2 pr-4">5</td><td class="py-2 pr-4">0</td><td class="py-2 pr-4">1</td><td class="py-2 pr-4">2</td><td class="py-2 pr-4">3</td></tr></tbody></table>`;

describe("StepStatsTable", () => {
  it("renders rows for each step with metadata when available", () => {
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 100,
            error_count: 2,
            status_counts: { "200": 98, "500": 2 },
            p50_ms: 10,
            p95_ms: 50,
            p99_ms: 90,
            loop_breakdown: [],
          },
          {
            step_id: "stepB",
            count: 50,
            error_count: 0,
            status_counts: { "200": 50 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
            loop_breakdown: [],
          },
        ]}
        meta={meta}
      />,
    );
    const region = screen.getByRole("region", { name: /스텝별 통계/ });
    expect(region).toHaveTextContent("login");
    expect(region).toHaveTextContent("POST");
    expect(region).toHaveTextContent("http://x/login");
    expect(region).toHaveTextContent("100");
    expect(region).toHaveTextContent("stepB"); // missing meta → falls back to id
  });

  it("하나도 보내지 않은 스텝만 응답 시간 칸이 「—」 — 보냈지만 응답을 못 받은 스텝은 잰 시간", () => {
    const base = { loop_breakdown: [], p50_ms: 0, p95_ms: 0, p99_ms: 0 };
    render(
      <StepStatsTable
        steps={[
          {
            ...base,
            step_id: "timeout",
            count: 7,
            error_count: 7,
            status_counts: { "0": 7 },
            p50_ms: 30000,
            p95_ms: 30001,
            p99_ms: 30002,
          },
          { ...base, step_id: "blank", count: 6, error_count: 6, status_counts: {}, not_sent: 6 },
          {
            ...base,
            step_id: "fast",
            count: 5,
            error_count: 0,
            status_counts: { "200": 5 },
          },
        ]}
        meta={new Map()}
      />,
    );
    const cells = (id: string) =>
      within(screen.getByText(id).closest("tr") as HTMLElement)
        .getAllByRole("cell")
        .slice(3)
        .map((c) => c.textContent);
    expect(cells("timeout")).toEqual(["7", "7", "30000", "30001", "30002"]);
    expect(cells("blank")).toEqual(["6", "6", "—", "—", "—"]);
    expect(cells("fast")).toEqual(["5", "0", "0", "0", "0"]);
  });

  it("shows a per-loop drill-down when a step has loop_breakdown", async () => {
    const user = userEvent.setup();
    const steps = [
      {
        step_id: "s",
        count: 6,
        error_count: 0,
        status_counts: { "200": 6 },
        p50_ms: 1,
        p95_ms: 2,
        p99_ms: 3,
        loop_breakdown: [
          { loop_index: 0, count: 3, error_count: 0 },
          { loop_index: 1, count: 2, error_count: 0 },
          { loop_index: null, count: 1, error_count: 0 },
        ],
      },
    ];
    const meta = new Map([["s", { id: "s", name: "tick", method: "GET", url: "/items" }]]);
    render(<StepStatsTable steps={steps as never} meta={meta} />);
    expect(screen.queryByText(/loop_index/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /tick|expand|loop/i }));
    // After expand: the drill-down table header and rows should appear
    expect(screen.getByText(/그 외|상한 초과|overflow/i)).toBeInTheDocument();
    // loop_index column header appears only when expanded (wire field name — R3 keep)
    expect(screen.getByText("loop_index")).toBeInTheDocument();
    // 드릴다운 서브테이블 헤더도 ko 카탈로그 경유(영어 requests/errors 잔존 금지, R1)
    expect(screen.getAllByText(ko.report.colRequests).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(ko.report.colErrors).length).toBeGreaterThanOrEqual(2);
  });

  it("renders no drill-down caret when loop_breakdown is empty", () => {
    const steps = [
      {
        step_id: "s",
        count: 6,
        error_count: 0,
        status_counts: {},
        p50_ms: 1,
        p95_ms: 2,
        p99_ms: 3,
        loop_breakdown: [],
      },
    ];
    render(<StepStatsTable steps={steps as never} meta={new Map()} />);
    expect(screen.queryByRole("button", { name: /루프 분해 표시 전환/ })).not.toBeInTheDocument();
  });

  it("shows download columns only when a step has download", () => {
    const emptyMeta = new Map<string, { id: string; name: string; method: string; url: string }>();
    const { rerender } = render(
      <StepStatsTable
        steps={[
          {
            step_id: "s1",
            count: 1,
            error_count: 0,
            status_counts: {},
            p50_ms: 5,
            p95_ms: 9,
            p99_ms: 9,
          },
        ]}
        meta={emptyMeta}
      />,
    );
    expect(screen.queryByText(/다운로드 p50/)).toBeNull();
    rerender(
      <StepStatsTable
        steps={[
          {
            step_id: "s1",
            count: 1,
            error_count: 0,
            status_counts: {},
            p50_ms: 5,
            p95_ms: 9,
            p99_ms: 9,
            download: { count: 1, p50_ms: 3, p95_ms: 7, p99_ms: 7, max_ms: 8 },
          },
        ]}
        meta={emptyMeta}
      />,
    );
    expect(screen.getByText(/다운로드 p50/)).toBeInTheDocument();
    // Download column headers include "ms" unit (consistency with p50 ms / p95 ms / p99 ms)
    expect(screen.getByText("다운로드 p50 ms")).toBeInTheDocument();
    expect(screen.getByText("다운로드 p95 ms")).toBeInTheDocument();
    expect(screen.getByText("다운로드 p99 ms")).toBeInTheDocument();
  });

  it("표 헤더가 한국어이고 p50/p95/p99에 용어 도움말이 있다", async () => {
    const user = userEvent.setup();
    const meta = new Map([
      ["stepA", { id: "stepA", name: "login", method: "POST", url: "http://x/login" }],
    ]);
    render(
      <StepStatsTable
        steps={[
          {
            step_id: "stepA",
            count: 10,
            error_count: 0,
            status_counts: { "200": 10 },
            p50_ms: 5,
            p95_ms: 20,
            p99_ms: 40,
            loop_breakdown: [],
          },
        ]}
        meta={meta}
      />,
    );
    expect(screen.getAllByText("스텝").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("메서드")).toBeInTheDocument();
    expect(screen.getByText("요청 수")).toBeInTheDocument();
    expect(screen.getByText("에러")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "p95 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("95%");
  });

  describe("retriedStepIds 표지", () => {
    const mk = (id: string) => ({
      step_id: id,
      count: 10,
      error_count: 0,
      status_counts: { "200": 10 },
      p50_ms: 1,
      p95_ms: 2,
      p99_ms: 3,
      loop_breakdown: [],
    });
    const meta2 = new Map([
      ["a", { id: "a", name: "stepAname", method: "GET", url: "/a" }],
      ["b", { id: "b", name: "stepBname", method: "GET", url: "/b" }],
    ]);
    it("든 스텝 행에만 표지가 보인다", () => {
      render(
        <StepStatsTable steps={[mk("a"), mk("b")]} meta={meta2} retriedStepIds={new Set(["a"])} />,
      );
      const rowA = screen.getByText("stepAname").closest("tr") as HTMLElement;
      const rowB = screen.getByText("stepBname").closest("tr") as HTMLElement;
      expect(within(rowA).getByText("재시도 포함")).toBeInTheDocument();
      expect(within(rowB).queryByText("재시도 포함")).not.toBeInTheDocument();
    });
    it("prop 없음과 빈 Set의 DOM이 같고 표지가 없다", () => {
      const a = render(<StepStatsTable steps={[mk("a")]} meta={meta2} />);
      const htmlNone = a.container.innerHTML;
      a.unmount();
      const b = render(
        <StepStatsTable steps={[mk("a")]} meta={meta2} retriedStepIds={new Set()} />,
      );
      expect(b.container.innerHTML).toBe(htmlNone);
      expect(htmlNone).not.toContain("재시도 포함");
      // 표지 없는 행의 이름 칸은 슬라이스 이전과 같은 리터럴 구조(감싸는 요소 없음).
      const nameCell = screen.getByText("stepAname").closest("td") as HTMLElement;
      expect(nameCell.innerHTML).toBe("stepAname");
      expect(nameCell.children).toHaveLength(0);
    });
  });

  describe("loop_split 두 줄", () => {
    const base = {
      status_counts: { "200": 10 },
      error_count: 0,
      p50_ms: 1,
      p95_ms: 2,
      p99_ms: 3,
    };
    it("loop_split이 없으면 DOM이 작업 전과 같다", () => {
      const meta = new Map([
        ["a", { id: "a", name: "주문", method: "GET", url: "/a" }],
        ["b", { id: "b", name: "결제", method: "POST", url: "/b" }],
      ]);
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...base,
              step_id: "a",
              count: 10,
              loop_breakdown: [
                { loop_index: 0, count: 6, error_count: 0 },
                { loop_index: 1, count: 4, error_count: 0 },
              ],
            },
            { ...base, step_id: "b", count: 5, loop_breakdown: [] },
          ]}
          meta={meta}
          retriedStepIds={new Set(["a"])}
        />,
      );
      expect(container.querySelector("section > div > table")!.outerHTML).toBe(OLD_TABLE_HTML);
    });

    const stats = (count: number, e: number, a: number, b: number, c: number) => ({
      count,
      error_count: e,
      p50_ms: a,
      p95_ms: b,
      p99_ms: c,
    });
    const split = {
      final: stats(1200, 0, 182, 420, 488),
      retry: stats(612, 0, 12, 31, 44),
    };
    const meta2 = new Map([
      ["a", { id: "a", name: "주문", method: "GET", url: "/a" }],
      ["b", { id: "b", name: "결제", method: "POST", url: "/b" }],
    ]);
    const cells = (tr: Element) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? "");
    const rowsOf = (container: HTMLElement) =>
      Array.from(container.querySelectorAll(":scope > section > div > table > tbody > tr"));

    it("두 줄이 스텝 행 바로 아래에 순서대로", () => {
      const { container } = render(
        <StepStatsTable
          steps={[
            { ...base, step_id: "a", count: 1812, loop_split: split },
            { ...base, step_id: "b", count: 5 },
          ]}
          meta={meta2}
        />,
      );
      const rows = rowsOf(container);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("주문");
      expect(rows[1]).toHaveTextContent("반복을 끝낸 응답");
      expect(rows[2]).toHaveTextContent("재시도로 이어진 응답");
      expect(rows[3]).toHaveTextContent("결제");
      expect(cells(rows[1]).slice(3, 8)).toEqual(["1200", "0", "182", "420", "488"]);
      expect(cells(rows[2]).slice(3, 8)).toEqual(["612", "0", "12", "31", "44"]);
    });

    it("끝낸 응답 0건이면 백분위가 —", () => {
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...base,
              step_id: "a",
              count: 612,
              loop_split: { final: stats(0, 0, 0, 0, 0), retry: split.retry },
            },
          ]}
          meta={meta2}
        />,
      );
      const rows = rowsOf(container);
      expect(cells(rows[1]).slice(3, 8)).toEqual(["0", "0", "—", "—", "—"]);
      expect(cells(rows[2]).slice(3, 8)).toEqual(["612", "0", "12", "31", "44"]);
    });

    it("토글을 열면 두 줄 아래에 회차별 표", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...base,
              step_id: "a",
              count: 1812,
              loop_split: split,
              loop_breakdown: [{ loop_index: 0, count: 3, error_count: 0 }],
            },
          ]}
          meta={meta2}
        />,
      );
      await user.click(screen.getByRole("button", { name: ko.report.toggleLoopBreakdown("주문") }));
      const rows = rowsOf(container);
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("주문");
      expect(rows[1]).toHaveTextContent("반복을 끝낸 응답");
      expect(rows[2]).toHaveTextContent("재시도로 이어진 응답");
      expect(rows[3]).toHaveTextContent("loop_index");
    });

    it("대기·다운로드 칸이 있어도 칸 수가 같다", () => {
      const ph = { count: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 3 };
      const { container } = render(
        <StepStatsTable
          steps={[
            { ...base, step_id: "a", count: 1812, loop_split: split, wait: ph, download: ph },
          ]}
          meta={meta2}
        />,
      );
      const rows = rowsOf(container);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.querySelectorAll("td").length)).toEqual([12, 12, 12]);
    });

    it("대기만 있어도 칸 수가 같다", () => {
      const ph = { count: 1, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 3 };
      const { container } = render(
        <StepStatsTable
          steps={[{ ...base, step_id: "a", count: 1812, loop_split: split, wait: ph }]}
          meta={meta2}
        />,
      );
      const rows = rowsOf(container);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.querySelectorAll("td").length)).toEqual([9, 9, 9]);
    });

    it("도움말 이름이 스텝마다 다르다", () => {
      render(
        <StepStatsTable
          steps={[
            { ...base, step_id: "a", count: 1812, loop_split: split },
            { ...base, step_id: "b", count: 1812, loop_split: split },
          ]}
          meta={meta2}
        />,
      );
      expect(screen.getAllByRole("button", { name: "「주문」 나뉜 응답 시간 설명" })).toHaveLength(
        1,
      );
      expect(screen.getAllByRole("button", { name: "「결제」 나뉜 응답 시간 설명" })).toHaveLength(
        1,
      );
    });

    it("└는 낭독되지 않는다", () => {
      const { container } = render(
        <StepStatsTable
          steps={[{ ...base, step_id: "a", count: 1812, loop_split: split }]}
          meta={meta2}
        />,
      );
      const rows = rowsOf(container);
      for (const r of [rows[1], rows[2]]) {
        const marks = Array.from(r.querySelectorAll("td:first-child *")).filter(
          (el) => el.textContent === "└ ",
        );
        expect(marks).toHaveLength(1);
        expect(marks[0]).toHaveAttribute("aria-hidden", "true");
      }
      const spoken = (r: Element) => {
        const clone = (r.querySelector("td") as HTMLElement).cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[aria-hidden]").forEach((el) => el.remove());
        return (clone.textContent ?? "").trim();
      };
      expect(spoken(rows[1]).startsWith("반복을 끝낸 응답")).toBe(true);
      expect(spoken(rows[2]).startsWith("재시도로 이어진 응답")).toBe(true);
    });

    it("표지 없이도 두 줄이 보인다", () => {
      render(
        <StepStatsTable
          steps={[{ ...base, step_id: "a", count: 1812, loop_split: split }]}
          meta={meta2}
          retriedStepIds={new Set()}
        />,
      );
      expect(screen.queryByText("재시도 포함")).not.toBeInTheDocument();
      expect(screen.getByText("반복을 끝낸 응답")).toBeInTheDocument();
      expect(screen.getByText("재시도로 이어진 응답")).toBeInTheDocument();
    });
  });

  describe("µs·60초 칸 (R23)", () => {
    const b = { status_counts: { "200": 10 }, error_count: 0, count: 10, loop_breakdown: [] };
    const st = (p50: number, p95: number, p99: number, capped = false) => ({
      min_us: 1,
      mean_us: 2,
      max_us: 3,
      stdev_us: 4,
      p50_us: p50,
      p90_us: p95,
      p95_us: p95,
      p99_us: p99,
      capped,
    });
    const m = new Map([["a", { id: "a", name: "주문", method: "GET", url: "/a" }]]);
    const tds = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("tbody > tr > td")).map((td) => td.textContent);

    it("1ms 미만 p50은 µs로", () => {
      const { container } = render(
        <StepStatsTable
          steps={[
            { ...b, step_id: "a", p50_ms: 0, p95_ms: 2, p99_ms: 3, stats: st(350, 2_400, 3_100) },
          ]}
          meta={m}
        />,
      );
      expect(tds(container).slice(5, 8)).toEqual(["350 µs", "2", "3"]);
      expect(screen.queryByRole("note")).toBeNull();
    });

    it("60초 칸은 「≥ 60,000」과 표 아래 안내", () => {
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...b,
              step_id: "a",
              p50_ms: 10,
              p95_ms: 20,
              p99_ms: 60030,
              stats: st(10_000, 20_000, 60_000_000, true),
            },
          ]}
          meta={m}
        />,
      );
      expect(tds(container).slice(5, 8)).toEqual(["10", "20", "≥\u00a060,000"]);
      const note = screen.getByRole("note");
      expect(note.textContent).toBe(
        "「≥ 60,000」: 60초를 넘긴 응답이 있습니다. 그런 응답은 60초로 기록되므로 「≥ 60,000」인 값은 실제로 더 클 수 있습니다.",
      );
      expect(note).toBe(container.querySelector("section > p[role='note']"));
    });

    it("stats가 없으면 지금 글자 그대로", () => {
      const { container } = render(
        <StepStatsTable
          steps={[{ ...b, step_id: "a", p50_ms: 0, p95_ms: 2, p99_ms: 60030 }]}
          meta={m}
        />,
      );
      expect(tds(container).slice(5, 8)).toEqual(["0", "2", "60030"]);
      expect(screen.queryByRole("note")).toBeNull();
    });

    it("통과 0건 표본 스텝은 「—」 그대로", () => {
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...b,
              step_id: "a",
              count: 4,
              error_count: 4,
              p50_ms: 0,
              p95_ms: 0,
              p99_ms: 0,
              stats: st(350, 350, 350),
            },
          ]}
          meta={m}
          sample="passed"
        />,
      );
      expect(tds(container).slice(5, 8)).toEqual(["—", "—", "—"]);
    });

    it("1ms 이상·60초 칸 없는 stats여도 바깥 표 DOM은 작업 전과 같고, 부모는 가로 스크롤 상자", () => {
      const base2 = {
        status_counts: { "200": 10 },
        error_count: 0,
        p50_ms: 1,
        p95_ms: 2,
        p99_ms: 3,
      };
      const meta = new Map([
        ["a", { id: "a", name: "주문", method: "GET", url: "/a" }],
        ["b", { id: "b", name: "결제", method: "POST", url: "/b" }],
      ]);
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...base2,
              step_id: "a",
              count: 10,
              loop_breakdown: [
                { loop_index: 0, count: 6, error_count: 0 },
                { loop_index: 1, count: 4, error_count: 0 },
              ],
              stats: st(1_500, 2_500, 3_500),
            },
            {
              ...base2,
              step_id: "b",
              count: 5,
              loop_breakdown: [],
              stats: st(1_500, 2_500, 3_500),
            },
          ]}
          meta={meta}
          retriedStepIds={new Set(["a"])}
        />,
      );
      const table = container.querySelector("section > div > table")!;
      expect(table.outerHTML).toBe(OLD_TABLE_HTML);
      expect(table.parentElement).toHaveClass("overflow-x-auto");
    });
  });

  describe("응답 시간 통계 더 보기 (R24)", () => {
    const b = { status_counts: { "200": 10 }, error_count: 0, count: 10, loop_breakdown: [] };
    const full = {
      min_us: 840,
      mean_us: 312_600,
      max_us: 4_105_900,
      stdev_us: 288_600,
      p50_us: 210_000,
      p90_us: 655_700,
      p95_us: 890_000,
      p99_us: 1_420_000,
      capped: false,
    };
    const meta = new Map([
      ["a", { id: "a", name: "주문", method: "GET", url: "/a" }],
      ["b", { id: "b", name: "결제", method: "POST", url: "/b" }],
    ]);
    const mkSummary = (over: Record<string, unknown>) =>
      ({
        count: 15,
        errors: 1,
        rps: 7.5,
        duration_seconds: 2,
        mean_ms: 1843,
        p50_ms: 210,
        p95_ms: 890,
        p99_ms: 1420,
        stats: { ...full, mean_us: 1_842_400 },
        ...over,
      }) as never;
    const outer = (container: HTMLElement) =>
      container.querySelector(":scope > section > div > table") as HTMLElement;
    const heads = (container: HTMLElement) =>
      Array.from(outer(container).querySelectorAll(":scope > thead th")).map((th) =>
        (th.firstChild?.textContent ?? "").trim(),
      );
    const rows = (container: HTMLElement) =>
      Array.from(outer(container).querySelectorAll(":scope > tbody > tr"));
    const cells = (tr: Element) =>
      Array.from(tr.querySelectorAll(":scope > td")).map((td) => td.textContent ?? "");
    const toggle = () => screen.getByRole("button", { name: ko.report.stats.toggleMore });
    const one = { ...b, step_id: "a", p50_ms: 210, p95_ms: 890, p99_ms: 1420, stats: full };

    it("펼친 바깥 표만 whitespace-nowrap — 접으면 다시 없다", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable steps={[one]} meta={meta} summary={mkSummary({})} />,
      );
      expect(outer(container)).not.toHaveClass("whitespace-nowrap");
      await user.click(toggle());
      expect(outer(container)).toHaveClass("whitespace-nowrap");
      await user.click(screen.getByRole("button", { name: ko.report.stats.toggleLess }));
      expect(outer(container)).not.toHaveClass("whitespace-nowrap");
    });

    it("기본은 접힘 — 단추 aria-expanded=false, 새 열·「모든 스텝」 행 없음, 단추는 제목 줄", () => {
      const { container } = render(
        <StepStatsTable steps={[one]} meta={meta} summary={mkSummary({})} />,
      );
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(heads(container)).not.toContain(ko.report.stats.colMin);
      expect(screen.queryByText(ko.report.stats.allSteps)).toBeNull();
      const headRow = screen.getByRole("heading", { name: ko.report.stepsHeading }).parentElement!;
      expect(headRow).toContainElement(toggle());
    });

    it("펼치면 머리 순서·접근명이 바뀌고, 접으면 표 DOM이 처음과 같다", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable steps={[one]} meta={meta} summary={mkSummary({})} />,
      );
      const before = outer(container).outerHTML;
      await user.click(toggle());
      const open = screen.getByRole("button", { name: ko.report.stats.toggleLess });
      expect(open).toHaveAttribute("aria-expanded", "true");
      expect(heads(container)).toEqual([
        ko.report.colStep,
        ko.report.colMethod,
        "URL",
        ko.report.colRequests,
        ko.report.colErrors,
        ko.report.stats.colMin,
        ko.report.stats.colMean,
        ko.report.stats.colMax,
        ko.report.stats.colStdev,
        "p50 ms",
        "p90 ms",
        "p95 ms",
        "p99 ms",
      ]);
      await user.click(open);
      expect(outer(container).outerHTML).toBe(before);
    });

    it("새 머리의 도움말 단추 이름은 「… 설명」 — 접힘엔 없다", async () => {
      const user = userEvent.setup();
      render(<StepStatsTable steps={[one]} meta={meta} summary={mkSummary({})} />);
      const section = screen
        .getByRole("heading", { name: ko.report.stepsHeading })
        .closest("section") as HTMLElement;
      const names = ["평균 설명", "최대 설명", "표준편차 설명", "p90 설명"];
      for (const n of names) {
        expect(within(section).queryByRole("button", { name: n })).toBeNull();
      }
      await user.click(toggle());
      for (const n of names) {
        expect(within(section).getByRole("button", { name: n })).toBeInTheDocument();
      }
    });

    it("스텝 행 값 — 평균·표준편차는 반올림, 최소·최대·p90은 내림", async () => {
      const user = userEvent.setup();
      const { container } = render(<StepStatsTable steps={[one]} meta={meta} />);
      await user.click(toggle());
      expect(cells(rows(container)[0]).slice(5)).toEqual([
        "840 µs",
        "313",
        "4105",
        "289",
        "210",
        "655",
        "890",
        "1420",
      ]);
    });

    it("60초 칸 — 최대 「≥ 60,000」과 펼친 안내, 접힘엔 안내 없음(p 칸이 정상이므로)", async () => {
      const user = userEvent.setup();
      render(
        <StepStatsTable
          steps={[{ ...one, stats: { ...full, max_us: 60_000_000, capped: true } }]}
          meta={meta}
        />,
      );
      expect(screen.queryByRole("note")).toBeNull();
      await user.click(toggle());
      expect(screen.getByRole("note").textContent).toBe(ko.report.stats.cappedNoteExpanded);
    });

    it("stats 없는 스텝은 새 다섯 칸이 「—」", async () => {
      const user = userEvent.setup();
      const { stats: _unused, ...noStats } = one;
      void _unused;
      const { container } = render(<StepStatsTable steps={[noStats]} meta={meta} />);
      await user.click(toggle());
      expect(cells(rows(container)[0]).slice(5)).toEqual([
        "—",
        "—",
        "—",
        "—",
        "210",
        "—",
        "890",
        "1420",
      ]);
    });

    it("통과 표본에서 요청이 모두 오류인 스텝은 칸이 「—」이고 안내도 없다(접힘·펼침 모두)", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...one,
              count: 4,
              error_count: 4,
              p50_ms: 0,
              p95_ms: 0,
              p99_ms: 0,
              stats: { ...full, p99_us: 60_000_000, max_us: 60_000_000, capped: true },
            },
          ]}
          meta={meta}
          sample="passed"
        />,
      );
      expect(screen.queryByRole("note")).toBeNull();
      await user.click(toggle());
      expect(cells(rows(container)[0]).slice(5)).toEqual(Array(8).fill("—"));
      expect(screen.queryByRole("note")).toBeNull();
    });

    it("「모든 스텝」 행 — summary 값, 평균은 카드와 같은 식(반올림 1842가 아니라 1843)", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable steps={[one]} meta={meta} summary={mkSummary({})} />,
      );
      await user.click(toggle());
      const rs = rows(container);
      expect(cells(rs[rs.length - 1])).toEqual([
        ko.report.stats.allSteps,
        "",
        "",
        "15",
        "1",
        "840 µs",
        "1843",
        "4105",
        "289",
        "210",
        "655",
        "890",
        "1420",
      ]);
    });

    it("「모든 스텝」 평균이 60초 칸이면 「≥ 60,000」 — 60015가 아니다", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable
          steps={[one]}
          meta={meta}
          summary={mkSummary({ mean_ms: 60015, stats: { ...full, mean_us: 60_000_000 } })}
        />,
      );
      await user.click(toggle());
      const rs = rows(container);
      expect(cells(rs[rs.length - 1])[6]).toBe("≥\u00a060,000");
      expect(screen.getByRole("note").textContent).toBe(ko.report.stats.cappedNoteExpanded);
    });

    it("summary.stats 없으면 「모든 스텝」 p50·p95·p99만 정수 ms, 나머지 다섯은 「—」, summary가 없으면 행이 없다", async () => {
      const user = userEvent.setup();
      const { container, rerender } = render(
        <StepStatsTable steps={[one]} meta={meta} summary={mkSummary({ stats: undefined })} />,
      );
      await user.click(toggle());
      let rs = rows(container);
      expect(cells(rs[rs.length - 1]).slice(3)).toEqual([
        "15",
        "1",
        "—",
        "—",
        "—",
        "—",
        "210",
        "—",
        "890",
        "1420",
      ]);
      rerender(<StepStatsTable steps={[one]} meta={meta} />);
      rs = rows(container);
      expect(rs).toHaveLength(1);
      expect(screen.queryByText(ko.report.stats.allSteps)).toBeNull();
    });

    it("「모든 스텝」 p 칸 — 통과 표본에서 요청이 모두 오류면 「—」(stats 없어도)", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable
          steps={[{ ...one, count: 4, error_count: 4 }]}
          meta={meta}
          sample="passed"
          summary={mkSummary({ count: 4, errors: 4, stats: undefined })}
        />,
      );
      await user.click(toggle());
      const rs = rows(container);
      expect(cells(rs[rs.length - 1]).slice(3)).toEqual(["4", "4", ...Array(8).fill("—")]);
    });

    it("펼치면 주소·스텝 이름 칸만 줄바꿈 허용(whitespace-normal) — 접힘엔 클래스 변화 없음", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...one,
              loop_split: {
                final: { count: 1, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
                retry: { count: 1, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 },
              },
            },
          ]}
          meta={meta}
          summary={mkSummary({})}
        />,
      );
      const stepRow = () => rows(container)[0];
      const nameTd = () => stepRow().querySelectorAll(":scope > td")[0];
      const urlTd = () => stepRow().querySelectorAll(":scope > td")[2];
      expect(nameTd()).not.toHaveClass("whitespace-normal");
      expect(urlTd()).not.toHaveClass("whitespace-normal");
      await user.click(toggle());
      expect(nameTd()).toHaveClass("whitespace-normal", "min-w-[10rem]");
      expect(urlTd()).toHaveClass("whitespace-normal", "min-w-[16rem]");
      const rs = rows(container);
      expect(rs[1].querySelectorAll(":scope > td")[0]).toHaveClass(
        "whitespace-normal",
        "min-w-[10rem]",
      );
      expect(rs[rs.length - 1].querySelectorAll(":scope > td")[0]).toHaveClass(
        "whitespace-normal",
        "min-w-[10rem]",
      );
      const ths = outer(container).querySelectorAll(":scope > thead th");
      expect(ths[0]).toHaveClass("whitespace-normal", "min-w-[10rem]");
      expect(ths[2]).toHaveClass("whitespace-normal", "min-w-[16rem]");
      await user.click(screen.getByRole("button", { name: ko.report.stats.toggleLess }));
      expect(nameTd()).not.toHaveClass("whitespace-normal");
      expect(urlTd()).not.toHaveClass("whitespace-normal");
      expect(nameTd()).not.toHaveClass("min-w-[10rem]");
      expect(urlTd()).not.toHaveClass("min-w-[16rem]");
    });

    it("반복 나눔 아래 줄 — 60초 칸(60030)은 「≥ 60,000」이고 안내가 접힘에도 뜬다", () => {
      const part = (p99: number) => ({
        count: 3,
        error_count: 0,
        p50_ms: 10,
        p95_ms: 20,
        p99_ms: p99,
      });
      render(
        <StepStatsTable
          steps={[
            { ...one, stats: undefined, loop_split: { final: part(60030), retry: part(44) } },
          ]}
          meta={meta}
        />,
      );
      const tds = Array.from(document.querySelectorAll("td")).map((td) => td.textContent);
      expect(tds).toContain("≥\u00a060,000");
      expect(tds).not.toContain("60030");
      expect(screen.getByRole("note").textContent).toBe(ko.report.stats.cappedNoteCollapsed);
    });

    it("열 수 일치 — 대기·다운로드·반복 나눔·회차 펼침이 함께 있어도 접힘·펼침 모두", async () => {
      const user = userEvent.setup();
      const ph = { count: 10, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 };
      const part = (count: number) => ({ count, error_count: 0, p50_ms: 1, p95_ms: 2, p99_ms: 3 });
      const { container } = render(
        <StepStatsTable
          steps={[
            {
              ...one,
              wait: ph,
              download: ph,
              loop_split: { final: part(6), retry: part(4) },
              loop_breakdown: [{ loop_index: 0, count: 3, error_count: 0 }],
            },
            { ...b, step_id: "b", p50_ms: 1, p95_ms: 2, p99_ms: 3, wait: ph, download: ph },
          ]}
          meta={meta}
          summary={mkSummary({})}
        />,
      );
      await user.click(screen.getByRole("button", { name: ko.report.toggleLoopBreakdown("주문") }));
      const check = () => {
        const n = outer(container).querySelectorAll(":scope > thead th").length;
        for (const tr of rows(container)) {
          const span = tr.querySelector(":scope > td[colspan]");
          if (span) {
            expect(Number(span.getAttribute("colspan"))).toBe(n);
          } else {
            expect(tr.querySelectorAll(":scope > td")).toHaveLength(n);
          }
        }
        return n;
      };
      const collapsed = check();
      await user.click(toggle());
      expect(check()).toBe(collapsed + 5);
      expect(screen.getByText(ko.report.stats.allSteps)).toBeInTheDocument();
    });
  });
});
