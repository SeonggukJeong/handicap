import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkTimeBoard } from "../ThinkTimeBoard";
import { useScenarioEditor } from "../../../scenario/store";
import { flattenHttpSteps } from "../../../scenario/model";
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
function minInput(name: string) {
  return within(row(name)).getByLabelText(ko.editor.thinkBoardRowMinAria);
}
function maxInput(name: string) {
  return within(row(name)).getByLabelText(ko.editor.thinkBoardRowMaxAria);
}
// Finding 7: 최상위 배열만 훑으면 parallel 분기 등 중첩 컨테이너 안 http leaf(예:
// "이미지")는 못 찾는다 — `flattenHttpSteps`(model.ts, loop/if/parallel 전부 재귀)로
// 중첩 컨테이너까지 내려간다.
function stepThink(id: string) {
  const m = useScenarioEditor.getState().model;
  if (!m) return undefined;
  const s = flattenHttpSteps(m.steps).find((x) => x.id === id);
  return s?.think_time;
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

describe("ThinkTimeBoard — 행별 편집", () => {
  it("min/max를 채우고 blur하면 커밋된다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("로그인"));
    await user.type(minInput("로그인"), "300");
    await user.clear(maxInput("로그인"));
    await user.type(maxInput("로그인"), "800");
    fireEvent.blur(maxInput("로그인"));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 300, max_ms: 800 });
  });

  it("둘 다 비우면 상속으로 되돌아간다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("주문"));
    await user.clear(maxInput("주문"));
    fireEvent.blur(maxInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toBeUndefined();
  });

  it("정확히 한 칸만 비면 no-op — 모델이 안 바뀐다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.clear(minInput("주문"));
    fireEvent.blur(minInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 800, max_ms: 900 });
  });

  // 주의(Finding 1): 대상 행("로그인")은 애초에 configured가 없어(undefined) 재파싱
  // 후에도 `row.configured`는 항상 원시값 undefined다 — `Object.is(undefined, undefined)`가
  // 성립해 재시드 dep을 객체(`row.configured`)로 되돌려도 이 테스트는 RED가 안 뜬다(vacuous).
  // 즉 이 테스트는 dep 회귀 가드가 **아니다** — 실제 가드는 바로 아래 "R3 회귀(보강)"
  // (configured 있는 행을 표적으로 삼는다). 이 테스트 자체는 별개로 유효한 케이스
  // (미설정 행의 draft가 무관한 행 커밋에서도 보존된다)를 커버하므로 유지한다.
  it("미설정 행의 draft는 무관한 행의 커밋에도 보존된다 (dep 회귀 가드는 아래 보강 테스트)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // B행("로그인", configured 없음)에 min만 입력해 둔다
    await user.clear(minInput("로그인"));
    await user.type(minInput("로그인"), "123");
    // A행("주문")에서 값을 바꾸고 커밋
    await user.clear(maxInput("주문"));
    await user.type(maxInput("주문"), "950");
    fireEvent.blur(maxInput("주문"));
    // B행의 draft가 살아 있어야 한다
    expect(minInput("로그인")).toHaveValue(123);
  });

  it("R3 회귀(보강): 기존 configured 있는 행의 no-op 부분편집도 무관 커밋에 안 지워진다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // "즉시"(기존 configured {0,0} 있음)의 min만 비운다 — 정확히 한 칸만 비어 no-op,
    // draft는 {min:"", max:"0"}로 남는다.
    await user.clear(minInput("즉시"));
    // "로그인"(기존 configured 없음)에 값을 채우고 커밋한다 — 포커스 이동으로 위 no-op이
    // 먼저 blur-commit(no-op)되고, 이 커밋이 모델을 reparse해 "즉시".configured가
    // 내용은 같아도(═{0,0}) 새 객체 레퍼런스를 받는다.
    await user.clear(minInput("로그인"));
    await user.type(minInput("로그인"), "300");
    await user.clear(maxInput("로그인"));
    await user.type(maxInput("로그인"), "800");
    fireEvent.blur(maxInput("로그인"));
    expect(minInput("즉시")).toHaveValue(null); // 여전히 빈 채로 — "0"으로 되돌아가면 버그
  });

  // Finding 4: 4분기 중 "그 외(유효하지 않은 입력) → 마지막 커밋값으로 revert"만
  // 테스트가 없었다(다른 3분기는 위에 있음). 사용자가 친 입력이 버려지는 분기라
  // 핀으로 고정한다.
  it("잘못된 입력(min>max)이면 draft가 마지막 커밋값으로 되돌아간다 — 모델도 불변", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    // "주문"의 기존 configured = {min:800,max:900}. min을 950으로 바꾸면 min>max.
    await user.clear(minInput("주문"));
    await user.type(minInput("주문"), "950");
    fireEvent.blur(minInput("주문"));
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 800, max_ms: 900 }); // 모델 불변
    expect(minInput("주문")).toHaveValue(800); // draft가 마지막 커밋값(800)으로 revert
  });

  it("× 버튼이 상속으로 되돌린다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.click(
      within(row("주문")).getByRole("button", { name: ko.editor.thinkBoardResetAria }),
    );
    expect(stepThink("01HX0000000000000000000002")).toBeUndefined();
  });
});

