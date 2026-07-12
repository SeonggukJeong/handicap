import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlotSizingHelper } from "../SlotSizingHelper";
import type { Scenario, Step } from "../../scenario/model";

// 실 헬퍼 보존(factory-spread) — 이 파일이 모킹하는 4개 훅만 stub, 나머지는 실물.
vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
  useScenario: vi.fn(),
  useTestRun: vi.fn(),
}));
import { useScenarioRuns, useRunReport, useScenario, useTestRun } from "../../api/hooks";

// http() 캐스트는 sizing.test.ts의 관행과 동형 — 최소 Step 필드만 채운 뒤 Step으로 캐스트.
const http = (id: string): Step =>
  ({
    type: "http",
    id,
    name: id,
    request: { method: "GET", url: "/x" },
  }) as unknown as Step;

const openRun = (created_at: number, maxInFlight: number | null) =>
  ({
    id: `r${created_at}`,
    status: "completed",
    profile: { vus: 0, target_rps: 100, max_in_flight: maxInFlight },
    created_at,
  }) as unknown as never;

type ReportFixture = {
  insights?: unknown[];
  steps?: unknown[];
  summary?: { mean_ms: number };
};

function setHooks(opts: {
  runs?: unknown[];
  report?: ReportFixture;
  yaml?: string;
  testRun?: unknown;
}) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { runs: opts.runs ?? [] },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: opts.report,
  });
  (useScenario as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { yaml: opts.yaml ?? "version: 1\nsteps: []\n" },
  });
  (useTestRun as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.testRun ?? { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
  );
}

const saturatedReport: ReportFixture = {
  insights: [
    { kind: "load_gen_saturated", cause: "slots", achieved_per_sec: 2.667, recommended: 23 },
  ],
  steps: [],
  summary: { mean_ms: 0 },
};

beforeEach(() => vi.clearAllMocks());

