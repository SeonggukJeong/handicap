import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
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
let cloneShouldFail = false;
function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    return putShould409
      ? jsonResponse({ error: "stale version" }, 409)
      : jsonResponse({ ...DEMO, version: 2 });
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios/S2")) return jsonResponse(COPY);
  if (url.endsWith("/api/scenarios") && method === "POST")
    return cloneShouldFail ? jsonResponse({ error: "clone failed" }, 500) : jsonResponse(COPY, 201);
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
  const router = createMemoryRouter(
    [
      { path: "/scenarios/:id", element: <ScenarioEditPage /> },
      { path: "/scenarios/S2", element: <h1>demo (copy)</h1> },
    ],
    { initialEntries: ["/scenarios/S1"] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
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
    cloneShouldFail = false;
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

  it("복제 실패 시 오류 Callout(alert, 구체 클래스: rounded-md/bg-red-50)", async () => {
    // R1 fix로 즉시경로("not dirty" → void cloneAndGo(...))도 안전해졌다 —
    // cloneAndGo 내부 try/catch가 실패를 흡수하므로 unhandled rejection이 없다.
    const user = userEvent.setup();
    cloneShouldFail = true;
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty

    await user.click(screen.getByRole("button", { name: "복제" }));
    await user.click(await screen.findByRole("button", { name: "저장 후 복제" }));

    const alertBox = await screen.findByRole("alert");
    expect(alertBox).toHaveClass("rounded-md");
    expect(alertBox).toHaveClass("bg-red-50");
    // R2: 열려 있던 확인 모달이 닫혔다(backdrop에 Callout이 안 가림)
    expect(screen.queryByRole("dialog")).toBeNull();
    // R5: "저장 실패" 모달이 아니라(clone 실패를 save 실패로 오분류하지 않음)
    expect(screen.queryByText(/저장에 실패했습니다/)).toBeNull();
  });

  it("not dirty + 복제 실패: unhandled rejection 없이 Callout만 뜬다 (R1)", async () => {
    const user = userEvent.setup();
    cloneShouldFail = true;
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" })); // not dirty

    await user.click(screen.getByRole("button", { name: "복제" }));

    const alertBox = await screen.findByRole("alert");
    expect(alertBox).toHaveTextContent("복제 실패: clone failed");
  });
});
