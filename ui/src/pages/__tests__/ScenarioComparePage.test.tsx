import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ScenarioComparePage } from "../ScenarioComparePage";
import { api } from "../../api/client";
import * as downloadModule from "../../api/download";

// jsdom does not implement URL.createObjectURL.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:noop", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/scenarios/:id/compare" element={<ScenarioComparePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseReport = {
  run: {
    id: "A",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 5 },
    env: {},
    started_at: 100,
    ended_at: 105,
    created_at: 99,
  },
  scenario_yaml: "version: 1\nname: t\nsteps: []\n",
  summary: {
    count: 100,
    errors: 2,
    rps: 20.0,
    duration_seconds: 5,
    p50_ms: 10,
    p95_ms: 25,
    p99_ms: 35,
  },
  steps: [],
  status_distribution: { "200": 98, "500": 2 },
  windows: [],
  if_breakdown: [],
  verdict: null,
};

const reportB = {
  ...baseReport,
  run: { ...baseReport.run, id: "B" },
  summary: { ...baseReport.summary, p95_ms: 30, p99_ms: 40 },
};

describe("ScenarioComparePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders matrix and export buttons once reports load", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(reportB);
      return Promise.reject(new Error("unknown"));
    });
    vi.spyOn(downloadModule, "downloadFile").mockResolvedValue(undefined);

    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    // Summary metric appears in the matrix
    expect(await screen.findByText("p95_ms")).toBeInTheDocument();

    // Export buttons
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export XLSX/i })).toBeInTheDocument();
  });

  it("calls downloadFile with compareCsvUrl when Export CSV clicked", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(reportB);
      return Promise.reject(new Error("unknown"));
    });
    const dlSpy = vi.spyOn(downloadModule, "downloadFile").mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    // Wait for matrix to render
    await screen.findByText("p95_ms");

    await user.click(screen.getByRole("button", { name: /Export CSV/i }));

    await waitFor(() => {
      expect(dlSpy).toHaveBeenCalledWith(
        api.compareCsvUrl("S1", ["A", "B"], "A"),
        "comparison.csv",
        "text/csv",
      );
    });
  });

  it("calls downloadFile with compareXlsxUrl when Export XLSX clicked", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(reportB);
      return Promise.reject(new Error("unknown"));
    });
    const dlSpy = vi.spyOn(downloadModule, "downloadFile").mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    await screen.findByText("p95_ms");

    await user.click(screen.getByRole("button", { name: /Export XLSX/i }));

    await waitFor(() => {
      expect(dlSpy).toHaveBeenCalledWith(
        api.compareXlsxUrl("S1", ["A", "B"], "A"),
        "comparison.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });
  });

  it("shows loading state while reports are loading", () => {
    vi.spyOn(api, "getRunReport").mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows error state when a report fails to load", async () => {
    vi.spyOn(api, "getRunReport").mockRejectedValue(new Error("fetch failed"));
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("shows guard message when fewer than 2 runs provided", () => {
    vi.spyOn(api, "getRunReport").mockResolvedValue(baseReport);
    renderPage("/scenarios/S1/compare?runs=A&baseline=A");
    expect(screen.getByText(/비교하려면 런을 2개 이상 선택하세요/)).toBeInTheDocument();
  });
});
