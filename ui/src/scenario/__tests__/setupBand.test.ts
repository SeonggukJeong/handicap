import { describe, expect, it } from "vitest";
import {
  SETUP_BAND,
  SETUP_DROP_ID,
  SETUP_ZONE_LIFT_PX,
  SETUP_ZONE_REACH_PX,
  TOP_BAND,
  TOP_DROP_ID,
  bandIndex,
  bandKey,
  dropId,
  enumerateBands,
  filterDropCandidates,
  keyboardCandidateIds,
  legalTargetBands,
  parseDropId,
  setupZoneOpen,
} from "../dropRules";
import { resolveDrop } from "../reorder";
import { StepModel, type Step } from "../model";

const S1 = "01HX0000000000000000000S01";
const S2 = "01HX0000000000000000000S02";
const B1 = "01HX0000000000000000000B01";
const B2 = "01HX0000000000000000000B02";
const K1 = "01HX0000000000000000000K01";
const C1 = "01HX0000000000000000000C01";
const C2 = "01HX0000000000000000000C02";
const F1 = "01HX0000000000000000000F01";
const C3 = "01HX0000000000000000000C03";
const P1 = "01HX0000000000000000000P01";
const C4 = "01HX0000000000000000000C04";
const C5 = "01HX0000000000000000000C05";

const http = (id: string): Step =>
  StepModel.parse({
    id,
    name: id.slice(-3),
    type: "http",
    request: { method: "GET", url: "/x" },
  });
const loop = (id: string, kids: string[]): Step =>
  StepModel.parse({
    id,
    name: id.slice(-3),
    type: "loop",
    repeat: 1,
    do: kids.map((k) => ({
      id: k,
      name: k.slice(-3),
      type: "http",
      request: { method: "GET", url: "/x" },
    })),
  });
const ifStep = (id: string, kid: string): Step =>
  StepModel.parse({
    id,
    name: id.slice(-3),
    type: "if",
    cond: { left: "1", op: "eq", right: "1" },
    then: [{ id: kid, name: kid.slice(-3), type: "http", request: { method: "GET", url: "/x" } }],
  });
const par = (id: string, a: string, b: string): Step =>
  StepModel.parse({
    id,
    name: id.slice(-3),
    type: "parallel",
    branches: [a, b].map((k, i) => ({
      name: `b${i}`,
      steps: [{ id: k, name: k.slice(-3), type: "http", request: { method: "GET", url: "/x" } }],
    })),
  });

const setup = [http(S1), http(S2)];
const steps = [http(B1), loop(K1, [C1, C2]), http(B2)];
const loopOne = [loop(K1, [C1])];
const withIf = [http(B1), ifStep(F1, C3)];
const withPar = [http(B1), par(P1, C4, C5)];

