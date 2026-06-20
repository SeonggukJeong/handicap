import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { WorkerDashboardPage } from "../WorkerDashboardPage";
import { ko } from "../../i18n/ko";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkerDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WorkerDashboardPage", () => {
  it("풀-모드: 워커 행·hostname·상태·카운트·run 링크", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pool_mode: true,
        workers: [
          {
            worker_id: "wkr-idle",
            hostname: "pc-alice",
            capacity_vus: 100,
            busy: false,
            run_id: null,
          },
          {
            worker_id: "wkr-busy",
            hostname: "pc-bob",
            capacity_vus: 50,
            busy: true,
            run_id: "run-1",
          },
        ],
      }),
    );
    renderPage();

    // hostname cells
    expect(await screen.findByText("pc-alice")).toBeInTheDocument();
    expect(screen.getByText("pc-bob")).toBeInTheDocument();

    // status cells
    expect(screen.getByText(ko.workers.statusIdle)).toBeInTheDocument();
    expect(screen.getByText(ko.workers.statusBusy)).toBeInTheDocument();

    // count summary: 1 idle, 1 busy
    expect(screen.getByText(ko.workers.countSummary(1, 1))).toBeInTheDocument();

    // busy row has a link to the run
    const runLink = screen.getByRole("link", { name: /run-1/ });
    expect(runLink).toHaveAttribute("href", "/runs/run-1");
  });

  it("풀 아님: emptyNotPool 안내", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pool_mode: false, workers: [] }));
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNotPool)).toBeInTheDocument();
  });

  it("풀-모드 0대: emptyNoWorkers 안내", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pool_mode: true, workers: [] }));
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNoWorkers)).toBeInTheDocument();
    // count summary shows 0 idle 0 busy
    expect(screen.getByText(ko.workers.countSummary(0, 0))).toBeInTheDocument();
  });

  it("로딩 중: role=status 표시", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("fetch 실패: role=alert 에러", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(ko.workers.loadError)).toBeInTheDocument();
  });
});