describe("ThinkTimeBoard — 일괄", () => {
  const selectRow = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(within(row(name)).getByRole("checkbox"));

  it("선택이 0이면 액션 바가 없다", () => {
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(
      screen.queryByRole("group", { name: ko.editor.thinkBoardBulkAria }),
    ).not.toBeInTheDocument();
  });

  it("전체선택 → [대기없음으로] → 전 행이 {0,0} (병렬 분기 안 행 포함, Finding 7)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: ko.editor.thinkBoardSelectAllAria }));
    await user.click(screen.getByRole("button", { name: ko.editor.thinkBoardBulkNoWait }));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 0, max_ms: 0 });
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 0, max_ms: 0 });
    // "동시" 분기("b1") 안 "이미지"도 전체선택에 포함돼야 한다 — 최상위만 훑는
    // stepThink 헬퍼였다면 이 단언 자체가 불가능했다(항상 undefined).
    expect(stepThink("01HX0000000000000000000004")).toEqual({ min_ms: 0, max_ms: 0 });
  });

  it("US2: 선택 행만 적용되고 비선택 행은 무변화", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "300");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "800");
    await user.click(screen.getByRole("button", { name: ko.editor.thinkBoardBulkApply }));
    expect(stepThink("01HX0000000000000000000001")).toEqual({ min_ms: 300, max_ms: 800 });
    expect(stepThink("01HX0000000000000000000002")).toEqual({ min_ms: 800, max_ms: 900 });
  });

  it("[적용]은 잘못된 입력에서 disabled (빈칸 / min>max / 600001)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    const apply = screen.getByRole("button", { name: ko.editor.thinkBoardBulkApply });
    expect(apply).toBeDisabled(); // 빈칸

    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "500");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "100");
    expect(apply).toBeDisabled(); // min > max

    await user.clear(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria));
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "600001");
    expect(apply).toBeDisabled(); // 상한 초과
  });

  it("US4: 값이 지정된 병렬 행을 포함해 선택하면 안내가 뜨고 [상속으로]는 활성", async () => {
    // 병렬 분기 스텝에 값을 넣어 n>=1을 만든다
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000004", ["think_time"], { min_ms: 50, max_ms: 60 });
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "이미지");
    await selectRow(user, "로그인");
    expect(screen.getByRole("status")).toHaveTextContent(ko.editor.thinkBoardParallelWarn(1));
    expect(screen.getByRole("button", { name: ko.editor.thinkBoardBulkInherit })).toBeEnabled();
  });

  it("US4: 순차 행만 선택하면 안내가 없다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("이미 미설정인 병렬 행은 n에 안 세진다 (no-op 행 제외)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "이미지"); // think_time 없음 = parallel_unset
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("R4: 부분 선택이면 전체선택 체크박스가 indeterminate다", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    const all = screen.getByRole("checkbox", {
      name: ko.editor.thinkBoardSelectAllAria,
    }) as HTMLInputElement;
    expect(all.indeterminate).toBe(false);
    await selectRow(user, "로그인");
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);
    await user.click(all); // 전체선택
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);
  });

  it("R4: 모달을 닫으면 선택과 일괄 입력이 버려진다", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ThinkTimeBoard open onClose={() => {}} />);
    await selectRow(user, "로그인");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "300");
    expect(screen.getByRole("group", { name: ko.editor.thinkBoardBulkAria })).toBeInTheDocument();

    rerender(<ThinkTimeBoard open={false} onClose={() => {}} />);
    rerender(<ThinkTimeBoard open onClose={() => {}} />);

    expect(
      screen.queryByRole("group", { name: ko.editor.thinkBoardBulkAria }),
    ).not.toBeInTheDocument();
    expect(
      (
        screen.getByRole("checkbox", {
          name: ko.editor.thinkBoardSelectAllAria,
        }) as HTMLInputElement
      ).indeterminate,
    ).toBe(false);

    // Finding 2 teeth: 선택 리셋만으론 위 두 단언이 성립한다(액션 바 자체가
    // 언마운트돼 stale bulkMin이 관측 불가능하므로) — 일괄 입력이 실제로
    // 지워졌는지는 행을 다시 선택해 액션 바를 재노출한 뒤 값을 직접 읽어야 한다.
    await selectRow(user, "로그인");
    expect(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria)).toHaveValue(null);
  });
});

