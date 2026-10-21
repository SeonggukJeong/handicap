import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MonitorEditPage } from "../MonitorEditPage";
import { ko } from "../../i18n/ko";

const SID = "01HZZZZZZZZZZZZZZZZZZZZZZ1";
const STEP_A = "01HZZZZZZZZZZZZZZZZZZZZZA1";
const STEP_B = "01HZZZZZZZZZZZZZZZZZZZZZB1";
const YAML = `version: 1
name: 점검
steps:
  - id: ${STEP_A}
    name: 로그인 호출
    type: http
    request:
      method: GET
      url: http://x/a
  - id: ${STEP_B}
    name: 조회 호출
    type: http
    request:
      method: GET
      url: http://x/b
`;
const scenarios = {
  scenarios: [{ id: SID, name: "점검", yaml: YAML, version: 1, created_at: 1, updated_at: 1 }],
};
const environments = {
  environments: [{ id: "E1", name: "staging", var_count: 0, created_at: 1, updated_at: 1 }],
};

function panel(over: Record<string, unknown> = {}) {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZP1",
    title: "결제",
    scenario_id: SID,
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
function board(over: Record<string, unknown> = {}) {
  return {
    id: "B1",
    name: "운영실",
    config: { font_scale: "large", blink: "fail", panels: [panel()] },
    enabled: false,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const fetchMock = vi.fn();
const MS_LABEL = new RegExp(`${ko.monitor.thresholdMs}$`);
type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let handlers: Record<string, (body: unknown) => Response | Promise<Response>> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  handlers = {
    "GET /api/scenarios": () => json(scenarios),
    "GET /api/environments": () => json(environments),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: String(url), body });
    const h = handlers[`${method} ${url}`];
    if (!h) return Promise.resolve(json({ error: `unmocked ${method} ${url}` }, 500));
    return Promise.resolve(h(body));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanFullscreen();
  vi.unstubAllGlobals();
});

