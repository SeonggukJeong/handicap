import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetailPage } from "../RunDetailPage";

const YAML = "version: 1\nname: x\ncookie_jar: auto\nvariables: {}\nsteps: []\n";
const STEADY = { ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 };
const PROFILE = {
  vus: 0,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  target_rps: 80,
  steady: STEADY,
};

function reportFor(selected: "steady" | "whole") {
  return {
    run: {
      id: "R",
      scenario_id: "S",
      status: "completed",
      profile: PROFILE,
      env: {},
      started_at: 100,
      ended_at: 400,
      created_at: 99,
    },
    scenario_yaml: YAML,
    summary: {
      count: 10,
      errors: 0,
      rps: 5.0,
      duration_seconds: 2,
      mean_ms: 15,
      p50_ms: 10,
      p95_ms: 20,
      p99_ms: 30,
    },
    windows: [],
    steps: [],
    status_distribution: { "200": 10 },
    dropped: 0,
    basis: {
      selected,
      default: "steady",
      state: "measured",
      config: STEADY,
      window: { start_ms: 1000, end_ms: 2000, measured_seconds: 265 },
      t0_estimated: false,
      dropped_whole_run: false,
      other: null,
    },
  };
}

let runProfile: Record<string, unknown> = PROFILE;

const fetchMock = vi.fn();
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function Probe() {
  const loc = useLocation();
  return <div data-testid="search">{loc.search}</div>;
}

function renderAt(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const reportCalls = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/runs/R/report"));

beforeEach(() => {
  runProfile = PROFILE;
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/runs/R")) {
      return Promise.resolve(
        jsonResponse({
          id: "R",
          scenario_id: "S",
          scenario_yaml: YAML,
          status: "completed",
          profile: runProfile,
          env: {},
          started_at: 100,
          ended_at: 400,
          created_at: 99,
        }),
      );
    }
    if (url.endsWith("/api/runs/R/metrics")) {
      return Promise.resolve(jsonResponse({ run_id: "R", windows: [] }));
    }
    if (url.includes("/api/runs/R/report")) {
      return Promise.resolve(
        jsonResponse(reportFor(url.endsWith("?basis=whole") ? "whole" : "steady")),
      );
    }
    if (url.endsWith("/api/scenarios/S")) {
      return Promise.resolve(
        jsonResponse({
          id: "S",
          name: "x",
          yaml: YAML,
          version: 1,
          created_at: 1,
          updated_at: 1,
          group: null,
        }),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
});

describe("RunDetailPage — 위쪽 카드의 「전체 구간」 표지", () => {
  const badged = ["테스트 시간", "총 요청 수", "에러", "평균 RPS"];

  it("상승·버림이 있는 run은 run 전체 값 카드 넷에 표지가 붙는다", async () => {
    renderAt("/runs/R");
    const cards = await screen.findByTestId("run-cards");
    for (const label of badged) {
      const card = within(cards).getByText(label).closest("[data-card]") as HTMLElement;
      expect(within(card).getByText("전체 구간")).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "전체 구간 값 설명" })).toBeInTheDocument();
    }
    expect(within(cards).getAllByText("전체 구간")).toHaveLength(4);
  });

  it("상승·버림이 없는 run은 표지가 없다", async () => {
    runProfile = { vus: 0, ramp_up_seconds: 0, duration_seconds: 300, target_rps: 80 };
    renderAt("/runs/R");
    const cards = await screen.findByTestId("run-cards");
    expect(within(cards).getByText("총 요청 수")).toBeInTheDocument();
    expect(within(cards).queryByText("전체 구간")).toBeNull();
  });
});

describe("RunDetailPage — 집계 기준 주소", () => {
  it("주소의 basis=whole로 열면 그 기준을 받는다", async () => {
    renderAt("/runs/R?basis=whole");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    expect(reportCalls()).toEqual([expect.stringMatching(/\/api\/runs\/R\/report\?basis=whole$/)]);
    expect(screen.getByRole("radio", { name: "전체 구간" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("전환하면 주소가 바뀌고 새 기준을 받는다", async () => {
    const user = userEvent.setup();
    renderAt("/runs/R");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    expect(screen.getByTestId("search").textContent).toBe("");
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?basis=whole"));
    await waitFor(() =>
      expect(reportCalls().filter((u) => u.endsWith("?basis=whole"))).toHaveLength(1),
    );
  });

  it("기본 기준으로 돌아오면 주소에서 사라진다", async () => {
    const user = userEvent.setup();
    renderAt("/runs/R");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?basis=whole"));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "전체 구간" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    await user.click(screen.getByRole("radio", { name: "유지 구간" }));
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
  });

  it("새 기준을 받는 동안 전환이 aria-busy이고 받으면 풀린다", async () => {
    const user = userEvent.setup();
    const base = fetchMock.getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("?basis=whole") ? gate.then(() => base(url)) : base(url),
    );
    renderAt("/runs/R");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    expect(screen.getByRole("radiogroup", { name: "집계 기준" })).not.toHaveAttribute("aria-busy");
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", { name: "집계 기준" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    release();
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", { name: "집계 기준" })).not.toHaveAttribute(
        "aria-busy",
      ),
    );
  });

  it("잘못된 basis 값은 무시한다", async () => {
    renderAt("/runs/R?basis=x");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    expect(reportCalls()).toEqual([expect.stringMatching(/\/api\/runs\/R\/report$/)]);
  });
});
