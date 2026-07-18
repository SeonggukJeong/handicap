import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestFlowChips } from "../TestFlowChips";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import type { ScenarioTrace, StepTrace } from "../../../api/schemas";

// loop/if(elif·else 포함)/parallel 전 유형 fixture. id는 유효 ULID 필수(model.ts ULID_RE).
const CHIP_YAML = `version: 1
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
      - id: "01HX0000000000000000000011"
        name: confirm
        type: http
        request:
          method: POST
          url: "/confirm"
    elif:
      - cond:
          left: "{{code}}"
          op: eq
          right: "500"
        then:
          - id: "01HX0000000000000000000012"
            name: alt
            type: http
            request:
              method: GET
              url: "/alt"
    else:
      - id: "01HX0000000000000000000013"
        name: cancel
        type: http
        request:
          method: GET
          url: "/cancel"
  - id: "01HX0000000000000000000020"
    name: retry
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000021"
        name: ping
        type: http
        request:
          method: GET
          url: "/ping"
  - id: "01HX0000000000000000000030"
    name: fan
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
      - name: feed
        steps:
          - id: "01HX0000000000000000000032"
            name: get-feed
            type: http
            request:
              method: GET
              url: "/feed"
`;

const parsed = parseScenarioDoc(CHIP_YAML);
if (!("model" in parsed)) throw new Error("fixture must parse");
const STEPS = parsed.model.steps;

const httpRow = (step_id: string, over?: Partial<StepTrace>): StepTrace => ({
  step_id,
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "/x", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 1,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
  ...over,
});

const failRow = (step_id: string, loop_index: number | null): StepTrace => {
  const r = httpRow(step_id, { loop_index });
  r.response = { ...r.response!, status: 500 };
  return r;
};

const ifRow = (step_id: string, branch: string): StepTrace =>
  httpRow(step_id, { kind: "if", branch, request: null, response: null });

const mkTrace = (steps: StepTrace[]): ScenarioTrace => ({
  ok: false,
  total_ms: 5,
  steps,
  final_vars: {},
  truncated: false,
  error: null,
});

// login pass · gate → elif_0 타짐 · alt pass · ping 2회 중 1 fail · get-user pass.
// confirm/cancel/get-feed는 행 없음(미실행 ○).
const TRACE = mkTrace([
  httpRow("01HX0000000000000000000001"),
  ifRow("01HX0000000000000000000010", "elif_0"),
  httpRow("01HX0000000000000000000012"),
  httpRow("01HX0000000000000000000021", { loop_index: 0 }),
  failRow("01HX0000000000000000000021", 1),
  httpRow("01HX0000000000000000000031"),
]);

const noop = () => {};

