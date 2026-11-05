import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPrintPage } from "../RunPrintPage";

const STEP_ID = "01HX0000000000000000000001";
const T0 = 1_700_000_000_000;
const GOOD_YAML = [
  "version: 1",
  'name: "주문 흐름"',
  "steps:",
  `  - id: ${STEP_ID}`,
  '    name: "로그인"',
  "    request:",
  "      method: GET",
  '      url: "https://api.example.com/login"',
  "",
].join("\n");

function runBody(status: string, yaml = GOOD_YAML) {
  return {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: yaml,
    status,
    profile: {
      vus: 10,
      ramp_up_seconds: 0,
      duration_seconds: 5,
      loop_breakdown_cap: 256,
      http_timeout_seconds: 30,
    },
    env: null,
    started_at: T0,
    ended_at: T0 + 5000,
    created_at: T0,
    message: null,
    verdict: null,
    last_metric_ts: null,
    label: null,
  };
}

function reportBody(yaml = GOOD_YAML) {
  const sec = Math.floor(T0 / 1000);
  return {
    run: {
      id: "R1",
      scenario_id: "S1",
      status: "completed",
      profile: runBody("completed").profile,
      env: null,
      started_at: T0,
      ended_at: T0 + 5000,
      created_at: T0,
    },
    scenario_yaml: yaml,
    verdict: null,
    summary: {
      count: 50,
      errors: 2,
      rps: 10,
      duration_seconds: 5,
      mean_ms: 20,
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
    windows: [0, 1, 2, 3, 4].map((i) => ({
      ts_second: sec + i,
      step_id: STEP_ID,
      count: 10,
      error_count: i === 3 ? 2 : 0,
      status_counts: i === 3 ? { "200": 8, "500": 2 } : { "200": 10 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    })),
    steps: [
      {
        step_id: STEP_ID,
        count: 50,
        error_count: 2,
        status_counts: { "200": 48, "500": 2 },
        p50_ms: 10,
        p95_ms: 50,
        p99_ms: 90,
        loop_breakdown: [],
      },
    ],
    status_distribution: { "200": 48, "500": 2 },
    dropped: 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

type Opts = {
  status?: string;
  yaml?: string;
  reportStatus?: number;
  scenarioName?: string | null;
};

function mockApi(o: Opts = {}) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/runs/R1")) {
      return Promise.resolve(json(runBody(o.status ?? "completed", o.yaml)));
    }
    if (url.endsWith("/api/runs/R1/report")) {
      if (o.reportStatus && o.reportStatus !== 200) {
        return Promise.resolve(json({ error: "boom" }, o.reportStatus));
      }
      return Promise.resolve(json(reportBody(o.yaml)));
    }
    if (url.endsWith("/api/scenarios/S1")) {
      if (o.scenarioName == null) return Promise.resolve(json({ error: "nf" }, 404));
      return Promise.resolve(
        json({
          id: "S1",
          name: o.scenarioName,
          yaml: GOOD_YAML,
          version: 1,
          created_at: T0,
          updated_at: T0,
        }),
      );
    }
    return Promise.resolve(json({}, 404));
  });
}

function renderPage(path = "/runs/R1/print") {
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

const CHART = { name: "시간에 따른 처리량과 오류 차트" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(window, "isSecureContext");
});

