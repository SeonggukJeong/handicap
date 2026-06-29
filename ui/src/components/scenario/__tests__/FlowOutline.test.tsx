import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline, OutlineRowPreview, nearestByHeader } from "../FlowOutline";
import { useScenarioEditor } from "../../../scenario/store";
import { computeReorder } from "../../../scenario/reorder";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const NESTED_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000010"
    name: gate
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000020"
        name: inner-loop
        type: loop
        repeat: 3
        do:
          - id: "01HX0000000000000000000021"
            name: ping
            type: http
            request:
              method: GET
              url: "/ping"
            assert:
              - status: 200
  - id: "01HX0000000000000000000030"
    name: fan-out
    type: parallel
    branches:
      - name: user
        steps:
          - id: "01HX0000000000000000000031"
            name: get-user
            type: http
            request:
              method: GET
              url: "/user"
            assert:
              - status: 200
      - name: feed
        steps:
          - id: "01HX0000000000000000000032"
            name: get-feed
            type: http
            request:
              method: GET
              url: "/feed"
            assert:
              - status: 200
`;

describe("FlowOutline render (full nesting)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("renders every leaf + container with full nesting", () => {
    render(<FlowOutline />);
    // top-level http
    expect(screen.getByText("login")).toBeInTheDocument();
    // method badge text (R6: color + text)
    expect(screen.getByText("POST")).toBeInTheDocument();
    // raw url shown (parity with old canvas — raw, not resolved)
    expect(screen.getByText("/login")).toBeInTheDocument();
    // if container + condition summary + THEN band
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText(/\{\{code\}\} eq 200/)).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    // nested loop container + repeat badge + depth-2 leaf
    expect(screen.getByText("inner-loop")).toBeInTheDocument();
    expect(screen.getByText(/×\s*3/)).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument();
    // parallel container + lane labels + branch leaves
    expect(screen.getByText("fan-out")).toBeInTheDocument();
    expect(screen.getByText("user")).toBeInTheDocument();
    expect(screen.getByText("feed")).toBeInTheDocument();
    expect(screen.getByText("get-user")).toBeInTheDocument();
    expect(screen.getByText("get-feed")).toBeInTheDocument();
  });

  it("indents nested rows deeper than top-level rows", () => {
    render(<FlowOutline />);
    const top = screen.getByRole("option", { name: /login/ });
    const nested = screen.getByRole("option", { name: /ping/ });
    // depth is encoded as a data attribute (data-depth) for a deterministic assertion
    expect(Number(nested.getAttribute("data-depth"))).toBeGreaterThan(
      Number(top.getAttribute("data-depth")),
    );
  });

  it("R5: http leaf 의 이름과 URL 이 각각 truncate+title 한 줄이고 행은 items-center 다(드래그 핸들·메서드 배지 수직 중앙 정렬)", () => {
    render(<FlowOutline />);
    const name = screen.getByText("login");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "login");
    const url = screen.getByText("/login");
    expect(url).toHaveClass("truncate");
    expect(url).toHaveAttribute("title", "/login");
    // 드래그 핸들(⠿)·메서드 배지를 2줄 이름/URL 블록에 대해 수직 중앙 정렬(사용자 요청 2026-06-29).
    // 블록이 최장 항목이라 스택은 시각적 무변경, 단일줄 형제(핸들/배지/⚠)만 중앙으로 내려온다.
    const row = screen.getByRole("option", { name: /login/ });
    expect(row).toHaveClass("items-center");
  });

  it("R6: 컨테이너 헤더 이름이 truncate+title 이고 행은 items-center 다", () => {
    render(<FlowOutline />);
    const gate = screen.getByText("gate"); // if 컨테이너 헤더
    expect(gate).toHaveClass("truncate");
    expect(gate).toHaveAttribute("title", "gate");
    const gateRow = screen.getByRole("option", { name: /gate/ });
    expect(gateRow).toHaveClass("items-center");
  });
});

describe("FlowOutline selection", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("clicking a row selects that step", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    await user.click(screen.getByText("login"));
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
  });

  it("pressing Enter on a focused row selects it (keyboard a11y, M2)", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /ping/ });
    row.focus();
    await user.keyboard("{Enter}");
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000021");
  });

  it("clicking the empty background clears selection", async () => {
    const user = userEvent.setup();
    render(<FlowOutline />);
    // select() triggers a Zustand update that causes DndContext to re-render
    // OutlineRows outside any act() boundary → act warning cascade.
    // Wrapping the store update in act() flushes those re-renders synchronously.
    await act(async () => {
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    await user.click(screen.getByTestId("outline-blank"));
    expect(useScenarioEditor.getState().selectedStepId).toBeNull();
  });

  it("the selected row carries the accent highlight class", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    render(<FlowOutline />);
    const row = screen.getByRole("option", { name: /login/ });
    expect(row.className).toMatch(/border-accent-500|ring-accent/);
  });
});

describe("FlowOutline url-missing badge + add buttons + empty state", () => {
  beforeEach(() => reset());

  it("renders a ⚠ badge only on http rows whose url is empty", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    name: "no-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
  - id: "01HX0000000000000000000041"
    name: "has-url"
    type: http
    request:
      method: GET
      url: "/ok"
    assert:
      - status: 200
`);
    render(<FlowOutline />);
    expect(screen.getAllByTitle("URL이 비어 있습니다")).toHaveLength(1);
  });

  it("url-missing ⚠ badge has role=img and aria-label for screen readers (a11y)", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000042"
    name: "empty-url"
    type: http
    request:
      method: GET
      url: ""
    assert:
      - status: 200
`);
    render(<FlowOutline />);
    const badge = screen.getByRole("img", { name: "URL이 비어 있습니다" });
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("title", "URL이 비어 있습니다");
  });

  it("shows the empty-state message and the 4 add buttons", () => {
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    expect(screen.getByText(/HTTP 스텝을 추가해 시작하세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 반복(loop)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 조건(if)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ 동시 실행(parallel)" })).toBeInTheDocument();
  });

  it("the add-HTTP button appends a step and selects it", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ HTTP 스텝" }));
    const st = useScenarioEditor.getState();
    expect(st.model!.steps.length).toBe(1);
    expect(st.selectedStepId).not.toBeNull();
  });

  it("selecting a top-level loop morphs the primary add button into the in-loop variant", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().resetEmpty();
    const loopId = useScenarioEditor.getState().addLoopStep("L");
    useScenarioEditor.getState().select(loopId);
    render(<FlowOutline />);
    await user.click(screen.getByRole("button", { name: "+ 반복 안에 HTTP 스텝" }));
    const steps = useScenarioEditor.getState().model!.steps;
    expect(steps[0].type === "loop" && steps[0].do.length).toBe(2); // seed child + 1
  });
});

describe("FlowOutline drag wiring", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: first
    type: http
    request: { method: GET, url: "/1" }
    assert: [{ status: 200 }]
  - id: "01HX0000000000000000000002"
    name: second
    type: http
    request: { method: GET, url: "/2" }
    assert: [{ status: 200 }]
`);
  });

  it("renders a keyboard-operable drag handle per row", () => {
    render(<FlowOutline />);
    expect(screen.getByRole("button", { name: /"first" 스텝 순서 이동/ })).toBeInTheDocument();
  });

  it("computeReorder maps a same-group drop to moveStep's toIndex", () => {
    // 순수 매핑 단언(헬퍼는 reorder.test가 전수) — 여기선 그룹 id 순서가 모델과 일치함을 핀
    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(computeReorder(ids, ids[0], ids[1])).toBe(1);
  });
});

