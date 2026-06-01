import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioEditPage } from "../ScenarioEditPage";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SCENARIO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};
const TRACE = { ok: true, total_ms: 4, truncated: false, error: null, final_vars: {}, steps: [] };

// Route fetch by URL: scenario GET, environments list GET, test-run POST.
function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(SCENARIO);
  // listEnvironments parses EnvironmentListSchema = { environments: [...] } — a bare []
  // would fail .parse and error the useEnvironments query (page still renders; picker
  // guards with `?.map`). Return the real DTO shape.
  if (url.endsWith("/api/environments")) return jsonResponse({ environments: [] });
  if (url.endsWith("/api/test-runs") && init?.method === "POST") return jsonResponse(TRACE);
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/S1/edit"]}>
        <Routes>
          <Route path="/scenarios/:id/edit" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioEditPage test-run", () => {
  it("POSTs the current buffer + env + max_requests and renders the trace", async () => {
    const user = userEvent.setup();
    renderPage();

    // wait for the scenario to load (Save button appears)
    await screen.findByRole("button", { name: /Save/ });

    const runBtn = await screen.findByRole("button", { name: /Test run/ });
    await user.click(runBtn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/test-runs") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.scenario_yaml).toContain("name: demo");
    expect(body.env).toEqual({});
    expect(body.max_requests).toBe(50);

    // panel rendered
    await screen.findByRole("region", { name: /Test run result/ });
  });

  it("groups Save, Back and Runs in the top header row next to the title", async () => {
    renderPage();
    const save = await screen.findByRole("button", { name: /Save/ });
    const back = screen.getByRole("button", { name: /Back/ });
    const runs = screen.getByRole("button", { name: /Runs/ });
    const group = save.closest("div")!;
    expect(group).toContainElement(back);
    expect(group).toContainElement(runs); // Runs shares the header action group
    const header = group.parentElement!;
    expect(header).toHaveClass("justify-between"); // header row, title on the left
    expect(within(header).getByRole("heading", { name: "demo" })).toBeInTheDocument();
  });
});
