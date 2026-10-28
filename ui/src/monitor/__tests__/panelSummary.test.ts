import { describe, it, expect } from "vitest";
import { panelSummary } from "../panelSummary";
import { newPanel } from "../../api/monitors";

describe("panelSummary", () => {
  it("formats scenario, interval, conditions and displays", () => {
    const p = { ...newPanel(), interval_seconds: 10 };
    expect(panelSummary(p, "점검")).toBe("점검 · 10초 · 조건 0 · 표시 0");
  });
  it("falls back when the scenario is missing", () => {
    const p = { ...newPanel(), interval_seconds: 30 };
    expect(panelSummary(p, undefined)).toBe("시나리오 — · 30초 · 조건 0 · 표시 0");
  });
});
