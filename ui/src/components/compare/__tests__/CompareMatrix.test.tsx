import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { CompareMatrix } from "../CompareMatrix";
import type { CompareResult } from "../../../compare/compareReports";
import { runColor } from "../../../compare/runLabel";
import { ko } from "../../../i18n/ko";

const result: CompareResult = {
  runIds: ["A", "B"],
  baselineIdx: 0,
  summary: [
    {
      label: "p95_ms",
      metric: "p95_ms",
      cells: [
        { value: 152, delta: null },
        { value: 184, delta: { pct: 0.21, polarity: "bad", capped: false } },
      ],
    },
  ],
  steps: [],
  stepStats: [],
  status: [],
  verdict: { passed: [true, false] },
  stepMismatch: true,
  setup: [],
};

describe("CompareMatrix verdict polarity (spec R8)", () => {
  const labels = { A: "#A", B: "#B" };
  function verdictResult(passed: (boolean | null)[]): CompareResult {
    return {
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary: [],
      steps: [],
      stepStats: [],
      status: [],
      verdict: { passed },
      stepMismatch: false,
      setup: [],
    };
  }

  it("baseline PASS & candidate FAIL → ▲악화 on candidate, none on baseline", () => {
    render(
      <CompareMatrix
        result={verdictResult([true, false])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/악화/)).toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });

  it("baseline FAIL & candidate PASS → ▼개선", () => {
    render(
      <CompareMatrix
        result={verdictResult([false, true])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/개선/)).toBeInTheDocument();
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
  });

  it("equal verdicts → neutral (no glyph)", () => {
    render(
      <CompareMatrix
        result={verdictResult([true, true])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/악화/)).not.toBeInTheDocument();
    expect(screen.queryByText(/개선/)).not.toBeInTheDocument();
  });
});