describe("TestFlowChips — 구조 (spec R2)", () => {
  it("컨테이너 그룹 안에 자식 칩이 중첩되고 최상위 구분자 수 = 최상위 스텝 - 1", () => {
    const { container } = render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    const loopGroup = container.querySelector('[data-group="01HX0000000000000000000020"]');
    expect(loopGroup).not.toBeNull();
    expect(within(loopGroup as HTMLElement).getByTitle("ping")).toBeInTheDocument();
    // 라벨: glyph(aria-hidden) + 이름 + × 2
    expect(within(loopGroup as HTMLElement).getByText("⟳")).toBeInTheDocument();
    expect(within(loopGroup as HTMLElement).getByText("× 2")).toBeInTheDocument();
    // parallel 그룹: 분기명 라벨 + 자식
    const parGroup = container.querySelector('[data-group="01HX0000000000000000000030"]');
    expect(within(parGroup as HTMLElement).getByText("user:")).toBeInTheDocument();
    expect(within(parGroup as HTMLElement).getByTitle("get-feed")).toBeInTheDocument();
    // 최상위 4개 → 구분자 3개 (RTL 텍스트 매치는 직계 텍스트 노드 join이라
    // 밴드 라벨은 "→elif 0:"으로 조인돼 exact "→"에 안 걸림)
    expect(screen.getAllByText("→")).toHaveLength(3);
    // 빈 steps → null 렌더
    const empty = render(
      <TestFlowChips steps={[]} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    expect(empty.container.firstChild).toBeNull();
  });
});

describe("TestFlowChips — run 전 플레인 미러 (spec R4/R5)", () => {
  it("trace 없음 = 아이콘·결과 접미 없는 플레인 칩", () => {
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(screen.queryByText("✓")).not.toBeInTheDocument();
    expect(screen.queryByText("✗")).not.toBeInTheDocument();
    expect(screen.queryByText("○")).not.toBeInTheDocument();
    // aria-label = 이름만
    expect(screen.getByRole("button", { name: "login" })).toBeInTheDocument();
  });
});

describe("TestFlowChips — 결과 색/아이콘/aria (spec R4/R5)", () => {
  it("pass/fail/not-run 3상태의 클래스와 aria-label", () => {
    render(<TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />);
    const pass = screen.getByRole("button", { name: "login — 성공" });
    expect(pass.className).toContain("border-emerald-300");
    const fail = screen.getByRole("button", { name: "ping — 실패" }); // loop 2행 중 1 fail 집계
    expect(fail.className).toContain("border-red-300");
    const notRun = screen.getByRole("button", { name: "get-feed — 미실행" });
    expect(notRun.className).toContain("border-slate-200");
    // TRACE 기준 pass 칩 3개(login·alt·get-user) — getByText는 다중매치 throw라 getAll로.
    expect(screen.getAllByText("✓")).toHaveLength(3);
    expect(screen.getAllByText("✗")).toHaveLength(1); // ping
    expect(screen.getAllByText("○")).toHaveLength(3); // confirm·cancel·get-feed
  });
});

describe("TestFlowChips — if 분기 라벨 (spec R3)", () => {
  it("타진 elif_0 라벨은 → 접두 + 강조, 안 타진 then/else는 dimmed", () => {
    render(<TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />);
    const taken = screen.getByText("→elif 0:");
    expect(taken.className).toContain("text-violet-700");
    expect(screen.getByText("then:").className).toContain("text-slate-300");
    expect(screen.getByText("else:").className).toContain("text-slate-300");
  });

  it("then+else 두 행이면 두 라벨 모두 강조되고 elif는 dimmed (spec R3 '둘 다 강조')", () => {
    const bothTrace = mkTrace([
      ifRow("01HX0000000000000000000010", "then"),
      ifRow("01HX0000000000000000000010", "else"),
    ]);
    render(<TestFlowChips steps={STEPS} trace={bothTrace} selectedStepId={null} onSelect={noop} />);
    expect(screen.getByText("→then:").className).toContain("text-violet-700");
    expect(screen.getByText("→else:").className).toContain("text-violet-700");
    expect(screen.getByText("elif 0:").className).toContain("text-slate-300");
  });

  it("branch none 행 = 그룹 라벨 옆 (미매치) 표지", () => {
    const noneTrace = mkTrace([ifRow("01HX0000000000000000000010", "none")]);
    render(<TestFlowChips steps={STEPS} trace={noneTrace} selectedStepId={null} onSelect={noop} />);
    expect(screen.getByText("(미매치)")).toBeInTheDocument();
  });

  it("parallel 분기 라벨은 trace 유무와 무관하게 동일(중립) 클래스", () => {
    const a = render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />,
    );
    const before = within(a.container).getByText("user:").className;
    a.unmount();
    const b = render(
      <TestFlowChips steps={STEPS} trace={TRACE} selectedStepId={null} onSelect={noop} />,
    );
    const after = within(b.container).getByText("user:").className;
    expect(after).toBe(before);
  });
});

