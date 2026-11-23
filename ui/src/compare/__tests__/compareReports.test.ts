import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { compareReports, computeDelta, verdictPolarity } from "../compareReports";
import type { Report } from "../../api/schemas";

// jsdom environment does not provide a file: import.meta.url, so we use
// path.resolve(__dirname, ...) instead. __dirname is vitest's test file dir.
const golden = JSON.parse(
  readFileSync(nodePath.resolve(__dirname, "../../../../testdata/compare_golden.json"), "utf8"),
);

describe("computeDelta (matches Rust §4.3)", () => {
  it("lower_is_better p95: increase = bad", () => {
    expect(computeDelta("p95_ms", 152, 184)).toEqual({ pct: (184 - 152) / 152, polarity: "bad" });
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
    expect(computeDelta("p50_ms", 9, 9)).toEqual({ pct: 0, polarity: "neutral" });
  });
});

describe("golden cross-check vs Rust", () => {
  it("summary deltas match the shared fixture", () => {
    const baseIdx = golden.reports.findIndex(
      (r: { run: { id: string } }) => r.run.id === golden.baseline_id,
    );
    const result = compareReports(golden.reports, golden.baseline_id);
    for (const row of golden.expected.summary) {
      const r = result.summary.find((m) => m.metric === row.metric)!;
      row.deltas.forEach((exp: null | { pct: number; polarity: string }, i: number) => {
        const cell = r.cells[i];
        if (exp === null) {
          expect(i).toBe(baseIdx);
          expect(cell.delta).toBeNull();
          return;
        }
        expect(cell.delta!.pct).toBeCloseTo(exp.pct, 9);
        expect(cell.delta!.polarity).toBe(exp.polarity);
      });
    }
  });
});

describe("golden missing_cases vs Rust (통과한 요청 없는 칸)", () => {
  type Exp = {
    metric: string;
    values: (number | null)[];
    deltas: (null | { pct: number | null; polarity: string })[];
  };
  const cases = golden.missing_cases as {
    name: string;
    reports: Report[];
    baseline_id: string;
    expected: { summary: Exp[] };
  }[];
  it("두 사례가 있다", () => {
    expect(cases.map((c) => c.name)).toEqual(["baseline_missing", "candidate_missing"]);
  });
  for (const c of cases) {
    it(`${c.name}: 값·Δ가 서버 기대와 같다(null 위치 포함)`, () => {
      const result = compareReports(c.reports, c.baseline_id);
      for (const row of c.expected.summary) {
        const r = result.summary.find((m) => m.metric === row.metric)!;
        expect(
          r.cells.map((x) => x.value),
          row.metric,
        ).toEqual(row.values);
        row.deltas.forEach((exp, i) => {
          const cell = r.cells[i];
          if (exp === null) expect(cell.delta, `${row.metric}[${i}]`).toBeNull();
          else {
            expect(cell.delta!.pct).toBeCloseTo(exp.pct!, 9);
            expect(cell.delta!.polarity).toBe(exp.polarity);
          }
        });
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
  it("옛 run(sample 없음)은 모두 실패여도 0 그대로 비교한다", () => {
    const old = (id: string) =>
      ({
        ...(cases[0].reports[0] as Report),
        run: { ...cases[0].reports[0].run, id },
        sample: undefined,
      }) as Report;
    const res = compareReports([old("a"), old("b")], "a");
    expect(res.summary[0].cells.map((x) => x.value)).toEqual([0, 0]);
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
    summary: { count: 100, errors: 2, rps: 20, p50_ms: 10, p95_ms: p95, p99_ms: 35 },
    steps: stepIds.map((s) => ({ step_id: s, p95_ms: p95 })),
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
    expect(failed.cells[1].delta).toEqual({ pct: null, polarity: "bad" });
    const errs = r.setup.find((x) => x.label === "s1" && x.metric === "setup_errors")!;
    expect(errs.cells[1].delta?.polarity).toBe("good");
  });

  it("no setup anywhere → setup is [] and existing cells are unchanged", () => {
    const r = compareReports([mkReport("A", ["m1", "m2"], 25), mkReport("B", ["m1"], 30)], "A");
    expect(r.setup).toEqual([]);
    expect({
      runIds: r.runIds,
      baselineIdx: r.baselineIdx,
      summary: r.summary,
      steps: r.steps,
      status: r.status,
      verdict: r.verdict,
      stepMismatch: r.stepMismatch,
    }).toEqual({
      runIds: ["A", "B"],
      baselineIdx: 0,
      summary: [
        {
          label: "p50_ms",
          metric: "p50_ms",
          cells: [
            { value: 10, delta: null },
            { value: 10, delta: { pct: 0, polarity: "neutral" } },
          ],
        },
        {
          label: "p95_ms",
          metric: "p95_ms",
          cells: [
            { value: 25, delta: null },
            { value: 30, delta: { pct: 0.2, polarity: "bad" } },
          ],
        },
        {
          label: "p99_ms",
          metric: "p99_ms",
          cells: [
            { value: 35, delta: null },
            { value: 35, delta: { pct: 0, polarity: "neutral" } },
          ],
        },
        {
          label: "rps",
          metric: "rps",
          cells: [
            { value: 20, delta: null },
            { value: 20, delta: { pct: 0, polarity: "neutral" } },
          ],
        },
        {
          label: "error_rate",
          metric: "error_rate",
          cells: [
            { value: 0.02, delta: null },
            { value: 0.02, delta: { pct: 0, polarity: "neutral" } },
          ],
        },
      ],
      steps: [
        {
          label: "m1",
          metric: "p95_ms",
          cells: [
            { value: 25, delta: null },
            { value: 30, delta: { pct: 0.2, polarity: "bad" } },
          ],
        },
        {
          label: "m2",
          metric: "p95_ms",
          cells: [
            { value: 25, delta: null },
            { value: null, delta: null },
          ],
        },
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