describe("RunPrintPage", () => {
  it("not_terminal_message", async () => {
    mockApi({ status: "running" });
    renderPage();
    expect(await screen.findByText("측정이 끝난 뒤 출력할 수 있습니다")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "돌아가기" })).toHaveAttribute("href", "/runs/R1");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/report"))).toBe(false);
  });

  it("loading_and_error", async () => {
    mockApi({ reportStatus: 500 });
    renderPage();
    expect(screen.getByRole("status")).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("보고서를 불러오지 못했습니다:");
  });

  it("kind_toggle_via_query", async () => {
    mockApi({ scenarioName: "현재이름" });
    const user = userEvent.setup();
    renderPage();
    const std = await screen.findByRole("button", { name: "표준판" });
    expect(std).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("img", CHART)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "요약판" }));
    expect(screen.getByRole("button", { name: "요약판" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "표준판" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(screen.queryByRole("img", CHART)).not.toBeInTheDocument());
  });

  it("kind_initial_summary_and_bogus", async () => {
    mockApi({ scenarioName: "현재이름" });
    const first = renderPage("/runs/R1/print?kind=summary");
    expect(await screen.findByRole("button", { name: "요약판" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    first.unmount();
    renderPage("/runs/R1/print?kind=bogus");
    expect(await screen.findByRole("button", { name: "표준판" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("print_button_calls_window_print", async () => {
    mockApi({ scenarioName: "현재이름" });
    const spy = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "인쇄 / PDF 저장" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe("copy_button_secure_only", () => {
    function setClipboard(writeText: () => Promise<void>) {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    }
    function setSecure(v: boolean) {
      Object.defineProperty(window, "isSecureContext", { value: v, configurable: true });
    }

    it("copies when clipboard + secure", async () => {
      mockApi({ scenarioName: "현재이름" });
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard(writeText);
      setSecure(true);
      renderPage();
      await user.click(await screen.findByRole("button", { name: "주소 복사" }));
      expect(writeText).toHaveBeenCalledWith(window.location.href);
      expect(await screen.findByText("복사했습니다")).toBeInTheDocument();
      expect(screen.getByText(window.location.href, { selector: "code" })).toBeInTheDocument();
    });

    it("hidden when insecure", async () => {
      mockApi({ scenarioName: "현재이름" });
      setClipboard(vi.fn().mockResolvedValue(undefined));
      setSecure(false);
      renderPage();
      await screen.findByRole("button", { name: "인쇄 / PDF 저장" });
      expect(screen.queryByRole("button", { name: "주소 복사" })).not.toBeInTheDocument();
      expect(screen.getByText(window.location.href, { selector: "code" })).toBeInTheDocument();
    });

    it("hidden without clipboard", async () => {
      mockApi({ scenarioName: "현재이름" });
      setSecure(true);
      renderPage();
      await screen.findByRole("button", { name: "인쇄 / PDF 저장" });
      expect(screen.queryByRole("button", { name: "주소 복사" })).not.toBeInTheDocument();
      expect(screen.getByText(window.location.href, { selector: "code" })).toBeInTheDocument();
    });

    it("disappears when writeText rejects", async () => {
      mockApi({ scenarioName: "현재이름" });
      const user = userEvent.setup();
      setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
      setSecure(true);
      renderPage();
      await user.click(await screen.findByRole("button", { name: "주소 복사" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "주소 복사" })).not.toBeInTheDocument(),
      );
      expect(screen.getByText(window.location.href, { selector: "code" })).toBeInTheDocument();
    });
  });

  it("toolbar_inside_root_and_hidden_in_print", async () => {
    mockApi({ scenarioName: "현재이름" });
    renderPage();
    const group = await screen.findByRole("group", { name: "보고서 종류" });
    const bar = group.closest(".p-noprint");
    expect(bar).not.toBeNull();
    expect(bar!.closest(".p-root")).not.toBeNull();
  });

  it("page_rule_style_present", async () => {
    mockApi({ scenarioName: "현재이름" });
    const pageStyles = () =>
      Array.from(document.querySelectorAll("style")).filter(
        (s) =>
          (s.textContent ?? "").includes("@page") && (s.textContent ?? "").includes("size: A4"),
      );
    const { unmount } = renderPage();
    await screen.findByRole("button", { name: "표준판" });
    expect(pageStyles()).toHaveLength(1);
    unmount();
    expect(pageStyles()).toHaveLength(0);
  });

  it("scenario_name_fallback", async () => {
    mockApi({ yaml: "::: [ broken", scenarioName: "현재이름" });
    const first = renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("현재이름 부하 측정").length).toBeGreaterThan(0),
    );
    first.unmount();
    mockApi({ yaml: "::: [ broken", scenarioName: null });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("시나리오 부하 측정").length).toBeGreaterThan(0),
    );
  });
});
