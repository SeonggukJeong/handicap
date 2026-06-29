import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlowOutline, OutlineRowPreview } from "../FlowOutline";
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
