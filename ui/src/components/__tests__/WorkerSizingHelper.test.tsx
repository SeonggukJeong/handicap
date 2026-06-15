import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkerSizingHelper } from "../WorkerSizingHelper";

// 앵커 훅이 쓰는 React Query 훅 스텁 — 슬롯 헬퍼 테스트 패턴.
vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
}));
import { useScenarioRuns, useRunReport } from "../../api/hooks";

/** anchor=null이면 prior run 없음(빈 runs). 아니면 dropped/peak/wc를 가진 완료 open-loop run. */
function setHooks(anchor: { dropped: number; peak: number; priorWorkerCount: number } | null) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: {
      runs:
        anchor == null
          ? []
          : [
              {
                id: "r1",
                status: "completed",
                created_at: 1,
                profile: { vus: 0, target_rps: 100, worker_count: anchor.priorWorkerCount },
              },
            ],
    },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data:
      anchor == null
        ? undefined
        : { windows: [{ ts_second: 0, count: anchor.peak }], dropped: anchor.dropped },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("WorkerSizingHelper", () => {
  it("강한 근거(dropped>0): 천장 문구 + 권장 N + 적용 + HelpTip", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 500, peak: 790, priorWorkerCount: 2 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="2000" maxInFlight="100" onApply={onApply} />,
    );
    expect(screen.getByText(/요청이 밀렸어요/)).toBeInTheDocument();
    expect(screen.getByText(/워커 ~6대가 필요해요/)).toBeInTheDocument(); // ceil(2000*2/790)=6
    expect(screen.getByRole("button", { name: "워커 수 사이징 설명" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(6);
  });

  it("약한 근거(dropped==0): 보수적 문구 + 포화 안내 + 적용", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 0, peak: 400, priorWorkerCount: 4 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="800" maxInFlight="1000" onApply={onApply} />,
    );
    expect(screen.getByText(/드롭 없이 냈어요/)).toBeInTheDocument();
    expect(screen.getByText(/보수적으로/)).toBeInTheDocument();
    expect(screen.getByText(/포화시켜 보세요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(8); // ceil(800*4/400)=8
  });

  it("근거 없음(prior run 없음): 안내 + 적용 버튼 부재", () => {
    setHooks(null);
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="2000" maxInFlight="100" onApply={vi.fn()} />,
    );
    expect(screen.getByText(/1대로 시작하고/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "적용" })).toBeNull();
  });

  it("cross-field: 적용값 > max_in_flight → needMaxInFlight 경고", () => {
    setHooks({ dropped: 500, peak: 100, priorWorkerCount: 1 });
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="500" maxInFlight="3" onApply={vi.fn()} />,
    );
    // ceil(500*1/100)=5 > maxInFlight 3
    expect(screen.getByText(/max_in_flight도 최소 5/)).toBeInTheDocument();
  });

  it("max_in_flight 충분하면 cross-field 경고 미표시", () => {
    setHooks({ dropped: 500, peak: 100, priorWorkerCount: 1 });
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="500" maxInFlight="50" onApply={vi.fn()} />,
    );
    expect(screen.queryByText(/max_in_flight도 최소/)).toBeNull();
  });

  it("하드캡 초과(rawN>64) → overCap 경고 + 적용은 64", async () => {
    const user = userEvent.setup();
    setHooks({ dropped: 500, peak: 10, priorWorkerCount: 1 });
    const onApply = vi.fn();
    render(
      <WorkerSizingHelper scenarioId="s1" targetRps="1000" maxInFlight="10000" onApply={onApply} />,
    );
    // ceil(1000*1/10)=100 > 64
    expect(screen.getByText(/상한\(64\)을 넘어요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(64);
  });

  it("peakBased(곡선): 최고 단계 목표 문구", () => {
    setHooks({ dropped: 500, peak: 790, priorWorkerCount: 2 });
    render(
      <WorkerSizingHelper
        scenarioId="s1"
        targetRps="2000"
        peakBased
        maxInFlight="3000"
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText(/최고 단계 목표엔 워커 ~6대/)).toBeInTheDocument();
  });
});
