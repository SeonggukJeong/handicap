import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MonitorDisplayPage } from "../MonitorDisplayPage";
import { ko } from "../../i18n/ko";

const BID = "B1";
const P1 = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const P2 = "01HZZZZZZZZZZZZZZZZZZZZZP2";
// Local wall-clock 14:32:10 — HH:MM:SS display is local time.
const T = new Date(2026, 9, 22, 14, 32, 10).getTime();

type Json = Record<string, unknown>;

function panelCfg(over: Json = {}): Json {
  return {
    id: P1,
    title: "결제",
    scenario_id: "S1",
    environment_id: null,
    interval_seconds: 10,
    timeout_seconds: 5,
    latency_source: { kind: "total" },
    thresholds: [],
    bar_count: 60,
    graph_max_ms: 2000,
    ...over,
  };
}
function board(over: Json = {}, panels: Json[] = [panelCfg()]): Json {
  return {
    id: BID,
    name: "운영실 화면",
    config: { font_scale: "large", blink: "fail", panels },
    enabled: true,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}
function okResult(latency: number, at = T): Json {
  return { at_ms: at, verdict: "ok", latency_ms: latency, reason: null };
}
function panelStatus(panelId: string, results: Json[], over: Json = {}): Json {
  return {
    panel_id: panelId,
    results,
    consecutive_fail: 0,
    fail_since_ms: null,
    running: false,
    ...over,
  };
}
function status(panels: Json[], over: Json = {}): Json {
  return {
    now_ms: T + 1000,
    board_updated_at: 1,
    enabled: true,
    started_at_ms: T - 60_000,
    panels,
    ...over,
  };
}

/** Minimal Response stand-in (avoids undici body streams under fake timers). */
function res(body: unknown, code = 200): Response {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
  } as unknown as Response;
}

