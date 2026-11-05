import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunPrintPage } from "../RunPrintPage";

vi.mock("../../print/PrintDocument", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    PrintDocument: (p: { kind: string; onLadder?: (l: number) => void }) => {
      React.useEffect(() => {
        p.onLadder?.(p.kind === "summary" ? 3 : 0);
      }, [p]);
      return null;
    },
  };
});

const YAML = 'version: 1\nname: "n"\nsteps: []\n';
const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const profile = {
  vus: 1,
  ramp_up_seconds: 0,
  duration_seconds: 5,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/runs/R1")) {
      return Promise.resolve(
        json({
          id: "R1",
          scenario_id: "S1",
          scenario_yaml: YAML,
          status: "completed",
          profile,
          env: null,
          started_at: 1000,
          ended_at: 6000,
          created_at: 1000,
          message: null,
          verdict: null,
          last_metric_ts: null,
          label: null,
        }),
      );
    }
    if (url.endsWith("/api/runs/R1/report")) {
      return Promise.resolve(
        json({
          run: {
            id: "R1",
            scenario_id: "S1",
            status: "completed",
            profile,
            env: null,
            started_at: 1000,
            ended_at: 6000,
            created_at: 1000,
          },
          scenario_yaml: YAML,
          verdict: null,
          summary: {
            count: 0,
            errors: 0,
            rps: 0,
            duration_seconds: 5,
            mean_ms: 0,
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
          },
          windows: [],
          steps: [],
          status_distribution: {},
          dropped: 0,
        }),
      );
    }
    return Promise.resolve(json({ error: "nf" }, 404));
  });
});

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/runs/:id/print" element={<RunPrintPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RunPrintPage ladder notice", () => {
  it("ladder_notice: shown in summary when reduced, absent in standard", async () => {
    const first = renderPage("/runs/R1/print?kind=summary");
    expect(
      await screen.findByText("1장에 맞추려고 일부를 줄였습니다(표준판에 전체)"),
    ).toBeInTheDocument();
    first.unmount();
    renderPage("/runs/R1/print");
    await screen.findByRole("button", { name: "표준판" });
    expect(
      screen.queryByText("1장에 맞추려고 일부를 줄였습니다(표준판에 전체)"),
    ).not.toBeInTheDocument();
  });
});
