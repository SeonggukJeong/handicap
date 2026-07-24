import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ScenarioNotesCallout } from "../ScenarioNotesCallout";
import { EditorShell } from "../EditorShell";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

const WITH_NOTES =
  'version: 1\nname: "메모 시나리오"\nnotes: |-\n  운영 환경 금지.\n  BASE_URL 필수.\nsteps: []\n';
const NO_NOTES = 'version: 1\nname: "메모 없음"\nsteps: []\n';

/** /scenarios/:id 마운트 재현 — 접힘 영속(localStorage) 경로용 */
function renderWithId(id = "SC1") {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${id}`]}>
      <Routes>
        <Route path="/scenarios/:id" element={<ScenarioNotesCallout />} />
      </Routes>
    </MemoryRouter>,
  );
}

const note = () => screen.getByRole("note", { name: ko.scenarioNotes.title });

describe("ScenarioNotesCallout", () => {
  beforeEach(() => {
    reset();
    window.localStorage.clear();
  });

  it("메모 있으면 Callout에 제목+전문 표출 (US2)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    expect(note()).toHaveTextContent("운영 환경 금지.");
    expect(note()).toHaveTextContent("BASE_URL 필수.");
  });

  it("[접기] → 첫 줄 미리보기만, localStorage 기억 → 재마운트에도 접힘 (US3)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    const first = renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.collapseAria }));
    expect(note()).toHaveTextContent("운영 환경 금지.");
    expect(note()).not.toHaveTextContent("BASE_URL 필수."); // 둘째 줄 부재 = 접힘 판별
    first.unmount();
    renderWithId(); // 재마운트 — localStorage 초기값 경로
    expect(note()).not.toHaveTextContent("BASE_URL 필수.");
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.expandAria }));
    expect(note()).toHaveTextContent("BASE_URL 필수.");
  });

  it("[편집]→수정→[완료] → store 반영 (US1)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    const ta = screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria });
    expect(ta).toHaveValue("운영 환경 금지.\nBASE_URL 필수.");
    fireEvent.change(ta, { target: { value: "새 메모" } });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.doneAria }));
    expect(useScenarioEditor.getState().model?.notes).toBe("새 메모");
    expect(useScenarioEditor.getState().yamlText).toContain("새 메모");
  });

  it("공백-only [완료] → notes 키 삭제 + 빈 진입 라인 (R4)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    fireEvent.change(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria }), {
      target: { value: "   \n  " },
    });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.doneAria }));
    expect(useScenarioEditor.getState().yamlText).not.toContain("notes");
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeInTheDocument();
  });

  it("[취소] → 원본 유지", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.editAria }));
    fireEvent.change(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria }), {
      target: { value: "버려질 편집" },
    });
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.cancelAria }));
    expect(useScenarioEditor.getState().model?.notes).toBe("운영 환경 금지.\nBASE_URL 필수.");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("메모 없음 → 진입 라인, 클릭 → 편집 모드 (R5)", () => {
    useScenarioEditor.getState().loadFromString(NO_NOTES);
    renderWithId();
    fireEvent.click(screen.getByRole("button", { name: ko.scenarioNotes.addAria }));
    expect(screen.getByRole("textbox", { name: ko.scenarioNotes.textareaAria })).toHaveValue("");
  });

  it('YAML 유래 notes: "" → 빈 Callout 대신 진입 라인', () => {
    useScenarioEditor.getState().loadFromString('version: 1\nname: x\nnotes: ""\nsteps: []\n');
    renderWithId();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeInTheDocument();
  });

  it("yamlError → 편집 disabled·접기 활성 (무음 유실 가드)", () => {
    useScenarioEditor.getState().loadFromString(WITH_NOTES);
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    renderWithId();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.editAria })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.collapseAria })).toBeEnabled();
  });

  it("메모 없음 + yamlError → 진입 라인 disabled", () => {
    useScenarioEditor.getState().loadFromString(NO_NOTES);
    useScenarioEditor.getState().setPendingYamlText("version: [broken");
    useScenarioEditor.getState().commitPendingYaml();
    renderWithId();
    expect(screen.getByRole("button", { name: ko.scenarioNotes.addAria })).toBeDisabled();
  });

  it("model === null → 아무것도 렌더하지 않음", () => {
    renderWithId(); // reset 상태 그대로 (model: null)
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("EditorShell 통합 — 라우터 없이도 안전 + 최상단 표출", () => {
    render(<EditorShell initialYaml={WITH_NOTES} />);
    expect(screen.getByRole("note", { name: ko.scenarioNotes.title })).toBeInTheDocument();
  });

  it("addAria가 가시 CTA 전문을 포함한다 (WCAG 2.5.3 Label-in-Name)", () => {
    const visibleWithoutSymbol = ko.scenarioNotes.addLine.replace(/^＋\s*/, "");
    expect(ko.scenarioNotes.addAria).toContain(visibleWithoutSymbol);
  });
});
