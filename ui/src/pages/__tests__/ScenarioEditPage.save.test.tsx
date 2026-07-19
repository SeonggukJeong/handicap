import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioEditPage } from "../ScenarioEditPage";

// `seed`/`edit`는 이 mock이 한 번에 렌더하므로, 비동기 경계(페이지 로드) 직후 첫 쿼리만
// 노출된다 — `getByRole("seed")`(동기)는 부하 걸린 CI 러너에서 페이지 크롬보다 늦게
// 마운트되는 순간에 걸려 간헐 실패했다(2026-07-20 ci 29708407603, 재실행은 코드 변경
// 없이 green). `findByRole`은 getBy + 재시도라 단언이 약해지지 않는다 — 동기로 되돌리지 말 것.
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
let putShouldFail = false;
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  putShouldFail = false;
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
    return putShouldFail
      ? jsonResponse({ error: "stale version" }, 409)
      : jsonResponse({ ...DEMO, version: 2 });
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
  const router = createMemoryRouter([{ path: "/scenarios/:id", element: <ScenarioEditPage /> }], {
    initialEntries: ["/scenarios/S1"],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
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
    await user.click(await screen.findByRole("button", { name: "seed" })); // baseline → not dirty
    await user.click(screen.getByRole("button", { name: "edit" })); // dirty → Save 활성화

    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(putBody()).not.toBeNull());
    // 와이어 1:1 (client.ts:130-133): 정확히 {yaml, version} 두 키.
    expect(putBody()).toEqual({
      yaml: "version: 1\nname: demo\nsteps: []\n# edited\n",
      version: 1,
    });
  });

  it("저장 실패 시 오류 Callout(roleless, rounded-md/bg-red-50)", async () => {
    const user = userEvent.setup();
    putShouldFail = true;
    renderPage();
    await screen.findByRole("button", { name: "저장" });
    await user.click(await screen.findByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));

    await user.click(screen.getByRole("button", { name: "저장" }));

    const message = await screen.findByText(/stale version/);
    const box = message.closest("div");
    expect(box).not.toBeNull();
    expect(box).toHaveClass("rounded-md");
    expect(box).toHaveClass("bg-red-50");
    expect(box).not.toHaveAttribute("role");
  });
});
