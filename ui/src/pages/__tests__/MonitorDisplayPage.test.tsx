import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MonitorDisplayPage } from "../MonitorDisplayPage";
import { ko } from "../../i18n/ko";
import { MIN_FIT, nextSearch } from "../../monitor/display";
import { focusGeometries } from "../../monitor/logic";

const BID = "B1";
const P1 = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const P2 = "01HZZZZZZZZZZZZZZZZZZZZZP2";
// Local wall-clock 14:32:10 — HH:MM:SS display is local time.
const T = new Date(2026, 9, 22, 14, 32, 10).getTime();

type Json = Record<string, unknown>;

// Wall display items (spec §2.2): the first is drawn big, the second small.
const ITEM1: Json = { step_id: "01HZZZZZZZZZZZZZZZZZZZZZS1", source: "body", path: "$.code" };
const ITEM2: Json = { step_id: "01HZZZZZZZZZZZZZZZZZZZZZS1", source: "body", path: "$.message" };

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
    conditions: [],
    display_items: [],
    ...over,
  };
}
function board(over: Json = {}, panels: Json[] = [panelCfg()]): Json {
  return {
    id: BID,
    name: "운영실 화면",
    config: {
      font_scale: "large",
      show_latency_stats: true,
      display_style: "border",
      blink: "fail",
      panels,
    },
    enabled: true,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}
function boardStats(show: boolean, updatedAt = 1, style = "border"): Json {
  return board({
    updated_at: updatedAt,
    config: { ...(board().config as Json), show_latency_stats: show, display_style: style },
  });
}
function okResult(latency: number, at = T): Json {
  return { at_ms: at, verdict: "ok", latency_ms: latency, reason: null, detail: null, display: [] };
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
let statsHandler: (init?: RequestInit) => Promise<Response>;
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
  statsHandler = () => Promise.resolve(res({ error: "unexpected" }, 500));
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
    if (u === `/api/monitor-boards/${BID}/latency-stats`) return statsHandler(init);
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
          panelStatus(
            P1,
            [
              {
                at_ms: T,
                verdict: "fail",
                latency_ms: null,
                reason: "HTTP 503",
                detail: null,
                display: [],
              },
            ],
            {
              consecutive_fail: 3,
              fail_since_ms: T - 20_000,
            },
          ),
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
    const fail = {
      at_ms: T,
      verdict: "fail",
      latency_ms: null,
      reason: "HTTP 503",
      detail: null,
      display: [],
    };
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

  describe("A (fill) style", () => {
    const failRes = {
      at_ms: T,
      verdict: "fail",
      latency_ms: null,
      reason: "HTTP 503",
      detail: null,
      display: [],
    };
    const fillBoard = (style: string, panels: Json[] = [panelCfg()], over: Json = {}) =>
      board(
        {
          ...over,
          config: {
            font_scale: "large",
            show_latency_stats: true,
            display_style: style,
            blink: "off",
            panels,
          },
        },
        panels,
      );
    const boxOf = (title: string) => within(panelEl(title)).getByTestId("panel-box");

    it("fill_panel_background_is_state_color", async () => {
      boardHandler = () => res(fillBoard("fill"));
      statusHandler = () => res(status([panelStatus(P1, [failRes])]));
      await renderPage();
      expect(boxOf("결제").style.background).toBe("rgb(185, 28, 28)");
      expect(within(panelEl("결제")).getByRole("heading", { name: "결제" }).style.color).toBe(
        "rgb(255, 255, 255)",
      );
    });

    it("fill_slow_yellow_threshold_uses_dark_text", async () => {
      boardHandler = () =>
        res(fillBoard("fill", [panelCfg({ thresholds: [{ ms: 1000, color: "#facc15" }] })]));
      statusHandler = () => res(status([panelStatus(P1, [okResult(1500)])]));
      await renderPage();
      expect(boxOf("결제").style.background).toBe("rgb(250, 204, 21)");
      expect(within(panelEl("결제")).getByText("1,500 ms").style.color).toBe("rgb(11, 15, 20)");
    });

    it("fill_pending_matches_border", async () => {
      statusHandler = () => res(status([panelStatus(P1, [])], { started_at_ms: T - 5000 }));
      boardHandler = () => res(fillBoard("fill"));
      await renderPage();
      expect(boxOf("결제").getAttribute("data-state")).toBe("pending");
      expect(boxOf("결제").style.background).toBe("rgb(17, 26, 35)");
    });

    it("fill_graph_inside_dark_box", async () => {
      boardHandler = () => res(fillBoard("fill"));
      await renderPage();
      expect(within(panelEl("결제")).getByTestId("latency-bars").style.background).toBe(
        "rgb(11, 15, 20)",
      );
    });

    it("border_board_unchanged", async () => {
      boardHandler = () => res(fillBoard("border"));
      await renderPage();
      expect(within(panelEl("결제")).getByTestId("latency-bars").style.background).toBe("");
      expect(boxOf("결제").style.background).toBe("rgb(17, 26, 35)");
    });

    it("display_style_change_applies_after_board_refetch", async () => {
      boardHandler = () => res(fillBoard("border"));
      statusHandler = () => res(status([panelStatus(P1, [failRes])]));
      await renderPage();
      expect(boxOf("결제").style.background).toBe("rgb(17, 26, 35)");
      boardHandler = () => res(fillBoard("fill", [panelCfg()], { updated_at: 2 }));
      statusHandler = () => res(status([panelStatus(P1, [failRes])], { board_updated_at: 2 }));
      await tick(1000);
      await tick(10);
      expect(boxOf("결제").style.background).toBe("rgb(185, 28, 28)");
    });
  });

  describe("C (focus) layout", () => {
    const P3 = "01HZZZZZZZZZZZZZZZZZZZZZP3";
    const P4 = "01HZZZZZZZZZZZZZZZZZZZZZP4";
    const failRes = (at = T) => ({
      at_ms: at,
      verdict: "fail",
      latency_ms: null,
      reason: "HTTP 503",
      detail: null,
      display: [],
    });
    const cfgs = (): Json[] => [
      panelCfg({ id: P1, title: "가", thresholds: [{ ms: 1000, color: "#facc15" }] }),
      panelCfg({ id: P2, title: "나" }),
      panelCfg({ id: P3, title: "다" }),
      panelCfg({ id: P4, title: "라" }),
    ];
    const focusBoard = (style = "focus", blink = "off") =>
      board(
        {
          config: {
            font_scale: "large",
            show_latency_stats: true,
            display_style: style,
            blink,
            panels: cfgs(),
          },
        },
        cfgs(),
      );
    const withResults = (r: Record<string, Json>) =>
      status([P1, P2, P3, P4].map((id) => panelStatus(id, [r[id] ?? okResult(200)])));
    const mainEl = () => screen.getByTestId("monitor-display").querySelector("main") as HTMLElement;

    it("focus_no_fail_renders_plain_grid", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () => res(withResults({}));
      await renderPage();
      expect(screen.getAllByTestId("monitor-panel")).toHaveLength(4);
      expect(screen.queryAllByTestId("strip-card")).toHaveLength(0);
    });

    it("focus_one_fail_big_plus_right_strip", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () => res(withResults({ [P2]: failRes() }));
      await renderPage();
      const big = screen.getAllByTestId("monitor-panel");
      expect(big).toHaveLength(1);
      expect(big[0].getAttribute("aria-label")).toBe("나");
      expect(screen.getAllByTestId("strip-card").map((c) => c.getAttribute("aria-label"))).toEqual([
        "가",
        "다",
        "라",
      ]);
      expect(mainEl().style.gridTemplateColumns).toBe("3fr 1fr");
    });

    it("focus_two_fail_bottom_strip", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () => res(withResults({ [P1]: failRes(), [P3]: failRes() }));
      await renderPage();
      expect(screen.getAllByTestId("monitor-panel")).toHaveLength(2);
      expect(screen.getAllByTestId("strip-card")).toHaveLength(2);
      expect(mainEl().style.gridTemplateRows).toBe("3fr 1fr");
    });

    it("focus_all_fail_plain_grid", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () =>
        res(withResults({ [P1]: failRes(), [P2]: failRes(), [P3]: failRes(), [P4]: failRes() }));
      await renderPage();
      expect(screen.getAllByTestId("monitor-panel")).toHaveLength(4);
      expect(screen.queryAllByTestId("strip-card")).toHaveLength(0);
    });

    it("focus_recovers_to_grid", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () => res(withResults({ [P2]: failRes() }));
      await renderPage();
      expect(screen.getAllByTestId("strip-card")).toHaveLength(3);
      statusHandler = () => res(withResults({}));
      await tick(1100);
      expect(screen.queryAllByTestId("strip-card")).toHaveLength(0);
      expect(screen.getAllByTestId("monitor-panel")).toHaveLength(4);
    });

    it("strip_card_shows_state_and_ms", async () => {
      boardHandler = () => res(focusBoard());
      statusHandler = () =>
        res(
          withResults({
            [P1]: okResult(1350),
            [P2]: failRes(),
            [P3]: {
              at_ms: T,
              verdict: "config_error",
              latency_ms: null,
              reason: "조건 기준 스텝 없음",
              detail: "x",
              display: [],
            },
          }),
        );
      await renderPage();
      const slow = screen.getByRole("article", { name: "가" });
      expect(within(slow).getByTestId("strip-status").textContent).toContain("▲ 느림");
      expect(within(slow).getByTestId("strip-status").textContent).toContain("1,350 ms");
      const cfg = screen.getByRole("article", { name: "다" });
      expect(within(cfg).getByTestId("strip-status").textContent).toContain("—");
      expect(within(cfg).queryByText("조건 기준 스텝 없음")).toBeNull();
    });

    it("strip_slow_card_blinks_with_slow_and_fail", async () => {
      boardHandler = () => res(focusBoard("focus", "slow_and_fail"));
      statusHandler = () => res(withResults({ [P1]: okResult(1350), [P2]: failRes() }));
      await renderPage();
      const slow = screen.getByRole("article", { name: "가" });
      expect(slow.getAttribute("data-testid")).toBe("strip-card");
      expect(slow.querySelector("[data-blink='on']")).not.toBeNull();
      const ok = screen.getByRole("article", { name: "라" });
      expect(ok.querySelector("[data-blink='on']")).toBeNull();
    });

    it("border_board_never_focus_layout", async () => {
      boardHandler = () => res(focusBoard("border"));
      statusHandler = () => res(withResults({ [P2]: failRes() }));
      await renderPage();
      expect(screen.queryAllByTestId("strip-card")).toHaveLength(0);
      expect(screen.getAllByTestId("monitor-panel")).toHaveLength(4);
    });
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

  /**
   * Layout stub: every panel and every size probe is 300x300. `liveH(title, el)`
   * gives a real panel's text-block height (it may depend on what is shown);
   * `probeH(title, el, geometry)` gives that panel's settings-only probe height
   * (worst-case state + one-line value) — `geometry` is the probe layout's
   * `data-geometry` (C incident probes) or "grid" (the board grid probes).
   * Strip card probes are 400x120 with a `cardH(geometry, el)` text block.
   * Read via getBoundingClientRect after each render.
   */
  function stubLayout(
    liveH: (title: string, el: HTMLElement) => number,
    probeH: (title: string, el: HTMLElement, geometry: string) => number = () => 150,
    cardH: (geometry: string, el: HTMLElement) => number = () => 40,
  ) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const id = this.getAttribute("data-testid");
      const rect = (w: number, h: number) =>
        ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 }) as DOMRect;
      const geometry = this.closest("[data-geometry]")?.getAttribute("data-geometry") ?? "grid";
      if (id === "monitor-panel" || id === "panel-probe") return rect(300, 300);
      if (id === "panel-text") {
        const title = this.closest("article")?.getAttribute("aria-label") ?? "";
        return rect(300, liveH(title, this));
      }
      if (id === "probe-text") {
        const title = this.closest("[data-title]")?.getAttribute("data-title") ?? "";
        return rect(300, probeH(title, this, geometry));
      }
      if (id === "card-probe") return rect(400, 120);
      if (id === "card-probe-text") return rect(400, cardH(geometry, this));
      return rect(0, 0);
    });
  }
  const fitOf = (title: string) =>
    within(panelEl(title)).getByTestId("panel-box").style.getPropertyValue("--fit");

  it("board_that_fits_keeps_scale_1_and_graphs", async () => {
    // 300x300: free below text = 300 - 10.2 - 150 = 139.8 >= 30% (90): no shrink
    const spy = stubLayout(() => 150);
    try {
      await renderPage();
      await tick(10);
      expect(fitOf("결제")).toBe("1");
      expect(screen.getByTestId("bars-area")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("graph_shown_while_free_space_at_least_15_percent", async () => {
    // live text 220: free = 300 - 10.2 - 220 = 69.8 (23%) >= 15%, and the bars
    // area (free - 29.43 = 40.4) >= 8% (24) -> shown. An earlier rule compared
    // the bars area against 15% and hid this graph.
    const spy = stubLayout(() => 220);
    try {
      await renderPage();
      await tick(10);
      expect(screen.getByTestId("bars-area")).toBeInTheDocument();
      expect(fitOf("결제")).toBe("1");
    } finally {
      spy.mockRestore();
    }
  });

  it("graph_hidden_when_bars_area_would_be_under_8_percent", async () => {
    // live text 240: free 49.8 (>= 15%) but the bars area would be ~20px
    // (< 8% = 24px) once the axis row and margins are placed -> hidden
    const spy = stubLayout(() => 240);
    try {
      await renderPage();
      await tick(10);
      expect(screen.queryByTestId("bars-area")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("graph_hidden_below_15_percent", async () => {
    // live text 260: free = 29.8 (< 45) -> hidden; the axis goes too
    const spy = stubLayout(() => 260);
    try {
      await renderPage();
      await tick(10);
      expect(screen.queryByTestId("bars-area")).toBeNull();
      expect(screen.queryByText(ko.monitor.axisNow)).toBeNull();
      expect(within(panelEl("결제")).getByText("413 ms")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("scale_is_settings_driven_and_unaffected_by_results", async () => {
    // The live text grows when the panel fails (reason + step + consecutive
    // lines); the settings-only probe stays 150 — unless live text leaks into
    // it (then it reports 260 and the scale would drop). The scale must not
    // move: the extra lines take room from the graph instead (spec §7.3, 축소
    // 비율은 설정으로 고정). The old live-driven scale shrank here.
    const failing = {
      at_ms: T,
      verdict: "fail",
      latency_ms: null,
      reason: "HTTP 503 · 로그인 단계",
      detail: null,
      display: [],
    };
    const spy = stubLayout(
      (_t, el) => (el.textContent?.includes(ko.monitor.stateFail) ? 260 : 150),
      (_t, el) => (el.textContent?.includes("HTTP 503") ? 260 : 150),
    );
    const probeText = () => screen.getByTestId("panel-probe").textContent;
    try {
      await renderPage();
      await tick(10);
      expect(fitOf("결제")).toBe("1");
      expect(screen.getByTestId("bars-area")).toBeInTheDocument();
      const before = probeText();
      statusHandler = () =>
        res(
          status([panelStatus(P1, [failing], { consecutive_fail: 3, fail_since_ms: T - 20_000 })]),
        );
      await tick(1000);
      await tick(10);
      expect(within(panelEl("결제")).getByText(ko.monitor.stateFail)).toBeInTheDocument();
      expect(fitOf("결제")).toBe("1");
      // no live text reaches the probe
      expect(
        within(screen.getByTestId("panel-probe")).queryByText(/HTTP 503|로그인 단계/),
      ).toBeNull();
      expect(probeText()).toBe(before);
      // the incident's lines ate the graph area -> hidden
      expect(screen.queryByTestId("bars-area")).toBeNull();
      // recovery: same scale, graph back
      statusHandler = () => res(status([panelStatus(P1, [okResult(413)])]));
      await tick(1000);
      await tick(10);
      expect(fitOf("결제")).toBe("1");
      expect(probeText()).toBe(before);
      expect(screen.getByTestId("bars-area")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("scale_search_reruns_when_settings_change", async () => {
    // the board is refetched (board_updated_at changed) with a much longer
    // title; its probe no longer fits (150 -> 260) and the scale must drop
    const LONG = "운영실 회선 상태 점검 대상 시스템";
    const spy = stubLayout(
      () => 150,
      (title) => (title === LONG ? 260 : 150),
    );
    try {
      await renderPage();
      await tick(10);
      expect(fitOf("결제")).toBe("1");
      boardHandler = () => res(board({ updated_at: 2 }, [panelCfg({ title: LONG })]));
      statusHandler = () =>
        res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 2 }));
      await tick(1000);
      await tick(10);
      await tick(10);
      expect(Number(fitOf(LONG))).toBeLessThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("stats_flag_in_scale_key", async () => {
    // a probe that carries the avg/max line is taller (150 -> 260): flipping
    // show_latency_stats via a board refetch must re-run the scale search
    const spy = stubLayout(
      () => 150,
      (_title, el) => (el.querySelector('[data-testid="stats-probe"]') ? 260 : 150),
    );
    try {
      boardHandler = () => res(boardStats(false));
      await renderPage();
      await tick(10);
      expect(screen.queryByTestId("stats-probe")).toBeNull();
      expect(fitOf("결제")).toBe("1");
      boardHandler = () => res(boardStats(true, 2));
      statusHandler = () =>
        res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 2 }));
      await tick(1000);
      await tick(10);
      await tick(10);
      expect(screen.getByTestId("stats-probe")).toBeInTheDocument();
      expect(Number(fitOf("결제"))).toBeLessThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("scale_key_changes_with_display_items_and_stats_flag", async () => {
    // An item panel's probe carries the split grid. Here the grid with its
    // avg/max split line makes the probe taller (150 -> 260): adding an item
    // through a board refetch must re-run the scale search (spec §6.2 키 규칙),
    // and so must turning the avg/max line off again (grid without it -> 150).
    const spy = stubLayout(
      () => 150,
      (_t, el) =>
        el.querySelector('[data-testid="probe-split"] [data-testid="stats-probe"]') ? 260 : 150,
    );
    try {
      await renderPage();
      await tick(10);
      expect(screen.queryByTestId("probe-split")).toBeNull();
      expect(fitOf("결제")).toBe("1");
      boardHandler = () => res(board({ updated_at: 2 }, [panelCfg({ display_items: [ITEM1] })]));
      statusHandler = () =>
        res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 2 }));
      await tick(1000);
      await tick(10);
      await tick(10);
      expect(screen.getByTestId("probe-split")).toBeInTheDocument();
      expect(Number(fitOf("결제"))).toBeLessThan(1);
      boardHandler = () =>
        res(
          board({
            updated_at: 3,
            config: {
              ...(board().config as Json),
              show_latency_stats: false,
              panels: [panelCfg({ display_items: [ITEM1] })],
            },
          }),
        );
      statusHandler = () =>
        res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 3 }));
      await tick(1000);
      await tick(10);
      await tick(10);
      expect(screen.getByTestId("probe-split")).toBeInTheDocument();
      expect(fitOf("결제")).toBe("1");
    } finally {
      spy.mockRestore();
    }
  });

  it("split_row_has_its_own_settings_scale", async () => {
    // the split probe's right lines (timeout ms, worst avg/max) are 1100px wide
    // in a 1000px half -> split-only scale 1000/1100 x 0.98; the board scale
    // (and so every other panel's text) stays 1 (D2.17)
    const spy = stubLayout(() => 150);
    const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-split-probe") ? 1100 : 0;
    });
    const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-split-probe") ? 1000 : 0;
    });
    boardHandler = () =>
      res(
        board({}, [
          panelCfg({ display_items: [ITEM1, ITEM2] }),
          panelCfg({ id: P2, title: "조회" }),
        ]),
      );
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [{ ...okResult(132), display: ["0000", "정상"] }]),
          panelStatus(P2, [okResult(413)]),
        ]),
      );
    try {
      await renderPage();
      await tick(10);
      await tick(10);
      const box = within(panelEl("결제")).getByTestId("panel-box");
      expect(box.style.getPropertyValue("--fit")).toBe("1");
      expect(box.style.getPropertyValue("--split-fit")).toBe("0.8909");
      expect(fitOf("조회")).toBe("1");
      const row = within(panelEl("결제")).getByTestId("split-row");
      for (const text of ["0000", "정상", "132 ms"]) {
        expect(within(row).getByText(text).style.fontSize).toContain("var(--split-fit");
      }
      expect(within(row).getByTestId("latency-stats").style.fontSize).toContain("var(--split-fit");
      for (const el of screen.getAllByTestId("panel-probe")) {
        el.querySelectorAll<HTMLElement>("[data-split-probe]").forEach((p) => {
          expect(p.className).toContain("whitespace-nowrap");
          expect(p.className).toContain("overflow-hidden");
        });
      }
    } finally {
      cw.mockRestore();
      sw.mockRestore();
      spy.mockRestore();
    }
  });

  it("reason_line_has_its_own_settings_scale", async () => {
    // the widest fixed reason (at reason size) is 1100px wide in a 1000px text
    // box -> reason-only scale 1000/1100 x 0.98; the board scale stays 1
    const spy = stubLayout(() => 150);
    const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-reason-probe") ? 1100 : 0;
    });
    const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-reason-probe") ? 1000 : 0;
    });
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [
            {
              at_ms: T,
              verdict: "config_error",
              latency_ms: null,
              reason: "응답 시간 기준 스텝 없음",
              detail: null,
              display: [],
            },
          ]),
        ]),
      );
    try {
      await renderPage();
      await tick(10);
      await tick(10);
      const box = within(panelEl("결제")).getByTestId("panel-box");
      expect(box.style.getPropertyValue("--fit")).toBe("1");
      expect(box.style.getPropertyValue("--reason-fit")).toBe("0.8909");
      const reason = within(panelEl("결제")).getByText("응답 시간 기준 스텝 없음");
      expect(reason.style.fontSize).toContain("var(--reason-fit");
      // the probe renders every widest-candidate reason, nothing live
      const probes = screen.getAllByTestId("reason-probe");
      expect(probes.length).toBeGreaterThan(0);
      // measured as one line, like the real reason line (found live: without
      // nowrap the probe wrapped and never reported overflow)
      for (const el of probes) expect(el.className).toContain("whitespace-nowrap");
    } finally {
      cw.mockRestore();
      sw.mockRestore();
      spy.mockRestore();
    }
  });

  it("crowded_settings_shrink_to_the_floor_at_most", async () => {
    // probe 260 (e.g. a very long title): free 29.8 < 30% at any scale -> floor
    const spy = stubLayout(
      () => 150,
      () => 260,
    );
    try {
      await renderPage();
      await tick(10);
      expect(fitOf("결제")).toBe("0.4");
    } finally {
      spy.mockRestore();
    }
  });

  it("shrink_is_board_wide_from_the_most_crowded_panel", async () => {
    boardHandler = () => res(board({}, [panelCfg(), panelCfg({ id: P2, title: "조회" })]));
    statusHandler = () =>
      res(status([panelStatus(P1, [okResult(413)]), panelStatus(P2, [okResult(500)])]));
    // 결제's settings fit (150px); 조회's are crowded (250px) -> both get 조회's scale
    const spy = stubLayout(
      () => 150,
      (title) => (title === "조회" ? 250 : 150),
    );
    try {
      await renderPage();
      await tick(10);
      const a = fitOf("결제");
      expect(Number(a)).toBeLessThan(1);
      expect(fitOf("조회")).toBe(a);
    } finally {
      spy.mockRestore();
    }
  });

  it("size_probes_are_hidden_and_outside_panels", async () => {
    await renderPage();
    const probe = screen.getByTestId("panel-probe");
    expect(probe.closest("article")).toBeNull();
    expect(probe.closest('[aria-hidden="true"]')).not.toBeNull();
    // worst-case inputs: the longest state label that can appear while checking
    // runs (stopped-only "점검 꺼짐" takes graph room instead) and a one-line value
    expect(within(probe).getByText(ko.monitor.stateConfigError)).toBeInTheDocument();
    expect(within(probe).queryByText(ko.monitor.stateStaleOff)).toBeNull();
  });

  it("fail_reason_split_fixed_part_big_step_name_small", async () => {
    statusHandler = () =>
      res(
        status([
          panelStatus(
            P1,
            [
              {
                at_ms: T,
                verdict: "fail",
                latency_ms: null,
                reason: "HTTP 503 · 회원 인증 단계",
                detail: null,
                display: [],
              },
            ],
            { consecutive_fail: 1, fail_since_ms: T },
          ),
        ]),
      );
    await renderPage();
    const a = panelEl("결제");
    const fixed = within(a).getByText("HTTP 503");
    const step = within(a).getByText("회원 인증 단계");
    expect(fixed).not.toBe(step);
    expect(fixed.className).toContain("whitespace-nowrap");
    expect(step.className).toContain("truncate");
    expect(within(a).queryByText("HTTP 503 · 회원 인증 단계")).toBeNull();
  });

  function failStatus(reason: string, detail: string, verdict = "fail") {
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [{ at_ms: T, verdict, latency_ms: null, reason, detail, display: [] }], {
            consecutive_fail: 1,
            fail_since_ms: T,
          }),
        ]),
      );
  }

  it("condition_fail_shows_value_big_and_detail_small", async () => {
    failStatus("a · b", "resultCode = 0000 · 로그인");
    await renderPage();
    const a = panelEl("결제");
    const big = within(a).getByText("a · b");
    expect(big.className).toContain("whitespace-nowrap");
    const small = within(a).getByText("resultCode = 0000 · 로그인");
    expect(small.className).toContain("truncate");
    expect(small).not.toBe(big);
  });

  it("not_contained_reason_keeps_tail_span", async () => {
    failStatus('"OK" 포함 안 됨', "본문 전체 글자 포함 OK");
    await renderPage();
    const row = within(panelEl("결제")).getByTestId("reason-not-contained");
    const needle = within(row).getByText("OK");
    const tail = within(row).getByText('" 포함 안 됨');
    expect(needle).not.toBe(tail);
    expect(tail.className).toContain("shrink-0");
    expect(needle.className).toContain("truncate");
    expect(within(panelEl("결제")).getByText("본문 전체 글자 포함 OK")).toBeInTheDocument();
  });

  it("condition_config_error_shows_detail", async () => {
    failStatus("조건 기준 스텝 없음", "status = 200", "config_error");
    await renderPage();
    const a = panelEl("결제");
    expect(within(a).getByText(ko.monitor.stateConfigError)).toBeInTheDocument();
    expect(within(a).getByText("조건 기준 스텝 없음")).toBeInTheDocument();
    expect(within(a).getByText("status = 200")).toBeInTheDocument();
  });

  it("reason_probes_include_condition_fixed_reasons", async () => {
    await renderPage();
    const text = screen.getAllByTestId("reason-probe").map((e) => e.textContent);
    for (const r of [
      "조건 기준 스텝 없음",
      "조건 스텝 미실행",
      "본문이 JSON 아님",
      "응답 본문이 너무 큼",
      "값 없음",
      "비어 있음",
    ])
      expect(text).toContain(r);
  });

  it("title_and_state_share_a_wrapping_row", async () => {
    await renderPage();
    const a = panelEl("결제");
    const title = within(a).getByRole("heading", { name: "결제" });
    const row = title.parentElement as HTMLElement;
    // fits -> one row (mockup); too wide -> the state wraps below and the title
    // takes the full width, at most 2 lines
    expect(row.className).toContain("flex-wrap");
    expect(title.className).toContain("line-clamp-2");
    const state = within(a).getByText(ko.monitor.stateOk);
    expect(state.parentElement).toBe(row);
    expect(state.className).toContain("ml-auto");
  });

  describe("C (focus) text scales", () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `01HZZZZZZZZZZZZZZZZZZZZZQ${i + 1}`);
    const TITLES = ["가", "나", "다", "라", "마", "바", "사", "아", "자"];
    const cfgsN = (n: number): Json[] => ids(n).map((id, i) => panelCfg({ id, title: TITLES[i] }));
    const styledBoard = (style: string, n: number) =>
      board(
        {
          config: {
            font_scale: "large",
            show_latency_stats: true,
            display_style: style,
            blink: "off",
            panels: cfgsN(n),
          },
        },
        cfgsN(n),
      );
    const failRes = {
      at_ms: T,
      verdict: "fail",
      latency_ms: null,
      reason: "HTTP 503",
      detail: null,
      display: [],
    };
    /** Status for an n-panel board; panels at `failIdx` fail. */
    const failing = (n: number, failIdx: number[]) =>
      status(
        ids(n).map((id, i) => panelStatus(id, [failIdx.includes(i) ? failRes : okResult(200)])),
      );
    /** The scale the board search settles on when `fits(c)` says whether scale c fits. */
    const settle = (fits: (c: number) => boolean): string => {
      let st = nextSearch({ lo: MIN_FIT, hi: 1, cand: 1, done: false }, fits(1));
      while (!st.done) st = nextSearch(st, fits(st.cand));
      return String(+st.lo.toFixed(4));
    };
    /** The scale a probe is measured at (`--fit`/`--card-fit` on its box). */
    const scaleOf = (el: HTMLElement, v: string) =>
      Number(el.parentElement?.style.getPropertyValue(v) || "1");
    // 300x300 probe: text may take 300 - 10.2 - 90 = 199.8px (+0.5 tolerance)
    const fitsH = (h: number) => (c: number) => h * c <= 200.3;
    // 400x120 card: content 120 - 2*(2+6)*1.2 = 100.8px (+0.5 tolerance)
    const cardFitsH = (h: number) => (c: number) => h * c <= 101.3;
    const cardFitOf = (title: string) =>
      within(screen.getByRole("article", { name: title }))
        .getByTestId("card-box")
        .style.getPropertyValue("--card-fit");
    async function settleSearch() {
      await tick(10);
      await tick(10);
      await tick(10);
    }

    it("border_board_has_no_focus_probes", async () => {
      for (const style of ["border", "fill"]) {
        boardHandler = () => res(styledBoard(style, 4));
        statusHandler = () => res(failing(4, [1]));
        const view = await renderPage();
        expect(screen.queryAllByTestId("incident-probe-layout")).toHaveLength(0);
        expect(screen.queryAllByTestId("card-probe-layout")).toHaveLength(0);
        expect(screen.queryAllByTestId("card-probe")).toHaveLength(0);
        expect(screen.getAllByTestId("panel-probe")).toHaveLength(4);
        view.unmount();
      }
    });

    it("focus_probe_counts", async () => {
      boardHandler = () => res(styledBoard("focus", 9));
      statusHandler = () => res(failing(9, []));
      await renderPage();
      const layouts = screen.getAllByTestId("incident-probe-layout");
      expect(layouts.map((l) => l.getAttribute("data-geometry"))).toEqual(
        focusGeometries(9).big.map((g) => g.key),
      );
      expect(layouts.map((l) => within(l).getAllByTestId("panel-probe").length)).toEqual([
        9, 9, 9, 9, 9, 9,
      ]);
      // 9 board-grid probes + 6 geometries x 9 panels
      expect(screen.getAllByTestId("panel-probe")).toHaveLength(63);
      const cards = screen.getAllByTestId("card-probe-layout");
      expect(cards.map((l) => l.getAttribute("data-geometry"))).toEqual(
        focusGeometries(9).strip.map((g) => g.key),
      );
      expect(screen.getAllByTestId("card-probe")).toHaveLength(8);
      // probes are invisible and carry no live state
      for (const l of [...layouts, ...cards]) {
        expect(l.closest('[aria-hidden="true"]')).not.toBeNull();
        expect(l.textContent).not.toContain(ko.monitor.stateOk);
      }
    });

    it("normal_fit_equals_border_board", async () => {
      // grid probes fit; every C big-area geometry is crowded (needs ~0.5)
      const spy = stubLayout(
        () => 150,
        (_t, el, g) => (g === "grid" ? 150 : 400 * scaleOf(el, "--fit")),
      );
      try {
        boardHandler = () => res(styledBoard("border", 4));
        statusHandler = () => res(failing(4, []));
        const view = await renderPage();
        await settleSearch();
        const borderFit = fitOf("가");
        expect(borderFit).toBe("1");
        view.unmount();

        boardHandler = () => res(styledBoard("focus", 4));
        await renderPage();
        await settleSearch();
        // calm C board (f=0): the same scale as the B board
        for (const t of ["가", "나", "다", "라"]) expect(fitOf(t)).toBe(borderFit);
        // incident (f=1): the big panel takes the incident scale
        statusHandler = () => res(failing(4, [1]));
        await tick(1000);
        await settleSearch();
        expect(screen.getAllByTestId("monitor-panel")).toHaveLength(1);
        expect(Number(fitOf("나"))).toBeLessThan(1);
        expect(fitOf("나")).toBe(settle(fitsH(400)));
        // recovery: back to the calm scale
        statusHandler = () => res(failing(4, []));
        await tick(1000);
        await settleSearch();
        for (const t of ["가", "나", "다", "라"]) expect(fitOf(t)).toBe(borderFit);
      } finally {
        spy.mockRestore();
      }
    });

    /** right:1x1 (f=1) fits; bottom:2x1 (f=2) is the most crowded; bottom:3x1 mildly. */
    const incidentStub = () =>
      stubLayout(
        () => 150,
        (_t, el, g) =>
          g === "bottom:2x1"
            ? 400 * scaleOf(el, "--fit")
            : g === "bottom:3x1"
              ? 250 * scaleOf(el, "--fit")
              : 150,
      );

    it("incident_fit_is_min_over_geometries", async () => {
      const spy = incidentStub();
      try {
        boardHandler = () => res(styledBoard("focus", 4));
        statusHandler = () => res(failing(4, [1]));
        await renderPage();
        await settleSearch();
        expect(screen.getAllByTestId("monitor-panel")).toHaveLength(1);
        // f=1's own geometry fits at 1; the scale comes from bottom:2x1
        expect(fitOf("나")).toBe(settle(fitsH(400)));
        expect(Number(fitOf("나"))).toBeLessThan(Number(settle(fitsH(250))));
      } finally {
        spy.mockRestore();
      }
    });

    it("incident_fit_unchanged_when_fail_count_changes", async () => {
      const spy = incidentStub();
      try {
        boardHandler = () => res(styledBoard("focus", 4));
        statusHandler = () => res(failing(4, [1]));
        await renderPage();
        await settleSearch();
        const atOne = fitOf("나");
        expect(Number(atOne)).toBeLessThan(1);
        statusHandler = () => res(failing(4, [0, 2]));
        await tick(1000);
        await settleSearch();
        expect(screen.getAllByTestId("monitor-panel")).toHaveLength(2);
        expect(fitOf("가")).toBe(atOne);
        expect(fitOf("다")).toBe(atOne);
      } finally {
        spy.mockRestore();
      }
    });

    it("scale_not_keyed_by_results", async () => {
      const spy = incidentStub();
      const incidentProbeReads = () =>
        (spy.mock.contexts as HTMLElement[]).filter(
          (el) =>
            el.getAttribute("data-testid") === "probe-text" &&
            el.closest('[data-testid="incident-probe-layout"]') !== null,
        ).length;
      try {
        boardHandler = () => res(styledBoard("focus", 4));
        statusHandler = () => res(failing(4, [1]));
        await renderPage();
        await settleSearch();
        // the search did measure the incident probes (the count below is not vacuous)
        expect(incidentProbeReads()).toBeGreaterThan(0);
        spy.mockClear();
        // results only: f=1 -> f=2, same titles and settings
        statusHandler = () => res(failing(4, [0, 2]));
        await tick(1000);
        await settleSearch();
        expect(screen.getAllByTestId("monitor-panel")).toHaveLength(2);
        expect(incidentProbeReads()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("strip_cards_share_card_fit", async () => {
      // only the bottom:2 strip (f=2) is too tight for the card text
      const spy = stubLayout(
        () => 150,
        () => 150,
        (g, el) => (g === "bottom:2" ? 200 * scaleOf(el, "--card-fit") : 40),
      );
      try {
        boardHandler = () => res(styledBoard("focus", 4));
        statusHandler = () => res(failing(4, [1]));
        await renderPage();
        await settleSearch();
        const want = settle(cardFitsH(200));
        expect(Number(want)).toBeLessThan(1);
        expect(screen.getAllByTestId("strip-card")).toHaveLength(3);
        for (const t of ["가", "다", "라"]) expect(cardFitOf(t)).toBe(want);
        // another fail count: the remaining cards keep the same card scale
        statusHandler = () => res(failing(4, [0, 2]));
        await tick(1000);
        await settleSearch();
        expect(screen.getAllByTestId("strip-card")).toHaveLength(2);
        for (const t of ["나", "라"]) expect(cardFitOf(t)).toBe(want);
      } finally {
        spy.mockRestore();
      }
    });

    it("strip_cards_share_card_fit_from_status_line_width", async () => {
      // heights fit everywhere; only in the bottom:2 strip (f=2) is the status
      // line (state + ms, one line) wider than the card: 500px at scale 1 in a
      // 380px line box -> fits once 500c <= 380.5
      const spy = stubLayout(() => 150);
      const cardScale = (el: HTMLElement) =>
        Number(
          (
            el.closest('[data-testid="card-probe"]')?.firstElementChild as HTMLElement | null
          )?.style.getPropertyValue("--card-fit") || "1",
        );
      const isStatus = (el: HTMLElement) =>
        el.getAttribute("data-testid") === "card-probe-status" &&
        el.closest("[data-geometry]")?.getAttribute("data-geometry") === "bottom:2";
      const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return isStatus(this) ? 500 * cardScale(this) : 0;
      });
      const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return isStatus(this) ? 380 : 0;
      });
      try {
        boardHandler = () => res(styledBoard("focus", 4));
        statusHandler = () => res(failing(4, [1]));
        await renderPage();
        await settleSearch();
        const want = settle((c) => 500 * c <= 380.5);
        expect(Number(want)).toBeLessThan(1);
        expect(screen.getAllByTestId("strip-card")).toHaveLength(3);
        for (const t of ["가", "다", "라"]) expect(cardFitOf(t)).toBe(want);
      } finally {
        cw.mockRestore();
        sw.mockRestore();
        spy.mockRestore();
      }
    });
  });

  it("toolbar_in_flow_below_panels_not_fixed", async () => {
    await renderPage();
    const bar = screen.getByTestId("monitor-toolbar");
    expect(bar.className).not.toContain("fixed");
    // a strip of the page's flex column after the grid -> never over a panel
    expect(bar.previousElementSibling?.tagName).toBe("MAIN");
  });
});