describe("CompareMatrix", () => {
  it("renders one table with a shared colgroup so run columns align", () => {
    // Single-table layout (commit d74fe7d): header, verdict, and every section
    // live in ONE <table> governed by a single <colgroup> (label col + one per
    // run), so each run's values sit directly under its header button. jsdom has
    // no layout engine, so we assert the structure that guarantees alignment.
    const { container } = render(
      <CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={() => {}} />,
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("colgroup col")).toHaveLength(result.runIds.length + 1);
  });

  it("renders sections, fires baseline change, shows mismatch banner", async () => {
    const user = userEvent.setup();
    const onBaselineChange = vi.fn();
    render(
      <CompareMatrix
        result={result}
        labels={{ A: "#A", B: "#B" }}
        onBaselineChange={onBaselineChange}
      />,
    );
    expect(screen.getByText("p95_ms")).toBeInTheDocument();
    // Mismatch banner must remain reachable via role="status" after Callout conversion
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/일부만 비교/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /#B/ }));
    expect(onBaselineChange).toHaveBeenCalledWith("B");
  });

  it("renders a per-run color swatch in each header matching the overlay palette (spec §3.2/R3)", () => {
    render(
      <CompareMatrix result={result} labels={{ A: "#A", B: "#B" }} onBaselineChange={() => {}} />,
    );
    const colA = screen.getByRole("button", { name: /#A/ });
    const colB = screen.getByRole("button", { name: /#B/ });
    const swatchA = colA.querySelector('span[aria-hidden="true"]');
    const swatchB = colB.querySelector('span[aria-hidden="true"]');
    expect(swatchA).not.toBeNull();
    expect(swatchB).not.toBeNull();
    expect(swatchA).toHaveStyle({ backgroundColor: runColor(0) });
    expect(swatchB).toHaveStyle({ backgroundColor: runColor(1) });
  });
});

describe("CompareMatrix sublines (run-identity Task 9, additive optional prop)", () => {
  const twoRunResult: CompareResult = {
    runIds: ["abc123", "xyz789"],
    // baseline is xyz789 (index 1) so the "(base)" suffix never lands on the
    // abc123 button — its accessible name stays exactly "#abc123" below.
    baselineIdx: 1,
    summary: [],
    steps: [],
    stepStats: [],
    status: [],
    verdict: { passed: [null, null] },
    stepMismatch: false,
    setup: [],
  };
  const labels = { abc123: "#abc123", xyz789: "#xyz789" };

  it("renders the subline text beside the header button without joining the baseline toggle button's accessible name", () => {
    render(
      <CompareMatrix
        result={twoRunResult}
        labels={labels}
        sublines={{ abc123: "2026-08-09 10:00 · 고정 20 VU · 60s" }}
        onBaselineChange={() => {}}
      />,
    );
    // Subline text renders in the header.
    expect(screen.getByText("2026-08-09 10:00 · 고정 20 VU · 60s")).toBeInTheDocument();
    // getByRole name-matching is exact by default — this only succeeds if the
    // subline text did NOT join the button's accessible name (it must be a
    // sibling of the button, not a descendant).
    expect(screen.getByRole("button", { name: "#abc123" })).toBeInTheDocument();
  });

  it("omits the subline element entirely when the sublines prop is not passed", () => {
    const { container } = render(
      <CompareMatrix result={twoRunResult} labels={labels} onBaselineChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "#abc123" })).toBeInTheDocument();
    expect(container.querySelectorAll("th div")).toHaveLength(0);
  });
});

describe("CompareMatrix 준비 스텝 section", () => {
  const labels = { A: "#A", B: "#B" };
  const row = (label: string, metric: string, id?: string, a = 1, b: number | null = 2) => ({
    label,
    metric,
    ...(id ? { id } : {}),
    cells: [
      { value: a, delta: null },
      { value: b, delta: null },
    ],
  });
  const base = (setup: CompareResult["setup"]): CompareResult => ({
    runIds: ["A", "B"],
    baselineIdx: 0,
    summary: [row("p95_ms", "p95_ms")],
    steps: [row("m1", "p95_ms", "m1")],
    stepStats: [],
    status: [row("200", "status")],
    verdict: { passed: [null, null] },
    stepMismatch: false,
    setup,
  });
  const groupHeads = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("th[colspan]")).map((t) => t.textContent);

  it("renders 준비 스텝 section between 스텝 and 상태", () => {
    const { container } = render(
      <CompareMatrix
        result={base([row("준비 성공", "setup_ok")])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(groupHeads(container)).toEqual(["요약", "스텝", "준비 스텝", "상태"]);
  });

  it("no setup rows → no 준비 스텝 section", () => {
    const { container } = render(
      <CompareMatrix result={base([])} labels={labels} onBaselineChange={vi.fn()} />,
    );
    expect(groupHeads(container)).toHaveLength(3);
    expect(screen.queryByText("준비 스텝")).not.toBeInTheDocument();
  });

  it("same-named setup steps render both rows without key warning", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <CompareMatrix
        result={base([row("로그인 p95 ms", "p95_ms", "s1"), row("로그인 p95 ms", "p95_ms", "s2")])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("로그인 p95 ms")).toHaveLength(2);
    const warned = err.mock.calls.some((args) => args.some((a) => String(a).includes("same key")));
    expect(warned).toBe(false);
    err.mockRestore();
  });

  it("null cell renders —", () => {
    render(
      <CompareMatrix
        result={base([row("준비 성공", "setup_ok", undefined, 5, null)])}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    const tr = screen.getByText("준비 성공").closest("tr")!;
    expect(tr.querySelectorAll("td")[2]).toHaveTextContent("—");
  });
});

describe("CompareMatrix 60초 칸 변화율 칩 (R-B5)", () => {
  const labels = { A: "#A", B: "#B" };
  const capped = (polarity: "good" | "bad" | "neutral"): CompareResult => ({
    runIds: ["A", "B"],
    baselineIdx: 0,
    summary: [
      {
        label: "max_ms",
        metric: "max_ms",
        cells: [
          { value: 1840, delta: null },
          { value: 60000, delta: { pct: null, polarity, capped: true } },
        ],
      },
    ],
    steps: [],
    stepStats: [],
    status: [],
    setup: [],
    verdict: { passed: [null, null] },
    stepMismatch: false,
  });
  const chip = (polarity: "good" | "bad" | "neutral") => {
    const { container } = render(
      <CompareMatrix result={capped(polarity)} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const td = screen
      .getByText(ko.compare.statLabel.max_ms)
      .closest("tr")!
      .querySelectorAll("td")[2];
    const el = td.querySelector("span");
    expect(el, "chip").not.toBeNull();
    return { td, el: el!, container };
  };

  it("bad → 「▲—」, title은 잘림 사유, aria-label은 「더 나쁨: 사유」", () => {
    const { el } = chip("bad");
    expect(el).toHaveTextContent("▲—");
    expect(el).toHaveAttribute("title", ko.compare.cappedDeltaTitle);
    expect(el).toHaveAttribute("aria-label", ko.compare.worseAria(ko.compare.cappedDeltaTitle));
  });

  it("good → 「▼—」, aria-label은 「더 좋음: 사유」", () => {
    const { el } = chip("good");
    expect(el).toHaveTextContent("▼—");
    expect(el).toHaveAttribute("aria-label", ko.compare.betterAria(ko.compare.cappedDeltaTitle));
  });

  it("neutral → 「—」, aria-label은 사유 그대로(「동일」·「신규」 없음)", () => {
    const { td, el } = chip("neutral");
    expect(el).toHaveTextContent(/^—$/);
    expect(el).toHaveAttribute("aria-label", ko.compare.cappedDeltaTitle);
    expect(td.textContent).not.toMatch(/신규|동일/);
    expect(el.getAttribute("aria-label")).not.toMatch(/신규|동일/);
  });

  it("사유 문구 자체가 정해진 글자다", () => {
    expect(ko.compare.cappedDeltaTitle).toBe("60초를 넘긴 응답이 있어 변화율을 계산할 수 없습니다");
  });
});

describe("CompareMatrix 시간 글자·통계 행·「응답 시간 통계 더 보기」 (R-B7)", () => {
  const labels = { A: "#A", B: "#B" };
  const SUMMARY_METRICS = [
    "p50_ms",
    "p90_ms",
    "p95_ms",
    "p99_ms",
    "mean_ms",
    "min_ms",
    "max_ms",
    "stdev_ms",
    "rps",
    "error_rate",
  ];
  const STEP_STAT_METRICS = ["mean_ms", "min_ms", "max_ms", "stdev_ms", "p90_ms"];
  const cell = (value: number | null, time?: { us: number }) => ({
    value,
    delta: null,
    ...(time ? { time } : {}),
  });
  const row = (metric: string, cells: ReturnType<typeof cell>[], id?: string, label?: string) => ({
    label: label ?? metric,
    ...(id ? { id } : {}),
    metric,
    cells,
  });
  function build(opts?: { noStepStats?: boolean }): CompareResult {
    const summary = SUMMARY_METRICS.map((m) => {
      if (m === "min_ms") return row(m, [cell(0.35, { us: 350 }), cell(null)]);
      if (m === "max_ms") return row(m, [cell(60000, { us: 60_000_000 }), cell(1840)]);
      if (m === "mean_ms") return row(m, [cell(52.118, { us: 52118 }), cell(null)]);
      if (m === "p50_ms")
        return row(m, [cell(115.204, { us: 115204 }), cell(115.633, { us: 115633 })]);
      if (m === "rps") return row(m, [cell(27.14164546225615), cell(790.1)]);
      if (m === "error_rate") return row(m, [cell(0.1), cell(0.11)]);
      return row(m, [cell(10), cell(11)]);
    });
    const steps = [
      row("p95_ms", [cell(88), cell(90)], "stepid-login", "로그인"),
      row("p95_ms", [cell(140), cell(171)], "stepid-list", "목록 조회"),
    ];
    const stepStats = opts?.noStepStats
      ? []
      : ["stepid-list", "stepid-login"].flatMap((id) =>
          STEP_STAT_METRICS.map((m) => row(m, [cell(1), cell(2)], id)),
        );
    return {
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary,
      steps,
      stepStats,
      status: [],
      verdict: { passed: [true, true] },
      stepMismatch: false,
      setup: [],
    };
  }
  const names = (c: HTMLElement) =>
    Array.from(c.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent);

  it("요약 절 행 이름 순서와 칸 글자", () => {
    const { container } = render(
      <CompareMatrix result={build()} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const all = names(container);
    const start = all.indexOf("p50_ms");
    expect(all.slice(start, start + 10)).toEqual([
      "p50_ms",
      ko.compare.statLabel.p90_ms,
      "p95_ms",
      "p99_ms",
      ko.compare.statLabel.mean_ms,
      ko.compare.statLabel.min_ms,
      ko.compare.statLabel.max_ms,
      ko.compare.statLabel.stdev_ms,
      "rps",
      "error_rate",
    ]);
    const tds = (name: string) =>
      Array.from(
        Array.from(container.querySelectorAll("tbody tr"))
          .find((tr) => tr.querySelector("td")?.textContent === name)!
          .querySelectorAll("td"),
      ).map((t) => t.textContent);
    expect(tds(ko.compare.statLabel.min_ms)).toEqual([ko.compare.statLabel.min_ms, "350 µs", "—"]);
    expect(tds(ko.compare.statLabel.max_ms)[1]).toBe(ko.report.stats.capped);
    // 사용자 결정(2026-11-26): 비교 화면 시간 칸은 CSV `ms3` 글자 — 소수 3자리.
    expect(tds(ko.compare.statLabel.mean_ms)[1]).toBe("52.118");
    expect(tds("p50_ms").slice(1)).toEqual(["115.204", "115.633"]);
    expect(tds("rps")[1]).toBe("27.14");
    expect(tds("error_rate")[1]).toBe("10.0%");
  });

  it("오류율 칸은 퍼센트 글자", () => {
    const r = build();
    r.summary = r.summary.map((x) =>
      x.metric === "error_rate" ? row("error_rate", [cell(0), cell(0.0123001230012)]) : x,
    );
    r.summary.push(row("error_rate", [cell(0.0001), cell(null)], undefined, "error_rate_2"));
    const { container } = render(
      <CompareMatrix result={r} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("0.0%");
    expect(text).toContain("1.2%");
    expect(text).toContain("<0.1%");
    expect(text).not.toContain("0.0123");
  });

  it("준비 스텝 잘린 p95 칸은 「≥ 60,000」, 안 잘린 칸은 정수 글자", () => {
    const r = build();
    r.setup = [
      {
        label: "s1",
        id: "s1",
        metric: "p95_ms",
        cells: [
          { value: 200, delta: null },
          {
            value: 60000,
            time: { us: 60_000_000 },
            delta: { pct: null, polarity: "bad", capped: true },
          },
        ],
      },
    ];
    const { container } = render(
      <CompareMatrix result={r} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const tr = Array.from(container.querySelectorAll("tbody tr")).find(
      (t) => t.querySelector("td")?.textContent === "s1" && t.querySelectorAll("td").length === 3,
    )!;
    const tds = Array.from(tr.querySelectorAll("td")).map((t) => t.textContent ?? "");
    expect(tds[1]).toBe("200");
    expect(tds[2]).toContain("≥\u00a060,000");
    expect(tds[1]).not.toContain("200.000");
    expect(tds.join("")).not.toContain("µs");
  });

  it("스텝 절: 단추는 접힘이 기본, 누르면 스텝 × 5행이 p95 행 바로 밑에", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CompareMatrix result={build()} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: ko.report.stats.toggleMore });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(names(container).filter((n) => n?.startsWith("└ "))).toHaveLength(0);
    await user.click(btn);
    const open = screen.getByRole("button", { name: ko.report.stats.toggleLess });
    expect(open).toHaveAttribute("aria-expanded", "true");
    const all = names(container);
    expect(all.filter((n) => n?.startsWith("└ "))).toHaveLength(10);
    const sub = STEP_STAT_METRICS.map((m) =>
      ko.compare.stepStatLabel(ko.compare.statLabel[m as keyof typeof ko.compare.statLabel]),
    );
    for (const stepName of ["로그인", "목록 조회"]) {
      const i = all.indexOf(stepName);
      expect(all.slice(i + 1, i + 6)).toEqual(sub);
    }
  });

  it("단추는 제목 글자 바로 다음 형제, 통계 행 이름 칸은 p95 행과 같은 글자 크기, 툴팁은 표시 이름", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CompareMatrix result={build()} labels={labels} onBaselineChange={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: ko.report.stats.toggleMore });
    const titleEl = btn.previousElementSibling;
    expect(titleEl).toHaveTextContent(ko.report.stepsHeading);
    expect(btn.parentElement?.className).not.toContain("justify-between");
    await user.click(btn);
    const nameTd = (text: string) =>
      Array.from(container.querySelectorAll("tbody tr td:first-child")).find(
        (td) => td.textContent === text,
      ) as HTMLElement;
    const sizeTokens = (el: HTMLElement) =>
      el.className.split(/\s+/).filter((c) => /^text-(xs|sm|base|lg|\[)/.test(c));
    const sub = nameTd(ko.compare.stepStatLabel(ko.compare.statLabel.mean_ms));
    expect(sizeTokens(sub)).toEqual(sizeTokens(nameTd("로그인")));
    expect(sub.className).not.toContain("text-xs");
    expect(nameTd(ko.compare.statLabel.min_ms)).toHaveAttribute(
      "title",
      ko.compare.statLabel.min_ms,
    );
    expect(sub).toHaveAttribute("title", sub.textContent);
    expect(nameTd("로그인")).toHaveAttribute("title", "로그인");
  });

  it("상속 속성 이름(constructor) 지표도 던지지 않고 label로", () => {
    const r = build();
    r.summary.push(row("constructor", [cell(1), cell(2)]));
    const { container } = render(
      <CompareMatrix result={r} labels={labels} onBaselineChange={vi.fn()} />,
    );
    expect(names(container)).toContain("constructor");
  });

  it("stepStats가 비면 단추가 없다", () => {
    render(
      <CompareMatrix
        result={build({ noStepStats: true })}
        labels={labels}
        onBaselineChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: ko.report.stats.toggleMore })).toBeNull();
  });

  it("펼친 상태에서 중복 key 경고가 없다", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<CompareMatrix result={build()} labels={labels} onBaselineChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: ko.report.stats.toggleMore }));
    const joined = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    spy.mockRestore();
    expect(joined).not.toContain("same key");
  });
});

