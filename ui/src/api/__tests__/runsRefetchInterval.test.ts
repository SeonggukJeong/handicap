import { describe, expect, it } from "vitest";
import { runsRefetchInterval } from "../hooks";

describe("runsRefetchInterval", () => {
  it("데이터 없음 → false", () => {
    expect(runsRefetchInterval(undefined)).toBe(false);
  });
  it("running 없음 → false", () => {
    expect(runsRefetchInterval({ runs: [{ status: "completed" }, { status: "failed" }] })).toBe(
      false,
    );
  });
  it("running 있음 → 5000", () => {
    expect(runsRefetchInterval({ runs: [{ status: "completed" }, { status: "running" }] })).toBe(
      5000,
    );
  });
});
