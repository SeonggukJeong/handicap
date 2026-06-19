import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/EditorShell", () => ({
  EditorShell: ({ onChange }: { onChange: (s: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange("version: 1\nname: demo\nsteps: []\n")}>
        seed
      </button>
      <button
        type="button"
        onClick={() => onChange("version: 1\nname: demo\nsteps: []\n# edited\n")}
      >
        edit
      </button>
    </div>
  ),
}));
vi.mock("../../components/scenario/TestRunSection", async () => {
  const { forwardRef } = await import("react");
  return {
    TestRunSection: forwardRef(function TestRunSection() {
      return null;
    }),
  };
});

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

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT")
    return jsonResponse({ ...DEMO, version: 2 });
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
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
      <MemoryRouter initialEntries={["/scenarios/S1"]}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function putBody() {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => String(u).endsWith("/api/scenarios/S1") && (i as RequestInit)?.method === "PUT",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

describe("ScenarioEditPage save", () => {
  it("Save PUTs {yaml, version}: the edited buffer + the loaded scenario version (optimistic lock)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "저장" });
    await user.click(screen.getByRole("button", { name: "seed" })); // baseline → not dirty
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty → Save 활성화

    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(putBody()).not.toBeNull());
    // 와이어 1:1 (client.ts:130-133): 정확히 {yaml, version} 두 키.
    expect(putBody()).toEqual({
      yaml: "version: 1\nname: demo\nsteps: []\n# edited\n",
      version: 1,
    });
  });
});
