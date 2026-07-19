import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThinkTimeBoard } from "../ThinkTimeBoard";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
default_think_time:
  min_ms: 200
  max_ms: 500
steps:
  - id: "01HX0000000000000000000001"
    name: "로그인"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000002"
    name: "주문"
    type: http
    think_time:
      min_ms: 800
      max_ms: 900
    request:
      method: GET
      url: "/order"
  - id: "01HX0000000000000000000005"
    name: "즉시"
    type: http
    think_time:
      min_ms: 0
      max_ms: 0
    request:
      method: GET
      url: "/now"
  - id: "01HX0000000000000000000003"
    name: "동시"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000004"
            name: "이미지"
            type: http
            request:
              method: GET
              url: "/img"
`;

const YAML_DEFAULT_ZERO = `version: 1
name: "demo-zero"
cookie_jar: auto
variables: {}
default_think_time:
  min_ms: 0
  max_ms: 0
steps:
  - id: "01HX0000000000000000000006"
    name: "핑"
    type: http
    request:
      method: GET
      url: "/ping"
`;

function table() {
  return screen.getByRole("table", { name: ko.editor.thinkBoardTableAria });
}
function row(name: string) {
  return within(table()).getByRole("row", { name: new RegExp(name) });
}

beforeEach(() => {
  useScenarioEditor.getState().loadFromString(YAML);
});

describe("ThinkTimeBoard — 읽기", () => {
  it("open=false면 아무것도 렌더하지 않는다", () => {
    render(<ThinkTimeBoard open={false} onClose={() => {}} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("전 http leaf가 아웃라인 순서로 행이 된다 (컨테이너는 행이 아니다)", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const bodyRows = within(table()).getAllByRole("row").slice(1); // 헤더 제외
    expect(bodyRows.map((r) => within(r).getByTestId("step-name").textContent)).toEqual([
      "로그인",
      "주문",
      "즉시",
      "이미지",
    ]);
  });

  it("상속 행 — 배지 '상속' + 실효 대기 200–500ms", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("로그인");
    expect(within(r).getByTestId("state-badge")).toHaveTextContent(ko.editor.thinkStateInherited);
    expect(within(r).getByTestId("effective")).toHaveTextContent("200–500ms");
  });

  it("지정 행 — 배지 '지정' + 실효 대기 800–900ms", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("주문");
    expect(within(r).getByTestId("state-badge")).toHaveTextContent(ko.editor.thinkStateOverride);
    expect(within(r).getByTestId("effective")).toHaveTextContent("800–900ms");
  });

  it("{0,0} 행 — 배지 '대기없음' + 실효 대기 '대기없음'", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("즉시");
    // thinkStateNoWait와 thinkNoWait가 둘 다 문자열 "대기없음"이라(배지+실효 열 동일 문구 —
    // 의도된 표시) 행 스코프 bare getByText는 다중매치 throw. 배지 셀을 data-testid로
    // 직접 특정해 "실효 열의 <td>가 우연히 [0]으로 잡혀 통과"하는 실패 모드를 차단한다.
    expect(within(r).getByTestId("state-badge")).toHaveTextContent(ko.editor.thinkStateNoWait);
    expect(within(r).getByTestId("effective")).toHaveTextContent(ko.editor.thinkNoWait);
  });

  it("US3: 병렬 분기 행은 '미적용' 배지 + 실효 '대기없음' (긍정 단언)", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const r = row("이미지");
    expect(within(r).getByTestId("state-badge")).toHaveTextContent(
      ko.editor.thinkStateParallelUnset,
    );
    expect(within(r).getByTestId("effective")).toHaveTextContent(ko.editor.thinkNoWait);
    expect(within(r).queryByText(ko.editor.thinkStateInherited)).not.toBeInTheDocument();
    expect(within(r).getByTestId("step-path")).toHaveTextContent("동시·b1");
  });

  it("min === max여도 범위 형식을 유지한다 (별도 분기 없음, spec R2)", () => {
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000001", ["think_time"], { min_ms: 250, max_ms: 250 });
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(within(row("로그인")).getByTestId("effective")).toHaveTextContent("250–250ms");
  });

  it("기본값 요약 줄을 보여준다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.getByTestId("default-summary")).toHaveTextContent("200–500ms");
  });

  it("기본값이 {0,0}이면 '대기없음' 요약 문구를 보여준다", () => {
    useScenarioEditor.getState().loadFromString(YAML_DEFAULT_ZERO);
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.getByTestId("default-summary")).toHaveTextContent(
      ko.editor.thinkBoardDefaultZero,
    );
  });

  it("스텝이 없으면 빈 상태 문구", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: "e"
cookie_jar: auto
variables: {}
steps: []
`);
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(screen.getByText(ko.editor.thinkBoardEmpty)).toBeInTheDocument();
  });
});
