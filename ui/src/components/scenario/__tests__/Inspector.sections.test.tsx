import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

// 배지 fixture: 헤더 active 1 + disabled 1, JSON 바디, 타임아웃, think, 검증 1, 추출 1
const RICH_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
      headers:
        accept: "application/json"
      disabled:
        headers:
          x-debug: "1"
      body:
        json: { a: 1 }
    timeout_seconds: 30
    think_time: { min_ms: 100, max_ms: 200 }
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.token"
  - id: "01HX0000000000000000000002"
    name: "next"
    type: http
    request:
      method: GET
      url: "/next"
    assert:
      - status: 200
`;

const SECTION_TITLES = [
  ko.editor.headersLabel,
  ko.editor.bodyLabel,
  ko.editor.sectionTiming,
  ko.editor.assertionsLegend,
  ko.editor.extractsLegend,
];

function loadRich(selectId = "01HX0000000000000000000001") {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(RICH_YAML);
  useScenarioEditor.getState().select(selectId);
}

describe("InspectorSection — 접이식 섹션 (R1/R2/R3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadRich();
  });

  it("기본은 5개 섹션 전부 접힘 — 편집기 미렌더, 토글 버튼 aria-expanded=false (R1)", () => {
    render(<Inspector />);
    for (const title of SECTION_TITLES) {
      expect(screen.getByRole("button", { name: title })).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.queryByPlaceholderText("헤더 이름")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(ko.editor.fieldTimeout)).not.toBeInTheDocument();
    // 핵심(이름·메서드·URL)은 항상 노출
    expect(screen.getByLabelText(ko.editor.fieldName)).toBeInTheDocument();
    expect(screen.getByLabelText(ko.editor.urlLabel)).toBeInTheDocument();
  });

  it("접힌 섹션에 값이 있으면 힌트 배지 — 정확 매치 (R2)", () => {
    render(<Inspector />);
    const hintOf = (title: string) => {
      const btn = screen.getByRole("button", { name: title });
      return btn.closest("legend")!.textContent;
    };
    expect(hintOf(ko.editor.headersLabel)).toContain(ko.editor.sectionCountHint(2)); // active 1 + disabled 1
    expect(hintOf(ko.editor.bodyLabel)).toContain(ko.editor.bodyJson);
    expect(hintOf(ko.editor.sectionTiming)).toContain(ko.editor.sectionSetHint);
    expect(hintOf(ko.editor.assertionsLegend)).toContain(ko.editor.sectionCountHint(1));
    expect(hintOf(ko.editor.extractsLegend)).toContain(ko.editor.sectionCountHint(1));
  });

  it("값 없는 섹션엔 힌트 배지 없음 (R2)", () => {
    loadRich("01HX0000000000000000000002"); // 헤더/바디/타이밍/추출 없음, 검증 1
    render(<Inspector />);
    const legendOf = (title: string) =>
      screen.getByRole("button", { name: title }).closest("legend")!.textContent!;
    expect(legendOf(ko.editor.headersLabel)).not.toContain("개");
    expect(legendOf(ko.editor.bodyLabel)).not.toContain(ko.editor.bodyJson); // kind 배지 없음
    expect(legendOf(ko.editor.sectionTiming)).not.toContain(ko.editor.sectionSetHint);
  });

  it("펼치면 편집기 렌더 + localStorage 기록, 스텝 전환에도 열림 유지 (R3)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }));
    expect(screen.getByPlaceholderText("헤더 이름")).toBeInTheDocument();
    // 스텝 전환 — 섹션 종류별 전역 상태라 다른 스텝에서도 열려 있음
    useScenarioEditor.getState().select("01HX0000000000000000000002");
    expect(await screen.findByRole("button", { name: ko.editor.headersLabel })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("재마운트(페이지 재진입) 시 localStorage에서 복원 (R3)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    unmount();
    render(<Inspector />);
    expect(screen.getByRole("button", { name: ko.editor.extractsLegend })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("컨테이너(loop) 인스펙터는 섹션 버튼이 없다 (R4)", () => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(RICH_YAML);
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);
    for (const title of SECTION_TITLES) {
      expect(screen.queryByRole("button", { name: title })).not.toBeInTheDocument();
    }
  });
});

describe("Inspector 카드 fieldset — Section variant=card 통합 락 (디자인시스템 5차 R6)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadRich();
  });

  it("요청 카드: 카드 fieldset 클래스 + legend 제목 유지", () => {
    render(<Inspector />);
    const fieldset = screen.getByLabelText(ko.editor.urlLabel).closest("fieldset")!;
    expect(fieldset).toHaveClass("min-w-0", "border", "border-slate-200", "rounded", "p-3");
    expect(fieldset.querySelector("legend")!).toHaveTextContent(ko.editor.requestLegend);
  });

  it("접이식 섹션: 펼쳐도 mt-2 본문 래퍼가 없다 (카드 경로 사용 증거)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const btn = screen.getByRole("button", { name: ko.editor.assertionsLegend });
    await user.click(btn);
    const fieldset = btn.closest("fieldset")!;
    expect(fieldset).not.toHaveClass("mb-4");
    expect(fieldset.querySelector(":scope > div.mt-2")).toBeNull();
  });
});
