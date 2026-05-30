import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RunDetailPage } from "../RunDetailPage";

// jsdom does not implement URL.createObjectURL — DownloadJsonButton in ReportView needs it.
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

    const abortBtn = await screen.findByRole("button", { name: /Abort/i });
    expect(abortBtn).toBeEnabled();

    await user.click(abortBtn);

    await waitFor(() => {
      const stillThere = screen.queryByRole("button", { name: /Abort/i });
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
    expect(screen.queryByRole("button", { name: /Abort/i })).toBeNull();
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

    const stepsRegion = await screen.findByRole("region", { name: /Steps/i });
    expect(stepsRegion).toHaveTextContent("login");
    expect(stepsRegion).toHaveTextContent("POST");
    expect(stepsRegion).toHaveTextContent("${BASE_URL}/login");
    expect(stepsRegion).toHaveTextContent("15"); // total count
    expect(stepsRegion).toHaveTextContent("4"); // total errors
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
        p50_ms: 10,
        p95_ms: 20,
        p99_ms: 30,
      },
      windows: [],
      steps: [],
      status_distribution: { "200": 10 },
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
    await screen.findByRole("region", { name: /Report summary/ });
    // The live "Metric windows" header should not be present in report mode.
    expect(screen.queryByText(/Metric windows/)).toBeNull();
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
    await screen.findByRole("heading", { name: /Metric windows/i });
    const reportCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].endsWith("/api/runs/R10/report"),
    );
    expect(reportCalls.length).toBe(0);
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
    expect(alert).toHaveTextContent(/Report 로드 실패/);
    expect(alert).toHaveTextContent(/boom/);
    // Live sections still render as fallback so the page isn't blank.
    expect(screen.getByRole("heading", { name: /Metric windows/i })).toBeInTheDocument();
  });
});
