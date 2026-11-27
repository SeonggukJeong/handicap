import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import {
  STEP_METRICS,
  SUMMARY_METRICS,
  compareReports,
  computeDelta,
  computeDeltaCapped,
  verdictPolarity,
} from "../compareReports";
import type { Report } from "../../api/schemas";
import type { Cell } from "../compareReports";

// jsdom environment does not provide a file: import.meta.url, so we use
// path.resolve(__dirname, ...) instead. __dirname is vitest's test file dir.
const golden = JSON.parse(
  readFileSync(nodePath.resolve(__dirname, "../../../../testdata/compare_golden.json"), "utf8"),
);

describe("computeDelta (matches Rust §4.3)", () => {
  it("lower_is_better p95: increase = bad", () => {
    expect(computeDelta("p95_ms", 152, 184)).toEqual({
      pct: (184 - 152) / 152,
      polarity: "bad",
      capped: false,
    });
  });
  it("higher_is_better rps: decrease = bad", () => {
    expect(computeDelta("rps", 20400, 19800).polarity).toBe("bad");
  });
  it("higher_is_better rps: increase = good", () => {
    expect(computeDelta("rps", 20400, 21000).polarity).toBe("good");
  });
  it("baseline 0 -> pct null", () => {
    expect(computeDelta("error_rate", 0, 0.01).pct).toBeNull();
  });
  it("equal -> neutral", () => {
    expect(computeDelta("p50_ms", 9, 9)).toEqual({ pct: 0, polarity: "neutral", capped: false });
  });
});

type GoldenDelta = null | { pct: number | null; polarity: string; capped: boolean };
type GoldenRow = {
  metric: string;
  step_id?: string;
  values: (number | null)[];
  deltas: GoldenDelta[];
};

/** 골든 행 하나를 비교 결과의 칸들에 대어 본다(값 1e-9·변화율 1e-9·방향·잘림, null 자리 포함). */
function expectRow(label: string, cells: Cell[], row: GoldenRow, baselineIdx: number) {
  row.values.forEach((v, i) => {
    if (v === null) expect(cells[i].value, `${label} value[${i}]`).toBeNull();
    else expect(cells[i].value, `${label} value[${i}]`).toBeCloseTo(v, 9);
  });
  row.deltas.forEach((exp, i) => {
    const d = cells[i].delta;
    if (exp === null) {
      expect(d, `${label} delta[${i}] null`).toBeNull();
      expect(
        i === baselineIdx || cells[i].value === null || cells[baselineIdx].value === null,
        `${label} delta[${i}] null only for baseline/missing`,
      ).toBe(true);
      return;
    }
    expect(d, `${label} delta[${i}]`).not.toBeNull();
    if (exp.pct === null) expect(d!.pct, `${label} pct[${i}]`).toBeNull();
    else expect(d!.pct).toBeCloseTo(exp.pct, 9);
    expect(d!.polarity, `${label} polarity[${i}]`).toBe(exp.polarity);
    expect(d!.capped, `${label} capped[${i}]`).toBe(exp.capped);
  });
}

describe("golden cross-check vs Rust", () => {
  const baseIdx = golden.reports.findIndex(
    (r: { run: { id: string } }) => r.run.id === golden.baseline_id,
  );
  const result = compareReports(golden.reports, golden.baseline_id);

  it("summary 지표 순서가 서버와 같다", () => {
    expect(result.summary.map((r) => r.metric)).toEqual(
      golden.expected.summary.map((r: GoldenRow) => r.metric),
    );
    expect([...SUMMARY_METRICS]).toEqual(golden.expected.summary.map((r: GoldenRow) => r.metric));
  });

  it("summary values·deltas match the shared fixture", () => {
    for (const row of golden.expected.summary as GoldenRow[]) {
      const r = result.summary.find((m) => m.metric === row.metric)!;
      expectRow(row.metric, r.cells, row, baseIdx);
    }
  });

  it("step 통계 행: p95는 steps, 나머지 다섯은 stepStats — 순서·id·값·Δ가 서버와 같다", () => {
    const rows = golden.expected.step_deltas as GoldenRow[];
    expect(rows.map((r) => [r.step_id, r.metric])).toEqual(
      ["s1"].flatMap((id) => STEP_METRICS.map((m) => [id, m])),
    );
    expect(result.stepStats.map((r) => [r.id, r.metric])).toEqual(
      rows.filter((r) => r.metric !== "p95_ms").map((r) => [r.step_id, r.metric]),
    );
    for (const row of rows) {
      const found =
        row.metric === "p95_ms"
          ? result.steps.find((r) => r.id === row.step_id)
          : result.stepStats.find((r) => r.id === row.step_id && r.metric === row.metric);
      expect(found, `${row.step_id} ${row.metric}`).toBeDefined();
      expectRow(`${row.step_id} ${row.metric}`, found!.cells, row, baseIdx);
    }
  });
});