describe("FlowOutline 오버레이 배선 (메커니즘은 Task 3 Playwright)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("오버레이 배선 후에도 live(sortable) 행의 선택 accent·드래그 핸들 button 이 유지된다", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    render(<FlowOutline />);
    // live 행은 여전히 accent (overlay 추가가 선택 표시를 회귀시키지 않음)
    expect(screen.getByRole("option", { name: /login/ }).className).toMatch(
      /border-accent-500|ring-accent/,
    );
    // live 드래그 핸들은 여전히 진짜 button (프리뷰 핸들은 정적 span — 드래그 없으면 미렌더)
    expect(screen.getByRole("button", { name: /"login" 스텝 순서 이동/ })).toBeInTheDocument();
    // 컨테이너 자식 재정렬도 그대로 마운트(중첩 SortableContext 회귀 없음)
    expect(screen.getByText("ping")).toBeInTheDocument();
  });
});

describe("FlowOutline 컨테이너 노드 = 외곽 wrapper (형제 재정렬 프리뷰; 실측은 Playwright)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  it("컨테이너 헤더와 자식 밴드가 단일 wrapper 아래 함께 있다 (sortable 노드=wrapper)", () => {
    // 드래그 shift-transform 자체는 jsdom 불가(spec §6.2). 여기선 컨테이너의
    // sortable 노드가 헤더가 아니라 헤더+자식 밴드를 감싼 *외곽 wrapper*라는
    // 구조 계약만 락인한다 — 이 wrapper가 useSortable setNodeRef/transform 을
    // 받아 재정렬 프리뷰 때 컨테이너 전체(헤더+자식)가 함께 이동한다(Problem 2 fix).
    // 실제 transform 추종은 Playwright(orchestrator)로 실측.
    render(<FlowOutline />);
    const gateHeader = screen.getByRole("option", { name: /gate/ }); // if 컨테이너 헤더
    const wrapper = gateHeader.parentElement!;
    // wrapper 는 헤더 자신이 아니라 그 부모(role 없는 외곽 div)
    expect(wrapper).not.toBe(gateHeader);
    expect(wrapper.getAttribute("role")).toBeNull();
    // 같은 wrapper 안에 헤더와 깊은 자식('ping')이 함께 존재 → transform 이 둘 다 옮긴다
    expect(wrapper.contains(gateHeader)).toBe(true);
    expect(wrapper.querySelector('[aria-label="스텝: ping"]')).not.toBeNull();
  });

  it("leaf 행은 자신이 sortable 노드 — 불필요한 wrapper 로 감싸지 않는다", () => {
    render(<FlowOutline />);
    const loginRow = screen.getByRole("option", { name: /login/ }); // http leaf
    // leaf 의 부모는 그룹 컨테이너(SortableContext 래퍼 등)이고, leaf 자신이
    // role=option 인 단일 행 div — 컨테이너처럼 별도 헤더+밴드 wrapper 가 없다.
    expect(loginRow.getAttribute("data-depth")).toBe("0");
    expect(loginRow.tagName).toBe("DIV");
  });
});

