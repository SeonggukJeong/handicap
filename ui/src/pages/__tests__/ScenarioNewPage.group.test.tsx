import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioNewPage } from "../ScenarioNewPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const IMPORTED =
  "version: 1\nname: 가져온 흐름\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: 01HX00000000000000000000ZZ\n    name: GET /users\n    type: http\n    request:\n      method: GET\n      url: https://api.example.com/users\n      headers: {}\n    assert: []\n    extract: []\n";

const fetchMock = vi.fn();
let listBroken = false;
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  listBroken = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(b), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (u.endsWith("/api/scenarios") && method === "POST")
      return json(
        {
          id: "N1",
          name: "x",
          yaml: IMPORTED,
          version: 1,
          created_at: 0,
          updated_at: 0,
          group: null,
        },
        201,
      );
    if (u.endsWith("/api/scenarios") && method === "GET") {
      if (listBroken) return json({ weird: true });
      return json({
        scenarios: [
          {
            id: "S9",
            name: "other",
            yaml: IMPORTED,
            version: 1,
            created_at: 0,
            updated_at: 0,
            group: "서비스B",
          },
        ],
      });
    }
    if (u.endsWith("/api/environments")) return json({ environments: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderWith(state: unknown) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: "/scenarios/new", element: <ScenarioNewPage /> },
      { path: "/scenarios/N1", element: <h1>created</h1> },
    ],
    { initialEntries: [{ pathname: "/scenarios/new", state }] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

function postBody() {
  const call = fetchMock.mock.calls.find(
    ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
  );
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

describe("ScenarioNewPage 그룹 버튼", () => {
  it("템플릿 고르기 단계에는 그룹 버튼이 없다", async () => {
    renderWith(undefined);
    await screen.findByRole("region", { name: ko.templates.galleryAria });
    expect(screen.queryByRole("button", { name: ko.scenarioGroups.assign })).toBeNull();
  });

  it("그룹을 정하고 저장하면 POST 본문 group이 그 값", async () => {
    const user = userEvent.setup();
    renderWith({ importedYaml: IMPORTED });
    await user.click(await screen.findByRole("button", { name: ko.scenarioGroups.assign }));
    await user.type(screen.getByLabelText(ko.scenarioGroups.fieldLabel), "서비스C");
    await user.click(screen.getByRole("button", { name: ko.scenarioGroups.apply }));
    await screen.findByRole("button", { name: ko.scenarioGroups.chip("서비스C") });

    await user.click(screen.getByRole("button", { name: ko.editor.create }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect(postBody().group).toBe("서비스C");
  });

  it("그룹을 안 정하면 본문에 group 키가 없다", async () => {
    const user = userEvent.setup();
    renderWith({ importedYaml: IMPORTED });
    await user.click(await screen.findByRole("button", { name: ko.editor.create }));
    await waitFor(() => expect(postBody()).not.toBeNull());
    expect("group" in postBody()).toBe(false);
  });

  it("목록 읽기가 틀린 모양이어도 화면이 동작한다", async () => {
    listBroken = true;
    const user = userEvent.setup();
    renderWith({ importedYaml: IMPORTED });
    await user.click(await screen.findByRole("button", { name: ko.scenarioGroups.assign }));
    expect(screen.getByLabelText(ko.scenarioGroups.fieldLabel)).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ko.common.cancel }),
    );
    await user.click(screen.getByRole("button", { name: ko.editor.create }));
    await waitFor(() => expect(postBody()).not.toBeNull());
  });
});
