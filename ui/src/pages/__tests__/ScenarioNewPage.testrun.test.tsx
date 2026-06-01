import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioNewPage } from "../ScenarioNewPage";

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

const TRACE = { ok: true, total_ms: 3, truncated: false, error: null, final_vars: {}, steps: [] };

// new page issues: environments list GET (for the picker) + test-run POST. No scenario GET (unsaved draft).
function routeFetch(url: string, init?: RequestInit): Response {
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
      <MemoryRouter initialEntries={["/scenarios/new"]}>
        <Routes>
          <Route path="/scenarios/new" element={<ScenarioNewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage test-run", () => {
  it("test-runs the unsaved draft buffer (env + max_requests) and renders the trace", async () => {
    const user = userEvent.setup();
    renderPage();

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
    // the unsaved STARTER_YAML draft is what gets traced (no Create/save needed)
    expect(body.scenario_yaml).toContain("Untitled");
    expect(body.env).toEqual({});
    expect(body.max_requests).toBe(50);

    // panel rendered
    await screen.findByRole("region", { name: /Test run result/ });
  });

  it("groups Create and Cancel in the top header row next to the title", async () => {
    renderPage();
    const create = await screen.findByRole("button", { name: /Create/ });
    const cancel = screen.getByRole("button", { name: /Cancel/ });
    const group = create.closest("div")!;
    expect(group).toContainElement(cancel);
    const header = group.parentElement!;
    expect(header).toHaveClass("justify-between"); // header row, title on the left
    expect(within(header).getByRole("heading", { name: /New scenario/ })).toBeInTheDocument();
  });
});
