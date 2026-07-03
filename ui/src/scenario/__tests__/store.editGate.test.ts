import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: 01J0000000000000000000000A
    name: login
    type: http
    request:
      method: POST
      url: https://x/login
`;
const ID = "01J0000000000000000000000A";

// 깨진 YAML 버퍼(yamlError) 상태 진입: 유효 모델 적재 → 선택 → unparseable 버퍼 커밋 실패.
function enterYamlErrorState() {
  const s = useScenarioEditor.getState();
  s.loadFromString(YAML);
  s.select(ID);
  s.setPendingYamlText("version: 1\nsteps: [oops"); // unparseable
  s.commitPendingYaml(); // parse 실패 → yamlError 설정, model=last-good, pending 잔존
}

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("edit gate while yamlError is set (R1)", () => {
  it("dispatch-기반 편집은 no-op (model/doc/yamlText/yamlError/pendingYamlText/selectedStepId 불변)", () => {
    enterYamlErrorState();
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull(); // 전제
    const before = {
      model: s.model,
      doc: s.doc,
      yamlText: s.yamlText,
      yamlError: s.yamlError,
      pendingYamlText: s.pendingYamlText,
      selectedStepId: s.selectedStepId,
    };
    s.setName("renamed");
    s.setStepField(ID, ["request", "url"], "https://y/login");
    s.moveStep(ID, 0);
    s.removeStep(ID);
    const after = useScenarioEditor.getState();
    expect(after.model).toBe(before.model); // 참조 동일 = 무변이 증명
    expect(after.doc).toBe(before.doc);
    expect(after.yamlText).toBe(before.yamlText);
    expect(after.yamlError).toBe(before.yamlError);
    expect(after.pendingYamlText).toBe(before.pendingYamlText);
    expect(after.selectedStepId).toBe(before.selectedStepId); // removeStep가 선택을 비우지 않음
  });

  it("reparentStep도 no-op", () => {
    enterYamlErrorState();
    const before = useScenarioEditor.getState().model;
    useScenarioEditor.getState().reparentStep(ID, { parentId: null, band: "top", index: 0 });
    expect(useScenarioEditor.getState().model).toBe(before);
  });

  it("id-반환 add 액션은 null 반환 (phantom-select 방지)", () => {
    enterYamlErrorState();
    const s = useScenarioEditor.getState();
    expect(s.addStep("x")).toBeNull();
    expect(s.addLoopStep("x")).toBeNull();
    expect(s.addIfStep("x")).toBeNull();
    expect(s.addParallelStep("x")).toBeNull();
    expect(s.addStepInLoop("nope", "x")).toBeNull();
    expect(s.addIfInLoop("nope", "x")).toBeNull();
    expect(s.addStepInParallelBranch("nope", 0, "x")).toBeNull();
    expect(useScenarioEditor.getState().model).toBe(s.model); // 여전히 무변이
  });

  it("yamlError=null 정상 상태면 편집은 그대로 적용 (R8 회귀 제어)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().setName("renamed");
    expect(useScenarioEditor.getState().model!.name).toBe("renamed");
    expect(useScenarioEditor.getState().addStep("Step 2")).not.toBeNull();
  });
});