describe("MonitorDisplayPage latency stats", () => {
  const failRes: Json = {
    at_ms: T,
    verdict: "fail",
    latency_ms: null,
    reason: "HTTP 503",
    detail: null,
    display: [],
  };
  const cfgErr: Json = {
    at_ms: T,
    verdict: "config_error",
    latency_ms: null,
    reason: "시나리오 오류",
    detail: null,
    display: [],
  };

  it("ok panel shows avg and max of visible results", async () => {
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [okResult(2410, T - 2000), okResult(100, T - 1000), okResult(113)]),
        ]),
      );
    await renderPage();
    expect(within(panelEl("결제")).getByTestId("latency-stats")).toHaveTextContent(
      "평균 874 최대 2,410",
    );
  });

  it("stats line is normal weight, only the numbers are bold", async () => {
    await renderPage();
    const line = within(panelEl("결제")).getByTestId("latency-stats");
    expect(line.className).not.toContain("font-bold");
    const nums = [...line.querySelectorAll("b")];
    expect(nums).toHaveLength(2);
    const labels = [...line.querySelectorAll("span")];
    expect(labels).toHaveLength(2);
    labels.forEach((l) => expect(l.closest("b")).toBeNull());
  });

  it("fail panel keeps the line, failures excluded", async () => {
    statusHandler = () =>
      res(
        status([
          panelStatus(P1, [okResult(100, T - 2000), okResult(200, T - 1000), failRes], {
            consecutive_fail: 3,
            fail_since_ms: T - 20_000,
          }),
        ]),
      );
    await renderPage();
    expect(within(panelEl("결제")).getByTestId("latency-stats")).toHaveTextContent(
      "평균 150 최대 200",
    );
  });

  it("config_error and pending panels have no line", async () => {
    boardHandler = () => res(board({}, [panelCfg(), panelCfg({ id: P2, title: "조회" })]));
    statusHandler = () =>
      res(status([panelStatus(P1, [cfgErr]), panelStatus(P2, [])], { started_at_ms: T - 5000 }));
    await renderPage();
    expect(within(panelEl("결제")).queryByTestId("latency-stats")).toBeNull();
    expect(within(panelEl("조회")).queryByTestId("latency-stats")).toBeNull();
  });

  it("off board draws neither the line nor the probe line", async () => {
    boardHandler = () => res(boardStats(false));
    await renderPage();
    expect(screen.queryByTestId("latency-stats")).toBeNull();
    expect(screen.queryByTestId("stats-probe")).toBeNull();
  });

  it("on board has the probe line too", async () => {
    await renderPage();
    expect(screen.getByTestId("latency-stats")).toBeInTheDocument();
    expect(screen.getByTestId("stats-probe")).toBeInTheDocument();
  });

  it("toggle sends PUT, reflects aria-pressed, disabled while busy", async () => {
    let resolve!: (r: Response) => void;
    let sent: unknown = null;
    statsHandler = (init) => {
      sent = JSON.parse(String(init?.body));
      return new Promise<Response>((r) => {
        resolve = r;
      });
    };
    await renderPage();
    const btn = screen.getByRole("button", { name: ko.monitor.toolbarStats });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      btn.click();
    });
    expect(sent).toEqual({ show: false });
    expect(btn).toBeDisabled();
    // the server bumped updated_at; polls and re-reads now agree with the answer
    boardHandler = () => res(boardStats(false, 2));
    statusHandler = () => res(status([panelStatus(P1, [okResult(413)])], { board_updated_at: 2 }));
    await act(async () => {
      resolve(res(boardStats(false, 2)));
    });
    await tick(10);
    const after = screen.getByRole("button", { name: ko.monitor.toolbarStats });
    expect(after).toHaveAttribute("aria-pressed", "false");
    expect(after).not.toBeDisabled();
    expect(screen.queryByTestId("latency-stats")).toBeNull();
  });

  it("toggle failure shows statsError", async () => {
    statsHandler = () => Promise.resolve(res({ error: "boom" }, 500));
    await renderPage();
    await act(async () => {
      screen.getByRole("button", { name: ko.monitor.toolbarStats }).click();
    });
    await tick(10);
    expect(screen.getByRole("alert").textContent).toContain("평균·최대 표시를 바꾸지 못했습니다");
  });

  it("fill style: stats text uses the ink colour", async () => {
    boardHandler = () => res(boardStats(true, 1, "fill"));
    await renderPage();
    const ink = within(panelEl("결제")).getByRole("heading", { name: "결제" }).style.color;
    const line = within(panelEl("결제")).getByTestId("latency-stats");
    const parts = [...line.querySelectorAll<HTMLElement>("span, b")];
    expect(parts.length).toBe(4);
    parts.forEach((el) => expect(el.style.color).toBe(ink));
  });
});

