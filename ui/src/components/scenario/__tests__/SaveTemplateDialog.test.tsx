/**
 * SaveTemplateDialog — unit tests
 * TDD: 이 파일을 먼저 작성(RED), 컴포넌트 구현 후 GREEN.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { StepTemplateConflictError } from "../../../api/stepTemplates";

// ── 의존성 모킹 ────────────────────────────────────────────────────
const mutateAsyncCreate = vi.fn();
const mutateAsyncUpdate = vi.fn();

vi.mock("../../../api/hooks", () => ({
  useCreateStepTemplate: () => ({
    mutateAsync: mutateAsyncCreate,
    isPending: false,
  }),
  useUpdateStepTemplate: () => ({
    mutateAsync: mutateAsyncUpdate,
    isPending: false,
  }),
}));

// SaveTemplateDialog를 각 테스트가 동적 import하기 전에 mock이 먼저 등록돼야 함.
// 컴포넌트는 describe 블록 내에서 lazy import 대신 직접 import (hoisting 문제 없음).
import { SaveTemplateDialog } from "../SaveTemplateDialog";

// ── 공통 YAML ────────────────────────────────────────────────────
const TWO_STEP_YAML = `version: 1
name: "s"
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA1
    name: ping
    request:
      method: GET
      url: http://x/ping
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA2
    name: login
    request:
      method: POST
      url: http://x/login
`;

const NESTED_STEP_YAML = `version: 1
name: "s"
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA1
    name: outer
    request:
      method: GET
      url: http://x/a
  - type: loop
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA3
    name: loop
    repeat: 3
    do:
      - type: http
        id: 01ARZ3NDEKTSV4RRFFQ69G5FA4
        name: inner
        request:
          method: GET
          url: http://x/inner
`;

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  mutateAsyncCreate.mockReset();
  mutateAsyncUpdate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SaveTemplateDialog", () => {
  it("선택 없음 = 전체 체크, 이름 비어있으면 저장 비활성", () => {
    useScenarioEditor.getState().loadFromString(TWO_STEP_YAML);
    const onClose = vi.fn();
    render(<SaveTemplateDialog onClose={onClose} />);

    // 두 스텝이 모두 체크박스로 나열돼야 함
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    checkboxes.forEach((cb) => expect(cb).toBeChecked());

    // 이름 비어있으면 저장 버튼 비활성
    expect(screen.getByRole("button", { name: ko.stepTemplates.saveAction })).toBeDisabled();
  });

  it("중첩 스텝 선택 시 최상위 조상만 체크", () => {
    useScenarioEditor.getState().loadFromString(NESTED_STEP_YAML);
    // 내부 스텝 선택
    useScenarioEditor.getState().select("01ARZ3NDEKTSV4RRFFQ69G5FA4");
    render(<SaveTemplateDialog onClose={vi.fn()} />);

    const checkboxes = screen.getAllByRole("checkbox");
    // loop(인덱스 1)만 체크, outer(인덱스 0)는 미체크
    const loopCheckbox = checkboxes[1];
    const outerCheckbox = checkboxes[0];
    expect(loopCheckbox).toBeChecked();
    expect(outerCheckbox).not.toBeChecked();
  });

  it("체크 0개이면 저장 비활성", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(TWO_STEP_YAML);
    render(<SaveTemplateDialog onClose={vi.fn()} />);

    // 이름 입력
    await user.type(screen.getByLabelText(ko.stepTemplates.nameLabel), "my-template");

    // 모든 체크박스 해제
    const checkboxes = screen.getAllByRole("checkbox");
    for (const cb of checkboxes) {
      if ((cb as HTMLInputElement).checked) {
        await user.click(cb);
      }
    }

    expect(screen.getByRole("button", { name: ko.stepTemplates.saveAction })).toBeDisabled();
  });

  it("저장 성공 — 체크된 스텝만 steps_yaml에 + onClose 호출", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(TWO_STEP_YAML);
    // 첫 스텝(ping)만 선택
    useScenarioEditor.getState().select("01ARZ3NDEKTSV4RRFFQ69G5FA1");
    const onClose = vi.fn();
    mutateAsyncCreate.mockResolvedValueOnce({ id: "tpl-1", name: "my-template" });

    render(<SaveTemplateDialog onClose={onClose} />);

    // 선택 스텝(index 0)만 체크 — index 1 해제
    const checkboxes = screen.getAllByRole("checkbox");
    if ((checkboxes[1] as HTMLInputElement).checked) {
      await user.click(checkboxes[1]);
    }

    await user.type(screen.getByLabelText(ko.stepTemplates.nameLabel), "my-template");
    await user.click(screen.getByRole("button", { name: ko.stepTemplates.saveAction }));

    expect(mutateAsyncCreate).toHaveBeenCalledTimes(1);
    const arg = mutateAsyncCreate.mock.calls[0][0] as {
      name: string;
      description: string;
      steps_yaml: string;
    };
    expect(arg.name).toBe("my-template");
    // steps_yaml은 ping 스텝만 포함해야 함
    expect(arg.steps_yaml).toContain("ping");
    expect(arg.steps_yaml).not.toContain("login");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("409 conflict → 덮어쓰기 확인 단계 → PUT with conflictId", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(TWO_STEP_YAML);
    const onClose = vi.fn();
    const conflictId = "existing-id-123";
    mutateAsyncCreate.mockRejectedValueOnce(new StepTemplateConflictError(conflictId, "이미 있음"));
    mutateAsyncUpdate.mockResolvedValueOnce({ id: conflictId, name: "my-template" });

    render(<SaveTemplateDialog onClose={onClose} />);

    await user.type(screen.getByLabelText(ko.stepTemplates.nameLabel), "my-template");
    await user.click(screen.getByRole("button", { name: ko.stepTemplates.saveAction }));

    // 덮어쓰기 확인 메시지 노출
    expect(screen.getByText(ko.stepTemplates.overwriteConfirm("my-template"))).toBeInTheDocument();

    // 덮어쓰기 클릭
    await user.click(screen.getByRole("button", { name: ko.stepTemplates.overwriteAction }));

    expect(mutateAsyncUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mutateAsyncUpdate.mock.calls[0][0] as { id: string; input: unknown };
    expect(updateArg.id).toBe(conflictId);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("이름 변경 시 conflict 무효화 (overwrite confirm 사라짐)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(TWO_STEP_YAML);
    mutateAsyncCreate.mockRejectedValueOnce(
      new StepTemplateConflictError("existing-id-123", "이미 있음"),
    );

    render(<SaveTemplateDialog onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(ko.stepTemplates.nameLabel), "my-template");
    await user.click(screen.getByRole("button", { name: ko.stepTemplates.saveAction }));

    // 덮어쓰기 확인이 떴다
    expect(screen.getByText(ko.stepTemplates.overwriteConfirm("my-template"))).toBeInTheDocument();

    // 이름 변경 → conflict 무효화
    const nameInput = screen.getByLabelText(ko.stepTemplates.nameLabel);
    await user.clear(nameInput);
    await user.type(nameInput, "other-name");

    // 덮어쓰기 확인이 사라져야 함
    expect(
      screen.queryByText(ko.stepTemplates.overwriteConfirm("my-template")),
    ).not.toBeInTheDocument();
  });
});
