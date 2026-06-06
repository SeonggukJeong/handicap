import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioListPage } from "../ScenarioListPage";

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

const DEMO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};
const CREATED = {
  ...DEMO,
  id: "S2",
  name: "demo (copy)",
  yaml: "version: 1\nname: demo (copy)\nsteps: []\n",
};

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(CREATED, 201);
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [DEMO] });
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
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioListPage clone", () => {
  it("clones the row's scenario via POST with a (copy)-munged YAML", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.yaml).toContain("name: demo (copy)");
  });

  it("clears stale error banner when cloning again after a failure", async () => {
    const user = userEvent.setup();
    let callCount = 0;
    fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).endsWith("/api/scenarios") && method === "POST") {
        callCount++;
        if (callCount === 1) return Promise.resolve(jsonResponse({ error: "network error" }, 500));
        return Promise.resolve(jsonResponse(CREATED, 201));
      }
      if (String(url).endsWith("/api/scenarios") && method === "GET")
        return Promise.resolve(jsonResponse({ scenarios: [DEMO] }));
      return Promise.resolve(jsonResponse({ error: "unexpected" }, 500));
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScenarioListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole("link", { name: "demo" });

    // first click → error banner appears
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByRole("alert");

    // second click → error banner should be gone immediately (reset before mutate)
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(screen.queryByRole("alert")).toBeNull();

    unmount();
  });
});
