import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

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

const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = {
  id: "S1",
  name: "demo",
  yaml: DEMO_YAML,
  version: 1,
  created_at: 0,
  updated_at: 0,
};

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

describe("ScenarioEditPage 이름 라이브 표시 + 인라인 편집 (R7/R8)", () => {
  it("store에서 name이 바뀌면 h2·브레드크럼이 즉시 갱신", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    // EditorShell의 마운트 이펙트(loadFromString(initialYaml) 자기-재시드)가
    // 위 findByRole 해결 시점에 아직 flush되지 않았을 수 있다 — 그 상태에서
    // 곧장 store를 mutate하면, 나중에 도착하는 그 이펙트가 우리 변경을 덮어쓴다
    // (FlowOutline.test.tsx의 act() 코멘트와 동일 클래스 — 여기선 남은 이펙트를
    // 먼저 비우는 빈 async act로 해소).
    await act(async () => {});

    act(() => {
      useScenarioEditor.getState().setName("renamed");
    });
    await screen.findByRole("heading", { name: "renamed" });
    // h2 + 브레드크럼 둘 다
    expect(screen.getAllByText("renamed").length).toBeGreaterThanOrEqual(2);
  });

  it("연필 → 입력 → Enter 커밋: h2 갱신 + dirty(저장 버튼 enabled)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "새이름{Enter}");

    await screen.findByRole("heading", { name: "새이름" });
    await waitFor(() => expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled());
  });

  it("빈 이름 커밋은 revert — 이름·dirty 무변화", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "   {Enter}");

    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("Escape는 취소 — 입력 닫히고 이름 무변화", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "버릴이름{Escape}");

    await screen.findByRole("heading", { name: "demo" });
    expect(
      screen.queryByRole("textbox", { name: ko.editor.nameInputAria }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("Escape 후 재편집 커밋은 정상 동작 — stale 취소 플래그 없음", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    // 1) 연필 → 입력 → Escape 취소 (기존 "Escape는 취소" 테스트와 동일 시퀀스)
    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    let input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "버릴이름{Escape}");
    await screen.findByRole("heading", { name: "demo" });

    // 2) 다시 연필 → 입력 → Enter 커밋 (정상 rename)
    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "새이름{Enter}");

    // stale nameEscapedRef가 이 커밋을 삼키면 h2가 "demo"로 남는다 — 갱신돼야 함.
    await screen.findByRole("heading", { name: "새이름" });
    await waitFor(() => expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled());
  });

  it("깨진 YAML(model=null)이면 연필 disabled + 서버명 폴백", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    // 위 테스트와 동일 이유의 방어적 flush(EditorShell 마운트 이펙트 잔류 방지).
    await act(async () => {});

    act(() => {
      useScenarioEditor.getState().loadFromString(":: broken [[[");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ko.editor.renameAria })).toBeDisabled(),
    );
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument();
  });
});
