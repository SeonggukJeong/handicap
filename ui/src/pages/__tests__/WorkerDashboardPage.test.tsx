import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
        workers: [
          {
            worker_id: "wkr-idle",
            hostname: "pc-alice",
            capacity_vus: 100,
            busy: false,
            run_id: null,
            last_seen_secs_ago: 2,
          },
          {
            worker_id: "wkr-busy",
            hostname: "pc-bob",
            capacity_vus: 50,
            busy: true,
            run_id: "run-1",
            last_seen_secs_ago: 3,
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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pool_mode: false,
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
        workers: [],
      }),
    );
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNotPool)).toBeInTheDocument();
  });

  it("풀-모드 0대: emptyNoWorkers 안내", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pool_mode: true,
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
        workers: [],
      }),
    );
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNoWorkers)).toBeInTheDocument();
    // count summary shows 0 idle 0 busy
    expect(screen.getByText(ko.workers.countSummary(0, 0))).toBeInTheDocument();
  });

  it("마지막 응답 열·stale 배지: quiet 행에만 표시", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pool_mode: true,
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
        workers: [
          {
            worker_id: "wkr-fresh",
            hostname: "pc-fresh",
            capacity_vus: 100,
            busy: false,
            run_id: null,
            last_seen_secs_ago: 2, // fresh: < interval → no badge
          },
          {
            worker_id: "wkr-quiet",
            hostname: "pc-quiet",
            capacity_vus: 50,
            busy: false,
            run_id: null,
            last_seen_secs_ago: 15, // > interval(10) and < stale_timeout(30) → badge
          },
        ],
      }),
    );
    renderPage();

    // "마지막 응답" column values rendered
    expect(await screen.findByText(ko.workers.secsAgo(2))).toBeInTheDocument();
    expect(screen.getByText(ko.workers.secsAgo(15))).toBeInTheDocument();

    // stale badge appears only for the quiet (15s) row, not the fresh (2s) row
    const staleBadges = screen.getAllByText(ko.workers.stale);
    expect(staleBadges).toHaveLength(1);

    // row-identity: the badge must be in the quiet worker's row
    const quietRow = screen.getByText("pc-quiet").closest("tr")!;
    expect(within(quietRow).getByText(ko.workers.stale)).toBeInTheDocument();
    const freshRow = screen.getByText("pc-fresh").closest("tr")!;
    expect(within(freshRow).queryByText(ko.workers.stale)).toBeNull();
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
