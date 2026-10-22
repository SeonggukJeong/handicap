import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MonitorDisplayPage } from "../MonitorDisplayPage";
import { ko } from "../../i18n/ko";
import { monitorKey } from "../../monitor/keys";

const BID = "B1";
const T = new Date(2026, 9, 22, 14, 32, 10).getTime();
const pid = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZP${n}`;

type Json = Record<string, unknown>;

function panelCfg(n: number, over: Json = {}): Json {
  return {
    id: pid(n),
    title: `칸${n}`,
    scenario_id: "S1",
    environment_id: null,
    interval_seconds: 10,
    timeout_seconds: 5,
    latency_source: { kind: "total" },
    thresholds: [{ ms: 300, color: "#f90" }],
    bar_count: 60,
    graph_max_ms: 2000,
    conditions: [],
    ...over,
  };
}
function result(verdict: string, latency: number | null, at = T): Json {
  return { at_ms: at, verdict, latency_ms: latency, reason: null, detail: null };
}
function ps(n: number, results: Json[]): Json {
  return { panel_id: pid(n), results, consecutive_fail: 0, fail_since_ms: null, running: false };
}
function res(body: unknown, code = 200): Response {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
  } as unknown as Response;
}

let blink = "fail";
let statusCalls = 0;
let stopCalls = 0;
let stopFail = false;
let stopHang = false;
let boardEnabled = true;
let statusHang = false;
let statusAborts = 0;
let lastQc: QueryClient | null = null;
// 1 fail, 2 slow, 3 config_error, 4 stale (old result), 5 pending, 6 ok
const PANELS = [1, 2, 3, 4, 5, 6].map((n) => panelCfg(n));
const STATUS_PANELS = [
  ps(1, [result("fail", null)]),
  ps(2, [result("ok", 413)]),
  ps(3, [result("config_error", null)]),
  ps(4, [result("ok", 100, T - 600_000)]),
  ps(5, []),
  ps(6, [result("ok", 100)]),
];

let fsEl: Element | null = null;
const requestFs = vi.fn();
const exitFs = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(T + 1000);
  blink = "fail";
  statusCalls = 0;
  stopCalls = 0;
  stopFail = false;
  stopHang = false;
  boardEnabled = true;
  statusHang = false;
  statusAborts = 0;
  lastQc = null;
  fsEl = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fsEl });
  requestFs.mockReset();
  requestFs.mockImplementation(() => {
    fsEl = document.documentElement;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  exitFs.mockReset();
  exitFs.mockImplementation(() => {
    fsEl = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  (document.documentElement as unknown as Json).requestFullscreen = requestFs;
  (document as unknown as Json).exitFullscreen = exitFs;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
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
        return Promise.resolve(
          res({
            now_ms: T + 1000,
            board_updated_at: 1,
            enabled: boardEnabled,
            started_at_ms: T - 5000,
            panels: STATUS_PANELS,
          }),
        );
      }
      if (u === `/api/monitor-boards/${BID}/stop` && init?.method === "POST") {
        stopCalls += 1;
        if (stopHang) return new Promise<Response>(() => {});
        if (stopFail) return Promise.resolve(res({ error: "boom" }, 500));
        return Promise.resolve(
          res({
            id: BID,
            name: "운영실 화면",
            config: { font_scale: "large", display_style: "border", blink, panels: PANELS },
            enabled: false,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      if (u === `/api/monitor-boards/${BID}`) {
        return Promise.resolve(
          res({
            id: BID,
            name: "운영실 화면",
            config: { font_scale: "large", display_style: "border", blink, panels: PANELS },
            enabled: true,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(res({ error: `unmocked ${u}` }, 500));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Json).fullscreenElement;
  delete (document.documentElement as unknown as Json).requestFullscreen;
  delete (document as unknown as Json).exitFullscreen;
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 10 } } });
  lastQc = qc;
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/monitors/${BID}/display`]}>
        <Routes>
          <Route path="/monitors/:id/display" element={<MonitorDisplayPage />} />
          <Route path="/monitors/:id" element={<div>설정 화면</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await tick(50);
  return view;
}

