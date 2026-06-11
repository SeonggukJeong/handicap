import { describe, it, expect } from "vitest";
import { ko } from "../ko";

describe("ko 카탈로그", () => {
  it("glossary 14개 핵심 용어가 전부 비어 있지 않은 문자열이다", () => {
    const required = [
      "vu",
      "rps",
      "p50",
      "p95",
      "p99",
      "rampUp",
      "closedLoop",
      "openLoop",
      "thinkTime",
      "maxInFlight",
      "slo",
      "scenario",
      "step",
      "run",
    ] as const;
    for (const key of required) {
      const value = ko.glossary[key];
      expect(value, `glossary.${key}`).toBeTypeOf("string");
      expect(value.length, `glossary.${key}`).toBeGreaterThan(0);
    }
  });

  it("백분위 용어 설명은 '낮을수록 좋음' 방향성을 포함한다", () => {
    for (const key of ["p50", "p95", "p99"] as const) {
      expect(ko.glossary[key]).toContain("낮을수록 좋");
    }
  });
});