function LocationProbe() {
  return <span data-testid="loc">{useLocation().pathname}</span>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/monitors" element={<div>LIST</div>} />
          <Route path="/monitors/new" element={<MonitorEditPage />} />
          <Route path="/monitors/:id" element={<MonitorEditPage />} />
          <Route path="/monitors/:id/display" element={<div>DISPLAY</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const sent = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

function cleanFullscreen() {
  const d = document as unknown as Record<string, unknown>;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  delete d.fullscreenElement;
  delete d.exitFullscreen;
}

describe("MonitorEditPage", () => {
  it("renders_board_fields_and_default_panel", async () => {
    renderAt("/monitors/new");
    expect(await screen.findByLabelText(ko.monitor.boardName)).toBeInTheDocument();
    expect(screen.getAllByLabelText(ko.monitor.interval)).toHaveLength(1);
    expect(screen.getByLabelText(ko.monitor.interval)).toHaveValue(10);
    expect(screen.getByLabelText(ko.monitor.fontScale)).toHaveDisplayValue(
      ko.monitor.fontScaleOptions.large,
    );
    expect(screen.getByLabelText(ko.monitor.blink)).toHaveDisplayValue(
      ko.monitor.blinkOptions.fail,
    );
    expect(screen.queryByLabelText(MS_LABEL)).not.toBeInTheDocument();
  });

  it("interval_is_editable", async () => {
    const user = userEvent.setup();
    handlers["POST /api/monitor-boards"] = () => json(board());
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.type(screen.getByLabelText(ko.monitor.panelTitle), "결제");
    await user.selectOptions(await screen.findByLabelText(ko.monitor.scenario), SID);
    const iv = screen.getByLabelText(ko.monitor.interval);
    await user.clear(iv);
    await user.type(iv, "30");
    await user.click(screen.getByRole("button", { name: ko.monitor.save }));
    await waitFor(() => expect(sent("POST", "/api/monitor-boards")).toHaveLength(1));
    const payload = sent("POST", "/api/monitor-boards")[0].body as {
      name: string;
      config: { panels: { interval_seconds: number }[] };
    };
    expect(payload.name).toBe("운영실");
    expect(payload.config.panels[0].interval_seconds).toBe(30);
  });

  it("thresholds_add_remove_max5", async () => {
    const user = userEvent.setup();
    renderAt("/monitors/new");
    const add = await screen.findByRole("button", { name: ko.monitor.addThreshold });
    for (let i = 0; i < 5; i++) await user.click(add);
    expect(screen.getAllByLabelText(MS_LABEL)).toHaveLength(5);
    expect(add).toBeDisabled();
    await user.click(screen.getByRole("button", { name: `${ko.monitor.thresholds} 1 ${ko.monitor.removeThreshold}` }));
    expect(screen.getAllByLabelText(MS_LABEL)).toHaveLength(4);
    expect(add).toBeEnabled();
  });

  it("advanced_collapsed_with_count_hint", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () =>
      json(
        board({
          config: {
            font_scale: "large",
            blink: "fail",
            panels: [panel({ timeout_seconds: 9, bar_count: 100 })],
          },
        }),
      );
    renderAt("/monitors/B1");
    const toggle = await screen.findByRole("button", { name: new RegExp(ko.monitor.advanced) });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(ko.monitor.advancedSet(2))).toBeInTheDocument();
    expect(screen.queryByLabelText(ko.monitor.timeout)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByLabelText(ko.monitor.timeout)).toHaveValue(9);
    expect(screen.getByLabelText(ko.monitor.barCount)).toHaveValue(100);
  });

  it("advanced_hint_absent_at_defaults", async () => {
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    renderAt("/monitors/B1");
    await screen.findByRole("button", { name: new RegExp(ko.monitor.advanced) });
    expect(screen.queryByText(/개 설정됨/)).not.toBeInTheDocument();
  });

  it("latency_step_options_from_scenario_yaml", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["PUT /api/monitor-boards/B1"] = (b) =>
      json(board({ config: (b as { config: unknown }).config }));
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: new RegExp(ko.monitor.advanced) }));
    const sel = await screen.findByLabelText(ko.monitor.latencySource);
    await waitFor(() =>
      expect(within(sel).getByRole("option", { name: "조회 호출" })).toBeInTheDocument(),
    );
    expect(within(sel).getByRole("option", { name: ko.monitor.latencyTotal })).toBeInTheDocument();
    expect(within(sel).getByRole("option", { name: "로그인 호출" })).toBeInTheDocument();
    await user.selectOptions(sel, "조회 호출");
    await user.click(screen.getByRole("button", { name: ko.monitor.save }));
    await waitFor(() => expect(sent("PUT", "/api/monitor-boards/B1")).toHaveLength(1));
    const p = sent("PUT", "/api/monitor-boards/B1")[0].body as {
      config: { panels: { latency_source: unknown }[] };
    };
    expect(p.config.panels[0].latency_source).toEqual({ kind: "step", step_id: STEP_B });
  });

  it("scenario_required_blocks_save", async () => {
    const user = userEvent.setup();
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.click(screen.getByRole("button", { name: ko.monitor.save }));
    expect(await screen.findByText(ko.monitor.scenarioRequired)).toBeInTheDocument();
    expect(sent("POST", "/api/monitor-boards")).toHaveLength(0);
  });

  it("preview_shows_verdict_and_raw_error", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/preview-check"] = () =>
      json({
        trace: {
          ok: false,
          total_ms: 1350,
          steps: [
            {
              step_id: STEP_A,
              kind: "http",
              loop_index: null,
              branch: null,
              request: null,
              response: {
                status: 503,
                latency_ms: 1350,
                download_ms: null,
                headers: {},
                set_cookies: [],
                body: '{"msg":"down"}',
                body_truncated: false,
              },
              extracted: {},
              unbound_vars: [],
              error: "connection reset by peer",
            },
          ],
          final_vars: {},
          truncated: false,
          error: null,
        },
        result: { at_ms: 1, verdict: "fail", latency_ms: null, reason: "HTTP 503" },
      });
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.preview }));
    expect(await screen.findByText("connection reset by peer")).toBeInTheDocument();
    expect(screen.getByText("503")).toBeInTheDocument();
    expect(screen.getByText("1,350 ms")).toBeInTheDocument();
    expect(screen.getByText("로그인 호출")).toBeInTheDocument();
    expect(screen.getByText('{"msg":"down"}')).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.stateFail)).toBeInTheDocument();
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
  });

  it("preview_without_trace_shows_notice", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/preview-check"] = () =>
      json({
        trace: null,
        result: { at_ms: 1, verdict: "fail", latency_ms: null, reason: "시간 초과(5초)" },
      });
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.preview }));
    expect(await screen.findByText(ko.monitor.previewNoTrace)).toBeInTheDocument();
    expect(screen.getByText("시간 초과(5초)")).toBeInTheDocument();
  });

  it("start_requests_fullscreen_synchronously", async () => {
    const spy = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: spy,
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["PUT /api/monitor-boards/B1"] = async (b) => {
      await new Promise((r) => setTimeout(r, 20));
      return json(board({ name: (b as { name: string }).name }));
    };
    handlers["POST /api/monitor-boards/B1/start"] = () => json(board({ enabled: true }));
    const user = userEvent.setup();
    renderAt("/monitors/B1");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "2");
    fireEvent.click(screen.getByRole("button", { name: ko.monitor.start }));
    // No await / waitFor: the gesture-bound call must already have happened.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("DISPLAY")).toBeInTheDocument();
    expect(sent("PUT", "/api/monitor-boards/B1")).toHaveLength(1);
  });

  it("start_failure_exits_fullscreen_and_shows_error", async () => {
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.documentElement,
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json({ error: "시작 실패 사유" }, 400);
    const user = userEvent.setup();
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("시작 실패 사유")).toBeInTheDocument();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("DISPLAY")).not.toBeInTheDocument();
  });

  it("resave_keeps_panel_ids", async () => {
    const user = userEvent.setup();
    const serverId = "01HZZZZZZZZZZZZZZZZZZZZZP9";
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["PUT /api/monitor-boards/B1"] = (b) => {
      const cfg = (b as { config: { panels: Record<string, unknown>[] } }).config;
      return json(
        board({ config: { ...cfg, panels: cfg.panels.map((p) => ({ ...p, id: serverId })) } }),
      );
    };
    renderAt("/monitors/B1");
    const save = await screen.findByRole("button", { name: ko.monitor.save });
    await user.click(save);
    await waitFor(() => expect(sent("PUT", "/api/monitor-boards/B1")).toHaveLength(1));
    await screen.findByText(ko.monitor.saved);
    await user.click(save);
    await waitFor(() => expect(sent("PUT", "/api/monitor-boards/B1")).toHaveLength(2));
    const ids = sent("PUT", "/api/monitor-boards/B1").map(
      (c) => (c.body as { config: { panels: { id: string }[] } }).config.panels[0].id,
    );
    expect(ids[0]).toBe("01HZZZZZZZZZZZZZZZZZZZZZP1");
    expect(ids[1]).toBe(serverId);
  });

  it("new_board_start_creates_then_starts", async () => {
    const user = userEvent.setup();
    handlers["POST /api/monitor-boards"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json(board({ enabled: true }));
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.type(screen.getByLabelText(ko.monitor.panelTitle), "결제");
    await user.selectOptions(await screen.findByLabelText(ko.monitor.scenario), SID);
    await user.click(screen.getByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("DISPLAY")).toBeInTheDocument();
    const order = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(order).toEqual(["/api/monitor-boards", "/api/monitor-boards/B1/start"]);
  });

  it("server_400_message_shown", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["PUT /api/monitor-boards/B1"] = () =>
      json({ error: "칸 제목은 1~40자여야 합니다" }, 400);
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.save }));
    expect(await screen.findByText("칸 제목은 1~40자여야 합니다")).toBeInTheDocument();
  });

  it("stop_button_shown_when_enabled", async () => {
    const user = userEvent.setup();
    handlers["GET /api/monitor-boards/B1"] = () => json(board({ enabled: true }));
    handlers["POST /api/monitor-boards/B1/stop"] = () => json(board({ enabled: false }));
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.stop }));
    await waitFor(() => expect(sent("POST", "/api/monitor-boards/B1/stop")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: ko.monitor.stop })).not.toBeInTheDocument(),
    );
  });

  it("delete_board_with_confirm", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["DELETE /api/monitor-boards/B1"] = () => new Response(null, { status: 204 });
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.deleteBoard }));
    expect(screen.getByText(ko.monitor.deleteConfirm("운영실"))).toBeInTheDocument();
    expect(sent("DELETE", "/api/monitor-boards/B1")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: ko.monitor.cancel }));
    expect(screen.queryByText(ko.monitor.deleteConfirm("운영실"))).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.monitor.deleteBoard }));
    await user.click(screen.getByRole("button", { name: ko.monitor.deleteConfirmOk }));
    await waitFor(() => expect(sent("DELETE", "/api/monitor-boards/B1")).toHaveLength(1));
    expect(await screen.findByText("LIST")).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
  it("validation_failure_never_requests_fullscreen", async () => {
    const spy = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: spy,
    });
    const user = userEvent.setup();
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.click(screen.getByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText(ko.monitor.scenarioRequired)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("server_failure_exits_fullscreen_after_pending_request_settles", async () => {
    let resolveReq!: () => void;
    const req = new Promise<void>((r) => {
      resolveReq = r;
    });
    let fs: Element | null = null;
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: vi.fn(() => req),
    });
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fs });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json({ error: "빠른 실패" }, 400);
    const user = userEvent.setup();
    renderAt("/monitors/B1");
    await user.click(await screen.findByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("빠른 실패")).toBeInTheDocument();
    // fullscreenElement is still null here: the exit must wait for the request.
    expect(exit).not.toHaveBeenCalled();
    fs = document.documentElement;
    resolveReq();
    await waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it("start_failure_after_create_keeps_board_url_and_error", async () => {
    const user = userEvent.setup();
    handlers["POST /api/monitor-boards"] = () => json(board());
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json({ error: "시작 불가" }, 400);
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.type(screen.getByLabelText(ko.monitor.panelTitle), "결제");
    await user.selectOptions(await screen.findByLabelText(ko.monitor.scenario), SID);
    await user.click(screen.getByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("시작 불가")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/monitors/B1");
    // A retry must update the created board, not create a duplicate.
    handlers["PUT /api/monitor-boards/B1"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json(board({ enabled: true }));
    await user.click(screen.getByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("DISPLAY")).toBeInTheDocument();
    expect(sent("POST", "/api/monitor-boards")).toHaveLength(1);
  });

  it("start_success_replaces_new_url_before_display", async () => {
    const user = userEvent.setup();
    handlers["POST /api/monitor-boards"] = () => json(board());
    handlers["POST /api/monitor-boards/B1/start"] = () => json(board({ enabled: true }));
    renderAt("/monitors/new");
    await user.type(await screen.findByLabelText(ko.monitor.boardName), "운영실");
    await user.type(screen.getByLabelText(ko.monitor.panelTitle), "결제");
    await user.selectOptions(await screen.findByLabelText(ko.monitor.scenario), SID);
    await user.click(screen.getByRole("button", { name: ko.monitor.start }));
    expect(await screen.findByText("DISPLAY")).toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/monitors/B1/display");
  });

  it("missing_board_shows_not_found", async () => {
    handlers["GET /api/monitor-boards/NOPE"] = () => json({ error: "없음" }, 404);
    renderAt("/monitors/NOPE");
    expect(await screen.findByText(ko.monitor.notFound)).toBeInTheDocument();
  });

  it("threshold_rows_have_distinct_accessible_names", async () => {
    const user = userEvent.setup();
    renderAt("/monitors/new");
    const add = await screen.findByRole("button", { name: ko.monitor.addThreshold });
    await user.click(add);
    await user.click(add);
    for (const n of [1, 2]) {
      expect(
        screen.getByLabelText(`${ko.monitor.thresholds} ${n} ${ko.monitor.thresholdMs}`),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `${ko.monitor.thresholds} ${n} ${ko.monitor.removeThreshold}` }),
      ).toBeInTheDocument();
    }
  });

  it("delete_button_disabled_while_busy", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    handlers["GET /api/monitor-boards/B1"] = () => json(board());
    handlers["PUT /api/monitor-boards/B1"] = async () => {
      await gate;
      return json(board());
    };
    renderAt("/monitors/B1");
    const del = await screen.findByRole("button", { name: ko.monitor.deleteBoard });
    await user.click(screen.getByRole("button", { name: ko.monitor.save }));
    await waitFor(() => expect(del).toBeDisabled());
    release();
    await waitFor(() => expect(del).toBeEnabled());
  });
});