describe("CompareMatrix 변화율 칩 글리프 = 값이 움직인 방향, 색 = 좋고 나쁨 (사용자 결정 2026-11-26)", () => {
  const labels = { A: "#A", B: "#B" };
  const one = (
    value: number,
    delta: { pct: number | null; polarity: "good" | "bad" | "neutral" },
  ): CompareResult => ({
    runIds: ["A", "B"],
    baselineIdx: 0,
    summary: [
      {
        label: "x",
        metric: "x",
        cells: [
          { value: 1, delta: null },
          { value, delta: { ...delta, capped: false } },
        ],
      },
    ],
    steps: [],
    stepStats: [],
    status: [],
    setup: [],
    verdict: { passed: [null, null] },
    stepMismatch: false,
  });
  const chipOf = (r: CompareResult) => {
    render(<CompareMatrix result={r} labels={labels} onBaselineChange={vi.fn()} />);
    const td = screen.getByText("x").closest("tr")!.querySelectorAll("td")[2];
    const el = td.querySelector("span");
    expect(el, "chip").not.toBeNull();
    return el!;
  };

  it("rps처럼 떨어져서 나쁨 → ▼-23.8% 빨강", () => {
    const el = chipOf(one(27.1, { pct: -0.238, polarity: "bad" }));
    expect(el).toHaveTextContent("▼-23.8%");
    expect(el.className).toContain("text-red-600");
    expect(el).toHaveAttribute("aria-label", ko.compare.worseAria("-23.8%"));
  });
  it("올라서 나쁨 → ▲+29.1% 빨강", () => {
    const el = chipOf(one(5, { pct: 0.291, polarity: "bad" }));
    expect(el).toHaveTextContent("▲+29.1%");
    expect(el.className).toContain("text-red-600");
  });
  it("떨어져서 좋음 → ▼-20.0% 초록", () => {
    const el = chipOf(one(5, { pct: -0.2, polarity: "good" }));
    expect(el).toHaveTextContent("▼-20.0%");
    expect(el.className).toContain("text-green-600");
    expect(el).toHaveAttribute("aria-label", ko.compare.betterAria("-20.0%"));
  });
  it("rps처럼 올라서 좋음 → ▲+10.0% 초록", () => {
    const el = chipOf(one(5, { pct: 0.1, polarity: "good" }));
    expect(el).toHaveTextContent("▲+10.0%");
    expect(el.className).toContain("text-green-600");
  });
  it("0% 중립 → 글리프 없음", () => {
    const el = chipOf(one(5, { pct: 0, polarity: "neutral" }));
    expect(el).toHaveTextContent(/^\+0\.0%$/);
  });
  it("기준 0 · 값 5 → ▲신규, 값 0 → 글리프 없는 동일", () => {
    expect(chipOf(one(5, { pct: null, polarity: "good" }))).toHaveTextContent("▲신규");
  });
  it("기준 0 · 값 0 → 동일", () => {
    expect(chipOf(one(0, { pct: null, polarity: "neutral" }))).toHaveTextContent(/^동일$/);
  });
});
