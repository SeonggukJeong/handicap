import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioNewPage } from "../ScenarioNewPage";
import { ko } from "../../i18n/ko";

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

// ScenarioSchema는 created_at/updated_at까지 required — 누락 시 Zod가 응답을 거부한다.
const CREATED = {
  id: "01HX00000000000000000000ZZ",
  name: "n",
  yaml: "version: 1\nname: n\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  if (url.endsWith("/api/environments")) return jsonResponse({ environments: [] });
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
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/new"]}>
        <Routes>
          <Route path="/scenarios/new" element={<ScenarioNewPage />} />
          <Route path="/" element={<div>HOME</div>} />
          <Route path="/scenarios/:id" element={<div>SAVED</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioNewPage 템플릿 갤러리 (U3)", () => {
  it("진입 시 에디터 대신 템플릿 4종 카드를 보여준다", async () => {
    renderPage();
    const gallery = await screen.findByRole("region", { name: ko.templates.galleryAria });
    expect(gallery).toHaveTextContent(ko.templates.blankName);
    expect(gallery).toHaveTextContent(ko.templates.getName);
    expect(gallery).toHaveTextContent(ko.templates.loginName);
    expect(gallery).toHaveTextContent(ko.templates.dataName);
    // 에디터(만들기 버튼)는 아직 없다
    expect(screen.queryByRole("button", { name: ko.editor.create })).not.toBeInTheDocument();
  });

  it("템플릿 선택 시 그 YAML이 시드된 에디터로 진입한다 (단순 GET → 헬스체크 노드)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: new RegExp(ko.templates.getName) }));
    // 캔버스(아웃라인) 노드로 스코프 — 테스트 흐름 칩 스트립도 같은 스텝명을 렌더해
    // 텍스트만으로 쿼리하면 다중 매치(FlowOutline row role="option" + 칩)로 충돌한다.
    expect(await screen.findByRole("option", { name: "스텝: 헬스체크" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.editor.create })).toBeInTheDocument();
  });

  it("만들기를 누르면 선택한 템플릿 YAML로 POST /api/scenarios 후 상세로 이동한다", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.loginName) }),
    );
    await user.click(await screen.findByRole("button", { name: ko.editor.create }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/scenarios") && (i as RequestInit)?.method === "POST",
    )!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.yaml).toContain("로그인 흐름");
    expect(body.yaml).toContain("Bearer {{token}}");
    expect(await screen.findByText("SAVED")).toBeInTheDocument();
  });

  it("미수정 템플릿에서 취소해도 confirm이 뜨지 않는다 (baseline 선험 확정)", async () => {
    // chooseTemplate이 store 선적재로 canonical baseline을 확정하므로, 직전 it가
    // store에 다른 시나리오를 남겼어도(싱글톤 잔존물) 가짜 dirty가 나면 안 된다.
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: new RegExp(ko.templates.dataName) }),
    );
    await screen.findByRole("button", { name: ko.editor.create }); // 에디터 mount 대기
    await user.click(screen.getByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("갤러리 화면의 취소는 confirm 없이 목록으로 돌아간다", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await user.click(await screen.findByRole("button", { name: ko.editor.cancel }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
