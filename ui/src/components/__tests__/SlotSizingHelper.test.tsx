import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlotSizingHelper } from "../SlotSizingHelper";

vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
  useScenario: vi.fn(),
  useTestRun: vi.fn(),
}));
import { useScenarioRuns, useRunReport, useScenario, useTestRun } from "../../api/hooks";

const openRun = (created_at: number) =>
  ({
    id: `r${created_at}`,
    status: "completed",
    profile: { vus: 0, target_rps: 100, max_in_flight: 50 },
    created_at,
  }) as unknown as never;

function setHooks(opts: {
  runs?: unknown[];
  p50?: number | null;
  yaml?: string;
  testRun?: unknown;
}) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { runs: opts.runs ?? [] },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: opts.p50 != null ? { summary: { p50_ms: opts.p50 } } : undefined,
  });
  (useScenario as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { yaml: opts.yaml ?? "version: 1\nsteps: []\n" },
  });
  (useTestRun as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.testRun ?? { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("SlotSizingHelper", () => {
  it("앵커(p50): 권장 슬롯 + p50 출처 문구 + 계산식", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="1000" onApply={vi.fn()} />);
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    expect(screen.getByText(/p50 50ms/)).toBeInTheDocument();
    // 계산식 투명성 줄 lock-in: 목표 1000 RPS × 지연 50ms ≈ 동시 50슬롯
    expect(screen.getByText(/≈ 동시 50슬롯/)).toBeInTheDocument();
  });

  it("적용 → onApply(권장)", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    setHooks({ runs: [openRun(100)], p50: 250 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={onApply} />);
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(50);
  });

  it("앵커 없음: 예상 응답시간 입력으로 권장 + 한계 문구", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], p50: null });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("예상 평균 응답시간(ms)"), "250");
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
    expect(screen.getByText(/부하 없는 1회 실행/)).toBeInTheDocument();
  });

  it("측정 버튼 → test-run 발사; truncated면 측정 거부", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      p50: null,
      testRun: {
        mutate,
        isPending: false,
        isError: false,
        data: { truncated: true, total_ms: 10, steps: [] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByText(/측정이 잘렸어요/)).toBeInTheDocument();
    expect(screen.queryByText(/최소 ~/)).not.toBeInTheDocument();
  });

  it("측정(비-truncated) → R/T로 권장", () => {
    setHooks({
      runs: [],
      p50: null,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 250, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    expect(screen.getByText(/요청 1개 · 평균 250ms/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~50\(으\)로/)).toBeInTheDocument();
  });

  it("권장값이 상한(10,000) 초과 → 경고", () => {
    setHooks({ runs: [openRun(100)], p50: 1000 }); // 1s 지연
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="20000" onApply={vi.fn()} />);
    // 20000 RPS × 1000ms = 20000 슬롯 > 10000
    expect(screen.getByText(/슬롯 상한\(10,000\)을 넘어요/)).toBeInTheDocument();
  });

  it("목표 RPS 비어있으면 안내(권장 미표시)", () => {
    setHooks({ runs: [openRun(100)], p50: 50 });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="" onApply={vi.fn()} />);
    expect(screen.getByText(/목표 RPS를 먼저 입력/)).toBeInTheDocument();
    expect(screen.queryByText(/최소 ~/)).not.toBeInTheDocument();
  });

  it("지연 출처 없음 → 계산 불가 안내", () => {
    setHooks({ runs: [], p50: null });
    render(<SlotSizingHelper scenarioId="s1" env={{}} targetRps="200" onApply={vi.fn()} />);
    expect(screen.getByText(/응답시간 정보가 없어요/)).toBeInTheDocument();
  });
});
