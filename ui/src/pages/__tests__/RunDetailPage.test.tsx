import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RunDetailPage } from "../RunDetailPage";
import { ko } from "../../i18n/ko";

// jsdom does not implement URL.createObjectURL — the report's blob download path needs it.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:noop", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
}

function renderWithRouter(runId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/runs/${runId}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RunDetailPage — abort", () => {
  it("shows Abort enabled only when status is running, and posts /abort", async () => {
    let phase = "running";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/R1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: phase,
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: null,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/abort") && init?.method === "POST") {
        phase = "aborted";
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    const user = userEvent.setup();
    renderWithRouter("R1");

    const abortBtn = await screen.findByRole("button", { name: /중단/ });
    expect(abortBtn).toBeEnabled();

    await user.click(abortBtn);

    await waitFor(() => {
      const stillThere = screen.queryByRole("button", { name: /중단/ });
      expect(
        stillThere === null || (stillThere && (stillThere as HTMLButtonElement).disabled),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].endsWith("/api/runs/R1/abort") &&
          c[1]?.method === "POST",
      ),
    ).toBe(true);
  });

  it("hides Abort when status is completed", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R2") || url.endsWith("/api/runs/R2/")) {
        return Promise.resolve(
          jsonResponse({
            id: "R2",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R2/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R2", windows: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderWithRouter("R2");

    await screen.findByText(/completed/i);
    expect(screen.queryByRole("button", { name: /중단/ })).toBeNull();
  });
});

describe("RunDetailPage — step metadata", () => {
  it("renders step name, method, URL, and per-step totals from scenario YAML", async () => {
    const stepId = "01KSP60QVSAZHCVQV6FNFYHJ11";
    const yaml = [
      "version: 1",
      "name: token-auth",
      "cookie_jar: auto",
      "variables: {}",
      "steps:",
      `  - id: ${stepId}`,
      "    name: login",
      "    type: http",
      "    request:",
      "      method: POST",
      "      url: ${BASE_URL}/login",
      "    assert: []",
      "    extract: []",
      "",
    ].join("\n");

    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R3")) {
        return Promise.resolve(
          jsonResponse({
            id: "R3",
            scenario_id: "S1",
            scenario_yaml: yaml,
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
            env: {},
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R3/metrics")) {
        return Promise.resolve(
          jsonResponse({
            run_id: "R3",
            windows: [
              {
                ts_second: 100,
                step_id: stepId,
                count: 10,
                error_count: 3,
                status_counts: { "200": 7, "500": 3 },
              },
              {
                ts_second: 101,
                step_id: stepId,
                count: 5,
                error_count: 1,
                status_counts: { "200": 4, "500": 1 },
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "token-auth",
            yaml,
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderWithRouter("R3");

    const stepsRegion = await screen.findByRole("region", { name: /스텝/ });
    expect(stepsRegion).toHaveTextContent("login");
    expect(stepsRegion).toHaveTextContent("POST");
    expect(stepsRegion).toHaveTextContent("${BASE_URL}/login");
    expect(stepsRegion).toHaveTextContent("15"); // total count
    expect(stepsRegion).toHaveTextContent("4"); // total errors
  });
});

describe("RunDetailPage — retry (A1)", () => {
  function mockTerminalRun() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/R1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "completed",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse({}, 404));
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "x",
            yaml: "version: 1\nname: x\nsteps: []\n",
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "R2",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: x\nsteps: []\n",
              status: "pending",
              profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
              env: { TOKEN: "abc" },
              started_at: null,
              ended_at: null,
              created_at: 3,
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  it("'동일 설정 즉시 재실행' POSTs createRun with this run's profile + env", async () => {
    const user = userEvent.setup();
    mockTerminalRun();
    renderWithRouter("R1");
    await user.click(await screen.findByRole("button", { name: "동일 설정 즉시 재실행" }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body.profile.vus).toBe(6);
      expect(body.env).toEqual({ TOKEN: "abc" });
    });
  });

  it("shows a '다시 실행' link to the run list with ?retry", async () => {
    mockTerminalRun();
    renderWithRouter("R1");
    const link = await screen.findByRole("link", { name: "다시 실행" });
    expect(link).toHaveAttribute("href", "/scenarios/S1/runs?retry=R1");
  });

  it("breadcrumb 에 실행 목록 링크가 있다", async () => {
    mockTerminalRun();
    renderWithRouter("R1");
    // wait for page to load
    await screen.findByRole("button", { name: "동일 설정 즉시 재실행" });
    const bc = screen.getByRole("navigation", { name: ko.breadcrumb.ariaLabel });
    expect(within(bc).getByRole("link", { name: "실행 목록" })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
  });
});

describe("RunDetailPage — save preset (A2)", () => {
  it("saves the run's profile+env as a preset via prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("from-run");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "P1",
              scenario_id: "S1",
              name: "from-run",
              profile: {
                vus: 6,
                duration_seconds: 12,
                ramp_up_seconds: 0,
                loop_breakdown_cap: 256,
              },
              env: { TOKEN: "abc" },
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse({}, 404));
      }
      if (url.endsWith("/api/runs/R1")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "completed",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 12, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "x",
            yaml: "version: 1\nname: x\nsteps: []\n",
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R1");

    await user.click(await screen.findByRole("button", { name: "프리셋으로 저장" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/scenarios/S1/presets") && (i as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.name).toBe("from-run");
      expect(body.profile.vus).toBe(6);
      expect(body.env).toEqual({ TOKEN: "abc" });
    });
    promptSpy.mockRestore();
  });

  it("prompt cancel (null) → no POST fired", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ id: "P1" }, 201));
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse({}, 404));
      }
      if (url.endsWith("/api/runs/R1")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "completed",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 12, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "x",
            yaml: "version: 1\nname: x\nsteps: []\n",
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R1");

    const btn = await screen.findByRole("button", { name: "프리셋으로 저장" });
    await user.click(btn);

    // Button remains present/enabled — use it as a settled signal.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "프리셋으로 저장" })).toBeInTheDocument(),
    );

    const post = fetchMock.mock.calls.find(
      ([u, i]) =>
        String(u).endsWith("/api/scenarios/S1/presets") && (i as RequestInit)?.method === "POST",
    );
    expect(post).toBeFalsy();
    promptSpy.mockRestore();
  });

  it("server 409 → error banner shown", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("dup");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "같은 이름의 프리셋이 이미 있습니다" }, 409));
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse({}, 404));
      }
      if (url.endsWith("/api/runs/R1")) {
        return Promise.resolve(
          jsonResponse({
            id: "R1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: x\nsteps: []\n",
            status: "completed",
            profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 12, loop_breakdown_cap: 256 },
            env: { TOKEN: "abc" },
            started_at: 1,
            ended_at: 2,
            created_at: 1,
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "x",
            yaml: "version: 1\nname: x\nsteps: []\n",
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R1");

    await user.click(await screen.findByRole("button", { name: "프리셋으로 저장" }));

    expect(await screen.findByText(/프리셋 저장 실패/)).toBeInTheDocument();
    promptSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// §7.4 stalled-running banner
// ---------------------------------------------------------------------------

function makeRunningRun(startedAt: number) {
  return {
    id: "SR1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "running",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 30 },
    env: {},
    started_at: startedAt,
    ended_at: null,
    created_at: startedAt,
  };
}

function mockRunningApi(startedAt: number, windowsCount = 0) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/runs/SR1")) {
      return Promise.resolve(jsonResponse(makeRunningRun(startedAt)));
    }
    if (url.endsWith("/api/runs/SR1/metrics")) {
      const windows =
        windowsCount > 0
          ? [
              {
                ts_second: Math.floor(Date.now() / 1000),
                step_id: "step1",
                count: 5,
                error_count: 0,
                status_counts: { "200": 5 },
              },
            ]
          : [];
      return Promise.resolve(jsonResponse({ run_id: "SR1", windows }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

describe("RunDetailPage — stalled running banner (§7.4)", () => {
  it("running + 15초 경과 + 요청 0건이면 진단 배너가 뜬다", async () => {
    mockRunningApi(Date.now() - 20_000, 0);
    renderWithRouter("SR1");
    expect(await screen.findByText(/워커가 시작하지 못했을 수 있습니다/)).toBeInTheDocument();
  });

  it("요청이 있으면 진단 배너가 안 뜬다", async () => {
    mockRunningApi(Date.now() - 20_000, 1);
    renderWithRouter("SR1");
    // Wait for page render to settle (metrics windows section visible)
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/워커가 시작하지 못했을/)).toBeNull();
    expect(screen.queryByText(/진행 없음/)).toBeNull();
  });

  it("15초 미만이면 진단 배너가 안 뜬다", async () => {
    mockRunningApi(Date.now() - 3_000, 0);
    renderWithRouter("SR1");
    // Wait for page render to settle
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/워커가 시작하지 못했을/)).toBeNull();
  });

  it("metrics 응답 도착 전(로딩 중)엔 경과해도 배너가 안 뜬다", async () => {
    // "요청 0건" = 기록된 0건이지 미수신이 아님 — 응답 RTT 동안의 false-positive 플래시 방지
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/SR1")) {
        return Promise.resolve(jsonResponse(makeRunningRun(Date.now() - 20_000)));
      }
      if (url.endsWith("/api/runs/SR1/metrics")) {
        return new Promise(() => {}); // 응답 미도착 상태 고정
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("SR1");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/워커가 시작하지 못했을/)).toBeNull();
  });
});

