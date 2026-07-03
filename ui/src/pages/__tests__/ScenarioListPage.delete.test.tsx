import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();
let confirmSpy: MockInstance<(message?: string) => boolean>;
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  confirmSpy = vi.spyOn(window, "confirm");
});
afterEach(() => {
  confirmSpy.mockRestore();
  vi.unstubAllGlobals();
});

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

/** DELETE 응답 시퀀스를 주입하는 fetch 라우터. */
function routeFetch(deleteResponses: Response[]) {
  return (url: string, init?: RequestInit): Response => {
    const method = init?.method ?? "GET";
    if (method === "DELETE" && url.includes("/api/scenarios/S1")) {
      const next = deleteResponses.shift();
      if (!next) throw new Error("unexpected extra DELETE");
      return next;
    }
    if (url.endsWith("/api/scenarios") && method === "GET")
      return jsonResponse({ scenarios: [DEMO] });
    return jsonResponse({ error: "unexpected" }, 500);
  };
}

function renderPage(deleteResponses: Response[]) {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(deleteResponses)(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const deleteCalls = () =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");

const listCalls = () =>
  fetchMock.mock.calls.filter(
    (c) =>
      String(c[0]).endsWith("/api/scenarios") &&
      ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET",
  );

describe("ScenarioListPage delete", () => {
  it("참조 0: 1차 confirm 후 즉시 삭제 (force 없이 1회 호출)", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([new Response(null, { status: 204 })]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(String(deleteCalls()[0][0])).not.toContain("force");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(ko.pages.deleteConfirm("demo"));
    // deleted:true → ["scenarios"] invalidate → 목록 재페치 (R5 invalidate 조건)
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
  });

  it("1차 confirm 거절 시 호출 0", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    renderPage([]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    expect(deleteCalls()).toHaveLength(0);
  });

  it("soft 409 → 참조 요약 2차 confirm → force 재요청", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([
      jsonResponse({ error: "참조", runs: 3, presets: 1, schedules: 0 }, 409),
      new Response(null, { status: 204 }),
    ]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(2));
    expect(String(deleteCalls()[1][0])).toContain("force=true");
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // 0인 항목(schedules)은 요약에서 생략 (spec 엣지 #4)
    const summary = confirmSpy.mock.calls[1][0] as string;
    expect(summary).toContain("run 이력 3건");
    expect(summary).toContain("프리셋 1건");
    expect(summary).not.toContain("스케줄");
  });

  it("2차 confirm 거절 시 force 미호출", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);
    renderPage([jsonResponse({ error: "참조", runs: 1, presets: 0, schedules: 0 }, 409)]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // deleted:false(force 거절) → invalidate 없음 — 초기 목록 GET 1회뿐 (R5)
    expect(listCalls()).toHaveLength(1);
  });

  it("삭제 진행 중엔 행 삭제 버튼 disabled (R6 pending)", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    // 영영 안 끝나는 DELETE — pending 상태 고정
    fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") return new Promise<Response>(() => {});
      return Promise.resolve(routeFetch([])(String(url), init));
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScenarioListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("link", { name: "demo" });

    const btn = screen.getByRole("button", { name: ko.pages.deleteBtn });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it("hard 409 → role=alert 배너에 서버 문구 passthrough", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([jsonResponse({ error: "실행 중 run이 있어 삭제할 수 없습니다" }, 409)]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("실행 중 run이 있어 삭제할 수 없습니다");
  });
});
