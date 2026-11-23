import { beforeEach, describe, expect, it } from "vitest";
import { useScenarioEditor } from "../store";
import { isSetupStep, scenarioHasThink, type Scenario } from "../model";
import { parseScenarioDoc } from "../yamlDoc";

const S1 = "01HX0000000000000000000S01";
const S2 = "01HX0000000000000000000S02";
const B1 = "01HX0000000000000000000B01";
const B2 = "01HX0000000000000000000B02";
const L1 = "01HX0000000000000000000K01";
const C1 = "01HX0000000000000000000C01";

const SETUP_ONE = `version: 1
name: demo
setup:
  steps:
    - id: ${S1}
      name: prep
      type: http
      request:
        method: POST
        url: /login
        # 메모는 안쪽
      extract:
        - var: token
          from: status
steps:
  - id: ${B1}
    name: main
    type: http
    request:
      method: GET
      url: /a
`;

const SETUP_TWO = `version: 1
name: demo
setup:
  steps:
    - id: ${S1}
      name: prep1
      type: http
      request:
        method: GET
        url: /p1
    - id: ${S2}
      name: prep2
      type: http
      request:
        method: GET
        url: /p2
steps:
  - id: ${B1}
    name: main
    type: http
    request:
      method: GET
      url: /a
`;

const SETUP_ONE_TWO_MAIN = `version: 1
name: demo
setup:
  steps:
    - id: ${S1}
      name: prep
      type: http
      request:
        method: GET
        url: /p
steps:
  - id: ${B1}
    name: main1
    type: http
    request:
      method: GET
      url: /a
  - id: ${B2}
    name: main2
    type: http
    request:
      method: GET
      url: /b
`;

const NO_SETUP = `version: 1
name: demo
steps:
  - id: ${B1}
    name: main1
    type: http
    request:
      method: GET
      url: "/a" # 메모
  - id: ${B2}
    name: main2
    type: http
    request:
      method: GET
      url: /b
`;

const FLOW_SETUP = `version: 1
name: demo
setup: { steps: [] }
steps:
  - id: ${B1}
    name: main1
    type: http
    request:
      method: GET
      url: /a
  - id: ${B2}
    name: main2
    type: http
    request:
      method: GET
      url: /b
`;

const WITH_LOOP = `version: 1
name: demo
steps:
  - id: ${L1}
    name: lp
    type: loop
    repeat: 2
    do:
      - id: ${C1}
        name: child
        type: http
        request:
          method: GET
          url: /c
  - id: ${B1}
    name: main
    type: http
    request:
      method: GET
      url: /a
`;

const ONE_MAIN = `version: 1
name: demo
steps:
  - id: ${B1}
    name: main
    type: http
    request:
      method: GET
      url: /a
`;

const st = () => useScenarioEditor.getState();
const ids = (xs: ReadonlyArray<{ id: string }>) => xs.map((x) => x.id);

