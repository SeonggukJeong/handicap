import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({ TestRunSection: () => null }));

const fetchMock = vi.fn();
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
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
const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = { id: "S1", name: "demo", yaml: DEMO_YAML, version: 1, created_at: 0, updated_at: 0 };
function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
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
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/scenarios/S1"]}>
          <Routes>
            <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

describe("ScenarioEditPage 헤더 접기/펴기 (C)", () => {
  it("접으면 브레드크럼·부제 숨김·제목/저장 유지, 펴면 복귀 + EditorShell cap 배선", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    // 펼침 기본: 부제("updated")·브레드크럼("시나리오") 보임
    expect(screen.getByText(/updated/)).toBeInTheDocument();
    expect(screen.getByText(ko.nav.scenarios)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("editor-grid").className.split(/\s+/)).toContain(
        "h-[calc(100vh-16rem)]",
      ),
    );

    // 접기
    await user.click(screen.getByRole("button", { name: ko.editor.chromeCollapse }));
    expect(screen.queryByText(/updated/)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.nav.scenarios)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument(); // 제목 유지
    expect(screen.getByRole("button", { name: ko.common.save })).toBeInTheDocument(); // 액션 유지
    // 배선: 접힘이 EditorShell grid fill-height를 11rem으로
    await waitFor(() =>
      expect(screen.getByTestId("editor-grid").className.split(/\s+/)).toContain(
        "h-[calc(100vh-11rem)]",
      ),
    );

    // 펴기
    await user.click(screen.getByRole("button", { name: ko.editor.chromeExpand }));
    expect(screen.getByText(/updated/)).toBeInTheDocument();
  });
});
