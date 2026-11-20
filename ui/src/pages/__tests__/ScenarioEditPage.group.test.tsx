import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
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

const YAML = "version: 1\nname: demo\nsteps: []\n";
let server: { id: string; group: string | null; version: number };
let assignFails = false;

function scenario() {
  return {
    id: server.id,
    name: "demo",
    yaml: YAML,
    version: server.version,
    created_at: 0,
    updated_at: 0,
    group: server.group,
  };
}
const OTHER = {
  ...{ id: "S9", name: "other", yaml: YAML, version: 1, created_at: 0, updated_at: 0 },
  group: "서비스B",
};

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenario-groups/assign")) {
    if (assignFails) return jsonResponse({ error: "boom" }, 500);
    server.group = JSON.parse(init!.body as string).group;
    return jsonResponse({ updated: 1 });
  }
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    server.version += 1;
    return jsonResponse(scenario());
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(scenario());
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [scenario(), OTHER] });
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
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

const calls = (frag: string, method?: string) =>
  fetchMock.mock.calls.filter(
    ([u, i]) =>
      String(u).includes(frag) && (method === undefined || (i as RequestInit)?.method === method),
  );

describe("ScenarioEditPage 그룹 버튼", () => {
  beforeEach(() => {
    server = { id: "S1", group: null, version: 1 };
    assignFails = false;
  });

  it("그룹이 없으면 「그룹 지정」", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: ko.scenarioGroups.assign })).toBeVisible();
  });

  it("그룹이 있으면 머리 줄에 chip", async () => {
    server.group = "서비스A";
    renderPage();
    expect(
      await screen.findByRole("button", { name: ko.scenarioGroups.chip("서비스A") }),
    ).toBeVisible();
  });

  it("새 이름 적용 → assign 1회, 저장 버튼 상태 불변·PUT 없음, 버튼이 서버 값 반영", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "seed" }));
    const save = screen.getByRole("button", { name: ko.common.save });
    expect(save).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: ko.scenarioGroups.assign }));
    await user.type(screen.getByLabelText(ko.scenarioGroups.fieldLabel), "서비스C");
    await user.click(screen.getByRole("button", { name: ko.scenarioGroups.apply }));

    await screen.findByRole("button", { name: ko.scenarioGroups.chip("서비스C") });
    const assigns = calls("/api/scenario-groups/assign");
    expect(assigns).toHaveLength(1);
    expect(JSON.parse((assigns[0][1] as RequestInit).body as string)).toEqual({
      scenario_ids: ["S1"],
      group: "서비스C",
    });
    expect(calls("/api/scenarios/S1", "PUT")).toHaveLength(0);
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dirty 상태에서 지정해도 dirty가 유지되고 PUT이 없다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));
    await waitFor(() => expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: ko.scenarioGroups.assign }));
    await user.type(screen.getByLabelText(ko.scenarioGroups.fieldLabel), "서비스C");
    await user.click(screen.getByRole("button", { name: ko.scenarioGroups.apply }));
    await screen.findByRole("button", { name: ko.scenarioGroups.chip("서비스C") });

    expect(calls("/api/scenarios/S1", "PUT")).toHaveLength(0);
    expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled();
  });

  it("실패 응답이면 창 안에 failed(...)가 보이고 창이 열린 채", async () => {
    assignFails = true;
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: ko.scenarioGroups.assign }));
    await user.type(screen.getByLabelText(ko.scenarioGroups.fieldLabel), "서비스C");
    await user.click(screen.getByRole("button", { name: ko.scenarioGroups.apply }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("그룹을 바꾸지 못했습니다");
    expect(screen.getByLabelText(ko.scenarioGroups.fieldLabel)).toBeInTheDocument();
  });

  it("이름을 고치는 동안에도 그룹 버튼이 남아 있다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "seed" }));
    const rename = screen.getByRole("button", { name: ko.editor.renameAria });
    await waitFor(() => expect(rename).toBeEnabled());
    await user.click(rename);
    expect(screen.getByRole("textbox", { name: ko.editor.nameInputAria })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.scenarioGroups.assign })).toBeVisible();
  });

  it("(스모크) 내용을 저장한 뒤에도 chip이 그대로", async () => {
    server.group = "서비스A";
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "seed" }));
    await user.click(screen.getByRole("button", { name: "edit" }));
    const save = screen.getByRole("button", { name: ko.common.save });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(calls("/api/scenarios/S1", "PUT")).toHaveLength(1));
    expect(
      await screen.findByRole("button", { name: ko.scenarioGroups.chip("서비스A") }),
    ).toBeVisible();
  });
});
