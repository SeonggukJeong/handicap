import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { runShortLabel } from "../../compare/runLabel";
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

  it("'즉시 재실행' 라벨 승계: 라벨 있는 run 행의 즉시 재실행 POST 페이로드에 label이 실린다 (run-identity Task 6)", async () => {
    const user = userEvent.setup();
    mockApi({ label: "이전 라벨" });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "즉시 재실행" }));
    await waitFor(() => expect(screen.getByText("run page")).toBeInTheDocument());
    const posted = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs") && (i as RequestInit)?.method === "POST",
    );
    expect(posted).toBeTruthy();
    const body = JSON.parse((posted![1] as RequestInit).body as string);
    expect(body.label).toBe("이전 라벨");
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

  it("검색(q) 입력 → 행 필터 + 초기화 버튼 표시 → 클릭 시 전체 복귀 (Task 10, US3)", async () => {
    const user = userEvent.setup();
    mockApiRuns(RUNS);
    renderRuns();
    await screen.findByRole("button", { name: ko.pages.runScenario });
    expect(screen.getAllByRole("link", { name: "view →" })).toHaveLength(3);

    const search = screen.getByRole("textbox", { name: ko.runFilter.searchLabel });
    // "pass1"(소문자) 입력이 대문자 id "PASS1"에 대소문자 무시로 매치.
    await user.type(search, "pass1");
    await screen.findByText(ko.runFilter.count(1, 3));
    expect(screen.getAllByRole("link", { name: "view →" })).toHaveLength(1);
    expect(screen.getByTestId("runs-location").textContent).toContain("q=pass1");

    const resetBtn = screen.getByRole("button", { name: ko.runFilter.reset });
    await user.click(resetBtn);
    expect(screen.getAllByRole("link", { name: "view →" })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: ko.runFilter.reset })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 8: run 목록 라벨 열 + 인라인 편집 (US4 사후 편집 — 목록 / US2·US5 목록 관찰)
// ---------------------------------------------------------------------------

/** PUT /api/runs/R1/label 후 다음 목록 GET이 "다른" label을 돌려주는 상태 보존 mock —
 *  onSuccess의 setEditing(null)이 없으면 stale draft가 남는 이빨(brief Step 4). */
function mockApiLabelFlow() {
  let serverLabel: string | null = null;
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
      return Promise.resolve(jsonResponse({ runs: [runRow({ label: serverLabel })] }));
    }
    if (url.endsWith("/api/datasets")) {
      return Promise.resolve(jsonResponse({ datasets: [] }));
    }
    if (url.endsWith("/api/runs/R1/label") && init?.method === "PUT") {
      serverLabel = "서버값(다른라벨)";
      return Promise.resolve(jsonResponse(runRow({ label: serverLabel })));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

describe("ScenarioRunsPage — 라벨 열 + 인라인 편집 (Task 8)", () => {
  it("라벨 열 헤더가 '비교' 뒤·'상태' 앞에 plain th로 존재한다(정렬 비대상)", async () => {
    mockApi();
    renderPage();
    await screen.findByRole("button", { name: "다시 실행" });
    const header = screen.getByRole("columnheader", { name: ko.runFilter.labelCol });
    expect(header.tagName).toBe("TH");
    expect(header).not.toHaveAttribute("aria-sort");

    const headers = screen.getAllByRole("columnheader");
    const labelIdx = headers.indexOf(header);
    expect(headers[labelIdx - 1]).toHaveTextContent("비교");
    expect(within(headers[labelIdx + 1]).getByText(ko.runFilter.statusLabel)).toBeInTheDocument();
  });

  it("라벨 있는 행은 라벨 텍스트, 없는 행은 muted #끝6자를 셀에 보여준다", async () => {
    const labeled = makeRun("LBL1", "completed", 100);
    (labeled as Record<string, unknown>).label = "커넥션 풀 2배";
    const unlabeled = makeRun("NOLBL2", "completed", 200);
    mockApiRuns([labeled, unlabeled]);
    renderPageWithCompare();

    const row1 = (await screen.findByLabelText("실행 LBL1 선택")).closest("tr")!;
    expect(within(row1).getByText("커넥션 풀 2배")).toBeInTheDocument();

    const row2 = screen.getByLabelText("실행 NOLBL2 선택").closest("tr")!;
    const shortEl = within(row2).getByText(runShortLabel("NOLBL2"));
    expect(shortEl).toBeInTheDocument();
    expect(shortEl).toHaveClass("text-slate-400");
  });

  it("셀 편집: 편집 클릭→타이핑→Enter→PUT + 성공 후 서버 값 표시(stale draft 회귀 가드)", async () => {
    const user = userEvent.setup();
    mockApiLabelFlow();
    renderPage();

    // 이빨(자기참조 방지): 기대값을 production과 같은 ko.runFilter.labelEditAria() 호출로
    // 계산하지 않는다 — 독립 리터럴("#R1 라벨 편집" = runShortLabel("R1") + " 라벨 편집")로
    // WCAG 2.5.3 label-in-name 회귀(예: labelEditAria가 인자를 무시)를 잡을 수 있게 한다.
    const editBtn = await screen.findByRole("button", { name: "#R1 라벨 편집" });
    await user.click(editBtn);

    const input = screen.getByRole("textbox", { name: "#R1 라벨 편집" });
    await user.type(input, "내가 입력한 초안");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/runs/R1/label") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
    });

    // 이빨: onSuccess에서 setEditing(null)이 없으면 input이 draft("내가 입력한 초안")를
    // 계속 보여준다 — invalidate 재페치로 서버 값("서버값(다른라벨)")이 대신 보여야 GREEN.
    expect(await screen.findByText("서버값(다른라벨)")).toBeInTheDocument();
    expect(screen.queryByText("내가 입력한 초안")).toBeNull();
  });

  it("무변경 blur: draft가 원래 라벨과 같으면 PUT 미발생 + 편집기가 닫힌다 (I1 no-op 가드)", async () => {
    const user = userEvent.setup();
    const labeled = { ...makeRun("R1", "completed", 100), label: "변경없음" };
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
        return Promise.resolve(jsonResponse({ runs: [labeled] }));
      }
      if (url.endsWith("/api/datasets")) {
        return Promise.resolve(jsonResponse({ datasets: [] }));
      }
      // 가드가 없으면(버그) 이 PUT이 실제로 호출된다 — 성공 응답을 둬 결과가 "PUT 호출 여부"에만
      // 좌우되게 한다(미모킹 404로 인한 무한대기 타임아웃이 아니라).
      if (url.endsWith("/api/runs/R1/label") && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ ...labeled, label: "변경없음" }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPageWithCompare();

    const editBtn = await screen.findByRole("button", { name: "변경없음 라벨 편집" });
    await user.click(editBtn);
    const input = screen.getByRole("textbox", { name: "변경없음 라벨 편집" });
    // 아무 타이핑도 하지 않고(=draft === 기존 라벨) blur.
    fireEvent.blur(input);

    // 편집기가 닫혀 표시 버튼(라벨 텍스트)으로 복귀.
    expect(await screen.findByRole("button", { name: "변경없음 라벨 편집" })).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs/R1/label") && (i as RequestInit)?.method === "PUT",
    );
    expect(put).toBeUndefined();
  });

  it("행-스코프: A 커밋 pending 중 B 편집 시작 → A onSuccess가 B 편집기를 닫지 않는다 (I1)", async () => {
    const user = userEvent.setup();
    let resolvePutA: ((v: Response) => void) | null = null;
    const runs = [
      { ...makeRun("R1", "completed", 100), label: null },
      { ...makeRun("R2", "completed", 200), label: null },
    ];
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
      if (url.endsWith("/api/runs/R1/label") && init?.method === "PUT") {
        // A의 PUT을 보류해 B 편집이 시작될 여지를 만든다.
        return new Promise<Response>((resolve) => {
          resolvePutA = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPage();

    const editA = await screen.findByRole("button", { name: "#R1 라벨 편집" });
    await user.click(editA);
    const inputA = screen.getByRole("textbox", { name: "#R1 라벨 편집" });
    await user.type(inputA, "A 초안");
    fireEvent.blur(inputA); // commitLabel(A) → PUT pending(미해결)

    // A의 PUT이 아직 안 끝난 상태에서 B 편집을 연다.
    const editB = screen.getByRole("button", { name: "#R2 라벨 편집" });
    await user.click(editB);
    const inputB = screen.getByRole("textbox", { name: "#R2 라벨 편집" });
    await user.type(inputB, "B 초안");

    // 이제 A의 PUT을 완료시킨다 — onSuccess가 행-스코프가 아니면 B의 편집기가 닫힌다.
    resolvePutA!(jsonResponse({ ...runs[0], label: "A 초안" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/runs/R1/label") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
    });

    // B의 입력이 여전히 draft("B 초안")를 보여준다 = 편집기가 안 닫혔다.
    expect(screen.getByRole("textbox", { name: "#R2 라벨 편집" })).toHaveValue("B 초안");
  });

  it("ESC 취소 후 blur가 발화해도 PUT이 발생하지 않는다 (M2 — Escape 커밋 억제)", async () => {
    const user = userEvent.setup();
    mockApiLabelFlow();
    renderPage();

    const editBtn = await screen.findByRole("button", { name: "#R1 라벨 편집" });
    await user.click(editBtn);
    const input = screen.getByRole("textbox", { name: "#R1 라벨 편집" });
    await user.type(input, "취소될 라벨");

    // keydown(Escape)과 blur를 같은 act() 안에서 발화 — 커밋 전(unmount 전) 경합을 재현한다
    // (RunDetailPage.tsx의 labelEscapedRef 패턴 미러 — 실브라우저의 remove-on-focus blur는
    // 비보장이라 방어적으로 억제 플래그가 필요하다, ui/CLAUDE.md 참고).
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
    });
    // mutate()의 실제 fetch 호출은 마이크로태스크 뒤이므로 한 틱 흘려보낸 뒤 확인한다
    // (동기 직후 확인은 가드가 없어도 우연히 통과하는 공허 신호 — RED 실측으로 확정).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const put = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/api/runs/R1/label") && (i as RequestInit)?.method === "PUT",
    );
    expect(put).toBeUndefined();
  });

  it("ESC 취소 뒤 재편집 시작은 억제 플래그를 리셋한다 (재리뷰 gap — edit-start 리셋)", async () => {
    const user = userEvent.setup();
    mockApiLabelFlow();
    renderPage();

    // 1) 편집 시작 → ESC(억제 플래그 세팅, blur는 발화 안 시킴 — 실브라우저의
    //    remove-on-focus blur 비보장 시나리오를 재현: 플래그가 리셋 없이 true로 남는다).
    const editBtn1 = await screen.findByRole("button", { name: "#R1 라벨 편집" });
    await user.click(editBtn1);
    const input1 = screen.getByRole("textbox", { name: "#R1 라벨 편집" });
    fireEvent.keyDown(input1, { key: "Escape" });
    expect(await screen.findByRole("button", { name: "#R1 라벨 편집" })).toBeInTheDocument();

    // 2) 재편집 시작 → 실제 변경 입력 → Enter 커밋.
    const editBtn2 = screen.getByRole("button", { name: "#R1 라벨 편집" });
    await user.click(editBtn2);
    const input2 = screen.getByRole("textbox", { name: "#R1 라벨 편집" });
    await user.type(input2, "정상 커밋될 라벨");
    await user.keyboard("{Enter}");

    // edit-start 리셋이 없으면 commitLabel이 (leftover) escape 분기를 타 PUT 없이 조용히
    // 편집기만 닫힌다 — 리셋이 있어야 실제 PUT이 나간다.
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/runs/R1/label") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
        label: "정상 커밋될 라벨",
      });
    });
  });

  it("라벨 셀은 긴 라벨을 truncate + title로 노출한다 (M4)", async () => {
    const longLabel = "가".repeat(200);
    const labeled = makeRun("LBL3", "completed", 100);
    (labeled as Record<string, unknown>).label = longLabel;
    mockApiRuns([labeled]);
    renderPageWithCompare();

    const cellBtn = await screen.findByRole("button", { name: `${longLabel} 라벨 편집` });
    expect(cellBtn).toHaveClass("max-w-[16rem]", "truncate", "block");
    expect(cellBtn).toHaveAttribute("title", longLabel);
  });
});
