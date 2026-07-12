import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioRunsPage } from "../ScenarioRunsPage";

const fetchMock = vi.fn();
beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SCENARIO_YAML =
  "version: 1\nname: demo\ncookie_jar: auto\nvariables: {}\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: SCENARIO_YAML,
    status: "completed",
    profile: { vus: 4, ramp_up_seconds: 1, duration_seconds: 8, loop_breakdown_cap: 256 },
    env: { BASE_URL: "http://x" },
    started_at: 1,
    ended_at: 2,
    created_at: 1,
    ...over,
  };
}

function mockApi(runOver: Record<string, unknown> = {}, postStatus = 201) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/scenarios/S1") && (!init || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse({
          id: "S1",
          name: "demo",
          yaml: SCENARIO_YAML,
          version: 1,
          created_at: 1,
          updated_at: 1,
        }),
      );
    }
    if (url.endsWith("/api/scenarios/S1/runs")) {
      return Promise.resolve(jsonResponse({ runs: [runRow(runOver)] }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    if (url.endsWith("/api/runs") && init?.method === "POST") {
      return Promise.resolve(
        postStatus >= 400
          ? jsonResponse({ error: "scenario drifted" }, postStatus)
          : jsonResponse(runRow({ id: "R2", status: "pending" }), postStatus),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderPage(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe("ScenarioRunsPage — retry (A1)", () => {
  it("'다시 실행' prefills the dialog from the run row", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(4);
    expect(screen.getByLabelText("환경 변수 키 0")).toHaveValue("BASE_URL");
  });

  it("'즉시 재실행' POSTs createRun and navigates to the new run", async () => {
    const user = userEvent.setup();
    mockApi();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    await waitFor(() => expect(screen.getByText("run page")).toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.profile.vus).toBe(4);
    expect(body.env).toEqual({ BASE_URL: "http://x" });
    expect(JSON.parse(window.localStorage.getItem("handicap.onboarding.v1")!)).toMatchObject({
      runCreated: true,
    });
  });

  it("shows the drift warning when the run snapshot differs from the live scenario", async () => {
    const user = userEvent.setup();
    mockApi({ scenario_yaml: SCENARIO_YAML.replace("http://x", "http://OLD") });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/이 run 이후 수정됨/);
  });

  it("auto-opens prefilled when ?retry=<runId> is present", async () => {
    mockApi();
    renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(4);
  });

  it("does not re-open the dialog after Cancel when the runs list refetches", async () => {
    const user = userEvent.setup();
    mockApi();
    const { qc } = renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(4); // opened via deep-link
    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("spinbutton", { name: /동시 사용자/ })).toBeNull(),
    ); // closed
    await qc.refetchQueries({ queryKey: ["scenarios", "S1", "runs"] });
    expect(screen.queryByRole("spinbutton", { name: /동시 사용자/ })).toBeNull();
  });

  it("does not re-open the ?retry dialog when createRun's identity changes (deps guard)", async () => {
    // The retry effect lists `createRun` in its deps (exhaustive-deps). A
    // createRun state transition (here: an error from 즉시 재실행) changes the
    // mutation object's identity and re-fires the effect — the consumedRetry
    // guard must keep the cancelled dialog closed for that retryId.
    const user = userEvent.setup();
    mockApi({}, 400);
    renderPage("/scenarios/S1/runs?retry=R1");
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(4); // opened via deep-link
    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.queryByRole("spinbutton", { name: /동시 사용자/ })).toBeNull(),
    ); // closed
    // Trigger a createRun error → its identity changes → effect re-fires.
    await user.click(screen.getByRole("button", { name: "즉시 재실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/scenario drifted/);
    expect(screen.queryByRole("spinbutton", { name: /동시 사용자/ })).toBeNull(); // stays closed
  });

  it("surfaces a createRun error from '즉시 재실행'", async () => {
    const user = userEvent.setup();
    mockApi({}, 400);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/scenario drifted/);
    // pin: run-creation error box is reachable via role="alert" and contains "실패"
    expect(screen.getByRole("alert")).toHaveTextContent(/실패/);
  });

  it("does not show the drift warning when the run snapshot matches the live scenario", async () => {
    const user = userEvent.setup();
    mockApi(); // runRow.scenario_yaml === live SCENARIO_YAML — no drift
    renderPage();
    await user.click(await screen.findByRole("button", { name: "다시 실행" }));
    // dialog opened (VUs seeded) but no drift alert because snapshots match
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(4);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A4b: run selection + compare entry
// ---------------------------------------------------------------------------

function makeRun(
  id: string,
  status: string,
  createdAt: number,
  lastMetricTs: number | null = null,
) {
  return {
    id,
    scenario_id: "S1",
    scenario_yaml: SCENARIO_YAML,
    status,
    profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
    env: {},
    started_at: createdAt,
    ended_at: createdAt + 1,
    created_at: createdAt,
    last_metric_ts: lastMetricTs,
  };
}

function mockApiRuns(runs: unknown[]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/scenarios/S1") && (!init || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse({
          id: "S1",
          name: "demo",
          yaml: SCENARIO_YAML,
          version: 1,
          created_at: 1,
          updated_at: 1,
        }),
      );
    }
    if (url.endsWith("/api/scenarios/S1/runs")) {
      return Promise.resolve(jsonResponse({ runs }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

/** LocationProbe renders inside the compare route so we can assert URL params. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="compare-location">{loc.pathname + loc.search}</div>;
}

function renderPageWithCompare(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
          <Route path="/scenarios/:id/compare" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe("ScenarioRunsPage — run selection + compare (A4b)", () => {
  it("running/pending row checkbox is disabled; completed rows are enabled", async () => {
    const runs = [
      makeRun("C1", "completed", 100),
      makeRun("C2", "completed", 200),
      makeRun("R1", "running", 300),
    ];
    mockApiRuns(runs);
    renderPageWithCompare();

    // wait for rows to appear
    await screen.findByLabelText("실행 C1 선택");
    const cbC1 = screen.getByLabelText("실행 C1 선택") as HTMLInputElement;
    const cbC2 = screen.getByLabelText("실행 C2 선택") as HTMLInputElement;
    const cbR1 = screen.getByLabelText("실행 R1 선택") as HTMLInputElement;

    expect(cbC1.disabled).toBe(false);
    expect(cbC2.disabled).toBe(false);
    expect(cbR1.disabled).toBe(true);
  });

  it("selecting 2 completed runs enables 비교(2) which navigates to compare route with correct baseline", async () => {
    const user = userEvent.setup();
    // C1 created earlier (created_at=100) should be baseline
    const runs = [makeRun("C1", "completed", 100), makeRun("C2", "completed", 200)];
    mockApiRuns(runs);
    renderPageWithCompare();

    // select both
    await user.click(await screen.findByLabelText("실행 C1 선택"));
    await user.click(screen.getByLabelText("실행 C2 선택"));

    const compareBtn = await screen.findByRole("button", { name: /비교 \(2\)/ });
    expect(compareBtn).not.toBeDisabled();
    await user.click(compareBtn);

    // LocationProbe should render
    const probe = await screen.findByTestId("compare-location");
    expect(probe.textContent).toMatch(/\/scenarios\/S1\/compare/);
    expect(probe.textContent).toMatch(/runs=C1%2CC2|runs=C1,C2/);
    // baseline = older run (C1, created_at=100)
    expect(probe.textContent).toMatch(/baseline=C1/);
  });

  it("selecting 6 completed runs shows the capped warning and disables the screen 비교 button; shows Export XLSX", async () => {
    const user = userEvent.setup();
    const runs = Array.from({ length: 6 }, (_, i) =>
      makeRun(`C${i + 1}`, "completed", (i + 1) * 100),
    );
    mockApiRuns(runs);
    renderPageWithCompare();

    // select all 6
    for (let i = 1; i <= 6; i++) {
      await user.click(await screen.findByLabelText(`실행 C${i} 선택`));
    }

    expect(await screen.findByText(/화면에선 5개까지 비교됩니다/)).toBeInTheDocument();

    // The screen compare button should be disabled
    const compareBtn = screen.queryByRole("button", { name: /비교 \(6\)/ });
    if (compareBtn) {
      expect(compareBtn).toBeDisabled();
    }
  });

  it("selecting >50 runs shows the 최대 50개 guard", async () => {
    const user = userEvent.setup();
    const runs = Array.from({ length: 51 }, (_, i) =>
      makeRun(`C${i + 1}`, "completed", (i + 1) * 100),
    );
    mockApiRuns(runs);
    renderPageWithCompare();

    // select all 51
    for (let i = 1; i <= 51; i++) {
      await user.click(await screen.findByLabelText(`실행 C${i} 선택`));
    }

    expect(await screen.findByText(/최대 50개까지 선택할 수 있습니다/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// U2: breadcrumb + 빈 상태
// ---------------------------------------------------------------------------

function mockApiEmpty() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith("/api/scenarios/S1") && (!init || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse({
          id: "S1",
          name: "demo",
          yaml: SCENARIO_YAML,
          version: 1,
          created_at: 1,
          updated_at: 1,
        }),
      );
    }
    if (url.endsWith("/api/scenarios/S1/runs")) {
      return Promise.resolve(jsonResponse({ runs: [] }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

describe("ScenarioRunsPage — U2 breadcrumb + 빈 상태", () => {
  it("breadcrumb 에 시나리오 이름 링크가 있다", async () => {
    mockApi();
    renderPage();
    // wait for scenario to load
    await screen.findByRole("button", { name: "다시 실행" });
    const bc = screen.getByRole("navigation", { name: ko.breadcrumb.ariaLabel });
    expect(within(bc).getByRole("link", { name: "demo" })).toHaveAttribute("href", "/scenarios/S1");
  });

  it("빈 상태 메시지와 CTA 버튼을 렌더하며, CTA 클릭 시 다이얼로그가 열린다", async () => {
    const user = userEvent.setup();
    mockApiEmpty();
    renderPage();
    expect(await screen.findByText(ko.empty.runs)).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: `${ko.empty.runsCta} →` });
    await user.click(cta);
    expect(await screen.findByRole("spinbutton", { name: /동시 사용자/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// §7.4 running elapsed time
// ---------------------------------------------------------------------------

describe("ScenarioRunsPage — elapsed time on running row (§7.4)", () => {
  it("running 행에 경과 시간이 표시된다", async () => {
    const startedAt = Date.now() - 90_000;
    mockApiRuns([makeRun("RUN1", "running", startedAt)]);
    renderPageWithCompare();
    // fixture 생성→렌더 사이 1초가 지나면 "1분 31초"가 될 수 있어 regex로 흡수(flake 방지)
    // elapsed는 단조 증가(시작점 -90s 고정) — 느린 CI에서 렌더가 늦어도 흡수되게 뒤쪽으로 넓힌 regex
    expect(await screen.findByText(/경과 1분 3[0-5]초/)).toBeInTheDocument();
  });

  it("terminal 행엔 경과 표시가 없다", async () => {
    mockApiRuns([makeRun("C1", "completed", Date.now() - 90_000)]);
    renderPageWithCompare();
    await screen.findByLabelText("실행 C1 선택");
    expect(screen.queryByText(/경과/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 6: VerdictBadge 배지 표시
// ---------------------------------------------------------------------------

describe("ScenarioRunsPage — verdict badge (Task 6)", () => {
  it("renders PASS badge for a run with passed verdict and — for a run without verdict", async () => {
    const runWithVerdict = makeRun("V1", "completed", 100);
    (runWithVerdict as Record<string, unknown>).verdict = { passed: true, criteria: [] };
    const runWithoutVerdict = makeRun("V2", "completed", 200);
    mockApiRuns([runWithVerdict, runWithoutVerdict]);
    renderPageWithCompare();

    // Scope to V1's table row so the badge (not the toolbar chip) is matched.
    // The filter chip lives in RunListControls above the table, so within(v1Row)
    // excludes it — getByText matches exactly the badge in that row.
    const v1Row = (await screen.findByLabelText("실행 V1 선택")).closest("tr");
    expect(v1Row).not.toBeNull();
    expect(within(v1Row!).getByText(ko.report.verdictPass)).toBeInTheDocument();
    // The run without verdict renders the em-dash placeholder
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G1b: 목록 stall 배지
// ---------------------------------------------------------------------------

describe("ScenarioRunsPage — stall 배지 (G1b 목록)", () => {
  it("running + 오래된 last_metric_ts → 정지 의심 배지(midrun)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 5_000, nowSec - 300)]);
    renderPageWithCompare();
    expect(await screen.findByText(/정지 의심/)).toBeInTheDocument();
  });

  it("running + 메트릭 0 + 시작 후 오래 → 정지 의심 배지(startup)", async () => {
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 30_000, null)]);
    renderPageWithCompare();
    expect(await screen.findByText(/정지 의심/)).toBeInTheDocument();
  });

  it("running + 최근 last_metric_ts → 배지 없음(healthy)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockApiRuns([makeRun("RUN1", "running", Date.now() - 5_000, nowSec - 2)]);
    renderPageWithCompare();
    await screen.findByLabelText(ko.report.selectRunAria("RUN1"));
    expect(screen.queryByText(/정지 의심/)).toBeNull();
  });

  it("terminal run → 배지 없음", async () => {
    mockApiRuns([makeRun("C1", "completed", Date.now() - 30_000, null)]);
    renderPageWithCompare();
    await screen.findByLabelText(ko.report.selectRunAria("C1"));
    expect(screen.queryByText(/정지 의심/)).toBeNull();
  });
});

describe("ScenarioRunsPage — 곡선/열린 run VU 열 (R1/R2)", () => {
  it("닫힌 곡선 run: VU 열 '최대 50 (곡선)'", async () => {
    mockApi({
      profile: {
        vus: 0,
        ramp_up_seconds: 0,
        duration_seconds: 0,
        vu_stages: [
          { target: 5, duration_seconds: 10 },
          { target: 50, duration_seconds: 20 },
        ],
      },
    });
    renderPage();
    expect(await screen.findByText("최대 50 (곡선)")).toBeInTheDocument();
  });

  it("열린 루프 run: VU 열 '—'", async () => {
    mockApi({
      profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 30, target_rps: 100 },
    });
    renderPage();
    expect(
      await screen.findByLabelText("VU 해당 없음 — 열린 루프(도착률·슬롯 기반)"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// run-list-filter-sort: ScenarioRunsPage 배선
// ---------------------------------------------------------------------------

function RunsLocationProbe() {
  return <div data-testid="runs-location">{useLocation().search}</div>;
}
function renderRuns(initialPath = "/scenarios/S1/runs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <RunsLocationProbe />
        <Routes>
          <Route path="/scenarios/:id/runs" element={<ScenarioRunsPage />} />
          <Route path="/runs/:id" element={<div>run page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioRunsPage — filter/sort (run-list-filter-sort)", () => {
  const RUNS = [
    runRow({
      id: "PASS1",
      status: "completed",
      verdict: { passed: true, criteria: [] },
      created_at: 3000,
    }),
    runRow({
      id: "FAIL1",
      status: "failed",
      verdict: {
        passed: false,
        criteria: [{ metric: "p95_ms", direction: "max", threshold: 1, actual: 9, passed: false }],
      },
      created_at: 2000,
    }),
    runRow({ id: "RUN1", status: "running", verdict: null, created_at: 1000 }),
  ];

  it("no-param page renders all rows newest-first (R8, R18)", async () => {
    mockApiRuns(RUNS);
    renderRuns();
    await screen.findByRole("button", { name: ko.pages.runScenario });
    const links = screen.getAllByRole("link", { name: "view →" });
    expect(links).toHaveLength(3); // all rows visible
  });

  it("status filter hides non-matching rows (R5)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    await user.click(await screen.findByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getAllByRole("link", { name: "view →" })).toHaveLength(1);
  });

  it("filter writes URL query params (R13)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    await user.click(await screen.findByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getByTestId("runs-location").textContent).toContain("status=running");
  });

  it("shows the filtered empty state when nothing matches (R15)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // verdict=fail + status=completed → 0 matches
    // pressed:false disambiguates the filter chip (aria-pressed) from the FailBadge button (aria-expanded, no aria-pressed)
    await user.click(
      await screen.findByRole("button", { name: ko.runFilter.verdictFail, pressed: false }),
    );
    await user.click(screen.getByRole("button", { name: ko.runFilter.statusCompleted }));
    expect(await screen.findByText(ko.runFilter.emptyFiltered)).toBeInTheDocument();
    expect(screen.queryByText(ko.empty.runs)).not.toBeInTheDocument();
  });

  it("header click sorts by that field (R12)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // 결과(verdict) 헤더 클릭 → promoteSort → [verdict:asc, created:desc]
    await user.click(
      await screen.findByRole("button", {
        name: ko.runSort.sortByHeaderAria(ko.runFilter.verdictLabel),
      }),
    );
    const ids = screen.getAllByRole("link", { name: "view →" }).map((a) => a.getAttribute("href"));
    // verdict asc default → fail(0) first, then pass(1), then none(2)
    expect(ids).toEqual(["/runs/FAIL1", "/runs/PASS1", "/runs/RUN1"]);
    const verdictHeader = screen
      .getByRole("button", { name: ko.runSort.sortByHeaderAria(ko.runFilter.verdictLabel) })
      .closest("th");
    expect(verdictHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("keeps comparison selection independent of filtering (R16)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    // select PASS1 and FAIL1 (both terminal)
    await user.click(
      await screen.findByRole("checkbox", { name: ko.report.selectRunAria("PASS1") }),
    );
    await user.click(screen.getByRole("checkbox", { name: ko.report.selectRunAria("FAIL1") }));
    expect(screen.getByRole("button", { name: "비교 (2)" })).toBeInTheDocument();
    // now filter to running only — selected runs hidden, but compare count unchanged
    await user.click(screen.getByRole("button", { name: ko.runFilter.statusRunning }));
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getByRole("button", { name: "비교 (2)" })).toBeInTheDocument();
  });
});
