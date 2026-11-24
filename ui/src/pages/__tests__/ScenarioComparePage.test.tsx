import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ScenarioComparePage } from "../ScenarioComparePage";
import { api } from "../../api/client";
import * as downloadModule from "../../api/download";
import { ko } from "../../i18n/ko";

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
    mean_ms: 18,
    p50_ms: 10,
    p95_ms: 25,
    p99_ms: 35,
  },
  steps: [],
  status_distribution: { "200": 98, "500": 2 },
  windows: [],
  if_breakdown: [],
  verdict: null,
  dropped: 0,
};

const reportB = {
  ...baseReport,
  run: { ...baseReport.run, id: "B" },
  summary: { ...baseReport.summary, p95_ms: 30, p99_ms: 40 },
};

describe("ScenarioComparePage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getScenario").mockResolvedValue({
      id: "S1",
      name: "demo",
      yaml: "version: 1\nname: demo\nsteps: []\n",
      version: 1,
      created_at: 0,
      updated_at: 0,
      group: null,
    });
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

    expect(screen.getByRole("region", { name: ko.compare.overlayTitle })).toBeInTheDocument();

    // Export buttons
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export XLSX/i })).toBeInTheDocument();

    // breadcrumb: scenario name link + "런 비교" current page
    const bc = screen.getByRole("navigation", { name: ko.breadcrumb.ariaLabel });
    expect(await within(bc).findByRole("link", { name: "demo" })).toHaveAttribute(
      "href",
      "/scenarios/S1",
    );
    expect(within(bc).getByText("런 비교")).toHaveAttribute("aria-current", "page");
  });

  it("집계 기준이 섞인 run을 비교하면 안내 한 줄이 보인다", async () => {
    const steadyA = { ...baseReport, basis: { selected: "steady" } };
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) =>
      Promise.resolve((id === "A" ? steadyA : reportB) as never),
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    const notice = screen.getByText(/집계 기준이 다릅니다/).closest('[role="status"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("유지 구간");
    expect(notice?.textContent).toContain("전체 구간");
  });

  it("응답 시간 표본이 섞인 run을 비교하면 안내가 보이고, 통과한 요청 없는 칸은 「—」", async () => {
    const passedA = {
      ...baseReport,
      summary: { ...baseReport.summary, errors: 100, p95_ms: 0 },
      sample: { selected: "passed", default: "passed", split: true },
    };
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) =>
      Promise.resolve((id === "A" ? passedA : reportB) as never),
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    const notice = screen.getByText(/실패한 요청을 포함해 응답 시간을 계산했습니다/);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    const row = screen.getByText("p95_ms").closest("tr")!;
    const cells = row.querySelectorAll("td");
    expect(cells[1].textContent).toBe("—");
    expect(cells[2].textContent).toBe("30");
  });

  it("상태 코드 규칙이 다른 run을 비교하면 안내가 보이고, 같으면 없다", async () => {
    const ruleA = { ...baseReport, run: { ...baseReport.run, status_rule: 2 } };
    const spy = vi
      .spyOn(api, "getRunReport")
      .mockImplementation((id: string) => Promise.resolve((id === "A" ? ruleA : reportB) as never));
    const { unmount } = renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    const notice = screen.getByText(/선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다/);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    unmount();
    spy.mockImplementation((id: string) =>
      Promise.resolve((id === "A" ? baseReport : reportB) as never),
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    expect(screen.queryByText(/선택한 run 가운데 오류 집계 규칙이 다른 run이 있습니다/)).not.toBeInTheDocument();
  });

  it("표본이 같으면 응답 시간 표본 안내가 없다", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) =>
      Promise.resolve(id === "A" ? baseReport : reportB),
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    expect(screen.queryByText(/실패한 요청을 포함해 응답 시간을/)).not.toBeInTheDocument();
  });

  it("둘 다 basis 없으면 집계 기준 안내가 없다", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) =>
      Promise.resolve(id === "A" ? baseReport : reportB),
    );
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
    await screen.findByText("p95_ms");
    expect(screen.queryByText(/집계 기준이 다릅니다/)).not.toBeInTheDocument();
  });

  it("links to the print comparison report with runs and the effective baseline", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) =>
      Promise.resolve(id === "A" ? baseReport : reportB),
    );
    renderPage("/scenarios/S1/compare?runs=A,B");
    const link = await screen.findByRole("link", { name: "비교 보고서 인쇄" });
    expect(link).toHaveAttribute("href", "/scenarios/S1/compare/print?runs=A%2CB&baseline=A");
    const q = new URLSearchParams((link.getAttribute("href") ?? "").split("?")[1]);
    expect(q.get("runs")).toBe("A,B");
    expect(q.get("baseline")).toBe("A");
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

  it("shows the run label in the column header when the report carries one (run-identity Task 9, US1)", async () => {
    const labeledReportB = {
      ...reportB,
      run: { ...reportB.run, label: "커넥션 풀 2배 후" },
    };
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(labeledReportB);
      return Promise.reject(new Error("unknown"));
    });

    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    expect(await screen.findByText("p95_ms")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /커넥션 풀 2배 후/ })).toBeInTheDocument();
  });

  it("run.profile이 ProfileSchema를 통과하지 못하면 서브라인은 시각만 보여준다(fail-soft, Task 9 리뷰 fold-in)", async () => {
    const reportBroken = {
      ...reportB,
      run: { ...reportB.run, profile: "garbage" },
    };
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(reportBroken);
      return Promise.reject(new Error("unknown"));
    });

    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    expect(await screen.findByText("p95_ms")).toBeInTheDocument();

    // B has no label → header button shows the #끝6자 fallback ("#B" — id is 1 char).
    const btnB = screen.getByRole("button", { name: /#B/ });
    const thB = btnB.closest("th");
    expect(thB).not.toBeNull();
    const expectedTs = new Date(reportBroken.run.created_at).toLocaleString();

    // 시각-단독: " · " 구분자도, profileSummary 요약 세그먼트도 없다(시각 뿐인 그 자체
    // 텍스트로 서브라인 div가 존재해야 — 요약이 붙어 있으면 exact-text 매치가 실패한다).
    expect(within(thB!).getByText(expectedTs)).toBeInTheDocument();
    expect(thB!.textContent).not.toContain(" · ");
  });

  describe("준비 스텝 묶음", () => {
    const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
    const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
    const S3 = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
    const yamlWith = (steps: { id: string; name: string }[]) =>
      "version: 1\nname: t\nsetup:\n  steps:\n" +
      steps
        .map(
          (s) =>
            `    - id: ${s.id}\n      name: "${s.name}"\n      type: http\n      request:\n        method: POST\n        url: "/login"\n`,
        )
        .join("") +
      "steps: []\n";
    const setupOf = (ids: string[]) => ({
      ok: 5,
      failed: 1,
      interrupted: 0,
      steps: ids.map((id) => ({
        step_id: id,
        count: 6,
        errors: 1,
        p50_ms: 3,
        p95_ms: 9,
        max_ms: 12,
        status_counts: {},
        failure_kinds: {},
      })),
    });
    function mockReports(a: object, b: object) {
      vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
        if (id === "A") return Promise.resolve({ ...baseReport, ...a });
        if (id === "B") return Promise.resolve({ ...reportB, ...b });
        return Promise.reject(new Error("unknown"));
      });
    }

    it("labels setup rows with the baseline scenario's step name", async () => {
      mockReports(
        { scenario_yaml: yamlWith([{ id: S1, name: "sign-in" }]), setup: setupOf([S1]) },
        { setup: setupOf([S1]) },
      );
      renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
      expect(await screen.findByText("sign-in p95 ms")).toBeInTheDocument();
      expect(screen.getByText("sign-in 오류")).toBeInTheDocument();
      expect(screen.getByText("준비 성공")).toBeInTheDocument();
      expect(screen.getByText("준비 실패")).toBeInTheDocument();
    });

    it("falls back to METHOD url for an unnamed setup step", async () => {
      mockReports(
        { scenario_yaml: yamlWith([{ id: S1, name: " " }]), setup: setupOf([S1]) },
        { setup: setupOf([S1]) },
      );
      renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
      expect(await screen.findByText("POST /login p95 ms")).toBeInTheDocument();
      expect(screen.getByText("POST /login 오류")).toBeInTheDocument();
    });

    it("prefers the baseline's name when runs name the same setup step differently", async () => {
      mockReports(
        { scenario_yaml: yamlWith([{ id: S1, name: "sign-in" }]), setup: setupOf([S1]) },
        { scenario_yaml: yamlWith([{ id: S1, name: "other-name" }]), setup: setupOf([S1]) },
      );
      renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
      expect(await screen.findByText("sign-in p95 ms")).toBeInTheDocument();
      expect(screen.getByText("sign-in 오류")).toBeInTheDocument();
      expect(screen.queryByText(/other-name/)).not.toBeInTheDocument();
    });

    it("uses another run's name when the baseline lacks the step, else the step id", async () => {
      mockReports(
        { scenario_yaml: yamlWith([{ id: S1, name: "sign-in" }]), setup: setupOf([S1]) },
        {
          scenario_yaml: yamlWith([{ id: S2, name: "token-refresh" }]),
          setup: setupOf([S2, S3]),
        },
      );
      renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");
      expect(await screen.findByText("token-refresh p95 ms")).toBeInTheDocument();
      expect(screen.getByText(`${S3} p95 ms`)).toBeInTheDocument();
    });
  });

  it("shows guard message when fewer than 2 runs provided", () => {
    vi.spyOn(api, "getRunReport").mockResolvedValue(baseReport);
    renderPage("/scenarios/S1/compare?runs=A&baseline=A");
    expect(screen.getByText(/비교하려면 런을 2개 이상 선택하세요/)).toBeInTheDocument();
    // breadcrumb should still be present in the guard state
    expect(screen.getByRole("navigation", { name: ko.breadcrumb.ariaLabel })).toBeInTheDocument();
  });

  it("shows export error banner with role=alert when download fails", async () => {
    vi.spyOn(api, "getRunReport").mockImplementation((id: string) => {
      if (id === "A") return Promise.resolve(baseReport);
      if (id === "B") return Promise.resolve(reportB);
      return Promise.reject(new Error("unknown"));
    });
    vi.spyOn(downloadModule, "downloadFile").mockRejectedValue(new Error("network error"));

    const user = userEvent.setup();
    renderPage("/scenarios/S1/compare?runs=A,B&baseline=A");

    await screen.findByText("p95_ms");
    await user.click(screen.getByRole("button", { name: /Export CSV/i }));

    // Export error Callout renders with role="alert"
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
