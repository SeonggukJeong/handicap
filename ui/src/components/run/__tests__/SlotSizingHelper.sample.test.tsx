import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SlotSizingHelper } from "../SlotSizingHelper";
import { queryKeys } from "../../../api/hooks";

// useScenarioRuns만 stub — useRunReport는 실물이라 캐시 열쇠와 요청 URL이 실제로 검증된다.
vi.mock("../../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/hooks")>()),
  useScenarioRuns: vi.fn(() => ({
    data: {
      runs: [
        {
          id: "R1",
          status: "completed",
          profile: { vus: 0, target_rps: 100, max_in_flight: 3 },
          created_at: 100,
        },
      ],
    },
  })),
}));

afterEach(() => vi.unstubAllGlobals());

describe("SlotSizingHelper 표본", () => {
  it("기본 리포트가 캐시에 있어도 sample=all 리포트를 따로 요청한다", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.runReport("R1"), { steps: [], summary: { mean_ms: 0 } });
    render(
      <QueryClientProvider client={qc}>
        <SlotSizingHelper scenarioId="s1" env={{}} targetRps="20" onApply={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]);
      expect(urls.some((u) => u.includes("/runs/R1/report") && u.includes("sample=all"))).toBe(
        true,
      );
    });
  });
});
