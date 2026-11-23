import { describe, it, expect } from "vitest";
import { hasLatency, stepCounts, summaryCounts, windowNotSent } from "../hasLatency";
import type { Report, ReportStep } from "../../api/schemas";

const normal = { count: 10, errors: 2, notSent: 0 };
const allFailed = { count: 10, errors: 10, notSent: 0 };
const allNotSent = { count: 10, errors: 10, notSent: 10 };
const empty = { count: 0, errors: 0, notSent: 0 };

describe("hasLatency", () => {
  it("passed: 통과한 요청(count − errors)이 있어야 값", () => {
    expect(hasLatency(normal, "passed")).toBe(true);
    expect(hasLatency(allFailed, "passed")).toBe(false);
    expect(hasLatency(allNotSent, "passed")).toBe(false);
    expect(hasLatency(empty, "passed")).toBe(false);
  });
  it("failed: 보낸 실패(errors − notSent)가 있어야 값", () => {
    expect(hasLatency(normal, "failed")).toBe(true);
    expect(hasLatency(allFailed, "failed")).toBe(true);
    expect(hasLatency(allNotSent, "failed")).toBe(false);
    expect(hasLatency(empty, "failed")).toBe(false);
  });
  it("all: 보낸 요청(count − notSent)이 있어야 값", () => {
    expect(hasLatency(normal, "all")).toBe(true);
    expect(hasLatency(allFailed, "all")).toBe(true);
    expect(hasLatency(allNotSent, "all")).toBe(false);
    expect(hasLatency(empty, "all")).toBe(false);
  });
});

describe("windowNotSent", () => {
  it("count에서 상태별 합을 뺀다", () => {
    expect(windowNotSent({ count: 10, status_counts: { "200": 6, "500": 1 } })).toBe(3);
    expect(windowNotSent({ count: 5, status_counts: { "200": 5 } })).toBe(0);
  });
});

describe("stepCounts·summaryCounts", () => {
  it("스텝은 not_sent를 그대로, 없으면 0", () => {
    const s = { count: 4, error_count: 3, not_sent: 2 } as unknown as ReportStep;
    expect(stepCounts(s)).toEqual({ count: 4, errors: 3, notSent: 2 });
    expect(stepCounts({ count: 4, error_count: 3 } as unknown as ReportStep).notSent).toBe(0);
  });
  it("요약은 스텝의 not_sent 합", () => {
    const r = {
      summary: { count: 9, errors: 9 },
      steps: [{ not_sent: 2 }, { not_sent: 3 }, {}],
    } as unknown as Report;
    expect(summaryCounts(r)).toEqual({ count: 9, errors: 9, notSent: 5 });
  });
});
