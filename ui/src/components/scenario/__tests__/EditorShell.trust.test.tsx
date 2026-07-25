import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { EditorShell } from "../EditorShell";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../../scenario/trustPrefs";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

const GOOD_YAML = `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: https://e.test/a
    assert:
      - kind: status
        code: 200
`;

const EMPTY_YAML = `version: 1
name: t
steps: []
`;

const chip = () => screen.getByRole("button", { name: /시나리오 신뢰도/ });
const chipOrNull = () => screen.queryByRole("button", { name: /시나리오 신뢰도/ });

beforeEach(() => {
  // 하네스 정본 = ScenarioNotesCallout.test.tsx:36-39 (스토어 리셋 + localStorage.clear).
  // 여기서는 resetEmpty()(STARTER_YAML 로드, steps:[])를 쓴다 — http 스텝 0개라 칩 상태가
  // 새지 않고, 각 테스트의 render가 자기 YAML을 act 안에서 로드한다.
  useScenarioEditor.getState().resetEmpty();
  window.localStorage.clear();
});

describe("EditorShell — 신뢰도 칩", () => {
  it("전 점검 통과 시 양호를 보여 준다", () => {
    render(<EditorShell initialYaml={GOOD_YAML} />);
    expect(chip().textContent).toContain(ko.trust.level.good);
  });

  it("http 스텝이 없으면 칩을 렌더하지 않는다", () => {
    render(<EditorShell initialYaml={EMPTY_YAML} />);
    expect(chipOrNull()).toBeNull();
  });

  it("미검증이면 (미확인) 접미가 붙고, 기록 후 epoch가 오르면 사라진다 — 등급은 그대로", () => {
    render(<EditorShell initialYaml={GOOD_YAML} />);
    expect(chip().textContent).toContain(ko.trust.chipUnverifiedSuffix);
    expect(chip().textContent).toContain(ko.trust.level.good);

    const model = useScenarioEditor.getState().model!;
    act(() => {
      recordVerified(DRAFT_KEY, fingerprintHash(model));
      useScenarioEditor.getState().bumpTestRunEpoch();
    });

    expect(chip().textContent).not.toContain(ko.trust.chipUnverifiedSuffix);
    // D는 등급 미반영 — 접미가 사라져도 등급 문구는 불변이어야 한다.
    expect(chip().textContent).toContain(ko.trust.level.good);
  });
});
