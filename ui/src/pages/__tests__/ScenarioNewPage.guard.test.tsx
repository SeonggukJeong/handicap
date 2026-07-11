import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioNewPage } from "../ScenarioNewPage";

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

const CREATED = {
  id: "01HX00000000000000000000ZZ",
  name: "n",
  yaml: "version: 1\nname: n\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/scenarios") && init?.method === "POST") return jsonResponse(CREATED, 201);
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
      { path: "/scenarios/new", element: <ScenarioNewPage /> },
      { path: "/", element: <div>HOME</div> },
      { path: "/scenarios/:id", element: <div>SAVED</div> },
    ],
    { initialEntries: ["/scenarios/new"] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

/** 템플릿 선택 → 에디터 mount 대기 → store 편집으로 dirty 만들기 (dirty 테스트 이디엄) */
async function enterEditorAndMakeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
  await screen.findByRole("button", { name: ko.editor.create }); // 에디터 mount 대기
  await act(async () => {}); // EditorShell 마운트 이펙트 flush (dirty 테스트 이디엄)
  act(() => {
    useScenarioEditor.getState().addStep("새 스텝");
  });
}

describe("ScenarioNewPage 이탈 가드", () => {
  it("dirty에서 취소 클릭 → window.confirm 없이 2버튼 다이얼로그, 잔류 (R1·R3·R8)", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
    expect(screen.getByText(ko.editor.discardConfirm)).toBeInTheDocument(); // 신규용 본문
    expect(screen.getByRole("button", { name: ko.editor.stayEditing })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ko.editor.leaveSave })).not.toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("계속 편집 → 다이얼로그 닫히고 잔류", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    await user.click(await screen.findByRole("button", { name: ko.editor.stayEditing }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument(); // 에디터 유지
  });

  it("버리고 이동 → HOME으로 이동", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    await user.click(await screen.findByRole("button", { name: ko.editor.discardAndLeave }));
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("clean이면 취소가 다이얼로그 없이 즉시 이동한다 (R4)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
    await screen.findByRole("button", { name: ko.editor.create });
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("갤러리 단계에선 가드가 비활성 — 취소 즉시 이동 (R10)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: ko.editor.cancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
  });

  it("dirty여도 만들기 성공 이동은 무프롬프트다 (R5 bypass)", async () => {
    const user = userEvent.setup();
    renderPage();
    await enterEditorAndMakeDirty(user);
    await user.click(screen.getByRole("button", { name: ko.editor.create }));
    expect(await screen.findByText("SAVED")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
  });
});
