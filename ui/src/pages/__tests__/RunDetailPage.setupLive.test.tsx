import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailPage } from "../RunDetailPage";

const WITH_SETUP = `version: 1
name: x
cookie_jar: auto
variables: {}
setup:
  steps:
    - id: 01HX0000000000000000000S01
      name: s1
      type: http
      request:
        method: GET
        url: http://t/s
steps:
  - id: 01HX0000000000000000000B01
    name: b1
    type: http
    request:
      method: GET
      url: http://t/b
`;
const NO_SETUP = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000B01
    name: b1
    type: http
    request:
      method: GET
      url: http://t/b
`;

const PROFILE = { vus: 50, ramp_up_seconds: 0, duration_seconds: 60 };

let runYaml = WITH_SETUP;
let scenarioYaml = WITH_SETUP;
let status = "running";
let setupLive: unknown = { ok: 37, failed: 2, interrupted: 0 };

const fetchMock = vi.fn();
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/runs/R"]}>
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

beforeEach(() => {
  runYaml = WITH_SETUP;
  scenarioYaml = WITH_SETUP;
  status = "running";
  setupLive = { ok: 37, failed: 2, interrupted: 0 };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/runs/R")) {
      return Promise.resolve(
        json({
          id: "R",
          scenario_id: "S",
          scenario_yaml: runYaml,
          status,
          profile: PROFILE,
          env: {},
          started_at: 100,
          created_at: 99,
          ended_at: status === "completed" ? 400 : null,
          ...(setupLive === undefined ? {} : { setup_live: setupLive }),
        }),
      );
    }
    if (url.endsWith("/api/runs/R/metrics"))
      return Promise.resolve(json({ run_id: "R", windows: [] }));
    if (url.endsWith("/api/scenarios/S")) {
      return Promise.resolve(
        json({
          id: "S",
          name: "x",
          yaml: scenarioYaml,
          version: 1,
          created_at: 1,
          updated_at: 1,
          group: null,
        }),
      );
    }
    return Promise.resolve(json({}, 404));
  });
});

const num = () => screen.findByTestId("setup-live-num");

describe("RunDetailPage — 실행 중 준비 진행 줄", () => {
  it("running + 준비 스텝 + setup_live → 줄이 run-cards 뒤에", async () => {
    renderPage();
    const n = await num();
    expect(n.textContent).toBe("37 / 50명 완료");
    const cards = screen.getByTestId("run-cards");
    const line = n.parentElement as HTMLElement;
    expect(cards.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("setup_live 키가 없으면 0", async () => {
    setupLive = undefined;
    renderPage();
    expect((await num()).textContent).toBe("0 / 50명 완료");
  });

  it("스냅샷에 준비가 없으면 줄 없음", async () => {
    runYaml = NO_SETUP;
    renderPage();
    await screen.findByTestId("run-cards");
    expect(screen.queryByTestId("setup-live-num")).toBeNull();
  });

  it("스냅샷에만 준비가 있어도 보인다", async () => {
    runYaml = WITH_SETUP;
    scenarioYaml = NO_SETUP;
    renderPage();
    expect((await num()).textContent).toBe("37 / 50명 완료");
  });

  it("현재 시나리오에만 준비가 있으면 없다", async () => {
    runYaml = NO_SETUP;
    scenarioYaml = WITH_SETUP;
    renderPage();
    await screen.findByTestId("run-cards");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/scenarios/S"))).toBe(
        true,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("setup-live-num")).toBeNull();
  });

  it("completed run에는 없다", async () => {
    status = "completed";
    renderPage();
    await screen.findByTestId("run-cards");
    expect(screen.queryByTestId("setup-live-num")).toBeNull();
  });

  it("스냅샷이 읽히지 않아도 페이지는 산다", async () => {
    runYaml = "version: [unclosed\n  : :";
    renderPage();
    await screen.findByTestId("run-cards");
    expect(screen.queryByTestId("setup-live-num")).toBeNull();
  });
});
