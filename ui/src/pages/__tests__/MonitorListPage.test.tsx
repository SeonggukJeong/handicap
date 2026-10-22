import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { MonitorListPage } from "../MonitorListPage";
import { ko } from "../../i18n/ko";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MonitorListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const mkBoard = (id: string, name: string, enabled: boolean, n: number) => ({
  id,
  name,
  config: {
    font_scale: "large",
    display_style: "border",
    blink: "fail",
    panels: Array.from({ length: n }, (_, i) => ({
      id: `P${i}`,
      title: `t${i}`,
      scenario_id: "S",
      environment_id: null,
      interval_seconds: 10,
      timeout_seconds: 5,
      latency_source: { kind: "total" },
      thresholds: [],
      bar_count: 60,
      graph_max_ms: 2000,
      conditions: [],
    })),
  },
  enabled,
  created_at: 1,
  updated_at: 1,
});

describe("MonitorListPage", () => {
  it("lists_boards_with_enabled_and_open_link", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ boards: [mkBoard("B1", "운영실", true, 2), mkBoard("B2", "개발실", false, 1)] }),
    );
    renderPage();
    expect(await screen.findByRole("link", { name: "운영실" })).toHaveAttribute(
      "href",
      "/monitors/B1",
    );
    expect(screen.getByText(ko.monitor.panelCount(2))).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.enabledOn)).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.enabledOff)).toBeInTheDocument();
    const open = screen.getAllByRole("link", { name: ko.monitor.openDisplay });
    expect(open[0]).toHaveAttribute("href", "/monitors/B1/display");
    expect(screen.getByRole("link", { name: ko.monitor.newBoard })).toHaveAttribute(
      "href",
      "/monitors/new",
    );
  });

  it("empty_state_copy", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [] }));
    renderPage();
    expect(await screen.findByText(ko.monitor.emptyList)).toBeInTheDocument();
  });
});
