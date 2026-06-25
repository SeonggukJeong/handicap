import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { compareReports, computeDelta, verdictPolarity } from "../compareReports";

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
