import { beforeEach, describe, expect, it } from "vitest";
import { useScenarioEditor } from "../store";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

const BASE = 'version: 1\nname: "노트 테스트"\nsteps: []\n';

describe("setNotes (spec R1/R4/R8)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(BASE);
  });

  it("메모 설정 → yamlText·model 반영 + 라운드트립 보존", () => {
    useScenarioEditor.getState().setNotes("운영 환경 금지.\nBASE_URL 필수.");
    const { yamlText, model } = useScenarioEditor.getState();
    expect(model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
    expect(yamlText).toContain("notes:");
    useScenarioEditor.getState().loadFromString(yamlText);
    expect(useScenarioEditor.getState().model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
  });

  it("undefined 커밋 → notes 키 삭제", () => {
    useScenarioEditor.getState().setNotes("지울 메모");
    useScenarioEditor.getState().setNotes(undefined);
    const { yamlText, model } = useScenarioEditor.getState();
    expect(model?.notes).toBeUndefined();
    expect(yamlText).not.toContain("notes");
  });

  it("notes 없는 시나리오 직렬화에 notes 키 미등장", () => {
    expect(useScenarioEditor.getState().yamlText).not.toContain("notes");
  });

  it('YAML 유래 notes: "" 는 모델에 빈 문자열로 남는다(렌더 술어가 처리)', () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: x\nnotes: ""\nsteps: []\n');
    expect(useScenarioEditor.getState().model?.notes).toBe("");
  });

  it("yamlError 동안 setNotes는 no-op(무음 유실 가드의 전제)", () => {
    useScenarioEditor.getState().setNotes("보존될 메모");
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const afterErr = useScenarioEditor.getState().yamlText;
    useScenarioEditor.getState().setNotes("삼켜질 메모");
    expect(useScenarioEditor.getState().yamlText).toBe(afterErr);
    expect(useScenarioEditor.getState().model?.notes).toBe("보존될 메모");
  });
});