describe("golden capped table vs Rust (computeDeltaCapped)", () => {
  type Row = {
    metric: string;
    base: number;
    val: number;
    base_cut: boolean;
    val_cut: boolean;
    pct: number | null;
    polarity: string;
    capped: boolean;
  };
  const rows = golden.expected.capped as Row[];
  it("7행이다", () => expect(rows).toHaveLength(7));
  for (const [i, row] of rows.entries()) {
    it(`#${i} ${row.metric} ${row.base}(${row.base_cut}) → ${row.val}(${row.val_cut})`, () => {
      const d = computeDeltaCapped(
        row.metric,
        { v: row.base, cut: row.base_cut },
        { v: row.val, cut: row.val_cut },
      );
      if (row.pct === null) expect(d.pct).toBeNull();
      else expect(d.pct).toBeCloseTo(row.pct, 9);
      expect(d.polarity).toBe(row.polarity);
      expect(d.capped).toBe(row.capped);
    });
  }
});

describe("golden stats_cases vs Rust (리포트 단위 잘림 판정)", () => {
  const cases = golden.stats_cases as {
    name: string;
    reports: Report[];
    baseline_id: string;
    expected: { summary: GoldenRow[] };
  }[];
  it("세 사례가 있다", () => {
    expect(cases.map((c) => c.name)).toEqual(["candidate_capped", "both_capped", "stats_absent"]);
  });
  for (const c of cases) {
    it(`${c.name}: 적힌 행의 값·Δ가 서버 기대와 같다`, () => {
      const result = compareReports(c.reports, c.baseline_id);
      const baseIdx = c.reports.findIndex((r) => r.run.id === c.baseline_id);
      for (const row of c.expected.summary) {
        const r = result.summary.find((m) => m.metric === row.metric)!;
        expectRow(`${c.name} ${row.metric}`, r.cells, row, baseIdx);
      }
    });
  }
  it("stats_absent: candidate 시간 칸은 값 없음·time 없음, rps·error_rate는 값이 있다", () => {
    const c = cases[2];
    const result = compareReports(c.reports, c.baseline_id);
    for (const r of result.summary) {
      if (r.metric === "rps" || r.metric === "error_rate") {
        expect(r.cells[1].value).not.toBeNull();
      } else {
        expect(r.cells[1]).toEqual({ value: null, delta: null });
        expect(r.cells[1].time).toBeUndefined();
      }
    }
  });
});

describe("Cell.time (정밀 글자용 µs)", () => {
  const result = compareReports(golden.reports, golden.baseline_id);
  const base = (metric: string) => result.summary.find((r) => r.metric === metric)!.cells[0];
  it("시간 지표 칸은 원래 µs를 싣는다", () => {
    expect(base("mean_ms").time).toEqual({ us: 25000 });
    expect(base("stdev_ms").time).toEqual({ us: 30000 });
    expect(base("min_ms").time).toEqual({ us: 2000 });
    for (const m of ["p50_ms", "p90_ms", "p95_ms", "p99_ms", "max_ms"]) {
      expect(base(m).time, m).toEqual({ us: expect.any(Number) });
    }
  });
  it("rps·error_rate 칸은 time이 없다", () => {
    expect(base("rps").time).toBeUndefined();
    expect(base("error_rate").time).toBeUndefined();
  });
});

