import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();

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

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioListPage 홈 온보딩 + 빈 상태 (U2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("빈 목록: 3요소 빈 상태 + CTA + 가이드 카드(① 미완)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [] }));
    renderPage();
    expect(await screen.findByText(ko.empty.scenarios)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `${ko.empty.scenariosCta} →` })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(
      within(card).getByRole("link", { name: `${ko.onboarding.step1Cta} →` }),
    ).toBeInTheDocument();
    // 한국어 chrome
    expect(screen.getByRole("heading", { name: ko.nav.scenarios })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.pages.newScenario })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
    expect(screen.getByRole("link", { name: ko.import.title })).toHaveAttribute(
      "href",
      "/scenarios/import",
    );
  });

  it("시나리오 있으면 카드 ② 링크가 첫 시나리오 실행 목록을 가리킨다", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [DEMO] }));
    renderPage();
    await screen.findByRole("link", { name: "demo" });
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
    // 테이블 행 액션 한국어화
    expect(screen.getByRole("button", { name: ko.pages.duplicate })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.pages.runsLink })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
  });

  it("dismissed 상태면 카드 없이 목록만", async () => {
    window.localStorage.setItem("handicap.onboarding.v1", JSON.stringify({ dismissed: true }));
    fetchMock.mockResolvedValue(jsonResponse({ scenarios: [DEMO] }));
    renderPage();
    await screen.findByRole("link", { name: "demo" });
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });
});
