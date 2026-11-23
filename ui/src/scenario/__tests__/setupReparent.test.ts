import { beforeEach, describe, expect, it } from "vitest";
import { useScenarioEditor } from "../store";
import { parseScenarioDoc } from "../yamlDoc";

const S1 = "01HX0000000000000000000S01";
const S2 = "01HX0000000000000000000S02";
const B1 = "01HX0000000000000000000B01";
const B2 = "01HX0000000000000000000B02";
const K1 = "01HX0000000000000000000K01";
const C1 = "01HX0000000000000000000C01";
const C2 = "01HX0000000000000000000C02";

const http = (id: string, indent: string, url: string, extra = "") =>
  `${indent}- id: ${id}
${indent}  name: ${id.slice(-3)}
${indent}  type: http
${indent}  request:
${indent}    method: GET
${extra}${indent}    url: ${url}
`;

const LOOP = `  - id: ${K1}
    name: lp
    type: loop
    repeat: 2
    do:
${http(C1, "      ", "/c1")}${http(C2, "      ", "/c2")}`;

const SETUP_ONE = `version: 1
name: demo
setup:
  steps:
${http(S1, "    ", "/s1")}steps:
${http(B1, "  ", "/b1")}${LOOP}`;

const SETUP_TWO = `version: 1
name: demo
setup:
  steps:
${http(S1, "    ", "/s1")}${http(S2, "    ", "/s2")}steps:
${http(B1, "  ", "/b1")}`;

const MAIN_ONLY = `version: 1
name: demo
steps:
${http(B1, "  ", "/b1", "      # 본 메모\n")}${LOOP}${http(B2, "  ", "/b2")}`;

const ONE_MAIN = `version: 1
name: demo
steps:
${http(B1, "  ", "/b1")}`;

const FLOW_SETUP = `version: 1
name: demo
setup: {steps: []}
steps:
${http(B1, "  ", "/b1")}`;

const st = () => useScenarioEditor.getState();
const ids = (xs: ReadonlyArray<{ id: string }>) => xs.map((x) => x.id);
const SETUP = { parentId: null, band: "setup" } as const;

function load(text: string) {
  st().loadFromString(text);
  expect(st().yamlError).toBeNull();
  expect(st().model).not.toBeNull();
}