describe("ThinkTimeBoard — R6 깨진 YAML 게이트", () => {
  it("yamlError면 입력·체크박스가 전부 disabled", () => {
    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    expect(minInput("로그인")).toBeDisabled();
    expect(maxInput("로그인")).toBeDisabled();
    expect(within(row("로그인")).getByRole("checkbox")).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: ko.editor.thinkBoardSelectAllAria }),
    ).toBeDisabled();
    // Finding 5: × 버튼("주문" — configured 있는 행이라 렌더됨. "로그인"은
    // configured가 없어 버튼 자체가 안 뜬다)도 disabled여야 한다. yamlError는
    // 깨진 pending YAML을 commit해도 doc/model은 보존되므로("주문"의 configured
    // {800,900}이 그대로 남아 있다) 이 단언은 vacuous가 아니다.
    expect(
      within(row("주문")).getByRole("button", { name: ko.editor.thinkBoardResetAria }),
    ).toBeDisabled();
    // 일괄 버튼 3종은 별도 테스트(아래)에서 단언한다: 자연스러운 경로는 YAML이
    // 유효할 때 행을 먼저 선택해 액션 바를 연 뒤 YAML을 깨는 것 — 선택은 컴포넌트
    // 로컬 state(useState)라 yamlError가 세팅돼도 살아남고, 액션 바는
    // `selectedIds.length > 0`(rows는 보존된 model에서 재계산)로 계속 마운트된
    // 채 disabled만 켜진다.
  });

  it("행 선택 후 YAML을 깨면 일괄 버튼 3종이 disabled (액션 바는 유지)", async () => {
    const user = userEvent.setup();
    render(<ThinkTimeBoard open onClose={() => {}} />);
    await user.click(within(row("로그인")).getByRole("checkbox"));
    expect(screen.getByRole("group", { name: ko.editor.thinkBoardBulkAria })).toBeInTheDocument();

    // [적용]은 disabled={disabled || !bulkValid} 복합조건이다 — 일괄 min/max를 비운
    // 채로 두면 !bulkValid가 이미 true라 disabled 게이트를 지워도 여전히 disabled로
    // 남아 아래 단언이 yamlError에 대해 공허해진다. bulkValid를 참으로 만들어야
    // "disabled ||"가 실제로 관측 가능한 게이트가 된다.
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMinAria), "300");
    await user.type(screen.getByLabelText(ko.editor.thinkBoardBulkMaxAria), "800");

    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    act(() => {
      useScenarioEditor.getState().commitPendingYaml();
    });
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();

    // 액션 바는 언마운트되지 않는다 — 선택이 살아 있으므로.
    expect(screen.getByRole("group", { name: ko.editor.thinkBoardBulkAria })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.thinkBoardBulkApply })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.editor.thinkBoardBulkInherit })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.editor.thinkBoardBulkNoWait })).toBeDisabled();
  });
});
