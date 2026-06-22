import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Canonical worker fixture with all fields including L7 additions.
// All tests should use this shape (FR3).
function makeWorker(overrides: {
  worker_id?: string;
  hostname?: string;
  capacity_vus?: number;
  busy?: boolean;
  run_id?: string | null;
  last_seen_secs_ago?: number;
  drained?: boolean;
  capacity_override?: number | null;
  label?: string | null;
}) {
  return {
    worker_id: "wkr-default",
    hostname: "pc-default",
    capacity_vus: 100,
    busy: false,
    run_id: null,
    last_seen_secs_ago: 2,
    drained: false,
    capacity_override: null,
    label: null,
    ...overrides,
  };
}

function makePoolResponse(workers: ReturnType<typeof makeWorker>[], pool_mode = true) {
  return {
    pool_mode,
    heartbeat_interval_seconds: 10,
    stale_timeout_seconds: 30,
    workers,
  };
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
      jsonResponse(
        makePoolResponse([
          makeWorker({ worker_id: "wkr-idle", hostname: "pc-alice", capacity_vus: 100 }),
          makeWorker({
            worker_id: "wkr-busy",
            hostname: "pc-bob",
            capacity_vus: 50,
            busy: true,
            run_id: "run-1",
            last_seen_secs_ago: 3,
          }),
        ]),
      ),
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
    fetchMock.mockResolvedValueOnce(jsonResponse(makePoolResponse([], false)));
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNotPool)).toBeInTheDocument();
  });

  it("풀-모드 0대: emptyNoWorkers 안내", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makePoolResponse([])));
    renderPage();
    expect(await screen.findByText(ko.workers.emptyNoWorkers)).toBeInTheDocument();
    // count summary shows 0 idle 0 busy
    expect(screen.getByText(ko.workers.countSummary(0, 0))).toBeInTheDocument();
  });

  it("마지막 응답 열·stale 배지: quiet 행에만 표시", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makePoolResponse([
          makeWorker({
            worker_id: "wkr-fresh",
            hostname: "pc-fresh",
            capacity_vus: 100,
            last_seen_secs_ago: 2, // fresh: < interval → no badge
          }),
          makeWorker({
            worker_id: "wkr-quiet",
            hostname: "pc-quiet",
            capacity_vus: 50,
            last_seen_secs_ago: 15, // > interval(10) and < stale_timeout(30) → badge
          }),
        ]),
      ),
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

  // ── L7 tests ──

  it("drained 배지·수동 용량 표기: drained+override 워커에 배지와 '(수동)' 표시", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makePoolResponse([
          makeWorker({
            worker_id: "wkr-drained",
            hostname: "pc-drain",
            capacity_vus: 20,
            drained: true,
            capacity_override: 5,
          }),
          makeWorker({
            worker_id: "wkr-normal",
            hostname: "pc-normal",
            capacity_vus: 10,
          }),
        ]),
      ),
    );
    renderPage();

    await screen.findByText("pc-drain");

    // drained badge shows
    expect(screen.getByText(ko.workers.drainedBadge)).toBeInTheDocument();

    // capacity_override=5 shows as "5 (수동)"
    expect(screen.getByText(ko.workers.capacityManual(5))).toBeInTheDocument();

    // normal worker shows plain capacity_vus
    const normalRow = screen.getByText("pc-normal").closest("tr")!;
    expect(within(normalRow).getByText("10")).toBeInTheDocument();
  });

  it("busy 워커 제외 확인창에 run 실패 경고 문구 포함", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makePoolResponse([
          makeWorker({
            worker_id: "wkr-busy-2",
            hostname: "pc-busy",
            busy: true,
            run_id: "r9",
          }),
        ]),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("pc-busy");

    // Open kebab menu then click 제외
    await user.click(screen.getByRole("button", { name: ko.workers.actionsLabel }));
    await user.click(screen.getByRole("menuitem", { name: ko.workers.exclude }));

    // Confirm dialog appears
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeInTheDocument();

    // busy run failure warning includes run_id and "실패"
    expect(within(dialog).getByText(/r9/)).toBeInTheDocument();
    expect(within(dialog).getByText(/실패/)).toBeInTheDocument();
  });

  it("비우기 확인창에 '되돌리기'가 포함되고 실패 경고 없음", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        makePoolResponse([makeWorker({ worker_id: "wkr-idle-2", hostname: "pc-idle2" })]),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("pc-idle2");

    // Open actions menu and click 비우기
    await user.click(screen.getByRole("button", { name: ko.workers.actionsLabel }));
    await user.click(screen.getByRole("menuitem", { name: ko.workers.drain }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // reversible copy: 되돌리기 present
    expect(within(dialog).getByText(/되돌리기/)).toBeInTheDocument();

    // NO failure warning
    expect(within(dialog).queryByText(/실패/)).toBeNull();
  });

  it("비우기 → 계속 클릭 시 PATCH {drained:true} 호출", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          makePoolResponse([makeWorker({ worker_id: "wkr-patch", hostname: "pc-patch" })]),
        ),
      )
      // PATCH response
      .mockResolvedValueOnce(
        jsonResponse(makeWorker({ worker_id: "wkr-patch", hostname: "pc-patch", drained: true })),
      )
      // refetch after invalidation
      .mockResolvedValueOnce(
        jsonResponse(
          makePoolResponse([
            makeWorker({ worker_id: "wkr-patch", hostname: "pc-patch", drained: true }),
          ]),
        ),
      );

    const user = userEvent.setup();
    renderPage();

    await screen.findByText("pc-patch");

    await user.click(screen.getByRole("button", { name: ko.workers.actionsLabel }));
    await user.click(screen.getByRole("menuitem", { name: ko.workers.drain }));
    await user.click(screen.getByRole("button", { name: ko.workers.confirmProceed }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/pool/workers/wkr-patch") &&
          (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body).toMatchObject({ drained: true });
    });
  });
});
