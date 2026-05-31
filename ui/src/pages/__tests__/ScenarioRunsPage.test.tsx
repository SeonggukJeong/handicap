import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioRunsPage } from "../ScenarioRunsPage";

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

const SCENARIO_YAML =
  "version: 1\nname: demo\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: SCENARIO_YAML,
    status: "completed",
    profile: { vus: 4, ramp_up_seconds: 1, duration_seconds: 8, loop_breakdown_cap: 256 },
    env: { BASE_URL: "http://x" },
    started_at: 1,
    ended_at: 2,
    created_at: 1,
    ...over,
  };
}

function mockApi(runOver: Record<string, unknown> = {}, postStatus = 201) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/scenarios/S1") && (!init || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse({
          id: "S1",
          name: "demo",
          yaml: SCENARIO_YAML,
          version: 1,
          created_at: 1,
          updated_at: 1,
        }),
      );
    }
    if (url.endsWith("/api/scenarios/S1/runs")) {
      return Promise.resolve(jsonResponse({ runs: [runRow(runOver)] }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    if (url.endsWith("/api/runs") && init?.method === "POST") {
      return Promise.resolve(
        postStatus >= 400
          ? jsonResponse({ error: "scenario drifted" }, postStatus)
          : jsonResponse(runRow({ id: "R2", status: "pending" }), postStatus),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderPage(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe("ScenarioRunsPage — retry (A1)", () => {
  it("'다시 실행' prefills the dialog from the run row", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    expect(await screen.findByLabelText("VUs")).toHaveValue(4);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
  });

  it("'즉시 재실행' POSTs createRun and navigates to the new run", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    await waitFor(() => expect(screen.getByText("run page")).toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.profile.vus).toBe(4);
    expect(body.env).toEqual({ BASE_URL: "http://x" });
  });

  it("shows the drift warning when the run snapshot differs from the live scenario", async () => {
    const user = userEvent.setup();
    mockApi({ scenario_yaml: SCENARIO_YAML.replace("http://x", "http://OLD") });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/이 run 이후 수정됨/);
  });

  it("auto-opens prefilled when ?retry=<runId> is present", async () => {
    mockApi();
    renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByLabelText("VUs")).toHaveValue(4);
  });

  it("does not re-open the dialog after Cancel when the runs list refetches", async () => {
    const user = userEvent.setup();
    mockApi();
    const { qc } = renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByLabelText("VUs")).toHaveValue(4); // opened via deep-link
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("VUs")).toBeNull()); // closed
    await qc.refetchQueries({ queryKey: ["scenarios", "S1", "runs"] });
    expect(screen.queryByLabelText("VUs")).toBeNull();
  });

  it("surfaces a createRun error from '즉시 재실행'", async () => {
    const user = userEvent.setup();
    mockApi({}, 400);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/scenario drifted/);
  });

  it("does not show the drift warning when the run snapshot matches the live scenario", async () => {
    const user = userEvent.setup();
    mockApi(); // runRow.scenario_yaml === live SCENARIO_YAML — no drift
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    // dialog opened (VUs seeded) but no drift alert because snapshots match
    expect(await screen.findByLabelText("VUs")).toHaveValue(4);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
