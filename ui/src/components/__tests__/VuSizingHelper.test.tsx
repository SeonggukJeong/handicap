import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VuSizingHelper } from "../VuSizingHelper";
import type { Scenario } from "../../scenario/model";

vi.mock("../../api/hooks", () => ({
  useScenarioRuns: vi.fn(),
  useRunReport: vi.fn(),
  useScenario: vi.fn(),
  useTestRun: vi.fn(),
}));
import { useScenarioRuns, useRunReport, useScenario, useTestRun } from "../../api/hooks";

// http step 1개짜리 최소 시나리오 모델(flattenHttpSteps → reqPerIter 1).
const scenario = {
  version: 1,
  steps: [
    {
      id: "0123456789ABCDEFGHJKMNPQRS",
      type: "http",
      name: "a",
      request: { method: "GET", url: "http://x/a", headers: {} },
    },
  ],
} as unknown as Scenario;

const completedRun = (vus: number, created_at: number) =>
  ({ id: `r${created_at}`, status: "completed", profile: { vus }, created_at }) as unknown as never;

function setHooks(opts: {
  runs?: unknown[];
  reportRps?: number | null;
  yaml?: string;
  testRun?: unknown;
}) {
  (useScenarioRuns as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { runs: opts.runs ?? [] },
  });
  (useRunReport as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: opts.reportRps != null ? { summary: { rps: opts.reportRps } } : undefined,
  });
  (useScenario as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { yaml: opts.yaml ?? "version: 1\nsteps: []\n" },
  });
  (useTestRun as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    opts.testRun ?? { mutate: vi.fn(), isPending: false, isError: false, data: undefined },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("VuSizingHelper", () => {
  it("최근 run 앵커: 목표 RPS 프리필 + 권장 VU(선형)", async () => {
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    const input = (await screen.findByLabelText("목표 RPS")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    expect(screen.getByText(/권장 VU: 최소 ~50개부터/)).toBeInTheDocument();
  });

  it("목표를 올리면 권장이 스케일, 적용→onApply", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={onApply} />);
    const input = (await screen.findByLabelText("목표 RPS")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("200"));
    await user.clear(input);
    await user.type(input, "400");
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(onApply).toHaveBeenCalledWith(100);
  });

  it("사용자가 먼저 입력하면 비동기 앵커가 덮어쓰지 않음", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [completedRun(50, 100)], reportRps: null }); // 앵커 아직 없음(report 미도착)
    const { rerender } = render(
      <VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />,
    );
    const input = screen.getByLabelText("목표 RPS") as HTMLInputElement;
    await user.type(input, "999");
    setHooks({ runs: [completedRun(50, 100)], reportRps: 200 }); // 이제 앵커 도착
    rerender(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    expect(input.value).toBe("999"); // 시드 스킵
  });

  it("앵커 없음: 추정 지연 입력으로 권장 + 한계 문구", async () => {
    const user = userEvent.setup();
    setHooks({ runs: [], reportRps: null });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("목표 RPS"), "400");
    await user.type(screen.getByLabelText("1회 반복 예상 지연(ms)"), "250");
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
    expect(screen.getByText(/부하 없는 1회 실행/)).toBeInTheDocument();
  });

  it("측정 버튼 → test-run 발사; truncated면 측정 거부", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      reportRps: null,
      testRun: {
        mutate,
        isPending: false,
        isError: false,
        data: { truncated: true, total_ms: 10, steps: [] },
      },
    });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalled();
    expect(screen.getByText(/측정이 잘렸어요/)).toBeInTheDocument();
    expect(screen.queryByText(/권장 VU/)).not.toBeInTheDocument();
  });

  it("측정(비-truncated) → R/T로 권장", async () => {
    const user = userEvent.setup();
    setHooks({
      runs: [],
      reportRps: null,
      testRun: {
        mutate: vi.fn(),
        isPending: false,
        isError: false,
        data: { truncated: false, total_ms: 250, steps: [{ response: { status: 200 } }] },
      },
    });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.type(screen.getByLabelText("목표 RPS"), "400");
    expect(screen.getByText(/요청 1개 · 250ms/)).toBeInTheDocument();
    expect(screen.getByText(/권장 VU: 최소 ~100개부터/)).toBeInTheDocument();
  });

  it("측정은 apply_think_time: true로 발사한다 (SlotSizingHelper와 같은 앵커 정의)", async () => {
    const mutate = vi.fn();
    const user = userEvent.setup();
    setHooks({
      runs: [],
      yaml: "version: 1\nname: d\nsteps: []\n",
      testRun: { mutate, isPending: false, isError: false, data: undefined },
    });
    render(<VuSizingHelper scenarioId="s1" scenario={scenario} env={{}} onApply={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "test-run으로 측정" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ apply_think_time: true }));
  });
});
