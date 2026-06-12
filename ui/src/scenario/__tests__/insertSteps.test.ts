import { beforeEach, describe, expect, it } from "vitest";
import { applyEdit, parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../../scenario/store";

const SCENARIO = `version: 1
name: target
steps:
  - id: 01HX0000000000000000000001
    name: First
    type: http
    request:
      method: GET
      url: /1
  - id: 01HX0000000000000000000002
    name: Second
    type: http
    request:
      method: GET
      url: /2
`;

const EMPTY = `version: 1
name: empty
steps: []
`;

// 재발급 완료(준비된) fragment — 주석 포함
const PREPARED = `# from template
- id: 01HX0000000000000000000100
  name: TplA
  type: http
  request:
    method: GET
    url: /a
- id: 01HX0000000000000000000101
  name: TplB
  type: http
  request:
    method: GET
    url: /b
`;

function names(yaml: string): string[] {
  const parsed = parseScenarioDoc(yaml);
  if (!("model" in parsed)) throw new Error("must parse");
  return parsed.model.steps.map((s) => s.name);
}

describe("applyEdit insertSteps", () => {
  it("afterTopIndex 뒤에 끼워 넣고 주석을 보존한다", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("must parse");
    applyEdit(parsed.doc, { type: "insertSteps", afterTopIndex: 0, stepsYaml: PREPARED });
    const out = serializeDoc(parsed.doc);
    expect(names(out)).toEqual(["First", "TplA", "TplB", "Second"]);
    expect(out).toContain("# from template");
  });

  it("afterTopIndex null = 맨 끝 append, 빈 시나리오(steps:[])에도 동작", () => {
    const p1 = parseScenarioDoc(SCENARIO);
    if (!("model" in p1)) throw new Error("must parse");
    applyEdit(p1.doc, { type: "insertSteps", afterTopIndex: null, stepsYaml: PREPARED });
    expect(names(serializeDoc(p1.doc))).toEqual(["First", "Second", "TplA", "TplB"]);

    const p2 = parseScenarioDoc(EMPTY);
    if (!("model" in p2)) throw new Error("must parse");
    applyEdit(p2.doc, { type: "insertSteps", afterTopIndex: null, stepsYaml: PREPARED });
    const out2 = serializeDoc(p2.doc);
    expect(names(out2)).toEqual(["TplA", "TplB"]);
    // 빈 `steps: []`(flow)에 삽입해도 block 스타일로 직렬화 (flow=false 전환)
    expect(out2).not.toContain("steps: [");
    expect(out2).toContain("- id:");
  });
});

describe("store insertTemplateSteps", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("선택 스텝의 최상위 조상 뒤에 삽입하고 firstId를 반환한다", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(SCENARIO);
    s.select("01HX0000000000000000000001");
    const id = useScenarioEditor
      .getState()
      .insertTemplateSteps({ preparedYaml: PREPARED, firstId: "01HX0000000000000000000100" });
    expect(id).toBe("01HX0000000000000000000100");
    const st = useScenarioEditor.getState();
    expect(st.model?.steps.map((x) => x.name)).toEqual(["First", "TplA", "TplB", "Second"]);
    expect(st.yamlError).toBe(null);
    expect(st.yamlText).toContain("TplA");
  });

  it("선택 없음 = 맨 끝 append", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(SCENARIO);
    useScenarioEditor
      .getState()
      .insertTemplateSteps({ preparedYaml: PREPARED, firstId: "01HX0000000000000000000100" });
    expect(useScenarioEditor.getState().model?.steps.map((x) => x.name)).toEqual([
      "First",
      "Second",
      "TplA",
      "TplB",
    ]);
  });
});
