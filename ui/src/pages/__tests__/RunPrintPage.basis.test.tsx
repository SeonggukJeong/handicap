import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { RunPrintPage } from "../RunPrintPage";
import { api } from "../../api/client";
import type { ReportBasis } from "../../api/schemas";

const STEP_ID = "01HX0000000000000000000001";
const T0 = 1_700_000_000_000;
const YAML = [
  "version: 1",
  'name: "주문 흐름"',
  "steps:",
  `  - id: ${STEP_ID}`,
  '    name: "로그인"',
  "    request:",
  "      method: GET",
  '      url: "https://api.example.com/login"',
  "",
].join("\n");

const profile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

const run = {
  id: "R1",
  scenario_id: "S1",
  scenario_yaml: YAML,
  status: "completed",
  profile,
  env: null,
  started_at: T0,
  ended_at: T0 + 60_000,
  created_at: T0,
  message: null,
  verdict: null,
  last_metric_ts: null,
  label: null,
};

const basisOf = (selected: "steady" | "whole", over: Partial<ReportBasis> = {}): ReportBasis => ({
  selected,
  default: "steady",
  state: "measured",
  config: { ramp_seconds: 20, hold_seconds: 45, discard_seconds: 5 },
  window: { start_ms: T0 + 25_000, end_ms: T0 + 60_000, measured_seconds: 35 },
  t0_estimated: false,
  dropped_whole_run: false,
  other: {
    rps: 40.5,
    p50_ms: 15,
    p95_ms: 90,
    p99_ms: 130,
    error_rate: 0.01,
    count: 900,
    duration_seconds: 60,
  },
  ...over,
});

const reportOf = (basis: ReportBasis) => ({
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile,
    env: null,
    started_at: T0,
    ended_at: T0 + 60_000,
    created_at: T0,
  },
  scenario_yaml: YAML,
  verdict: null,
  summary: {
    count: 50,
    errors: 0,
    rps: 10,
    duration_seconds: 60,
    mean_ms: 20,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [0, 1, 2].map((i) => ({
    ts_second: T0 / 1000 + 30 + i,
    n: 0,
    step_id: STEP_ID,
    count: 10,
    error_count: 0,
    status_counts: { "200": 10 },
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  })),
  steps: [
    {
      step_id: STEP_ID,
      count: 50,
      error_count: 0,
      status_counts: { "200": 50 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
      loop_breakdown: [],
    },
  ],
  status_distribution: { "200": 50 },
  dropped: 0,
  basis,
});

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.pathname + loc.search}</output>;
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/runs/:id/print" element={<RunPrintPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let getReport: MockInstance<typeof api.getRunReport>;

beforeEach(() => {
  vi.spyOn(api, "getRun").mockResolvedValue(run as never);
  vi.spyOn(api, "getScenario").mockResolvedValue({
    id: "S1",
    name: "주문 흐름",
    yaml: YAML,
    version: 1,
    created_at: T0,
    updated_at: T0,
    group: null,
  } as never);
  getReport = vi
    .spyOn(api, "getRunReport")
    .mockImplementation(((_id: string, basis?: "steady" | "whole") =>
      Promise.resolve(reportOf(basisOf(basis ?? "steady")))) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunPrintPage — basis 주소 파라미터", () => {
  it("?basis=whole이면 그 기준으로 리포트를 받는다", async () => {
    renderPage("/runs/R1/print?basis=whole");
    await screen.findByText("집계 기준");
    expect(getReport).toHaveBeenCalledWith("R1", "whole", undefined);
  });

  it("basis 파라미터가 없으면 기준 없이 받는다", async () => {
    renderPage("/runs/R1/print");
    await screen.findByText("집계 기준");
    expect(getReport).toHaveBeenCalledWith("R1", undefined, undefined);
  });

  it("kind_switch_keeps_basis_param: 요약으로 바꿔도 basis=whole이 주소에 남는다", async () => {
    const user = userEvent.setup();
    renderPage("/runs/R1/print?basis=whole");
    await screen.findByText("집계 기준");
    await user.click(screen.getByRole("button", { name: "요약판" }));
    const loc = screen.getByTestId("loc").textContent ?? "";
    expect(loc).toContain("basis=whole");
    expect(loc).toContain("kind=summary");
  });

  it("back_link_keeps_basis_param: 돌아가기가 /runs/{id}?basis=whole", async () => {
    renderPage("/runs/R1/print?basis=whole");
    await screen.findByText("집계 기준");
    expect(screen.getByRole("link", { name: "돌아가기" })).toHaveAttribute(
      "href",
      "/runs/R1?basis=whole",
    );
  });

  it("basis 파라미터가 없으면 돌아가기는 /runs/{id}", async () => {
    renderPage("/runs/R1/print");
    await screen.findByText("집계 기준");
    expect(screen.getByRole("link", { name: "돌아가기" })).toHaveAttribute("href", "/runs/R1");
  });

  it("머리에 집계 기준 줄과 참고 줄이 찍힌다", async () => {
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(screen.getAllByText("집계 기준").length).toBeGreaterThan(0);
      expect(screen.getAllByText("참고").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/^유지 구간 · /).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/^전체 구간: 초당 요청 40\.5/).length).toBeGreaterThan(0);
    });
  });

  it("print_page_shows_whole_when_steady_requested_but_not_reached", async () => {
    getReport.mockImplementation((() =>
      Promise.resolve(
        reportOf(basisOf("whole", { state: "not_reached", window: null, other: null })),
      )) as never);
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(screen.getAllByText(/^전체 구간 · 상승 20초 포함/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/유지 구간 ·/)).toBeNull();
  });
});