describe("RunDetailPage — report on terminal", () => {
  it("mounts ReportView when status is completed and report loaded; hides Metric windows", async () => {
    const reportBundle = {
      run: {
        id: "R9",
        scenario_id: "S9",
        status: "completed",
        profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
        env: {},
        started_at: 100,
        ended_at: 102,
        created_at: 99,
      },
      scenario_yaml: "version: 1\nname: x\ncookie_jar: auto\nvariables: {}\nsteps: []\n",
      summary: {
        count: 10,
        errors: 0,
        rps: 5.0,
        duration_seconds: 2,
        mean_ms: 15,
        p50_ms: 10,
        p95_ms: 20,
        p99_ms: 30,
      },
      windows: [],
      steps: [],
      status_distribution: { "200": 10 },
      dropped: 0,
    };
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R9")) {
        return Promise.resolve(
          jsonResponse({
            id: "R9",
            scenario_id: "S9",
            scenario_yaml: reportBundle.scenario_yaml,
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
            env: {},
            started_at: 100,
            ended_at: 102,
            created_at: 99,
          }),
        );
      }
      if (url.endsWith("/api/runs/R9/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R9", windows: [] }));
      }
      if (url.endsWith("/api/runs/R9/report")) {
        return Promise.resolve(jsonResponse(reportBundle));
      }
      if (url.endsWith("/api/scenarios/S9")) {
        return Promise.resolve(
          jsonResponse({
            id: "S9",
            name: "x",
            yaml: reportBundle.scenario_yaml,
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R9");
    await screen.findByRole("region", { name: /리포트 요약/ });
    // The live "Metric windows" header should not be present in report mode.
    expect(screen.queryByText(/메트릭 윈도우/)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("handicap.onboarding.v1")!)).toMatchObject({
      reportViewed: true,
    });
  });

  it("does NOT fetch /report while status is running", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R10")) {
        return Promise.resolve(
          jsonResponse({
            id: "R10",
            scenario_id: "S9",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: "running",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 30 },
            env: {},
            started_at: 100,
            ended_at: null,
            created_at: 99,
          }),
        );
      }
      if (url.endsWith("/api/runs/R10/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R10", windows: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R10");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    const reportCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].endsWith("/api/runs/R10/report"),
    );
    expect(reportCalls.length).toBe(0);
    expect(window.localStorage.getItem("handicap.onboarding.v1")).toBeNull();
  });

  it("surfaces report fetch error as an alert when terminal", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/R11")) {
        return Promise.resolve(
          jsonResponse({
            id: "R11",
            scenario_id: "S9",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: "completed",
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
            env: {},
            started_at: 100,
            ended_at: 102,
            created_at: 99,
          }),
        );
      }
      if (url.endsWith("/api/runs/R11/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R11", windows: [] }));
      }
      if (url.endsWith("/api/runs/R11/report")) {
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R11");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/리포트 로드 실패/);
    expect(alert).toHaveTextContent(/boom/);
    // Live sections still render as fallback so the page isn't blank.
    expect(screen.getByRole("heading", { name: /메트릭 윈도우/ })).toBeInTheDocument();
  });
});