let boardHandler: () => Response;
let statusHandler: () => Response;
let boardCalls = 0;
let statusCalls = 0;
/** When true, status requests never answer; they reject only when aborted. */
let statusHang = false;
let statusAborts = 0;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T + 1000);
  boardCalls = 0;
  statusCalls = 0;
  statusHang = false;
  statusAborts = 0;
  boardHandler = () => res(board());
  statusHandler = () => res(status([panelStatus(P1, [okResult(413)])]));
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === `/api/monitor-boards/${BID}/status`) {
      statusCalls += 1;
      if (statusHang) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            statusAborts += 1;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return Promise.resolve(statusHandler());
    }
    if (u === `/api/monitor-boards/${BID}`) {
      boardCalls += 1;
      return Promise.resolve(boardHandler());
    }
    return Promise.resolve(res({ error: `unmocked ${u}` }, 500));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderPage() {
  // Mirrors the app's global retry 1 (App.tsx). retryDelay 10ms keeps a retry
  // distinguishable from the 1000ms poll (see status_query_no_retry).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 10 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/monitors/${BID}/display`]}>
        <Routes>
          <Route path="/monitors/:id/display" element={<MonitorDisplayPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await tick(50);
  return view;
}

const panelEl = (title: string) => screen.getByRole("article", { name: title });

describe("MonitorDisplayPage", () => {
  it("header_board_name_and_last_check", async () => {
    await renderPage();
    expect(screen.getByText("운영실 화면")).toBeInTheDocument();
    expect(
      screen.getByText(`${ko.monitor.lastCheck("14:32:10")} · ${ko.monitor.everyN(10)}`),
    ).toBeInTheDocument();
    // same interval -> no per-panel interval on the axis
    expect(within(panelEl("결제")).queryByText(/초 주기/)).toBeNull();
  });

  it("header_intervals_differ_moves_interval_to_panel_axis", async () => {
    boardHandler = () =>
      res(board({}, [panelCfg(), panelCfg({ id: P2, title: "조회", interval_seconds: 30 })]));
    statusHandler = () =>
      res(status([panelStatus(P1, [okResult(413)]), panelStatus(P2, [okResult(500, T - 5000)])]));
    await renderPage();
    expect(screen.getByText(ko.monitor.lastCheck("14:32:10"))).toBeInTheDocument();
    expect(within(panelEl("결제")).getByText(/10초 주기/)).toBeInTheDocument();
    expect(within(panelEl("조회")).getByText(/30초 주기/)).toBeInTheDocument();
  });

  it("header_no_results_shows_dash", async () => {
    // started 5s ago: inside the stale grace (10*3+5+5 s) -> still "checking"
    statusHandler = () => res(status([panelStatus(P1, [])], { started_at_ms: T - 5000 }));
    await renderPage();
    expect(screen.getByText(new RegExp(`^${ko.monitor.lastCheckNone}`))).toBeInTheDocument();
    expect(within(panelEl("결제")).getByText(ko.monitor.statePending)).toBeInTheDocument();
  });

  it("no_login_wording", async () => {
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [{ at_ms: T, verdict: "fail", latency_ms: null, reason: "HTTP 503" }], {
            consecutive_fail: 3,
            fail_since_ms: T - 20_000,
          }),
        ]),
      );
    await renderPage();
    expect(document.body.textContent).not.toContain("로그인");
  });

  it("panel_shows_ms_and_state", async () => {
    boardHandler = () =>
      res(
        board({}, [
          panelCfg(),
          panelCfg({ id: P2, title: "조회", thresholds: [{ ms: 1200, color: "#fb923c" }] }),
        ]),
      );
    statusHandler = () =>
      res(status([panelStatus(P1, [okResult(1350)]), panelStatus(P2, [okResult(1407)])]));
    await renderPage();
    const a = panelEl("결제");
    expect(within(a).getByText("1,350 ms")).toBeInTheDocument();
    expect(within(a).getByText(ko.monitor.stateOk)).toBeInTheDocument();
    const b = panelEl("조회");
    expect(within(b).getByText("1,407 ms")).toBeInTheDocument();
    const slow = within(b).getByText(ko.monitor.stateSlow);
    expect(slow.style.color).toBe("rgb(251, 146, 60)");
  });

  it("fail_shows_reason_and_consecutive", async () => {
    const fail = { at_ms: T, verdict: "fail", latency_ms: null, reason: "HTTP 503" };
    boardHandler = () => res(board({}, [panelCfg(), panelCfg({ id: P2, title: "조회" })]));
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [fail], { consecutive_fail: 1, fail_since_ms: T }),
          panelStatus(P2, [fail], { consecutive_fail: 3, fail_since_ms: T - 20_000 }),
        ]),
      );
    await renderPage();
    const a = panelEl("결제");
    expect(within(a).getByText("HTTP 503")).toBeInTheDocument();
    expect(within(a).getByText(ko.monitor.stateFail)).toBeInTheDocument();
    expect(within(a).queryByText(/회 연속/)).toBeNull();
    const b = panelEl("조회");
    expect(within(b).getByText(ko.monitor.consecutive(3, "14:31:50"))).toBeInTheDocument();
    expect(within(b).getByText("3회 연속 · 14:31:50부터")).toBeInTheDocument();
  });

  it("refetches_board_when_updated_at_changes", async () => {
    await renderPage();
    expect(boardCalls).toBe(1);
    expect(screen.getByText("운영실 화면")).toBeInTheDocument();
    // unchanged updated_at across polls -> no refetch
    await tick(2000);
    expect(boardCalls).toBe(1);
    boardHandler = () => res(board({ name: "새 이름", updated_at: 2 }));
    statusHandler = () => res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 2 }));
    await tick(1000);
    await tick(10); // let the board refetch settle
    expect(boardCalls).toBe(2);
    expect(screen.getByText("새 이름")).toBeInTheDocument();
    await tick(3000);
    expect(boardCalls).toBe(2);
  });

  it("server_down_after_3_failed_polls", async () => {
    boardHandler = () => res(board({}, [panelCfg(), panelCfg({ id: P2, title: "조회" })]));
    statusHandler = () =>
      res(status([panelStatus(P1, [okResult(413)]), panelStatus(P2, [okResult(500)])]));
    await renderPage();
    expect(screen.getAllByText(ko.monitor.stateOk)).toHaveLength(2);
    statusHandler = () => res({ error: "boom" }, 500);
    await tick(1000);
    await tick(1000);
    expect(statusCalls).toBe(3);
    expect(screen.queryByText(ko.monitor.serverDown)).toBeNull();
    expect(screen.queryByText(ko.monitor.stateStale)).toBeNull();
    await tick(1000);
    expect(statusCalls).toBe(4);
    expect(screen.getByText(ko.monitor.serverDown)).toBeInTheDocument();
    expect(screen.getAllByText(ko.monitor.stateStale)).toHaveLength(2);
    // header keeps the last check time the server last reported
    expect(screen.getByText(new RegExp(ko.monitor.lastCheck("14:32:10")))).toBeInTheDocument();
    // recovery: one success clears it
    statusHandler = () =>
      res(status([panelStatus(P1, [okResult(413)]), panelStatus(P2, [okResult(500)])]));
    await tick(1000);
    expect(screen.queryByText(ko.monitor.serverDown)).toBeNull();
  });

  it("hung_status_requests_time_out_and_reach_server_down", async () => {
    await renderPage();
    expect(screen.getByText(ko.monitor.stateOk)).toBeInTheDocument();
    statusHang = true;
    // next poll at ~1s hangs; it is aborted at its 3s timeout (fail 1, ~4s)
    await tick(7500);
    expect(statusAborts).toBe(1);
    expect(screen.queryByText(ko.monitor.serverDown)).toBeNull();
    // fail 2 (~8s), fail 3 (~12s) -> server down, panels no longer green
    await tick(5000);
    expect(statusAborts).toBe(3);
    expect(screen.getByText(ko.monitor.serverDown)).toBeInTheDocument();
    expect(within(panelEl("결제")).getByText(ko.monitor.stateStale)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.stateOk)).toBeNull();
    // a hung request never stacks polls: one in flight at a time
    expect(statusCalls).toBeLessThanOrEqual(5);
  });

  it("status_query_no_retry", async () => {
    statusHandler = () => res({ error: "boom" }, 500);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 10 } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/monitors/${BID}/display`]}>
          <Routes>
            <Route path="/monitors/:id/display" element={<MonitorDisplayPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await tick(200);
    expect(statusCalls).toBe(1);
  });

  it("not_found_page_on_404", async () => {
    statusHandler = () => res({ error: "not found" }, 404);
    await renderPage();
    expect(screen.getByText(ko.monitor.notFound)).toBeInTheDocument();
    await tick(3500);
    expect(screen.queryByText(ko.monitor.serverDown)).toBeNull();
    expect(screen.getByText(ko.monitor.notFound)).toBeInTheDocument();
  });

  it("not_found_page_when_board_404", async () => {
    boardHandler = () => res({ error: "not found" }, 404);
    statusHandler = () => res({ error: "not found" }, 404);
    await renderPage();
    expect(screen.getByText(ko.monitor.notFound)).toBeInTheDocument();
  });

  it("stale_when_board_disabled", async () => {
    statusHandler = () => res(status([panelStatus(P1, [okResult(413)])], { enabled: false }));
    await renderPage();
    expect(within(panelEl("결제")).getByText(ko.monitor.stateStaleOff)).toBeInTheDocument();
  });

  it("graph_hidden_when_too_short", async () => {
    type Entry = { target: Element; contentRect: { height: number } };
    const observers: { cb: (e: Entry[]) => void; els: Element[] }[] = [];
    class MockRO {
      els: Element[] = [];
      constructor(cb: (e: Entry[]) => void) {
        observers.push({ cb, els: this.els });
      }
      observe(el: Element) {
        this.els.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockRO);
    const fire = (panelH: number, textH: number) =>
      act(() => {
        for (const o of observers) {
          o.cb(
            o.els.map((el) => ({
              target: el,
              contentRect: {
                height: el.getAttribute("data-testid") === "panel-box" ? panelH : textH,
              },
            })),
          );
        }
      });
    await renderPage();
    expect(observers.length).toBeGreaterThan(0);
    fire(300, 270);
    expect(screen.queryByTestId("bars-area")).toBeNull();
    // text stays
    expect(within(panelEl("결제")).getByText("413 ms")).toBeInTheDocument();
    fire(300, 150);
    expect(screen.getByTestId("bars-area")).toBeInTheDocument();
  });
});