describe("준비 밴드 규칙", () => {
  it("bandKey: 준비는 setup, 최상위는 top", () => {
    expect(bandKey(SETUP_BAND)).toBe("setup");
    expect(bandKey(TOP_BAND)).toBe("top");
  });

  it("준비 밴드는 비어 있어도 등록된다", () => {
    expect(enumerateBands(steps).some((b) => bandKey(b.ref) === "setup")).toBe(true);
  });

  it("bandIndex가 준비 스텝을 setup으로 싣는다", () => {
    expect(bandIndex(steps, setup).get(S1)).toBe("setup");
    expect(bandIndex(steps, setup).get(B1)).toBe("top");
  });

  it("최상위 http는 준비로 갈 수 있다", () => {
    expect(legalTargetBands(steps, B1, setup).has("setup")).toBe(true);
  });

  it("loop 안 http(형제 있음)는 준비로 갈 수 있다", () => {
    expect(legalTargetBands(steps, C1, setup).has("setup")).toBe(true);
  });

  it("loop 안 마지막 http는 준비로 못 간다", () => {
    expect(legalTargetBands(loopOne, C1, setup)).toEqual(new Set([`${K1}:do`]));
  });

  it("loop는 준비로 못 간다", () => {
    const legal = legalTargetBands(steps, K1, setup);
    expect(legal.has("setup")).toBe(false);
    expect(legal.has("top")).toBe(true);
  });

  it("if·parallel도 준비로 못 간다", () => {
    expect(legalTargetBands(withIf, F1, setup).has("setup")).toBe(false);
    expect(legalTargetBands(withPar, P1, setup).has("setup")).toBe(false);
  });

  it("준비 스텝은 최상위·loop do로 갈 수 있다", () => {
    const legal = legalTargetBands(steps, S1, setup);
    expect(legal.has("top")).toBe(true);
    expect(legal.has(`${K1}:do`)).toBe(true);
    expect(legal.has("setup")).toBe(true);
  });

  it("하나뿐인 준비 스텝도 나갈 수 있다", () => {
    expect(legalTargetBands(steps, S1, [http(S1)]).has("top")).toBe(true);
  });

  it("하나뿐인 본 스텝도 준비로 갈 수 있다", () => {
    expect(legalTargetBands([http(B1)], B1, setup).has("setup")).toBe(true);
  });

  it("준비 스텝의 키보드 후보는 준비 형제뿐", () => {
    expect(keyboardCandidateIds(steps, S1, [S1, S2, B1, B2], setup)).toEqual([S1, S2]);
  });

  it("본 스텝의 키보드 후보는 지금과 같다", () => {
    expect(keyboardCandidateIds(steps, B1, [S1, S2, B1, K1, B2], setup)).toEqual([B1, K1, B2]);
  });

  it("parseDropId/dropId 왕복", () => {
    expect(dropId(SETUP_BAND)).toBe(SETUP_DROP_ID);
    expect(dropId(TOP_BAND)).toBe(TOP_DROP_ID);
    expect(parseDropId(SETUP_DROP_ID)).toEqual(SETUP_BAND);
    expect(parseDropId(TOP_DROP_ID)).toEqual(TOP_BAND);
    expect(parseDropId(`band:${K1}:do`)).toEqual({ parentId: K1, band: "do" });
    expect(dropId({ parentId: K1, band: "do" })).toBe(`band:${K1}:do`);
    expect(parseDropId(B1)).toBeNull();
  });

  it("filterDropCandidates가 band:setup을 합법일 때만 남긴다", () => {
    const index = bandIndex(steps, setup);
    const ids = [SETUP_DROP_ID, TOP_DROP_ID, B1];
    expect(filterDropCandidates(ids, new Set(["setup", "top"]), index)).toEqual(ids);
    expect(filterDropCandidates(ids, new Set(["top"]), index)).toEqual([TOP_DROP_ID, B1]);
    expect(filterDropCandidates(ids, new Set(["setup"]), index)).toEqual([SETUP_DROP_ID]);
  });
});

describe("resolveDrop — 준비 밴드", () => {
  it("준비 안 같은 밴드 → move", () => {
    expect(resolveDrop(steps, S1, S2, "below", setup)).toEqual({
      kind: "move",
      stepId: S1,
      toIndex: 1,
    });
  });

  it("본 → 준비 행 위/아래", () => {
    const above = resolveDrop(steps, B1, S2, "above", setup);
    expect(above).toMatchObject({ kind: "reparent" });
    expect(above && above.kind === "reparent" && above.target).toEqual({
      parentId: null,
      band: "setup",
      index: 1,
    });
    const below = resolveDrop(steps, B1, S2, "below", setup);
    expect(below && below.kind === "reparent" && below.target.index).toBe(2);
  });

  it("준비 → 본 행 아래", () => {
    const r = resolveDrop(steps, S1, B1, "below", setup);
    expect(r && r.kind === "reparent" && r.target).toEqual({
      parentId: null,
      band: "top",
      index: 1,
    });
  });

  it("band:setup → 준비 인덱스 0", () => {
    const r = resolveDrop(steps, B1, SETUP_DROP_ID, null, []);
    expect(r && r.kind === "reparent" && r.target).toEqual({
      parentId: null,
      band: "setup",
      index: 0,
    });
  });

  it("band:top → 최상위 인덱스 0", () => {
    const r = resolveDrop([], S1, TOP_DROP_ID, null, setup);
    expect(r && r.kind === "reparent" && r.target).toEqual({
      parentId: null,
      band: "top",
      index: 0,
    });
  });
});

describe("setupZoneOpen", () => {
  it("영역·들어 올림 두 조건", () => {
    expect(SETUP_ZONE_REACH_PX).toBe(24);
    expect(SETUP_ZONE_LIFT_PX).toBe(8);
    expect(setupZoneOpen(30, 100)).toBe(false);
    expect(setupZoneOpen(10, 100)).toBe(true);
    expect(setupZoneOpen(-50, 100)).toBe(true);
    expect(setupZoneOpen(20, 23)).toBe(false);
    expect(setupZoneOpen(14, 23)).toBe(true);
    expect(setupZoneOpen(23, 23)).toBe(false);
  });
});