describe("RunDetailPage — mid-run stall banner (G1b)", () => {
  // 요청이 흘렀는데 마지막 메트릭이 오래된(ts_second stale) running run을 mock.
  function mockMidRunApi(lastTsSecond: number) {
    let phase = "running";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/runs/MR1") && (!init || init.method !== "POST")) {
        return Promise.resolve(
          jsonResponse({
            id: "MR1",
            scenario_id: "S1",
            scenario_yaml: "version: 1\nname: t\nsteps: []\n",
            status: phase,
            profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 600 },
            env: {},
            started_at: Date.now() - 300_000,
            ended_at: null,
            created_at: Date.now() - 300_000,
          }),
        );
      }
      if (url.endsWith("/api/runs/MR1/metrics")) {
        return Promise.resolve(
          jsonResponse({
            run_id: "MR1",
            windows: [
              {
                ts_second: lastTsSecond,
                step_id: "step1",
                count: 5,
                error_count: 0,
                status_counts: { "200": 5 },
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/runs/MR1/abort") && init?.method === "POST") {
        phase = "aborted";
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  it("마지막 메트릭이 임계 초과로 오래되면 정지-의심 배너가 뜬다", async () => {
    mockMidRunApi(Math.floor(Date.now() / 1000) - 130); // 침묵 ~130초 > 120
    renderWithRouter("MR1");
    expect(await screen.findByText(/진행 없음/)).toBeInTheDocument();
  });

  it("최근 메트릭이면 정지-의심 배너가 안 뜬다", async () => {
    mockMidRunApi(Math.floor(Date.now() / 1000) - 2); // 침묵 ~2초 < 120
    renderWithRouter("MR1");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/진행 없음/)).toBeNull();
  });

  it("배너의 [중단] 버튼이 abort를 호출한다", async () => {
    const user = userEvent.setup();
    mockMidRunApi(Math.floor(Date.now() / 1000) - 130);
    renderWithRouter("MR1");
    const text = await screen.findByText(/진행 없음/);
    // 헤더에도 "중단" 버튼이 있으므로 배너 영역 안에서만 스코프(R1).
    const banner = text.closest('[role="status"]') as HTMLElement;
    const stopBtn = within(banner).getByRole("button", { name: ko.common.abort });
    await user.click(stopBtn);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            typeof url === "string" &&
            url.endsWith("/api/runs/MR1/abort") &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 곡선 run VU 표시 (R1/R7) — raw 섹션은 running(non-terminal)에서만 렌더
// ---------------------------------------------------------------------------

function makeCurveRunningRun() {
  return {
    id: "CR1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "running",
    profile: {
      vus: 0,
      ramp_up_seconds: 0,
      duration_seconds: 0,
      vu_stages: [
        { target: 5, duration_seconds: 10 },
        { target: 50, duration_seconds: 20 },
        { target: 2, duration_seconds: 5 },
      ],
    },
    env: {},
    started_at: Date.now(),
    ended_at: null,
    created_at: Date.now(),
  };
}

describe("RunDetailPage — 곡선 run VU 표시 (R1/R7)", () => {
  it("닫힌 곡선 running run: VUs 카드 '최대 50 (곡선)' + raw vu_stages 줄", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/runs/CR1"))
        return Promise.resolve(jsonResponse(makeCurveRunningRun()));
      if (url.endsWith("/api/runs/CR1/metrics"))
        return Promise.resolve(jsonResponse({ run_id: "CR1", windows: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("CR1");
    // 주의: 카드 단언은 정확매치 "최대 50 (곡선)" 유지 — `/최대 50/`로 느슨하게 하면 raw
    // 줄("최대 50 · 3단계")까지 다중매치돼 throw(ui/CLAUDE.md "같은 라벨 여럿" 함정).
    expect(await screen.findByText("최대 50 (곡선)")).toBeInTheDocument();
    expect(screen.getByText(/vu_stages = 최대 50 · 3단계/)).toBeInTheDocument();
  });

  it("고정 VU running run: raw vu_stages 줄 없음", async () => {
    mockRunningApi(Date.now() - 1_000, 1);
    renderWithRouter("SR1");
    await screen.findByRole("heading", { name: /메트릭 윈도우/ });
    expect(screen.queryByText(/vu_stages =/)).toBeNull();
  });
});
