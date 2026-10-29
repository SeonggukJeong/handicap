import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { MonitorListPage } from "../MonitorListPage";
import { ko } from "../../i18n/ko";
import { downloadBoardFile } from "../../api/monitorTransfer";

vi.mock("../../api/monitorTransfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/monitorTransfer")>()),
  downloadBoardFile: vi.fn(),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.mocked(downloadBoardFile).mockReset();
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
    show_latency_stats: true,
    record_limit_kb: 128,
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
      display_items: [],
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

  it("select_all_and_row_checkboxes_have_names", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [mkBoard("B1", "운영실", true, 1)] }));
    renderPage();
    const t = ko.monitor.transfer;
    expect(await screen.findByRole("checkbox", { name: t.selectAll })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: t.selectBoard("운영실") })).toBeInTheDocument();
  });

  it("select_all_indeterminate_when_partial", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ boards: [mkBoard("B1", "첫째", true, 1), mkBoard("B2", "둘째", true, 1)] }),
    );
    renderPage();
    const all = (await screen.findByRole("checkbox", {
      name: ko.monitor.transfer.selectAll,
    })) as HTMLInputElement;
    expect(all.indeterminate).toBe(false);
    fireEvent.click(
      screen.getByRole("checkbox", { name: ko.monitor.transfer.selectBoard("첫째") }),
    );
    expect(all.indeterminate).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: ko.monitor.transfer.selectBoard("둘째") }),
    );
    expect(all.indeterminate).toBe(false);
    expect(all.checked).toBe(true);
  });

  it("export_button_disabled_when_none_selected", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [mkBoard("B1", "운영실", true, 1)] }));
    renderPage();
    const btn = await screen.findByRole("button", { name: ko.monitor.transfer.exportSelected(0) });
    expect(btn).toBeDisabled();
  });

  it("export_button_disabled_over_50_with_message", async () => {
    const boards = Array.from({ length: 51 }, (_, i) => mkBoard(`B${i}`, `보드${i}`, false, 1));
    fetchMock.mockResolvedValueOnce(json({ boards }));
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: ko.monitor.transfer.selectAll }));
    const btn = screen.getByRole("button", { name: ko.monitor.transfer.exportSelected(51) });
    expect(btn).toBeDisabled();
    expect(screen.getByText(ko.monitor.transfer.tooManyToExport)).toBeInTheDocument();
  });

  it("export_downloads_selected_in_list_order", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ boards: [mkBoard("B1", "첫째", true, 1), mkBoard("B2", "둘째", true, 1)] }),
    );
    renderPage();
    const t = ko.monitor.transfer;
    fireEvent.click(await screen.findByRole("checkbox", { name: t.selectBoard("둘째") }));
    fireEvent.click(screen.getByRole("checkbox", { name: t.selectBoard("첫째") }));
    fetchMock.mockResolvedValueOnce(new Response('{"file":1}', { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: t.exportSelected(2) }));
    await waitFor(() => expect(downloadBoardFile).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(init.body)).toEqual({ board_ids: ["B1", "B2"] });
    expect(downloadBoardFile).toHaveBeenCalledWith(
      "monitor-boards-2.handicap-board.json",
      '{"file":1}',
    );
  });

  it("export_error_is_shown_and_no_download", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [mkBoard("B1", "운영실", true, 1)] }));
    renderPage();
    const t = ko.monitor.transfer;
    fireEvent.click(await screen.findByRole("checkbox", { name: t.selectBoard("운영실") }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "보드 '운영실' 칸 1: 시나리오가 없습니다" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: t.exportSelected(1) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "보드 '운영실' 칸 1: 시나리오가 없습니다",
    );
    expect(downloadBoardFile).not.toHaveBeenCalled();
  });

  it("import_button_visible_on_empty_list", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [] }));
    renderPage();
    expect(await screen.findByText(ko.monitor.emptyList)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ko.monitor.transfer.importFromFile }),
    ).toBeInTheDocument();
  });

  it("plaintext_notice_visible", async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [mkBoard("B1", "운영실", true, 1)] }));
    renderPage();
    expect(await screen.findByText(ko.monitor.transfer.plaintextNotice)).toBeInTheDocument();
  });
});
