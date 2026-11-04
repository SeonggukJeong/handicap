import { describe, it, expect } from "vitest";
import { panelSummary } from "../panelSummary";
import { newPanel } from "../../api/monitors";

describe("panelSummary", () => {
  it("formats scenario, interval, conditions and displays", () => {
    const p = { ...newPanel(), interval_seconds: 10 };
    expect(panelSummary(p, "점검")).toBe("점검 · 10초 · 조건 0 · 표시 0");
  });
  it("solo_appends_whole_scenario", () => {
    const p = { ...newPanel(), interval_seconds: 10 };
    expect(panelSummary(p, "점검", { solo: true })).toBe(
      "단독 실행 · 점검 · 10초 · 조건 0 · 표시 0 · 시나리오 전체",
    );
  });
  it("stepName_shows_step_limit_conditions", () => {
    const p = { ...newPanel(), timeout_seconds: 5 };
    expect(panelSummary(p, "점검", { stepName: "로그인" })).toBe(
      "스텝: 로그인 · 제한 5초 · 조건 0",
    );
  });
  it("falls back when the scenario is missing", () => {
    const p = { ...newPanel(), interval_seconds: 30 };
    expect(panelSummary(p, undefined)).toBe("시나리오 — · 30초 · 조건 0 · 표시 0");
  });
});