describe("MonitorDisplayPage display items", () => {
  const TEXT = "rgb(242, 245, 248)"; // COLOR.text
  const SOFT = "rgb(203, 213, 225)"; // COLOR.soft
  const okWith = (latency: number, display: (string | null)[]): Json => ({
    ...okResult(latency),
    display,
  });
  const failWith = (display: (string | null)[]): Json => ({
    at_ms: T,
    verdict: "fail",
    latency_ms: null,
    reason: "HTTP 503",
    detail: null,
    display,
  });
  function setup(items: Json[], results: Json[], over: Json = {}, cfg: Json = {}) {
    boardHandler = () => res(board({}, [panelCfg({ display_items: items, ...cfg })]));
    statusHandler = () => res(status([panelStatus(P1, results, over)]));
  }
  const failOver = { consecutive_fail: 3, fail_since_ms: T - 20_000 };
  const panel = () => within(panelEl("결제"));
  const left = () => within(panel().getByTestId("split-left"));

  it("two_items_ok_panel_splits_values_left_latency_right", async () => {
    setup([ITEM1, ITEM2], [okWith(132, ["0000", "정상 처리되었습니다"])]);
    await renderPage();
    const row = panel().getByTestId("split-row");
    expect(row.style.display).toBe("grid");
    expect(row.style.gridTemplateColumns).toBe("minmax(0,1fr) minmax(0,1fr)");
    const big = left().getByText("0000");
    const small = left().getByText("정상 처리되었습니다");
    expect(big.className).toContain("truncate");
    expect(big.className).toContain("text-left");
    expect(big.className).toContain("font-black");
    expect(big.style.color).toBe(TEXT);
    expect(small.className).toContain("truncate");
    expect(small.className).toContain("text-left");
    expect(small.style.color).toBe(SOFT);
    const right = within(panel().getByTestId("split-right"));
    const ms = right.getByText("132 ms");
    expect(ms.className).toContain("text-right");
    expect(right.getByTestId("latency-stats")).toHaveTextContent("평균 132 최대 132");
    // the latency is drawn once, inside the split row (no full-width line)
    expect(panel().getAllByText("132 ms")).toHaveLength(1);
    // the avg/max stats line is drawn exactly once (split row owns it; no second full-width line)
    expect(panel().getAllByTestId("latency-stats")).toHaveLength(1);
  });

  it("one_item_left_has_one_line", async () => {
    setup([ITEM1], [okWith(132, ["0000"])]);
    await renderPage();
    expect(panel().getByTestId("split-left").children).toHaveLength(1);
    expect(left().getByText("0000")).toBeInTheDocument();
  });

  it("missing_display_index_renders_dash", async () => {
    // items were just added in the settings: the latest result predates them
    setup([ITEM1, ITEM2], [okWith(132, [])]);
    await renderPage();
    expect(left().getAllByText(ko.monitor.noValue)).toHaveLength(2);
  });

  it("null_and_empty_values_render_dash", async () => {
    setup([ITEM1, ITEM2], [okWith(132, [null, ""])]);
    await renderPage();
    expect(left().getAllByText(ko.monitor.noValue)).toHaveLength(2);
  });

  it("slow_panel_left_value_keeps_text_colour", async () => {
    setup(
      [ITEM1, ITEM2],
      [okWith(1407, ["0000", "정상"])],
      {},
      { thresholds: [{ ms: 1200, color: "#fb923c" }] },
    );
    await renderPage();
    expect(panel().getByText(ko.monitor.stateSlow)).toBeInTheDocument();
    expect(panel().getByText("1,407 ms").style.color).toBe("rgb(251, 146, 60)");
    expect(left().getByText("0000").style.color).toBe(TEXT);
    expect(left().getByText("정상").style.color).toBe(SOFT);
  });

  it("no_items_panel_has_no_split_row", async () => {
    await renderPage();
    expect(panel().queryByTestId("split-row")).toBeNull();
    expect(panel().getByText("413 ms")).toBeInTheDocument();
  });

  it("fail_item_panel_shows_display_line_under_consecutive", async () => {
    setup([ITEM1, ITEM2], [failWith(["E1023", "세션이 만료되었습니다"])], failOver);
    await renderPage();
    expect(panel().queryByTestId("split-row")).toBeNull();
    expect(panel().getByText("HTTP 503")).toBeInTheDocument();
    const line = panel().getByTestId("display-line");
    expect(line).toHaveTextContent(/^E1023 세션이 만료되었습니다$/);
    expect(line.className).toContain("truncate");
    expect(line.className).toContain("text-left");
    const v0 = line.querySelector("b");
    expect(v0?.textContent).toBe("E1023");
    expect(v0?.style.color).toBe(TEXT);
    expect(line.querySelector("span")?.style.color).toBe(SOFT);
    const consecutive = panel().getByText(ko.monitor.consecutive(3, "14:31:50"));
    expect(
      consecutive.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("fail_one_item_shows_v0_only", async () => {
    setup([ITEM1], [failWith(["E1023"])], failOver);
    await renderPage();
    expect(panel().getByTestId("display-line")).toHaveTextContent(/^E1023$/);
  });

  it("fail_no_drawable_value_omits_display_line", async () => {
    setup([ITEM1, ITEM2], [failWith([null, ""])], failOver);
    await renderPage();
    expect(panel().getByText("HTTP 503")).toBeInTheDocument();
    expect(panel().queryByTestId("display-line")).toBeNull();
  });

  it("fail_empty_display_omits_display_line", async () => {
    setup([ITEM1, ITEM2], [failWith([])], failOver);
    await renderPage();
    expect(panel().queryByTestId("display-line")).toBeNull();
  });

  it("fail_partly_missing_values_show_dash_in_their_slot", async () => {
    setup([ITEM1, ITEM2], [failWith([null, "세션이 만료되었습니다"])], failOver);
    await renderPage();
    expect(panel().getByTestId("display-line")).toHaveTextContent(/^— 세션이 만료되었습니다$/);
  });

  it("fail_second_value_missing_shows_dash_after_first", async () => {
    setup([ITEM1, ITEM2], [failWith(["E1023", null])], failOver);
    await renderPage();
    expect(panel().getByTestId("display-line")).toHaveTextContent(/^E1023 —$/);
  });

  it("config_error_item_panel_has_no_values", async () => {
    setup(
      [ITEM1, ITEM2],
      [
        {
          at_ms: T,
          verdict: "config_error",
          latency_ms: null,
          reason: "시나리오 오류",
          detail: null,
          display: ["X-CODE", "X-MSG"],
        },
      ],
    );
    await renderPage();
    expect(panel().queryByTestId("split-row")).toBeNull();
    expect(panel().queryByTestId("display-line")).toBeNull();
    expect(panel().queryByText("X-CODE")).toBeNull();
  });

  it("item_panel_probe_has_no_fit_line", async () => {
    // D2.17: an item panel's probe never reaches the board-wide `--fit` with
    // a full-width big value or stats line — only title/state + the split grid
    setup([ITEM1, ITEM2], [okWith(132, ["0000", "정상"])]);
    await renderPage();
    const text = screen.getByTestId("probe-text");
    expect(text.querySelectorAll("[data-fit-line]")).toHaveLength(0);
    expect(text.querySelectorAll("[data-split-probe]")).toHaveLength(2);
    const split = within(text).getByTestId("probe-split");
    const fillers = [...within(split).getByTestId("probe-split-left").children];
    expect(fillers).toHaveLength(2);
    fillers.forEach((el) => {
      expect(el.textContent).toBe("\u00a0");
      expect((el as HTMLElement).style.color).toBe("transparent");
    });
    // no live value reaches the probe
    expect(within(text).queryByText("0000")).toBeNull();
  });

  it("split_stats_gap_shrinks_with_split_fit", async () => {
    // The 평균 N → 최대 gap must scale with --split-fit like the text: the split
    // scale is measured on the full-size probe (text + 3cqw), so a fixed gap
    // overflows the half at any scale < 1 (xlarge × 30 s -> "최대 30,0…").
    boardHandler = () =>
      res(board({}, [panelCfg({ display_items: [ITEM1] }), panelCfg({ id: P2, title: "조회" })]));
    statusHandler = () =>
      res(status([panelStatus(P1, [okWith(132, ["0000"])]), panelStatus(P2, [okResult(413)])]));
    await renderPage();
    const gapOf = (line: Element) => line.querySelectorAll("span")[1].style.marginLeft;
    const split = within(panel().getByTestId("split-right")).getByTestId("latency-stats");
    expect(gapOf(split)).toBe("calc(3cqw * var(--split-fit, 1))");
    // jsdom's CSS parser drops a plain `3cqw` margin (unknown unit) but keeps a
    // calc() with var(), so the plain-gap lines are pinned as "no --split-fit":
    // the full-width line (measured for --fit) and the split probe (measured at
    // full size, where --split-fit is not applied) must not take the scaled gap
    expect(gapOf(within(panelEl("조회")).getByTestId("latency-stats"))).not.toContain(
      "--split-fit",
    );
    const probe = document.querySelector('[data-split-probe][data-testid="stats-probe"]');
    expect(probe).not.toBeNull();
    expect(gapOf(probe!)).not.toContain("--split-fit");
  });

  it("item_panel_probe_split_lines_follow_stats_flag", async () => {
    boardHandler = () =>
      res(
        board({
          config: {
            ...(board().config as Json),
            show_latency_stats: false,
            panels: [panelCfg({ display_items: [ITEM1] })],
          },
        }),
      );
    await renderPage();
    const text = screen.getByTestId("probe-text");
    expect(text.querySelectorAll("[data-split-probe]")).toHaveLength(1);
    expect(within(text).getByTestId("probe-split-left").children).toHaveLength(1);
    expect(text.querySelectorAll("[data-fit-line]")).toHaveLength(0);
  });

  it("no_items_probe_keeps_full_width_lines", async () => {
    await renderPage();
    const text = screen.getByTestId("probe-text");
    expect(within(text).queryByTestId("probe-split")).toBeNull();
    expect(text.querySelectorAll("[data-split-probe]")).toHaveLength(0);
    expect(text.querySelectorAll("[data-fit-line]").length).toBeGreaterThanOrEqual(2);
  });

  it("fill_style_split_row_and_display_line_use_ink", async () => {
    boardHandler = () =>
      res(
        board({
          config: {
            ...(board().config as Json),
            display_style: "fill",
            panels: [panelCfg({ display_items: [ITEM1, ITEM2] })],
          },
        }),
      );
    statusHandler = () => res(status([panelStatus(P1, [okWith(132, ["0000", "정상"])])]));
    await renderPage();
    const ink = panel().getByRole("heading", { name: "결제" }).style.color;
    expect(left().getByText("0000").style.color).toBe(ink);
    expect(left().getByText("정상").style.color).toBe(ink);
    expect(panel().getByText("132 ms").style.color).toBe(ink);
  });

  it("fill_style_fail_display_line_uses_ink", async () => {
    boardHandler = () =>
      res(
        board({
          config: {
            ...(board().config as Json),
            display_style: "fill",
            panels: [panelCfg({ display_items: [ITEM1, ITEM2] })],
          },
        }),
      );
    statusHandler = () => res(status([panelStatus(P1, [failWith(["E1023", "만료"])], failOver)]));
    await renderPage();
    const ink = panel().getByRole("heading", { name: "결제" }).style.color;
    const line = panel().getByTestId("display-line");
    expect(line.querySelector("b")?.style.color).toBe(ink);
    expect(line.querySelector("span")?.style.color).toBe(ink);
  });
});