describe("준비 스텝 쓰기 경로", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("준비 스텝의 필드를 고치면 setup.steps에 반영된다", () => {
    st().loadFromString(SETUP_ONE);
    const before = st().model!.steps[0];
    st().setStepField(S1, ["request", "url"], "/x");
    const m = st().model!;
    const s = m.setup!.steps[0];
    expect(s.request.url).toBe("/x");
    expect(m.steps[0]).toEqual(before);
  });

  it("준비 스텝의 추출·검증을 고친다", () => {
    st().loadFromString(SETUP_ONE);
    st().setStepExtract(S1, []);
    expect(st().model!.setup!.steps[0].extract).toEqual([]);
    st().setStepAssert(S1, [{ kind: "status", code: 201 }]);
    expect(st().model!.setup!.steps[0].assert).toEqual([{ kind: "status", code: 201 }]);
  });

  it("마지막 준비 스텝을 지우면 setup 키가 사라진다", () => {
    st().loadFromString(SETUP_ONE);
    st().removeStep(S1);
    expect(st().yamlText).not.toMatch(/^setup:/m);
    expect(st().model!.setup).toBeUndefined();
  });

  it("하나뿐인 준비 스텝을 본 목록으로 끌어 옮기면 setup 키가 사라진다", () => {
    st().loadFromString(SETUP_ONE);
    st().reparentStep(S1, { parentId: null, band: "top", index: 0 });
    const m = st().model!;
    expect(m.setup).toBeUndefined();
    expect(ids(m.steps)).toEqual([S1, B1]);
    expect(st().yamlText).not.toMatch(/^setup:/m);
  });

  it("준비 스텝이 둘이면 하나를 끌어 옮겨도 setup이 남는다", () => {
    st().loadFromString(SETUP_TWO);
    st().reparentStep(S1, { parentId: null, band: "top", index: 1 });
    const m = st().model!;
    expect(ids(m.setup!.steps)).toEqual([S2]);
    expect(ids(m.steps)).toEqual([B1, S1]);
    expect(st().yamlText).toMatch(/^setup:/m);
  });

  it("준비 스텝이 둘이면 하나를 지워도 setup이 남는다", () => {
    st().loadFromString(SETUP_TWO);
    st().removeStep(S1);
    expect(st().model!.setup!.steps.length).toBe(1);
    expect(st().yamlText).toMatch(/^setup:/m);
  });

  it("본 스텝을 준비로 옮기면 setup 키가 steps 앞에 block 표기로 생긴다", () => {
    st().loadFromString(NO_SETUP);
    st().moveStepToSection(B1, "setup");
    const y = st().yamlText;
    expect(y.indexOf("setup:")).toBeGreaterThanOrEqual(0);
    expect(y.indexOf("setup:")).toBeLessThan(y.search(/^steps:/m));
    expect(y).not.toContain("setup: {");
    expect(y).not.toContain("steps: [{");
    const m = st().model!;
    expect(ids(m.setup!.steps)).toEqual([B1]);
    expect(ids(m.steps)).toEqual([B2]);
  });

  it("준비로 옮기면 준비 구획 끝에 붙는다", () => {
    st().loadFromString(SETUP_ONE_TWO_MAIN);
    st().moveStepToSection(B1, "setup");
    const m = st().model!;
    expect(ids(m.setup!.steps)).toEqual([S1, B1]);
    expect(ids(m.steps)).toEqual([B2]);
  });

  it("하나뿐인 본 스텝도 옮겨지고 steps는 빈 목록으로 남는다", () => {
    st().loadFromString(ONE_MAIN);
    st().moveStepToSection(B1, "setup");
    const m = st().model!;
    expect(m.steps).toEqual([]);
    const last = m.setup!.steps[m.setup!.steps.length - 1];
    expect(last.id).toBe(B1);
    expect("error" in parseScenarioDoc(st().yamlText)).toBe(false);
    expect(st().yamlText).toMatch(/^steps: \[\]$/m);
  });

  it("손으로 쓴 flow 표기 setup에 옮겨도 block 표기로 쓰인다", () => {
    st().loadFromString(FLOW_SETUP);
    expect(st().yamlError).toBeNull();
    st().moveStepToSection(B1, "setup");
    const y = st().yamlText;
    expect(y).not.toContain("setup: {");
    expect(y.match(/^setup:/gm)!.length).toBe(1);
    expect(st().model!.setup!.steps.length).toBe(1);
  });

  it("준비 스텝을 본 스텝으로 옮기면 steps 끝에 붙고 마지막이면 setup 키가 사라진다", () => {
    st().loadFromString(SETUP_ONE);
    st().moveStepToSection(S1, "steps");
    const m = st().model!;
    expect(ids(m.steps)).toEqual([B1, S1]);
    expect(m.setup).toBeUndefined();
    expect(st().yamlText).not.toMatch(/^setup:/m);
  });

  it("옮겨도 선택과 스텝 내용이 그대로다", () => {
    st().loadFromString(SETUP_ONE);
    const orig = st().model!.setup!.steps[0];
    st().select(S1);
    st().moveStepToSection(S1, "steps");
    expect(st().selectedStepId).toBe(S1);
    const moved = st().model!.steps.find((x) => x.id === S1)!;
    if (moved.type !== "http") throw new Error("http");
    expect(moved.request).toEqual(orig.request);
    expect(moved.extract).toEqual(orig.extract);
  });

  it("옮긴 스텝 안의 주석이 따라간다", () => {
    st().loadFromString(NO_SETUP);
    st().moveStepToSection(B1, "setup");
    expect(st().model!.setup!.steps.map((s) => s.id)).toContain(B1);
    const text = st().yamlText;
    expect(text).toContain("# 메모");
    expect(text.indexOf("# 메모")).toBeLessThan(text.search(/^steps:/m));
  });

  it("loop 안의 스텝·컨테이너·없는 id는 옮기지 않는다", () => {
    st().loadFromString(WITH_LOOP);
    expect(st().model).not.toBeNull();
    for (const id of [C1, L1, "nope"]) {
      const before = st().model;
      st().moveStepToSection(id, "setup");
      expect(st().model).toBe(before);
    }
  });

  it("이미 그 구획에 있는 스텝은 옮기지 않는다", () => {
    st().loadFromString(SETUP_ONE);
    const before = st().model;
    st().moveStepToSection(S1, "setup");
    expect(st().model).toBe(before);
    st().moveStepToSection(B1, "steps");
    expect(st().model).toBe(before);
  });

  it("깨진 YAML 버퍼 중에는 옮기지 않는다", () => {
    st().loadFromString(NO_SETUP);
    st().setPendingYamlText("version: [");
    st().commitPendingYaml();
    expect(st().yamlError).not.toBeNull();
    const text = st().yamlText;
    const model = st().model;
    st().moveStepToSection(B1, "setup");
    expect(st().yamlText).toBe(text);
    expect(st().model).toBe(model);
  });

  it("think 일괄 편집이 준비 스텝에도 적용된다", () => {
    st().loadFromString(SETUP_ONE);
    st().setStepsThinkTime([S1, B1], { min_ms: 1, max_ms: 2 });
    const m = st().model!;
    expect(m.setup!.steps[0].think_time).toEqual({ min_ms: 1, max_ms: 2 });
    const main = m.steps[0];
    if (main.type !== "http") throw new Error("http");
    expect(main.think_time).toEqual({ min_ms: 1, max_ms: 2 });
  });

  it("test-run의 +추출이 준비 스텝에 붙는다", () => {
    st().loadFromString(SETUP_ONE);
    st().addStepExtract(S1, { var: "x", from: "status" });
    expect(st().model!.setup!.steps[0].extract.length).toBe(2);
  });

  it("준비 스텝을 고른 채 템플릿을 넣으면 본 스텝 끝에 들어간다", () => {
    st().loadFromString(SETUP_ONE);
    st().select(S1);
    const NEW = "01HX0000000000000000000T01";
    st().insertTemplateSteps({
      preparedYaml: `- id: ${NEW}\n  name: tpl\n  type: http\n  request:\n    method: GET\n    url: /t\n`,
      firstId: NEW,
    });
    const m = st().model!;
    expect(ids(m.steps)[m.steps.length - 1]).toBe(NEW);
    expect(m.setup!.steps.length).toBe(1);
  });

  it("scenarioHasThink는 준비 스텝의 think_time을 본다", () => {
    st().loadFromString(SETUP_ONE);
    expect(scenarioHasThink(st().model as Scenario)).toBe(false);
    st().setStepsThinkTime([S1], { min_ms: 1, max_ms: 2 });
    expect(scenarioHasThink(st().model as Scenario)).toBe(true);
  });

  it("isSetupStep", () => {
    st().loadFromString(SETUP_ONE);
    const m = st().model!;
    expect(isSetupStep(m, S1)).toBe(true);
    expect(isSetupStep(m, B1)).toBe(false);
    st().loadFromString(NO_SETUP);
    expect(isSetupStep(st().model!, B1)).toBe(false);
  });
});
