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

  it("hides the inspector when the YAML tab is active", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    expect(
      screen.getByRole("complementary", { name: ko.editor.inspectorAria }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(
      screen.queryByRole("complementary", { name: ko.editor.inspectorAria }),
    ).not.toBeInTheDocument();
  });
});

describe("EditorShell YAML tab placeholder (U3)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("U3: YAML 탭에서 스텝 설정 패널 자리는 한국어 안내를 보여준다", async () => {
    const user = userEvent.setup();
    render(<EditorShell initialYaml={'version: 1\nname: "x"\nsteps: []\n'} />);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByText(/캔버스 탭에서 사용할 수 있습니다/)).toBeInTheDocument();
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
