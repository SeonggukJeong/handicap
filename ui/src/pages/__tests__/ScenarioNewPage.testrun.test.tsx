import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
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
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage test-run", () => {
  it("test-runs the unsaved draft buffer (env + max_requests) and renders the trace", async () => {
    const user = userEvent.setup();
    renderPage();

    // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.blankName) }),
    );

    const runBtn = await screen.findByRole("button", { name: "미리 실행" });
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
    await screen.findByRole("region", { name: /미리 실행 결과/ });

    // header button is gone — only the section button remains
    expect(screen.queryByRole("button", { name: "미리 1회 실행" })).not.toBeInTheDocument();
  });

  it("groups Create and Cancel in the top header row next to the title", async () => {
    const user = userEvent.setup();
    renderPage();

    // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.blankName) }),
    );

    const create = await screen.findByRole("button", { name: ko.editor.create });
    const cancel = screen.getByRole("button", { name: ko.editor.cancel });
    const group = create.closest("div")!;
    expect(group).toContainElement(cancel);
    const header = group.parentElement!;
    expect(header).toHaveClass("justify-between"); // header row, title on the left
    expect(within(header).getByRole("heading", { name: "새 시나리오" })).toBeInTheDocument();
  });

  it("Cancel returns to the list without nagging on an untouched draft", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();

    // U3: 갤러리 단계를 지나야 에디터가 mount된다 — 빈 시나리오 선택
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.blankName) }),
    );

    // 에디터 mount 대기 (baseline은 템플릿 선택 시 선험 확정)
    await screen.findByRole("button", { name: ko.editor.create });
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled(); // untouched → no discard prompt
    expect(await screen.findByText("HOME")).toBeInTheDocument(); // navigated to list
    confirmSpy.mockRestore();
  });
});
