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
    conditions: [],
    ...over,
  };
}
function board(over: Json = {}, panels: Json[] = [panelCfg()]): Json {
  return {
    id: BID,
    name: "운영실 화면",
    config: { font_scale: "large", display_style: "border", blink: "fail", panels },
    enabled: true,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}
function okResult(latency: number, at = T): Json {
  return { at_ms: at, verdict: "ok", latency_ms: latency, reason: null, detail: null };
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
          panelStatus(
            P1,
            [{ at_ms: T, verdict: "fail", latency_ms: null, reason: "HTTP 503", detail: null }],
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
    const fail = { at_ms: T, verdict: "fail", latency_ms: null, reason: "HTTP 503", detail: null };
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
    };
    const fillBoard = (style: string, panels: Json[] = [panelCfg()], over: Json = {}) =>
      board(
        {
          ...over,
          config: { font_scale: "large", display_style: style, blink: "off", panels },
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
   * `probeH(title)` gives that panel's settings-only probe height (worst-case
   * state + one-line value). Read via getBoundingClientRect after each render.
   */
  function stubLayout(
    liveH: (title: string, el: HTMLElement) => number,
    probeH: (title: string, el: HTMLElement) => number = () => 150,
  ) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const id = this.getAttribute("data-testid");
      const rect = (w: number, h: number) =>
        ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 }) as DOMRect;
      if (id === "monitor-panel" || id === "panel-probe") return rect(300, 300);
      if (id === "panel-text") {
        const title = this.closest("article")?.getAttribute("aria-label") ?? "";
        return rect(300, liveH(title, this));
      }
      if (id === "probe-text") {
        const title = this.closest("[data-title]")?.getAttribute("data-title") ?? "";
        return rect(300, probeH(title, this));
      }
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
          panelStatus(P1, [{ at_ms: T, verdict, latency_ms: null, reason, detail }], {
            consecutive_fail: 1,
            fail_since_ms: T,
          }),
        ]),
      );
  }

  it("condition_fail_shows_value_big_and_detail_small", async () => {
    failStatus("a · b", "resultCode · 같음 0000 · 로그인");
    await renderPage();
    const a = panelEl("결제");
    const big = within(a).getByText("a · b");
    expect(big.className).toContain("whitespace-nowrap");
    const small = within(a).getByText("resultCode · 같음 0000 · 로그인");
    expect(small.className).toContain("truncate");
    expect(small).not.toBe(big);
  });

  it("not_contained_reason_keeps_tail_span", async () => {
    failStatus('"OK" 포함 안 됨', "본문 전체 · 포함 OK");
    await renderPage();
    const row = within(panelEl("결제")).getByTestId("reason-not-contained");
    const needle = within(row).getByText("OK");
    const tail = within(row).getByText('" 포함 안 됨');
    expect(needle).not.toBe(tail);
    expect(tail.className).toContain("shrink-0");
    expect(needle.className).toContain("truncate");
    expect(within(panelEl("결제")).getByText("본문 전체 · 포함 OK")).toBeInTheDocument();
  });

  it("condition_config_error_shows_detail", async () => {
    failStatus("조건 기준 스텝 없음", "status · 같음 200", "config_error");
    await renderPage();
    const a = panelEl("결제");
    expect(within(a).getByText(ko.monitor.stateConfigError)).toBeInTheDocument();
    expect(within(a).getByText("조건 기준 스텝 없음")).toBeInTheDocument();
    expect(within(a).getByText("status · 같음 200")).toBeInTheDocument();
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

  it("toolbar_in_flow_below_panels_not_fixed", async () => {
    await renderPage();
    const bar = screen.getByTestId("monitor-toolbar");
    expect(bar.className).not.toContain("fixed");
    // a strip of the page's flex column after the grid -> never over a panel
    expect(bar.previousElementSibling?.tagName).toBe("MAIN");
  });
});