describe("준비 구획으로 위치 지정 옮기기 · addSetupStep", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("본 → 준비: setup 키가 steps 키 앞에 생긴다", () => {
    load(MAIN_ONLY);
    st().reparentStep(B1, { ...SETUP, index: 0 });
    const m = st().model!;
    expect(ids(m.setup!.steps)).toEqual([B1]);
    expect(m.steps.some((s) => s.id === B1)).toBe(false);
    const t = st().yamlText;
    expect(t.indexOf("\nsetup:")).toBeGreaterThan(-1);
    expect(t.indexOf("\nsetup:")).toBeLessThan(t.indexOf("\nsteps:"));
    expect(t).not.toMatch(/setup: *\{/);
  });

  it("옮긴 스텝 안의 주석이 따라간다", () => {
    load(MAIN_ONLY);
    st().reparentStep(B1, { ...SETUP, index: 0 });
    expect(st().model!.setup!.steps[0].id).toBe(B1);
    const t = st().yamlText;
    const c = t.indexOf("# 본 메모");
    expect(c).toBeGreaterThan(t.indexOf("\nsetup:"));
    expect(c).toBeLessThan(t.indexOf("\nsteps:"));
  });

  it("위치를 지정해 끼운다", () => {
    load(SETUP_TWO);
    st().reparentStep(B1, { ...SETUP, index: 1 });
    expect(ids(st().model!.setup!.steps)).toEqual([S1, B1, S2]);
    expect(st().model!.steps).toEqual([]);
  });

  it("loop 안 http → 준비", () => {
    load(MAIN_ONLY);
    st().reparentStep(C1, { ...SETUP, index: 0 });
    const m = st().model!;
    expect(ids(m.setup!.steps)).toEqual([C1]);
    const loop = m.steps.find((s) => s.id === K1)!;
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") expect(ids(loop.do)).toEqual([C2]);
  });

  it("손으로 쓴 flow 표기 setup을 block으로", () => {
    load(FLOW_SETUP);
    st().reparentStep(B1, { ...SETUP, index: 0 });
    const t = st().yamlText;
    expect(t).toMatch(/^setup:\n {2}steps:\n {4}- id: 01HX0000000000000000000B01$/m);
    const parsed = parseScenarioDoc(t);
    expect("model" in parsed).toBe(true);
    expect(ids(st().model!.setup!.steps)).toEqual([B1]);
  });

  it("준비 → 본(위치 지정), 마지막이면 setup 키 삭제", () => {
    load(SETUP_ONE);
    st().reparentStep(S1, { parentId: null, band: "top", index: 0 });
    const m = st().model!;
    expect(ids(m.steps)).toEqual([S1, B1, K1]);
    expect(m.setup).toBeUndefined();
    expect(st().yamlText).not.toContain("setup:");
  });

  it("준비 → loop do", () => {
    load(SETUP_ONE);
    st().reparentStep(S1, { parentId: K1, band: "do", index: 1 });
    const m = st().model!;
    const loop = m.steps.find((s) => s.id === K1)!;
    if (loop.type !== "loop") throw new Error("loop expected");
    expect(ids(loop.do)).toEqual([C1, S1, C2]);
    expect(m.setup).toBeUndefined();
  });

  it("loop를 준비에 넣으려 하면 아무 일도 없다", () => {
    load(MAIN_ONLY);
    const before = st().yamlText;
    st().reparentStep(K1, { ...SETUP, index: 0 });
    expect(st().yamlText).toBe(before);
    expect(st().yamlError).toBeNull();
    expect(st().model!.steps.some((s) => s.id === K1)).toBe(true);
  });

  it("본 스텝끼리 옮기면 setup 키가 안 생긴다", () => {
    load(MAIN_ONLY);
    st().reparentStep(B2, { parentId: K1, band: "do", index: 0 });
    const loop = st().model!.steps.find((s) => s.id === K1)!;
    if (loop.type !== "loop") throw new Error("loop expected");
    expect(ids(loop.do)).toEqual([B2, C1, C2]);
    expect(st().yamlText).not.toContain("setup");
  });

  it("하나뿐인 본 스텝을 준비로 보냈다가 되돌린다", () => {
    load(ONE_MAIN);
    st().reparentStep(B1, { ...SETUP, index: 0 });
    expect(st().model!.steps).toEqual([]);
    expect(ids(st().model!.setup!.steps)).toEqual([B1]);
    expect(st().yamlError).toBeNull();
    st().reparentStep(B1, { parentId: null, band: "top", index: 0 });
    expect(ids(st().model!.steps)).toEqual([B1]);
    expect(st().model!.setup).toBeUndefined();
  });

  it("addSetupStep: 키를 만들고 끝에 붙인다", () => {
    load(MAIN_ONLY);
    const id = st().addSetupStep("Setup 1")!;
    expect(id).not.toBeNull();
    expect(ids(st().model!.setup!.steps)).toEqual([id]);
    const t = st().yamlText;
    expect(t.indexOf("\nsetup:")).toBeLessThan(t.indexOf("\nsteps:"));

    load(SETUP_ONE);
    const id2 = st().addSetupStep("Setup 2")!;
    const setup = st().model!.setup!.steps;
    expect(ids(setup)).toEqual([S1, id2]);
    expect(setup[1].request).toMatchObject({ method: "GET", url: "/" });
    const t2 = st().yamlText;
    const section = t2.slice(t2.indexOf("\nsetup:"), t2.indexOf("\nsteps:"));
    expect(section).toMatch(new RegExp(`^ {4}- id: ${id2}$`, "m"));
    expect(section).not.toMatch(/[{}]/);
  });

  it("addSetupStep: YAML 오류 상태면 null", () => {
    load(MAIN_ONLY);
    st().setPendingYamlText("version: [");
    st().commitPendingYaml();
    expect(st().yamlError).not.toBeNull();
    const before = st().yamlText;
    expect(st().addSetupStep("x")).toBeNull();
    expect(st().yamlText).toBe(before);
  });
});
