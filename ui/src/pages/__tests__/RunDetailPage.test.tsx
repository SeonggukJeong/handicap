import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RunDetailPage } from "../RunDetailPage";

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
    expect(stepsRegion).toHaveTextContent("4");  // total errors
  });
});