describe("스텝이 한쪽 run에만 있는 비교 (run 셋)", () => {
  const stat = (p95: number) => ({
    min_us: 1000,
    mean_us: 2000,
    max_us: p95 * 1000,
    stdev_us: 500,
    p50_us: 1500,
    p90_us: p95 * 900,
    p95_us: p95 * 1000,
    p99_us: p95 * 1000,
    capped: false,
  });
  const mkStep = (id: string, p95: number) => ({
    step_id: id,
    count: 10,
    error_count: 0,
    status_counts: {},
    p50_ms: 1,
    p95_ms: p95,
    p99_ms: p95,
    stats: stat(p95),
    loop_breakdown: [],
  });
  const mk = (id: string, steps: ReturnType<typeof mkStep>[]) =>
    ({
      ...(golden.reports[0] as Report),
      run: { ...golden.reports[0].run, id },
      steps,
    }) as Report;
  const A = mk("A", [mkStep("s1", 100), mkStep("s2", 100)]);
  const B = mk("B", [mkStep("s1", 120)]); // s2 없음
  const C = mk("C", [mkStep("s1", 150), mkStep("s2", 200)]);
  const res = compareReports([A, B, C], "A");

  it("steps 행은 id를 싣는다", () => {
    expect(res.steps.every((r) => r.id !== undefined)).toBe(true);
    expect(res.steps.map((r) => r.id)).toEqual(["s1", "s2"]);
  });
  it("p95 행: B의 s2 칸은 빈 칸, 뒤 run C의 Δ는 제 열에 선다", () => {
    const s2 = res.steps.find((r) => r.id === "s2")!;
    expect(s2.cells[1]).toEqual({ value: null, delta: null });
    expect(s2.cells[2].value).toBe(200);
    expect(s2.cells[2].delta).toEqual({ pct: 1, polarity: "bad", capped: false });
  });
  it("stepStats의 s2 행도 같다(B 칸 빈 칸, C 칸 Δ 있음)", () => {
    const rows = res.stepStats.filter((r) => r.id === "s2");
    expect(rows.map((r) => r.metric)).toEqual([
      "mean_ms",
      "min_ms",
      "max_ms",
      "stdev_ms",
      "p90_ms",
    ]);
    for (const r of rows) {
      expect(r.cells[1], r.metric).toEqual({ value: null, delta: null });
      expect(r.cells[2].value, r.metric).not.toBeNull();
    }
    const max = rows.find((r) => r.metric === "max_ms")!;
    expect(max.cells[2].delta).toEqual({ pct: 1, polarity: "bad", capped: false });
  });
});

describe("golden missing_cases vs Rust (통과한 요청 없는 칸)", () => {
  const cases = golden.missing_cases as {
    name: string;
    reports: Report[];
    baseline_id: string;
    expected: { summary: GoldenRow[] };
  }[];
  it("두 사례가 있다", () => {
    expect(cases.map((c) => c.name)).toEqual(["baseline_missing", "candidate_missing"]);
  });
  for (const c of cases) {
    it(`${c.name}: 값·Δ가 서버 기대와 같다(null 위치 포함)`, () => {
      const result = compareReports(c.reports, c.baseline_id);
      const baseIdx = c.reports.findIndex((r) => r.run.id === c.baseline_id);
      expect(c.expected.summary).toHaveLength(SUMMARY_METRICS.length);
      for (const row of c.expected.summary) {
        const r = result.summary.find((m) => m.metric === row.metric)!;
        expect(
          r.cells.map((x) => x.value),
          row.metric,
        ).toEqual(row.values);
        expectRow(`${c.name} ${row.metric}`, r.cells, row, baseIdx);
      }
    });
  }
  it("스텝 p95도 같은 규칙: 통과한 요청이 없으면 null·Δ null", () => {
    const step = (count: number, errors: number, p95: number) => ({
      step_id: "s1",
      count,
      error_count: errors,
      status_counts: {},
      p50_ms: 0,
      p95_ms: p95,
      p99_ms: 0,
      stats: {
        min_us: 0,
        mean_us: 0,
        max_us: p95 * 1000,
        stdev_us: 0,
        p50_us: 0,
        p90_us: p95 * 1000,
        p95_us: p95 * 1000,
        p99_us: 0,
        capped: false,
      },
      loop_breakdown: [],
    });
    const mk = (id: string, st: ReturnType<typeof step>) =>
      ({
        ...(cases[0].reports[1] as Report),
        run: { ...cases[0].reports[1].run, id },
        steps: [st],
      }) as Report;
    const res = compareReports([mk("a", step(10, 10, 0)), mk("b", step(10, 1, 40))], "a");
    expect(res.steps[0].cells.map((x) => x.value)).toEqual([null, 40]);
    expect(res.steps[0].cells[1].delta).toBeNull();
  });
  it("옛 run(sample 없음)·stats 없는 리포트는 정수 칸이 0이어도 시간 칸이 값 없음이다", () => {
    const old = (id: string) =>
      ({
        ...(cases[0].reports[0] as Report),
        run: { ...cases[0].reports[0].run, id },
        sample: undefined,
      }) as Report;
    const res = compareReports([old("a"), old("b")], "a");
    for (const r of res.summary.filter((m) => m.metric !== "rps" && m.metric !== "error_rate")) {
      expect(r.cells, r.metric).toEqual([
        { value: null, delta: null },
        { value: null, delta: null },
      ]);
    }
  });
});

