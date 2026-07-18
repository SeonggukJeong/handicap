import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("#4: 비-wide 그리드는 뷰포트 높이를 채우고(fill) 열별 내부 스크롤 클래스 계약을 갖는다 (R3/R4/R13)", () => {
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    const grid = screen.getByTestId("editor-grid");
    expect(grid.className).toContain("grid-rows-[minmax(0,1fr)]");
    // max-h(상한)가 아니라 h(채움) — 짧은 내용에도 패널이 뷰포트 높이를 채운다(한 화면에 넓게).
    expect(grid.className.split(/\s+/)).toContain("h-[calc(100vh-16rem)]");
    expect(grid.className.split(/\s+/)).not.toContain("max-h-[calc(100vh-16rem)]");
    expect(grid.className).not.toContain("min-h-[680px]");
    expect(grid.className).toContain("min-h-[520px]");

    // 아웃라인 열(FlowOutline은 DndContext[DOM 미생성]+`flex h-full flex-col` 래퍼를
    // outline-blank의 부모로 두므로, EditorShell 자체 div는 그 조부모)
    const outlineCol = screen.getByTestId("outline-blank").parentElement?.parentElement;
    expect(outlineCol?.className).toContain("overflow-auto");
    expect(outlineCol?.className).toContain("min-h-0");

    // 디테일 열(Inspector aside를 감싸는 EditorShell div)
    const detailCol = screen.getByLabelText(ko.editor.inspectorAria).parentElement;
    expect(detailCol?.className).toContain("overflow-auto");
    expect(detailCol?.className).toContain("min-h-0");

    // 변수 aside는 overflow-visible(HelpTip 클립 방지) — 내부 ul만 스크롤(VariablesPanel.test.tsx)
    const varsAside = screen.getByRole("complementary", { name: ko.editor.varsPanelAria });
    expect(varsAside.className).toContain("overflow-visible");
    expect(varsAside.className).toContain("min-h-0");
  });

  it("C3: chromeCollapsed prop이 그리드 fill-height를 11rem으로 토글(기본=16rem)", () => {
    const yaml = 'version: 1\nname: "x"\nsteps: []\n';
    const { rerender } = render(<EditorShell initialYaml={yaml} />);
    expect(screen.getByTestId("editor-grid").className.split(/\s+/)).toContain(
      "h-[calc(100vh-16rem)]",
    );
    rerender(<EditorShell chromeCollapsed initialYaml={yaml} />);
    const cls = screen.getByTestId("editor-grid").className.split(/\s+/);
    expect(cls).toContain("h-[calc(100vh-11rem)]");
    expect(cls).not.toContain("h-[calc(100vh-16rem)]");
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

  it("R7: YAML 모달의 Monaco를 확정 높이(h-[70vh]) 컨테이너로 감싼다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    await user.click(screen.getByRole("button", { name: ko.editor.openYaml }));
    const view = screen.getByTestId("yaml-view");
    expect(view.parentElement).toHaveClass("h-[70vh]");
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

  it("왼쪽 패널이 변수와 시나리오 기본값을 함께 담고, 토글로 함께 접힌다 (R17)", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    expect(screen.getByText(ko.editor.variablesTitle)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.scenarioDefaultsTitle)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: ko.editor.varsToggleAria }));
    expect(screen.queryByText(ko.editor.variablesTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.editor.scenarioDefaultsTitle)).not.toBeInTheDocument();
  });

  const WIDE_YAML = `version: 1
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
    assert:
      - status: 200
`;

  // 주의: 이 describe는 기존 describe("EditorShell") 블록 *안에* 중첩해 추가한다
  // (store-reset beforeEach 상속 — 파일의 기존 beforeEach는 그 블록 스코프다).
  describe("스텝 넓게 보기 토글 (R5/R10)", () => {
    beforeEach(() => {
      window.localStorage.clear(); // Inspector 섹션 prefs 누수 방지 (Global Constraint)
    });

    it("ON: 인스펙터 열 미렌더 + 아웃라인 전폭 그리드, aria-pressed 토글", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByLabelText(ko.editor.inspectorAria)).toBeInTheDocument();
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByLabelText(ko.editor.inspectorAria)).not.toBeInTheDocument();
      expect(screen.getByTestId("editor-grid").className).toContain("grid-cols-[210px_1fr]");
      // #4: 와이드 모드에서도 변수 aside는 뷰포트 높이를 채운다(fill) (R4)
      expect(
        screen.getByRole("complementary", { name: ko.editor.varsPanelAria }).className.split(/\s+/),
      ).toContain("h-[calc(100vh-16rem)]");
    });

    it("OFF 복귀: 기존 그리드 클래스 byte-identical", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const before = screen.getByTestId("editor-grid").className;
      const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
      await user.click(toggle);
      await user.click(toggle);
      expect(screen.getByTestId("editor-grid").className).toBe(before);
    });

    it("재마운트 시 와이드 OFF (R10 — 마운트 수명)", async () => {
      const user = userEvent.setup();
      const { unmount } = render(<EditorShell initialYaml={WIDE_YAML} />);
      await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
      unmount();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      expect(screen.getByRole("button", { name: ko.editor.wideToggleAria })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    describe("wide 칩 스트립 하드 캡 (editor-wide-view-overflow R3)", () => {
      // spy 누수 방지 — 단언 throw에도 Element.prototype getter 원복 (in-body restore 금지)
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("펼치기 토글 부재 — expandable 미배선 락인 (overflow여도)", async () => {
        // 실제 가치 = 향후 우발적 expandable 전달 가드. 레이아웃 검증은 라이브 rect가 권위(spec R3.2).
        vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(300);
        vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(96);
        const user = userEvent.setup();
        render(<EditorShell initialYaml={WIDE_YAML} />);
        await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
        expect(screen.getByRole("group", { name: ko.editor.testFlowTitle })).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: ko.editor.chipStripExpand }),
        ).not.toBeInTheDocument();
        // 토글 부재만으론 캡이 사라지는 회귀(소비처 className 오버라이드 등)를 못 잡는다 —
        // wide 섹션 안 wrap의 캡 토큰을 직접 락인(substring toContain 금지, split 정확-토큰).
        const wideStrip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
        const tokens = within(wideStrip).getByTestId("chip-strip-wrap").className.split(/\s+/);
        expect(tokens).toContain("max-h-24");
        expect(tokens).toContain("overflow-y-auto");
      });
    });
  });

  describe("변수 넓게 보기 토글 (B/varsWide)", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it("ON: grid-cols [1fr_minmax] + aria-pressed + 인스펙터 열 미렌더 + 변수 aside 유지", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const toggle = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("editor-grid").className).toContain(
        "grid-cols-[1fr_minmax(260px,300px)]",
      );
      expect(screen.queryByLabelText(ko.editor.inspectorAria)).not.toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { name: ko.editor.varsPanelAria }),
      ).toBeInTheDocument();
    });

    it("varsWide↔wideOpen 상호배타", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const wideT = screen.getByRole("button", { name: ko.editor.wideToggleAria });
      const varsWideT = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      await user.click(varsWideT);
      expect(varsWideT).toHaveAttribute("aria-pressed", "true");
      await user.click(wideT); // 스텝 넓게 켜기 → 변수 넓게 꺼짐
      expect(wideT).toHaveAttribute("aria-pressed", "true");
      expect(varsWideT).toHaveAttribute("aria-pressed", "false");
    });

    it("varsWide ON이면 변수 show/hide 토글 disabled(title 힌트)", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const varsToggle = screen.getByRole("button", { name: ko.editor.varsToggleAria });
      expect(varsToggle).not.toBeDisabled();
      await user.click(screen.getByRole("button", { name: ko.editor.varsWideToggleAria }));
      expect(varsToggle).toBeDisabled();
      expect(varsToggle).toHaveAttribute("title", ko.editor.varsWideActiveTitle);
    });

    it("varsWide OFF 복귀 시 그리드 className byte-identical", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      const before = screen.getByTestId("editor-grid").className;
      const t = screen.getByRole("button", { name: ko.editor.varsWideToggleAria });
      await user.click(t);
      await user.click(t);
      expect(screen.getByTestId("editor-grid").className).toBe(before);
    });

    it("varsWide 행 활성화 → 편집 모달(Inspector) + 아웃라인 행 data-step-id", async () => {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML} />);
      await user.click(screen.getByRole("button", { name: ko.editor.varsWideToggleAria }));
      // 아웃라인 행에 data-step-id(스크롤 지원) 부여됨
      expect(document.querySelector("[data-step-id]")).toBeInTheDocument();
      await user.click(screen.getByRole("option", { name: ko.editor.outlineRowAria("login") }));
      expect(
        screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle }),
      ).toBeInTheDocument();
    });
  });

  const WIDE_YAML2 = `version: 1
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
    assert:
      - status: 200
  - id: "01HX0000000000000000000002"
    name: "next"
    type: http
    request:
      method: GET
      url: "/next"
    assert:
      - status: 200
`;

  // 주의: 기존 describe("EditorShell") 블록 *안에* 중첩(store-reset beforeEach 상속).
  describe("와이드 칩 스트립·점프·편집 모달 (R7/R8)", () => {
    beforeEach(() => {
      window.localStorage.clear(); // 타이밍 섹션 펼침이 prefs에 남는 누수 방지
    });

    async function renderWide() {
      const user = userEvent.setup();
      render(<EditorShell initialYaml={WIDE_YAML2} />);
      await user.click(screen.getByRole("button", { name: ko.editor.wideToggleAria }));
      return user;
    }
    const rowOf = (name: string) =>
      screen.getByRole("option", { name: ko.editor.outlineRowAria(name) });

    it("칩 스트립은 구분 wrapper region 안에 렌더 (R7 — 이중 role=group 회피)", async () => {
      await renderWide();
      const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
      expect(within(strip).getByText("login")).toBeInTheDocument();
    });

    it("칩 클릭 = 선택만, 모달 미오픈 (R7)", async () => {
      const user = await renderWide();
      const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
      await user.click(within(strip).getByRole("button", { name: /next/ }));
      expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000002");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("행 활성화 → 편집 모달(Inspector 재사용), 닫기 후 선택 유지 (R8)", async () => {
      const user = await renderWide();
      await user.click(rowOf("login"));
      const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
      expect(within(dialog).getByLabelText(ko.editor.inspectorAria)).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "닫기" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
    });

    it("모달 내 삭제 → 모달 닫힘, 이후 칩 클릭이 모달을 재오픈하지 않는다 (R8 상태머신)", async () => {
      const user = await renderWide();
      await user.click(rowOf("login"));
      const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
      await user.click(within(dialog).getByRole("button", { name: ko.common.delete }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const strip = screen.getByRole("region", { name: ko.editor.wideFlowStripAria });
      await user.click(within(strip).getByRole("button", { name: /next/ }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // detailOpen 리셋 ②
    });

    it("와이드 재토글이 모달을 재오픈하지 않는다 (R8 리셋 ③)", async () => {
      const user = await renderWide();
      await user.click(rowOf("login"));
      expect(
        screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle }),
      ).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: ko.editor.wideToggleAria });
      await user.click(toggle); // OFF — 모달 게이트로 언마운트
      await user.click(toggle); // ON
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("draft 타이핑 후 ESC 닫기 → blur-flush로 store 커밋 (R8)", async () => {
      const user = await renderWide();
      await user.click(rowOf("login"));
      const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
      await user.click(within(dialog).getByRole("button", { name: ko.editor.sectionTiming }));
      await user.type(within(dialog).getByLabelText(ko.editor.fieldTimeout), "30");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(useScenarioEditor.getState().model?.steps[0]).toMatchObject({ timeout_seconds: 30 });
    });

    it("빈 이름 draft로 ESC 닫기 → blur-flush가 Untitled 커밋 — 빈 이름 비기록 불변 (R13)", async () => {
      const user = await renderWide();
      await user.click(rowOf("login"));
      const dialog = screen.getByRole("dialog", { name: ko.editor.stepDetailModalTitle });
      await user.clear(within(dialog).getByLabelText(ko.editor.fieldName));
      await user.keyboard("{Escape}");
      expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("Untitled");
      // 재편집 정상 — 커밋된 이름으로 모달이 다시 열린다 (T6 클래스 회귀 가드)
      await user.click(rowOf("Untitled"));
      expect(within(screen.getByRole("dialog")).getByLabelText(ko.editor.fieldName)).toHaveValue(
        "Untitled",
      );
    });
    // (JSON 바디 ESC 변형은 의도적 미작성 — 같은 blur-flush 메커니즘을 타임아웃(위)·이름(이 테스트)
    //  두 커밋 경로가 커버. JsonBodyField도 동일 onBlur commit이라 별도 이득 없음.)
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
