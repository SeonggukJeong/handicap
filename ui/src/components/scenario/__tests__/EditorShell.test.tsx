import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../../i18n/ko";
import { EditorShell } from "../EditorShell";
import { useScenarioEditor } from "../../../scenario/store";

// YAML 탭 전환 시 Monaco 본체 import를 피한다(워커 모킹 불요 — 컴포넌트째 mock).
vi.mock("../MonacoYamlView", () => ({ MonacoYamlView: () => <div data-testid="yaml-view" /> }));

describe("EditorShell", () => {
  beforeEach(() => {
    // getInitialState는 store.ts의 커스텀 shim(:303) — ui/CLAUDE.md의 "Zustand v5
    // 미제공" 노트는 shim 도입 전 서술이니 이 호출을 "고치지" 말 것(기존 U3/U4와 동일).
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("mount 시(pre-load model=null 윈도) getSnapshot 캐싱 경고가 없다", () => {
    // VariablesPanel/CanvasView/Inspector 셀렉터의 인라인 `?? {}`/`?? []` fallback이
    // model=null 동안 매 스냅샷 새 객체를 반환하면 React가 경고(단독 마운트면 무한 리렌더).
    // 이 경고는 react-dom 모듈 수명당 1회만 발화(warn-once)라 이 테스트가
    // 파일 내 *첫 EditorShell 마운트*여야 한다 — 아래로 옮기지 말 것.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<EditorShell initialYaml={'version: 1\nname: "loadme"\nsteps: []\n'} />);
      const snapshotWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("getSnapshot should be cached")),
      );
      expect(snapshotWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("loads the initialYaml into the store on mount", () => {
    render(<EditorShell initialYaml={'version: 1\nname: "loadme"\nsteps: []\n'} />);
    const st = useScenarioEditor.getState();
    expect(st.yamlText).toContain("loadme");
    expect(st.model?.name).toBe("loadme");
  });

  it("calls onChange with the store text — first fire is the pre-load text (U3 B1), then the loaded canonical text", () => {
    const calls: string[] = [];
    render(
      <EditorShell
        initialYaml={'version: 1\nname: "loadme"\nsteps: []\n'}
        onChange={(y) => calls.push(y)}
      />,
    );
    // 문서화된 함정의 핀 고정: 첫 발화는 로드된 initialYaml이 아니라
    // mount-렌더에 캡처된 pre-load store 텍스트(fresh store = "").
    expect(calls[0]).toBe("");
    // 로드 완료 후 canonical 텍스트로 재발화 — store와 일치.
    expect(calls[calls.length - 1]).toContain("loadme");
    expect(calls[calls.length - 1]).toBe(useScenarioEditor.getState().yamlText);
  });

  it("디테일 편집기 컬럼이 고정 320px가 아닌 가변(1fr)이다 (R1)", () => {
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    const grid = screen.getByTestId("editor-grid");
    expect(grid.className).toContain("1fr"); // 디테일 = 1fr 가변
    expect(grid.className).not.toContain("320px"); // 옛 고정폭 제거
  });

  it("YAML 버튼 클릭 시 모달에 Monaco(yaml-view)가 열리고 닫힌다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    // 인스펙터는 항상 보인다(더 이상 탭 게이트 없음)
    expect(
      screen.getByRole("complementary", { name: ko.editor.inspectorAria }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("yaml-view")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.openYaml }));
    expect(screen.getByTestId("yaml-view")).toBeInTheDocument();
    // 디바운스 윈도에 미커밋 편집이 있다고 가정 — 닫기가 flush-커밋하는지(R8)를
    // 관측가능 상태(model 갱신 + pendingYamlText null)로 검증(Monaco는 모킹이라 직접 못 침).
    useScenarioEditor.setState({ pendingYamlText: 'version: 1\nname: "flushed"\nsteps: []\n' });
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByTestId("yaml-view")).not.toBeInTheDocument();
    expect(useScenarioEditor.getState().model?.name).toBe("flushed"); // flush 커밋됨
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("변수 토글 버튼이 VariablesPanel을 접고 편다", async () => {
    const user = userEvent.setup();
    render(
      <EditorShell
        initialYaml={'version: 1\nname: "x"\nvariables: {BASE_URL: "http://h"}\nsteps: []\n'}
      />,
    );
    // 펼친 기본 상태: 변수 패널(complementary, name=ko.editor.varsPanelAria) 보임.
    // getByText(/변수/)는 토글 텍스트와 패널 h3 둘 다 매치해 throw → role로 정확 스코프(finding 2).
    expect(
      screen.getByRole("complementary", { name: ko.editor.varsPanelAria }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: ko.editor.varsToggleAria });
    // 장식 글리프는 a11y 트리에서 숨긴다 (</> 버튼과 대칭)
    expect(toggle.querySelector('[aria-hidden="true"]')?.textContent).toContain("☰");
    await user.click(toggle); // 접기
    expect(
      screen.queryByRole("complementary", { name: ko.editor.varsPanelAria }),
    ).not.toBeInTheDocument();
    await user.click(toggle); // 다시 펼치기
    expect(
      screen.getByRole("complementary", { name: ko.editor.varsPanelAria }),
    ).toBeInTheDocument();
  });
});

describe("EditorShell 검증 배너 (U4)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("문제 있는 시나리오 로드 시 상단에 시나리오 문제 요약 배너가 보인다", () => {
    const yaml = `version: 1
name: s
steps:
  - type: http
    id: 01ARZ3NDEKTSV4RRFFQ69G5FA1
    name: ping
    request:
      method: GET
      url: ""
`;
    render(<EditorShell initialYaml={yaml} />);
    expect(screen.getByRole("status", { name: ko.editor.problemsBannerAria })).toBeInTheDocument();
  });
});