describe("golden polarity block vs Rust", () => {
  it("computeDelta matches every polarity fixture entry", () => {
    const rows = golden.expected.polarity as {
      metric: string;
      base: number;
      val: number;
      pct: number | null;
      polarity: string;
    }[];
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const d = computeDelta(row.metric, row.base, row.val);
      if (row.pct === null) expect(d.pct).toBeNull();
      else expect(d.pct).toBeCloseTo(row.pct, 12);
      expect(d.polarity, `${row.metric} ${row.base}->${row.val}`).toBe(row.polarity);
      expect(d.capped).toBe(false);
    }
  });
});

describe("verdictPolarity (baseline-relative, spec R7)", () => {
  it("baseline PASS & candidate FAIL → bad (악화)", () => {
    expect(verdictPolarity(true, false)).toBe("bad");
  });
  it("baseline FAIL & candidate PASS → good (개선)", () => {
    expect(verdictPolarity(false, true)).toBe("good");
  });
  it("equal verdicts → neutral", () => {
    expect(verdictPolarity(true, true)).toBe("neutral");
    expect(verdictPolarity(false, false)).toBe("neutral");
  });
  it("null on either side → neutral", () => {
    expect(verdictPolarity(null, false)).toBe("neutral");
    expect(verdictPolarity(true, null)).toBe("neutral");
    expect(verdictPolarity(null, null)).toBe("neutral");
  });
});

type SetupStepIn = { id: string; p95: number; errors: number };
function mkReport(
  id: string,
  stepIds: string[],
  p95: number,
  setup?: { ok: number; failed: number; steps: SetupStepIn[] },
): Report {
  return {
    run: { id },
    summary: {
      count: 100,
      errors: 2,
      rps: 20,
      p50_ms: 10,
      p95_ms: p95,
      p99_ms: 35,
      stats: {
        min_us: 5000,
        mean_us: 10000,
        max_us: 35000,
        stdev_us: p95 * 100,
        p50_us: 10000,
        p90_us: p95 * 1000,
        p95_us: p95 * 1000,
        p99_us: 35000,
        capped: false,
      },
    },
    steps: stepIds.map((s) => ({
      step_id: s,
      p95_ms: p95,
      stats: {
        min_us: 500,
        mean_us: 1000,
        max_us: p95 * 1000,
        stdev_us: p95 * 100,
        p50_us: 1000,
        p90_us: p95 * 1000,
        p95_us: p95 * 1000,
        p99_us: p95 * 1000,
        capped: false,
      },
    })),
    status_distribution: { "200": 98, "500": 2 },
    verdict: null,
    ...(setup
      ? {
          setup: {
            ok: setup.ok,
            failed: setup.failed,
            interrupted: 0,
            steps: setup.steps.map((s) => ({
              step_id: s.id,
              count: 10,
              errors: s.errors,
              p50_ms: 1,
              p95_ms: s.p95,
              max_ms: s.p95,
              status_counts: {},
              failure_kinds: {},
            })),
          },
        }
      : {}),
  } as unknown as Report;
}

