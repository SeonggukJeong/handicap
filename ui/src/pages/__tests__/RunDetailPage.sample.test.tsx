import { render, screen, waitFor } from "@testing-library/react";
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

type Sample = "passed" | "failed" | "all";
let splittable = true;

function reportFor(basis: "steady" | "whole", sample: Sample) {
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
    windows: [
      {
        ts_second: 100,
        n: 0,
        step_id: "01HX0000000000000000000001",
        count: 10,
        error_count: 0,
        status_counts: { "200": 10 },
        p50_ms: 10,
        p95_ms: 20,
        p99_ms: 30,
      },
    ],
    steps: [],
    status_distribution: { "200": 10 },
    dropped: 0,
    basis: {
      selected: basis,
      default: "steady",
      state: "measured",
      config: STEADY,
      window: { start_ms: 1000, end_ms: 2000, measured_seconds: 265 },
      t0_estimated: false,
      dropped_whole_run: false,
      other: null,
    },
    sample: splittable
      ? { selected: sample, default: "passed", split: true }
      : { selected: "all", default: "all", split: false },
  };
}

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
const paramsOf = (u: string) => new URL(u, "http://x").searchParams;
const SAMPLE_GROUP = { name: "응답 시간 표본 고르기" };

beforeEach(() => {
  splittable = true;
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
          profile: PROFILE,
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
      const p = paramsOf(url);
      const s = p.get("sample");
      return Promise.resolve(
        jsonResponse(
          reportFor(
            p.get("basis") === "whole" ? "whole" : "steady",
            s === "failed" || s === "all" ? s : "passed",
          ),
        ),
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

describe("RunDetailPage — 응답 시간 표본 주소", () => {
  it("주소의 sample=failed로 열면 그 표본을 받는다", async () => {
    renderAt("/runs/R?sample=failed");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    expect(reportCalls().map((u) => paramsOf(u).get("sample"))).toEqual(["failed"]);
    expect(screen.getByRole("radio", { name: "실패한 요청" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("잘못된 sample 값은 무시한다", async () => {
    renderAt("/runs/R?sample=xyz");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    expect(reportCalls().map((u) => paramsOf(u).has("sample"))).toEqual([false]);
  });

  it("basis와 sample을 함께 받는다", async () => {
    renderAt("/runs/R?basis=whole&sample=all");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    const p = paramsOf(reportCalls()[0]);
    expect(p.get("basis")).toBe("whole");
    expect(p.get("sample")).toBe("all");
  });

  it("표본을 고르면 주소가 바뀌고, 기본 표본으로 돌아오면 사라진다", async () => {
    const user = userEvent.setup();
    renderAt("/runs/R");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    await user.click(screen.getByRole("radio", { name: "실패한 요청" }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?sample=failed"));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "실패한 요청" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    await user.click(screen.getByRole("radio", { name: "통과한 요청" }));
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
  });

  it("표본을 받는 동안 눌린 단추는 요청한 표본을 따른다", async () => {
    const user = userEvent.setup();
    const base = fetchMock.getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fetchMock.mockImplementation((url: string) =>
      url.includes("sample=failed") ? gate.then(() => base(url)) : base(url),
    );
    renderAt("/runs/R");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    await user.click(screen.getByRole("radio", { name: "실패한 요청" }));
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", SAMPLE_GROUP)).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.getByRole("radio", { name: "실패한 요청" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    release();
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", SAMPLE_GROUP)).not.toHaveAttribute("aria-busy"),
    );
  });

  it("표본을 바꾼 채 기준을 바꾸면 sample이 주소에 남는다", async () => {
    const user = userEvent.setup();
    renderAt("/runs/R?sample=failed");
    await screen.findByRole("radiogroup", { name: "집계 기준" });
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    await waitFor(() => {
      const s = screen.getByTestId("search").textContent ?? "";
      expect(s).toContain("basis=whole");
      expect(s).toContain("sample=failed");
    });
  });

  it("기준을 바꾼 채 표본을 바꾸면 basis가 주소에 남는다", async () => {
    const user = userEvent.setup();
    renderAt("/runs/R?basis=whole");
    await screen.findByRole("radiogroup", SAMPLE_GROUP);
    await user.click(screen.getByRole("radio", { name: "실패한 요청" }));
    await waitFor(() => {
      const s = screen.getByTestId("search").textContent ?? "";
      expect(s).toContain("basis=whole");
      expect(s).toContain("sample=failed");
    });
  });

  it("나눌 수 없는 run은 sample=failed로 열어도 그대로 보인다", async () => {
    splittable = false;
    renderAt("/runs/R?sample=failed");
    await screen.findByText("모든 요청 (실패한 요청 포함)");
    expect(screen.queryByRole("radiogroup", SAMPLE_GROUP)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