describe("nearestByHeader (드롭 대상=헤더 근접도 — Problem 1)", () => {
  // 컨테이너의 sortable rect 는 자식 밴드까지 포함해 키가 크다. 드롭 대상을
  // rect 전체 중심(closestCenter)으로 고르면 중심이 자식 영역으로 내려가
  // "자식이 닿아야" 순서가 바뀐다 → nearestByHeader 는 컨테이너를 *헤더 띠*
  // 중심으로만 비교해 부모 헤더 위치가 드롭을 결정하게 한다.
  const HB = 44;

  it("키 큰 컨테이너를 rect 전체 중심이 아니라 헤더 띠 중심으로 고른다", () => {
    // leaf a: top0 h40 → 중심 20. 컨테이너 b: top50 h200 → 헤더중심 72, 전체중심 150.
    // 포인터 70: 헤더 기준이면 b(거리2), 전체중심 기준이면 a(거리50) → b 여야 한다.
    const items = [
      { id: "a", top: 0, height: 40, isContainer: false },
      { id: "b", top: 50, height: 200, isContainer: true },
    ];
    expect(nearestByHeader(items, 70, HB)).toBe("b");
  });

  it("포인터가 leaf 헤더에 가까우면 leaf 를 고른다", () => {
    const items = [
      { id: "a", top: 0, height: 40, isContainer: false },
      { id: "b", top: 50, height: 200, isContainer: true },
    ];
    expect(nearestByHeader(items, 15, HB)).toBe("a");
  });

  it("여러 형제 중 헤더 중심이 포인터에 가장 가까운 것을 고른다", () => {
    const items = [
      { id: "a", top: 0, height: 40, isContainer: false }, // 중심 20
      { id: "b", top: 44, height: 40, isContainer: false }, // 중심 64
      { id: "c", top: 88, height: 200, isContainer: true }, // 헤더중심 110
    ];
    expect(nearestByHeader(items, 60, HB)).toBe("b");
    expect(nearestByHeader(items, 108, HB)).toBe("c");
  });

  it("빈 목록은 null", () => {
    expect(nearestByHeader([], 100, HB)).toBeNull();
  });
});

describe("OutlineRowPreview (DragOverlay 프리뷰 — 비대화형 재귀)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().loadFromString(NESTED_YAML);
  });

  const stepById = (id: string) =>
    useScenarioEditor.getState().model!.steps.find((s) => s.id === id)!;

  it("컨테이너 프리뷰가 헤더 + 자식 서브트리를 재귀로 렌더한다 (#4)", () => {
    // 'gate'(if) → THEN → 'inner-loop'(loop) → 'ping'(http leaf)
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000010")} depth={0} />);
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText("THEN")).toBeInTheDocument();
    expect(screen.getByText("inner-loop")).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument(); // depth-2 자식까지
  });

  it("프리뷰 root 는 aria-hidden (SR 이중 구술 방지)", () => {
    const { container } = render(
      <OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />,
    );
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("프리뷰는 비대화형 — 진짜 button 이 없고 핸들은 정적 aria-hidden span 이다", () => {
    const { container } = render(
      <OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />,
    );
    // 프리뷰 root 가 aria-hidden 이라 getByRole 은 서브트리를 제외(teeth 없음) →
    // DOM 레벨로 단언해야 진짜 button 누출을 잡는다([[implementation-rigor-over-spec]]).
    expect(container.querySelector("button")).toBeNull();
    // 핸들 글리프(⠿)는 정적 span(aria-hidden) — leaf 프리뷰엔 정확히 이 1개
    const handle = container.querySelector('span[aria-hidden="true"]');
    expect(handle?.textContent).toContain("⠿");
  });

  it("선택된 스텝이어도 프리뷰는 accent 를 표시하지 않는다 (F3 — store 미접촉)", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000010"); // 'gate' 선택
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000010")} depth={0} />);
    const headerRow = screen.getByText("gate").parentElement!;
    expect(headerRow.className).not.toMatch(/border-accent-500|ring-accent/);
    expect(headerRow.className).toMatch(/border-slate-200/);
  });

  it("http leaf 프리뷰가 이름/URL/메서드 배지를 렌더한다", () => {
    render(<OutlineRowPreview step={stepById("01HX0000000000000000000001")} depth={0} />);
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("/login")).toBeInTheDocument();
  });
});