async function setFs(on: boolean) {
  await act(async () => {
    fsEl = on ? document.documentElement : null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
}

const pressF = (init: KeyboardEventInit = {}) =>
  act(async () => {
    fireEvent.keyDown(document.body, { key: "f", ...init });
  });
const box = (n: number) =>
  screen
    .getByRole("article", { name: `칸${n}` })
    .querySelector("[data-testid=panel-box]") as HTMLElement;
const root = () => screen.getByTestId("monitor-display");

describe("MonitorDisplayPage fullscreen", () => {
  it("f_key_toggles", async () => {
    await renderPage();
    await pressF();
    expect(requestFs).toHaveBeenCalledTimes(1);
    await tick(0);
    expect(screen.queryByText(ko.monitor.toolbarFullscreen)).toBeNull();
    await pressF();
    await tick(0);
    expect(exitFs).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ko.monitor.toolbarFullscreen)).toBeInTheDocument();
  });

  it("f_key_ignores_modifiers_and_repeat", async () => {
    await renderPage();
    await pressF({ ctrlKey: true });
    await pressF({ metaKey: true });
    await pressF({ altKey: true });
    await pressF({ repeat: true });
    expect(requestFs).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("any_mouse_button_exits (button %i)", async (button) => {
    await renderPage();
    await setFs(true);
    await act(async () => {
      fireEvent.mouseDown(document.body, { button });
    });
    expect(exitFs).toHaveBeenCalledTimes(1);
  });

  it("mousedown_windowed_does_nothing", async () => {
    await renderPage();
    await act(async () => {
      fireEvent.mouseDown(document.body, { button: 0 });
    });
    expect(exitFs).not.toHaveBeenCalled();
    expect(requestFs).not.toHaveBeenCalled();
  });

  it("mousemove_does_not_exit", async () => {
    await renderPage();
    await setFs(true);
    await act(async () => {
      fireEvent.mouseMove(document.body);
    });
    expect(exitFs).not.toHaveBeenCalled();
  });

  it("contextmenu_prevented_in_fullscreen", async () => {
    await renderPage();
    const windowed = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(windowed);
    expect(windowed.defaultPrevented).toBe(false);
    await setFs(true);
    const full = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(full);
    expect(full.defaultPrevented).toBe(true);
  });

  it("toolbar_only_when_windowed", async () => {
    await renderPage();
    expect(screen.getByText(ko.monitor.toolbarFullscreen)).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.toolbarSettings)).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.stop)).toBeInTheDocument();
    await setFs(true);
    expect(screen.queryByText(ko.monitor.toolbarFullscreen)).toBeNull();
    expect(screen.queryByText(ko.monitor.toolbarSettings)).toBeNull();
    expect(screen.queryByText(ko.monitor.stop)).toBeNull();
    await setFs(false);
    expect(screen.getByText(ko.monitor.toolbarFullscreen)).toBeInTheDocument();
  });

  it("f_key_works_with_korean_ime", async () => {
    await renderPage();
    await pressF({ key: "ㄹ", code: "KeyF" });
    expect(requestFs).toHaveBeenCalledTimes(1);
    await tick(0);
    await pressF({ key: "Process", code: "KeyF" });
    await tick(0);
    expect(exitFs).toHaveBeenCalledTimes(1);
  });

  it("stop_failure_shows_alert_and_busy_guard", async () => {
    stopFail = true;
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent(/^점검을 멈추지 못했습니다: /);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(screen.getByText(ko.monitor.stop)).not.toBeDisabled();
  });

  it("stop_button_disabled_while_pending", async () => {
    stopHang = true;
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    expect(screen.getByText(ko.monitor.stop)).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    expect(stopCalls).toBe(1);
  });

  it("stop_success_updates_board_cache_for_settings_page", async () => {
    await renderPage();
    expect(lastQc!.getQueryData<{ enabled: boolean }>(monitorKey(BID))?.enabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    await tick(0);
    expect(stopCalls).toBe(1);
    expect(lastQc!.getQueryData<{ enabled: boolean }>(monitorKey(BID))?.enabled).toBe(false);
  });

  it("stop_refetch_does_not_abort_in_flight_poll", async () => {
    await renderPage();
    statusHang = true;
    await tick(1000); // a poll is now in flight and never answers
    const before = statusCalls;
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    await tick(0);
    expect(stopCalls).toBe(1);
    expect(statusAborts).toBe(0);
    expect(statusCalls).toBe(before);
  });

  it("stop_button_hidden_when_board_already_stopped", async () => {
    boardEnabled = false;
    await renderPage();
    expect(screen.getByText(ko.monitor.toolbarFullscreen)).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.stop)).toBeNull();
  });

  it("toolbar_buttons_work", async () => {
    await renderPage();
    await act(async () => {
      const b = screen.getByText(ko.monitor.toolbarFullscreen);
      fireEvent.mouseDown(b);
      fireEvent.click(b);
    });
    await tick(0);
    expect(requestFs).toHaveBeenCalledTimes(1);
    expect(exitFs).not.toHaveBeenCalled();
    await setFs(false);
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.stop));
    });
    expect(stopCalls).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByText(ko.monitor.toolbarSettings));
    });
    expect(screen.getByText("설정 화면")).toBeInTheDocument();
  });

  it("cursor_hidden_then_shown_on_move", async () => {
    await renderPage();
    expect(root().style.cursor).not.toBe("none");
    await setFs(true);
    expect(root().style.cursor).not.toBe("none");
    await tick(3000);
    expect(root().style.cursor).toBe("none");
    await act(async () => {
      fireEvent.mouseMove(document.body);
    });
    expect(root().style.cursor).not.toBe("none");
    await tick(2900);
    expect(root().style.cursor).not.toBe("none");
    await tick(200);
    expect(root().style.cursor).toBe("none");
  });

  it("blink_targets", async () => {
    const blinking = () =>
      [1, 2, 3, 4, 5, 6].filter((n) => box(n).getAttribute("data-blink") === "on");
    blink = "off";
    const v0 = await renderPage();
    expect(blinking()).toEqual([]);
    v0.unmount();
    blink = "fail";
    const v1 = await renderPage();
    expect(blinking()).toEqual([1]);
    v1.unmount();
    blink = "slow_and_fail";
    await renderPage();
    expect(blinking()).toEqual([1, 2]);
  });

  it("polling_continues_after_exit", async () => {
    await renderPage();
    await setFs(true);
    await act(async () => {
      fireEvent.mouseDown(document.body, { button: 0 });
    });
    await tick(0);
    const before = statusCalls;
    await tick(3000);
    expect(statusCalls).toBeGreaterThanOrEqual(before + 2);
  });
});