describe("compareReports setup rows", () => {
  const A = () =>
    mkReport("A", ["m1"], 25, {
      ok: 50,
      failed: 0,
      steps: [
        { id: "s1", p95: 10, errors: 3 },
        { id: "s2", p95: 20, errors: 0 },
      ],
    });
  const B = () =>
    mkReport("B", ["m1"], 25, {
      ok: 47,
      failed: 3,
      steps: [
        { id: "s3", p95: 7, errors: 1 },
        { id: "s1", p95: 12, errors: 0 },
      ],
    });
  const C = () => mkReport("C", ["m1"], 25);

  it("setup rows: baseline order then first-seen", () => {
    const r = compareReports([A(), B(), C()], "A");
    expect(r.setup.map((x) => [x.label, x.metric])).toEqual([
      ["setup_ok", "setup_ok"],
      ["setup_failed", "setup_failed"],
      ["s1", "p95_ms"],
      ["s1", "setup_errors"],
      ["s2", "p95_ms"],
      ["s2", "setup_errors"],
      ["s3", "p95_ms"],
      ["s3", "setup_errors"],
    ]);
    expect(r.setup[2].id).toBe("s1");
    expect(r.setup[0].id).toBeUndefined();
  });

  it("setup rows: order follows the chosen baseline, not array position", () => {
    const r = compareReports([A(), B(), C()], "B");
    expect(r.setup.map((x) => [x.label, x.metric])).toEqual([
      ["setup_ok", "setup_ok"],
      ["setup_failed", "setup_failed"],
      ["s3", "p95_ms"],
      ["s3", "setup_errors"],
      ["s1", "p95_ms"],
      ["s1", "setup_errors"],
      ["s2", "p95_ms"],
      ["s2", "setup_errors"],
    ]);
  });

  it("setup rows: run without setup → null cells, no delta", () => {
    const r = compareReports([A(), B(), C()], "A");
    for (const row of r.setup) expect(row.cells[2]).toEqual({ value: null, delta: null });
  });

  it("setup rows: step missing in baseline → no delta", () => {
    const r = compareReports([A(), B(), C()], "A");
    const s3 = r.setup.find((x) => x.label === "s3" && x.metric === "p95_ms")!;
    expect(s3.cells[1].delta).toBeNull();
    expect(s3.cells[1].value).toBe(7);
  });

  it("setup rows: polarity", () => {
    const r = compareReports([A(), B()], "A");
    const ok = r.setup.find((x) => x.metric === "setup_ok")!;
    expect(ok.cells[1].delta?.polarity).toBe("bad");
    const failed = r.setup.find((x) => x.metric === "setup_failed")!;
    expect(failed.cells[1].delta).toEqual({ pct: null, polarity: "bad", capped: false });
    const errs = r.setup.find((x) => x.label === "s1" && x.metric === "setup_errors")!;
    expect(errs.cells[1].delta?.polarity).toBe("good");
  });

  describe("준비 스텝 p95의 60초 칸", () => {
    const cellsFor = (base: number, val: number) => {
      const mk = (id: string, p95: number) =>
        mkReport(id, ["m1"], 25, { ok: 10, failed: 0, steps: [{ id: "s1", p95, errors: 0 }] });
      const r = compareReports([mk("A", base), mk("B", val)], "A");
      return r.setup.find((x) => x.metric === "p95_ms")!.cells;
    };
    const capped = { us: 60_000_000 };

    it("기준 200 · 비교 60030 → 비교 칸이 60000 잘림, 나쁨", () => {
      const c = cellsFor(200, 60030);
      expect(c[0]).toEqual({ value: 200, delta: null });
      expect(c[1]).toEqual({
        value: 60000,
        time: capped,
        delta: { pct: null, polarity: "bad", capped: true },
      });
    });
    it("기준 60030 · 비교 200 → 기준 칸이 60000 잘림, 좋음", () => {
      const c = cellsFor(60030, 200);
      expect(c[0]).toEqual({ value: 60000, time: capped, delta: null });
      expect(c[1]).toEqual({
        value: 200,
        delta: { pct: null, polarity: "good", capped: true },
      });
    });
    it("기준 60030 · 비교 60100 → 둘 다 60000 잘림, 중립", () => {
      const c = cellsFor(60030, 60100);
      expect(c[0]).toEqual({ value: 60000, time: capped, delta: null });
      expect(c[1]).toEqual({
        value: 60000,
        time: capped,
        delta: { pct: null, polarity: "neutral", capped: true },
      });
    });
    it("기준 200 · 비교 60000 → 경계도 잘림", () => {
      const c = cellsFor(200, 60000);
      expect(c[0]).toEqual({ value: 200, delta: null });
      expect(c[1]).toEqual({
        value: 60000,
        time: capped,
        delta: { pct: null, polarity: "bad", capped: true },
      });
    });
    it("기준 200 · 비교 59999 → 안 잘림, 변화율 계산", () => {
      const c = cellsFor(200, 59999);
      expect(c[0]).toEqual({ value: 200, delta: null });
      expect(c[1].value).toBe(59999);
      expect(c[1]).not.toHaveProperty("time");
      expect(c[1].delta?.capped).toBe(false);
      expect(c[1].delta?.polarity).toBe("bad");
      expect(c[1].delta?.pct).toBeCloseTo(298.995, 9);
    });
  });

  it("no setup anywhere → setup is [] and existing cells are unchanged", () => {
    type D = { pct: number | null; polarity: string; capped: boolean };
    const t = (us: number) => ({ us });
    const d = (pct: number | null, polarity: string): D => ({ pct, polarity, capped: false });
    // 행 하나: 라벨(스텝 통계 행은 지표 이름)·값·time·Δ. 스텝 행은 id도 싣는다.
    const row = (
      label: string,
      values: (number | null)[],
      times: ({ us: number } | undefined)[],
      deltas: (D | null)[],
      metric: string = label,
      id?: string,
    ) => ({
      label,
      ...(id === undefined ? {} : { id }),
      metric,
      cells: values.map((value, i) => ({
        value,
        delta: deltas[i],
        ...(times[i] === undefined ? {} : { time: times[i] }),
      })),
    });
    const r = compareReports([mkReport("A", ["m1", "m2"], 25), mkReport("B", ["m1"], 30)], "A");
    expect(r.setup).toEqual([]);
    expect({
      runIds: r.runIds,
      baselineIdx: r.baselineIdx,
      summary: r.summary,
      steps: r.steps,
      stepStats: r.stepStats,
      status: r.status,
      verdict: r.verdict,
      stepMismatch: r.stepMismatch,
    }).toEqual({
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary: [
        row("p50_ms", [10, 10], [t(10000), t(10000)], [null, d(0, "neutral")]),
        row("p90_ms", [25, 30], [t(25000), t(30000)], [null, d(0.2, "bad")]),
        row("p95_ms", [25, 30], [t(25000), t(30000)], [null, d(0.2, "bad")]),
        row("p99_ms", [35, 35], [t(35000), t(35000)], [null, d(0, "neutral")]),
        row("mean_ms", [10, 10], [t(10000), t(10000)], [null, d(0, "neutral")]),
        row("min_ms", [5, 5], [t(5000), t(5000)], [null, d(0, "neutral")]),
        row("max_ms", [35, 35], [t(35000), t(35000)], [null, d(0, "neutral")]),
        row("stdev_ms", [2.5, 3], [t(2500), t(3000)], [null, d(0.2, "bad")]),
        row("rps", [20, 20], [undefined, undefined], [null, d(0, "neutral")]),
        row("error_rate", [0.02, 0.02], [undefined, undefined], [null, d(0, "neutral")]),
      ],
      steps: [
        row("m1", [25, 30], [t(25000), t(30000)], [null, d(0.2, "bad")], "p95_ms", "m1"),
        row("m2", [25, null], [t(25000), undefined], [null, null], "p95_ms", "m2"),
      ],
      stepStats: [
        row("mean_ms", [1, 1], [t(1000), t(1000)], [null, d(0, "neutral")], "mean_ms", "m1"),
        row("min_ms", [0.5, 0.5], [t(500), t(500)], [null, d(0, "neutral")], "min_ms", "m1"),
        row("max_ms", [25, 30], [t(25000), t(30000)], [null, d(0.2, "bad")], "max_ms", "m1"),
        row("stdev_ms", [2.5, 3], [t(2500), t(3000)], [null, d(0.2, "bad")], "stdev_ms", "m1"),
        row("p90_ms", [25, 30], [t(25000), t(30000)], [null, d(0.2, "bad")], "p90_ms", "m1"),
        row("mean_ms", [1, null], [t(1000), undefined], [null, null], "mean_ms", "m2"),
        row("min_ms", [0.5, null], [t(500), undefined], [null, null], "min_ms", "m2"),
        row("max_ms", [25, null], [t(25000), undefined], [null, null], "max_ms", "m2"),
        row("stdev_ms", [2.5, null], [t(2500), undefined], [null, null], "stdev_ms", "m2"),
        row("p90_ms", [25, null], [t(25000), undefined], [null, null], "p90_ms", "m2"),
      ],
      status: [
        {
          label: "200",
          metric: "status",
          cells: [
            { value: 98, delta: null },
            { value: 98, delta: null },
          ],
        },
        {
          label: "500",
          metric: "status",
          cells: [
            { value: 2, delta: null },
            { value: 2, delta: null },
          ],
        },
      ],
      verdict: { passed: [null, null] },
      stepMismatch: true,
    });
  });

  it("stepMismatch ignores setup steps", () => {
    const a = mkReport("A", ["m1"], 25, {
      ok: 1,
      failed: 0,
      steps: [{ id: "s1", p95: 1, errors: 0 }],
    });
    const b = mkReport("B", ["m1"], 25, {
      ok: 1,
      failed: 0,
      steps: [{ id: "s9", p95: 1, errors: 0 }],
    });
    expect(compareReports([a, b], "A").stepMismatch).toBe(false);
  });
});
