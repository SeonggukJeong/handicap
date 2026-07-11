import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const fetchMock = vi.fn();
let putShouldFail = false;
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
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

const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = { id: "S1", name: "demo", yaml: DEMO_YAML, version: 1, created_at: 0, updated_at: 0 };
const CLONED = { ...DEMO, id: "S2", name: "demo (copy)" };

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    if (putShouldFail) return jsonResponse({ error: "save boom" }, 500);
    const sent = JSON.parse(String(init?.body)) as { yaml: string };
    return jsonResponse({ ...DEMO, yaml: sent.yaml, version: 2 });
  }
  if (url.endsWith("/api/scenarios") && method === "POST") return jsonResponse(CLONED, 201);
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
  const router = createMemoryRouter(
    [
      { path: "/scenarios/:id", element: <ScenarioEditPage /> },
      { path: "/scenarios/:id/runs", element: <div>RUNS</div> },
      // 복제 목적지 stub — 정적 세그먼트가 ":id"보다 우선 매치(기존 clone 테스트와 동일 기법).
      // 실 페이지로 두면 GET /api/scenarios/S2 목까지 필요해져 stub이 간결.
      { path: "/scenarios/S2", element: <h1>demo (copy)</h1> },
    ],
    { initialEntries: ["/scenarios/S1"] },
  );
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

async function loadAndMakeDirty(user: ReturnType<typeof userEvent.setup>) {
  renderPage();
  await screen.findByRole("heading", { name: "demo" });
  await act(async () => {}); // EditorShell 마운트 이펙트 flush (dirty 테스트 이디엄)
  act(() => {
    useScenarioEditor.getState().addStep("새 스텝");
  });
  await waitFor(() => expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled());
  return user;
}

describe("ScenarioEditPage 이탈 가드", () => {
  it("dirty에서 실행 목록 링크 클릭 → 3버튼 다이얼로그, 잔류 (R1·R2)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    expect(await screen.findByRole("dialog", { name: ko.editor.unsavedTitle })).toBeInTheDocument();
    expect(screen.getByText(ko.editor.unsavedBodyEdit)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveCancel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveDiscard })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.leaveSave })).toBeInTheDocument();
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
  });

  it("취소 → 잔류, 다이얼로그 닫힘", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveCancel }));
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
  });

  it("저장 안 하고 이동 → PUT 없이 이동", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveDiscard }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PUT");
    expect(putCall).toBeUndefined();
  });

  it("저장 후 이동 → PUT 성공 후 이동 (R2)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveSave }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === "PUT");
    expect(putCall).toBeTruthy();
  });

  it("저장 실패 → 잔류·다이얼로그 닫힘·에러 Callout 노출 (R6)", async () => {
    putShouldFail = true;
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    await user.click(await screen.findByRole("button", { name: ko.editor.leaveSave }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: ko.editor.unsavedTitle }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("RUNS")).not.toBeInTheDocument();
    expect(await screen.findByText(/save boom/)).toBeInTheDocument();
  });

  it("dirty에서 복제(저장 없이) → 가드 이중 프롬프트 없이 이동 (R5 bypass)", async () => {
    const user = await loadAndMakeDirty(userEvent.setup());
    await user.click(screen.getByRole("button", { name: ko.pages.duplicateBtn }));
    // 복제 자체 확인 다이얼로그(기존)에서 "저장 없이 복제"
    await user.click(await screen.findByRole("button", { name: "저장 없이 복제" }));
    // 가드 다이얼로그 개입 없이 S2 stub에 도착(이 하니스는 정적 stub 라우트라 페이지가
    // 언마운트된다 — param-only 생존·seededId 리시드·잔존 플래그 회귀는 훅 테스트
    // (useUnsavedGuard.test "clean 이동도 armed 플래그를 소비")가 커버, 중복 아님).
    await screen.findByRole("heading", { name: "demo (copy)" });
    expect(screen.queryByRole("dialog", { name: ko.editor.unsavedTitle })).not.toBeInTheDocument();
  });

  it("clean이면 실행 목록 이동이 무프롬프트다 (R4)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    await user.click(screen.getByRole("button", { name: ko.pages.runsBtn }));
    expect(await screen.findByText("RUNS")).toBeInTheDocument();
  });
});