describe("TestFlowChips — 클릭/선택 (spec R6)", () => {
  it("http 칩 클릭 → onSelect(id); 컨테이너 라벨 클릭 → onSelect(컨테이너 id)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "login" }));
    expect(onSelect).toHaveBeenCalledWith("01HX0000000000000000000001");
    await user.click(screen.getByRole("button", { name: /retry/ }));
    expect(onSelect).toHaveBeenCalledWith("01HX0000000000000000000020");
  });

  it("selectedStepId 칩만 accent 링 (클릭 대상 = 링 대상)", () => {
    render(
      <TestFlowChips
        steps={STEPS}
        trace={null}
        selectedStepId={"01HX0000000000000000000001"}
        onSelect={noop}
      />,
    );
    const selected = screen.getByRole("button", { name: "login" });
    expect(selected.className).toContain("ring-accent-500");
    expect(selected.className).toContain("border-accent-500");
    const other = screen.getByTitle("confirm").closest("button");
    expect(other?.className).not.toContain("ring-accent-500");
  });
});

describe("TestFlowChips — 칩 스트립 높이 캡 + 펼치기 토글 (editor-wide-view-overflow R1/R2)", () => {
  // jsdom은 scrollHeight/clientHeight가 항상 0 — Element.prototype getter를 render *전*에 mock.
  // (HTMLElement.prototype엔 own property가 없어 vi.spyOn이 throw — spec 리스크 노트.)
  const mockOverflow = (scrollH: number, clientH: number) => {
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(scrollH);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(clientH);
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("T1: 칩 wrap div에 캡 토큰 — split 정확-토큰 단언", () => {
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    const tokens = screen.getByTestId("chip-strip-wrap").className.split(/\s+/);
    expect(tokens).toContain("max-h-24");
    expect(tokens).toContain("overflow-y-auto");
  });

  it("T2: expandable 미전달 → overflow여도 토글 부재", () => {
    mockOverflow(300, 96);
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
  });

  it("T3: expandable + overflow → 토글 렌더, aria-expanded/aria-controls 배선", () => {
    mockOverflow(300, 96);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    const toggle = screen.getByRole("button", { name: "전체 펼치기" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("chip-strip-wrap").id);
  });

  it("T4: 토글 클릭 → 캡 토큰 제거 + '접기', 재클릭 → 캡 복귀", async () => {
    const user = userEvent.setup();
    mockOverflow(300, 96);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    await user.click(screen.getByRole("button", { name: "전체 펼치기" }));
    const expandedTokens = screen.getByTestId("chip-strip-wrap").className.split(/\s+/);
    expect(expandedTokens).not.toContain("max-h-24");
    expect(expandedTokens).not.toContain("overflow-y-auto");
    const collapse = screen.getByRole("button", { name: "접기" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(screen.getByTestId("chip-strip-wrap").className.split(/\s+/)).toContain("max-h-24");
  });

  it("T5: expandable + overflow 없음(jsdom 기본 0) → 토글 부재(죽은 컨트롤 미노출)", () => {
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
  });

  it("T6: RO 재측정 경로 — wrap 등록 + 콜백 발화로 토글 등장", () => {
    let roCallback: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    render(
      <TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} expandable />,
    );
    const wrap = screen.getByTestId("chip-strip-wrap");
    expect(observed).toContain(wrap);
    // mount 측정(0>0=false) → 토글 부재
    expect(screen.queryByRole("button", { name: "전체 펼치기" })).not.toBeInTheDocument();
    // overflow로 전이 — element 인스턴스 getter 주입 후 RO 콜백 수동 발화
    Object.defineProperty(wrap, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(wrap, "clientHeight", { configurable: true, value: 96 });
    act(() => {
      roCallback?.([], {} as ResizeObserver);
    });
    expect(screen.getByRole("button", { name: "전체 펼치기" })).toBeInTheDocument();
  });

  it("T2b: expandable 미전달이면 RO 관측 자체가 없음 (spec R2.3 게이트)", () => {
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(_cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    render(<TestFlowChips steps={STEPS} trace={null} selectedStepId={null} onSelect={noop} />);
    expect(observed).toHaveLength(0);
  });
});
