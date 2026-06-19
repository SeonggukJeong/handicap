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
vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

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
const COPY = {
  ...DEMO,
  id: "S2",
  name: "demo (copy)",
  yaml: "version: 1\nname: demo (copy)\nsteps: []\n",
};

let putShould409 = false;
function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    return putShould409
      ? jsonResponse({ error: "stale version" }, 409)
      : jsonResponse({ ...DEMO, version: 2 });
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios/S2")) return jsonResponse(COPY);
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(COPY, 201);
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
          <Route path="/scenarios/S2" element={<h1>demo (copy)</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function postBody() {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}
function putCalled() {
  return fetchMock.mock.calls.some(
    ([u, i]) => String(u).endsWith("/api/scenarios/S1") && (i as RequestInit)?.method === "PUT",
  );
}

describe("ScenarioEditPage clone", () => {
  beforeEach(() => {
    putShould409 = false;
  });

  it("not dirty: clones immediately and navigates to the new scenario", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" })); // originalYaml = yamlText → not dirty

    await user.click(screen.getByRole("button", { name: "복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    expect(putCalled()).toBe(false);
    await screen.findByRole("heading", { name: "demo (copy)" }); // navigated to S2
  });

  it("dirty → save then clone: PUTs, then POSTs, then navigates", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 후 복제" }));

    await waitFor(() => expect(putCalled()).toBe(true));
    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    await screen.findByRole("heading", { name: "demo (copy)" });
  });

  it("dirty → clone without saving: POSTs from saved yaml, no PUT", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 없이 복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    expect(putCalled()).toBe(false);
    await screen.findByRole("heading", { name: "demo (copy)" });
  });

  it("dirty → save fails → continue with last saved", async () => {
    const user = userEvent.setup();
    putShould409 = true;
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 후 복제" }));

    // save-failed dialog appears
    await screen.findByText(/저장에 실패했습니다/);
    await user.click(screen.getByRole("button", { name: "저장본으로 복제" }));

    await waitFor(() => expect(postBody()?.yaml).toContain("name: demo (copy)"));
    await screen.findByRole("heading", { name: "demo (copy)" });
  });
});