describe("RunPrintPage — 머리 격자와 집계 기준 줄", () => {
  const metaLabels = (meta: Element): string[] =>
    [...meta.children].map((c) => c.querySelector("span")?.textContent ?? "");
  const rowLabels = (el: Element): string[] =>
    [...el.children].map((c) => c.querySelector("span")?.textContent ?? "");

  it("p-meta는 기준 유무와 상관없이 원래 네 칸 그대로", async () => {
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(document.querySelectorAll(".p-meta").length).toBeGreaterThan(0);
    });
    for (const meta of document.querySelectorAll(".p-meta")) {
      expect(metaLabels(meta)).toEqual(["대상 시스템", "측정 일시", "부하 조건", "측정 식별"]);
    }
  });

  it("steady 기준 리포트: p-meta-basis에 집계 기준, 참고 두 줄", async () => {
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(document.querySelectorAll(".p-meta-basis").length).toBeGreaterThan(0);
    });
    for (const block of document.querySelectorAll(".p-meta-basis")) {
      expect(rowLabels(block)).toEqual(["집계 기준", "참고"]);
      expect(block.children[0].textContent).toMatch(/^집계 기준유지 구간 · /);
      expect(block.children[1].textContent).toMatch(/^참고전체 구간: 초당 요청 40\.5/);
    }
  });

  it("p-meta-basis 줄은 라벨 span 하나 다음에 값 요소 하나 (줄바꿈·정렬은 CSS 텍스트로만 검사: jsdom은 레이아웃을 못 본다)", async () => {
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(document.querySelectorAll(".p-meta-basis").length).toBeGreaterThan(0);
    });
    for (const block of document.querySelectorAll(".p-meta-basis")) {
      for (const row of block.children) {
        expect([...row.children].map((c) => c.tagName + "." + c.className)).toEqual([
          "SPAN.",
          "DIV.p-meta-basis-value",
        ]);
        expect(row.children[1].textContent).not.toBe("");
      }
    }
    const css = readFileSync(`${process.cwd()}/src/print/print.css`, "utf8");
    const rule = (sel: string) => {
      const i = css.indexOf(sel + " {");
      expect(i).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf("}", i));
    };
    expect(rule(".p-root .p-meta-basis span")).toContain("white-space: nowrap");
    expect(rule(".p-root .p-meta-basis span")).toContain("min-width: 15mm");
    expect(rule(".p-root .p-meta-basis-value")).toContain("min-width: 0");
  });

  it("whole(not_reached) 리포트: 참고 줄 없이 한 줄", async () => {
    getReport.mockImplementation((() =>
      Promise.resolve(
        reportOf(basisOf("whole", { state: "not_reached", window: null, other: null })),
      )) as never);
    renderPage("/runs/R1/print?basis=steady");
    await waitFor(() => {
      expect(document.querySelectorAll(".p-meta-basis").length).toBeGreaterThan(0);
    });
    for (const block of document.querySelectorAll(".p-meta-basis")) {
      expect(rowLabels(block)).toEqual(["집계 기준"]);
    }
  });

  it("basis 블록이 없는 리포트: p-meta-basis가 없다", async () => {
    getReport.mockImplementation((() => {
      const r: Record<string, unknown> = { ...reportOf(basisOf("steady")) };
      delete r.basis;
      return Promise.resolve(r);
    }) as never);
    renderPage("/runs/R1/print");
    await waitFor(() => {
      expect(document.querySelectorAll(".p-meta").length).toBeGreaterThan(0);
    });
    expect(document.querySelectorAll(".p-meta-basis")).toHaveLength(0);
  });
});
