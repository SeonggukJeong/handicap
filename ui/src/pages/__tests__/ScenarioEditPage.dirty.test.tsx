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
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    const sent = JSON.parse(String(init?.body)) as { yaml: string };
    return jsonResponse({ ...DEMO, yaml: sent.yaml, version: 2 });
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [DEMO] });
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage(id = "S1") {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/scenarios/${id}`]}>
          <Routes>
            <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

describe("ScenarioEditPage dirty baseline (false-dirty 회귀, R9)", () => {
  it("로드 직후 무편집이면 저장 버튼 disabled", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("store 편집 후 저장 버튼 enabled, 저장하면 다시 disabled", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    // EditorShell의 마운트 이펙트(loadFromString(initialYaml) 자기-재시드)가
    // 위 findByRole 해결 시점에 아직 flush되지 않았을 수 있다 — 그 상태에서
    // 곧장 store를 mutate하면, 나중에 도착하는 그 이펙트가 우리 변경을 덮어쓴다
    // (ScenarioEditPage.name.test.tsx와 동일 클래스 — 남은 이펙트를 먼저 비우는
    // 빈 async act로 해소).
    await act(async () => {});

    act(() => {
      useScenarioEditor.getState().addStep("새 스텝");
    });
    const save = screen.getByRole("button", { name: ko.common.save });
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(save);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled(),
    );
  });

  it("시드 전 프레임에 stale store 모델 이름이 보이지 않는다 (R7 stale-model)", async () => {
    // 싱글톤 store 잔존물 재현: 다른 시나리오 모델 선주입
    useScenarioEditor.getState().loadFromString("version: 1\nname: other\nsteps: []\n");
    const seenRecords: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      seenRecords.push(...records);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    seenRecords.push(...observer.takeRecords());
    observer.disconnect();
    const sawOther = seenRecords.some(
      (r) =>
        r.oldValue === "other" ||
        Array.from(r.removedNodes).some((n) => n.textContent?.includes("other")),
    );
    expect(sawOther).toBe(false);
  });

  it("존재하지 않는 시나리오 로드 실패 시 오류 Callout(roleless, rounded-md/bg-red-50)", async () => {
    renderPage("S999"); // routeFetch 미매치 → 기본 500 "unexpected"
    const message = await screen.findByText(ko.common.failedToLoad("unexpected"));
    const box = message.closest("div");
    expect(box).not.toBeNull();
    expect(box).toHaveClass("rounded-md");
    expect(box).toHaveClass("bg-red-50");
    expect(box).not.toHaveAttribute("role");
  });
});
