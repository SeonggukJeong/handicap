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

// assert 없는 http 스텝 1개 → A fail(1건) · B pass · C na = 보완 필요 1.
const CAUTION_YAML = `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: https://e.test/a
`;

const EMPTY_YAML = `version: 1
name: t
steps: []
`;

// 칩 접근명은 이제 **가시 라벨로 시작**한다(WCAG 2.5.3) — 셀렉터도 거기 맞춘다.
// `·`(U+00B7) 리터럴을 테스트에 박지 않으려고 ko 값에서 정규식을 만든다.
const CHIP_NAME = new RegExp(`^${ko.trust.chipLabel} `);
const chip = () => screen.getByRole("button", { name: CHIP_NAME });
const chipOrNull = () => screen.queryByRole("button", { name: CHIP_NAME });

/** 칩의 **가시** 텍스트 = 장식 글리프(aria-hidden)를 뺀 나머지. DOM에서 도출한다. */
function visibleLabel(btn: HTMLElement): string {
  const clone = btn.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

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

  // WCAG 2.5.3 Label in Name — aria-label은 텍스트 콘텐츠를 **덮으므로**, 가시 라벨을 그대로
  // 포함(접두)해야 음성 제어 사용자가 화면에 보이는 말로 칩을 호출할 수 있다. 두 값 모두 DOM에서
  // 도출하므로 카피가 바뀌어도 계약이 유지된다(형제 페이싱 칩 `페이싱`/`페이싱 현황판 열기` 규약).
  it.each([
    {
      case: "good(접미 포함)",
      yaml: GOOD_YAML,
      grade: ko.trust.level.good,
      tail: ko.trust.chipAriaTailGood,
    },
    {
      case: "non-good(접미 + 맨숫자 포함)",
      yaml: CAUTION_YAML,
      grade: `${ko.trust.level.caution} 1`,
      tail: ko.trust.chipAriaTail(1),
    },
  ])("칩 접근명·title이 가시 라벨을 그대로 포함한다 — $case", ({ yaml, grade, tail }) => {
    render(<EditorShell initialYaml={yaml} />);
    const btn = chip();
    const visible = visibleLabel(btn);
    // 검증 대상 상태가 실제로 렌더됐는지 먼저 고정(등급·조건부 접미 둘 다 가시).
    expect(visible).toContain(grade);
    expect(visible).toContain(ko.trust.chipUnverifiedSuffix);

    const aria = btn.getAttribute("aria-label") ?? "";
    expect(aria).toContain(visible);
    expect(aria.startsWith(visible)).toBe(true);
    // 꼬리가 가시 라벨을 설명한다(good=US5 경계 문장 / non-good=맨숫자 해설).
    expect(aria).toContain(tail);
    // D10: 모달을 열지 않는 마우스 사용자에게도 같은 문장이 닿아야 한다.
    expect(btn.getAttribute("title")).toBe(aria);
  });

  it("보류 칩은 (미확인) 접미가 없고, 접근명이 가시 라벨 + 판정 보류 꼬리다", () => {
    render(<EditorShell initialYaml={GOOD_YAML} />);
    // YAML 버퍼를 깨뜨려 yamlError를 세팅(model 보존) — ScenarioDefaults.test.tsx S1 이디엄.
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    act(() => {
      useScenarioEditor.getState().commitPendingYaml();
    });
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();

    const btn = chip();
    const visible = visibleLabel(btn);
    expect(visible).toContain(ko.trust.chipPending);
    expect(visible).not.toContain(ko.trust.chipUnverifiedSuffix);
    expect(visible).not.toContain(ko.trust.level.good);

    const aria = btn.getAttribute("aria-label") ?? "";
    expect(aria).toContain(visible);
    expect(aria.startsWith(visible)).toBe(true);
    expect(aria).toContain(ko.trust.chipAriaTailPending);
    expect(btn.getAttribute("title")).toBe(aria);
  });
});