describe("SlotSizingHelper", () => {
  // ⓐ 직전 포화 run 실측 hold 복원 (R8, R9 parity)
  it("ⓐ 포화 run 앵커: hold=M÷achieved 복원 → target 20 → 23 (서버 recommended와 동일, R9)", () => {
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    expect(screen.getByText(/직전 실행이 포화였어요/)).toBeInTheDocument();
    expect(screen.getByText(/max_in_flight를 최소 ~23\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  it("ⓐ 앵커 hold 재사용: target 40 → 45 (스케일)", () => {
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="40" onApply={vi.fn()} />);
    expect(screen.getByText(/max_in_flight를 최소 ~45\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  it("우선순위: 포화 인사이트(ⓐ)가 있으면 scenario walk(ⓑ)가 계산돼도 ⓐ가 이긴다", () => {
    const scenario = { steps: [http("a"), http("b")] } as unknown as Scenario;
    setHooks({
      runs: [openRun(100, 3)],
      report: {
        insights: saturatedReport.insights,
        steps: [
          { step_id: "a", p50_ms: 100 },
          { step_id: "b", p50_ms: 200 },
        ],
        summary: { mean_ms: 999 },
      },
    });
    render(
      <SlotSizingHelper
        scenarioId="s1"
        scenario={scenario}
        env={{}}
        targetRps="20"
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText(/직전 실행이 포화였어요/)).toBeInTheDocument();
    expect(screen.queryByText(/지난 실행의 스텝별 응답시간/)).not.toBeInTheDocument();
    expect(screen.getByText(/max_in_flight를 최소 ~23\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  // ⓑ scenario walk(iterationHoldMs, p50 ?? mean_ms)
  it("ⓑ walk 앵커: per-step p50(100+200) → hold 300 → target 20 → 6", () => {
    const scenario = { steps: [http("a"), http("b")] } as unknown as Scenario;
    setHooks({
      runs: [openRun(100, null)],
      report: {
        insights: [],
        steps: [
          { step_id: "a", p50_ms: 100 },
          { step_id: "b", p50_ms: 200 },
        ],
        summary: { mean_ms: 999 },
      },
    });
    render(
      <SlotSizingHelper
        scenarioId="s1"
        scenario={scenario}
        env={{}}
        targetRps="20"
        onApply={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/지난 실행의 스텝별 응답시간으로 계산한 반복 1회 ~300ms/),
    ).toBeInTheDocument();
    expect(screen.getByText(/max_in_flight를 최소 ~6\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  it("ⓑ 무효(p50 전부 0·mean 0) → hold 0 → ⓒ 수동 입력 폴백 렌더", () => {
    const scenario = { steps: [http("a")] } as unknown as Scenario;
    setHooks({
      runs: [openRun(100, null)],
      report: {
        insights: [],
        steps: [{ step_id: "a", p50_ms: 0 }],
        summary: { mean_ms: 0 },
      },
    });
    render(
      <SlotSizingHelper
        scenarioId="s1"
        scenario={scenario}
        env={{}}
        targetRps="20"
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/반복 1회 예상 시간\(ms\)/)).toBeInTheDocument();
    expect(screen.queryByText(/지난 실행의 스텝별 응답시간/)).not.toBeInTheDocument();
    expect(screen.queryByText(/직전 실행이 포화였어요/)).not.toBeInTheDocument();
  });

  // ⓒ 수동 입력 — 라벨 의미 변경("반복 1회 예상 시간(ms)")
  it("ⓒ 수동 입력(1100) → target 20 → 22, 라벨 '반복 1회 예상 시간(ms)'", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], report: undefined });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    const input = screen.getByLabelText(/반복 1회 예상 시간\(ms\)/);
    await user.type(input, "1100");
    expect(screen.getByText(/max_in_flight를 최소 ~22\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  it("우선순위: 수동 입력(ⓒ)이 측정값(ⓓ)보다 우선", async () => {
    const user = userEvent.setup();
    setHooks({
      runs: [],
      report: undefined,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 1105, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    await user.type(screen.getByLabelText(/반복 1회 예상 시간\(ms\)/), "1100");
    // 수동(1100→22)이 측정(1105→23)보다 우선해야 함
    expect(screen.getByText(/max_in_flight를 최소 ~22\(으\)로 설정하세요/)).toBeInTheDocument();
  });

  // ⓓ 측정 클릭 → apply_think_time:true + trace.total_ms 직접 hold
  it("ⓓ 측정 클릭 → testRun.mutate가 apply_think_time:true 포함해 호출됨", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      report: undefined,
      testRun: { mutate, isPending: false, isError: false, data: undefined },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ apply_think_time: true }));
  });

  it("ⓓ 측정 결과 total_ms:1105 → hold 직접(÷R 없음) → target 20 → 23", () => {
    setHooks({
      runs: [],
      report: undefined,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 1105, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    expect(screen.getByText(/max_in_flight를 최소 ~23\(으\)로 설정하세요/)).toBeInTheDocument();
    expect(screen.getByText(/측정됨: 요청 1개 · 반복 1회 ~1105ms/)).toBeInTheDocument();
  });

  it("측정 버튼 → apply_think_time:true로 발사; truncated면 측정 거부", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      report: undefined,
      testRun: {
        mutate,
        isPending: false,
        isError: false,
        data: { truncated: true, total_ms: 10, steps: [] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ apply_think_time: true }));
    expect(screen.getByText(/측정이 잘렸어요/)).toBeInTheDocument();
    expect(screen.queryByText(/max_in_flight를 최소/)).not.toBeInTheDocument();
  });

  it("측정 중(isPending): 버튼 '측정 중…' + disabled", () => {
    setHooks({
      runs: [],
      report: undefined,
      testRun: { mutate: vi.fn(), isPending: true, isError: false, data: undefined },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    expect(screen.getByRole("button", { name: "측정 중…" })).toBeDisabled();
  });

  it("측정 실패(isError): 오류 알림 표시", () => {
    setHooks({
      runs: [],
      report: undefined,
      testRun: { mutate: vi.fn(), isPending: false, isError: true, data: undefined },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/측정에 실패했어요/);
  });

  it("적용 버튼 → onApply(권장 슬롯)", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(23);
  });

  it("권장값이 상한(10,000) 초과 → 경고", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], report: undefined });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20000" onApply={vi.fn()} />);
    await user.type(screen.getByLabelText(/반복 1회 예상 시간\(ms\)/), "1000");
    // 20000 × (1000/1000) = 20000 슬롯 > 10000
    expect(screen.getByText(/슬롯 상한\(10,000\)을 넘어요/)).toBeInTheDocument();
  });

  it("목표 도착률 비어있으면 안내(권장 미표시)", () => {
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="" onApply={vi.fn()} />);
    expect(screen.getByText(/목표 도착률을 먼저 입력/)).toBeInTheDocument();
    expect(screen.queryByText(/max_in_flight를 최소/)).not.toBeInTheDocument();
  });

  it("hold 출처 없음 → 계산 불가 안내", () => {
    setHooks({ runs: [], report: undefined });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />);
    expect(screen.getByText(/응답시간 정보가 없어요/)).toBeInTheDocument();
  });

  it("peakBased + 앵커: '최고 단계 목표' 문구로 계산식 표시", () => {
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(
      <SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" peakBased onApply={vi.fn()} />,
    );
    // formulaPeak: 최고 단계 목표 초당 20회 × 반복 1회 1125ms ≈ 동시 23슬롯
    expect(screen.getByText(/최고 단계 목표 초당 20회/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 동시 23슬롯/)).toBeInTheDocument();
  });

  it("peakBased + 목표 빈 문자열 → '단계 목표를 먼저 입력' (곡선 변형)", () => {
    setHooks({ runs: [openRun(100, 3)], report: saturatedReport });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="" peakBased onApply={vi.fn()} />);
    expect(screen.getByText(/단계 목표를 먼저 입력/)).toBeInTheDocument();
    // fixed 변형 문구는 안 떠야 함(회귀 가드)
    expect(screen.queryByText(/목표 도착률을 먼저 입력/)).not.toBeInTheDocument();
  });
});
