import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PrintDocument } from "../PrintDocument";
import { buildPrintDoc, type PrintDoc, type PrintKind } from "../buildPrintDoc";
import { PX_PER_MM } from "../paginate";
import type { Report, Run } from "../../api/schemas";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const T0 = 1_700_000_000_000;

const profile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

const STEPS: { id: string; name: string; counts: Record<string, number>; errors: number }[] = [
  { id: "s0", name: "로그인", counts: { "200": 1000 }, errors: 0 },
  { id: "s1", name: "목록", counts: { "200": 990, "404": 10 }, errors: 10 },
  { id: "s2", name: "제출", counts: { "200": 700, "503": 300 }, errors: 300 },
];

function makeDoc(): PrintDoc {
  let yaml = `version: 1\nname: "기준선 흐름"\nsteps:\n`;
  for (const s of STEPS) {
    yaml += `  - id: "${s.id}"\n    name: "${s.name}"\n    request:\n`;
    yaml += `      method: GET\n      url: "https://api.example.com/${s.id}"\n`;
  }
  const run: Run = {
    id: "01HZZZZZZZZZZZZZZZZZa91f3c",
    scenario_id: "sc1",
    scenario_yaml: yaml,
    status: "completed",
    profile: profile as Run["profile"],
    env: null,
    started_at: null,
    ended_at: null,
    created_at: T0,
    message: null,
    verdict: null,
    last_metric_ts: null,
    label: null,
  };
  const report: Report = {
    run: {
      id: run.id,
      scenario_id: "sc1",
      status: "completed",
      profile,
      env: null,
      started_at: null,
      ended_at: null,
      created_at: T0,
    },
    scenario_yaml: yaml,
    summary: {
      count: 3000,
      errors: 310,
      rps: 10,
      duration_seconds: 300,
      mean_ms: 840,
      p50_ms: 500,
      p95_ms: 2400,
      p99_ms: 3000,
    },
    windows: [],
    steps: STEPS.map((s) => ({
      step_id: s.id,
      count: Object.values(s.counts).reduce((a, b) => a + b, 0),
      error_count: s.errors,
      status_counts: s.counts,
      p50_ms: 100,
      p95_ms: 600,
      p99_ms: 900,
    })),
    status_distribution: {},
    verdict: null,
    dropped: 0,
    latency: null,
  };
  return buildPrintDoc({ run, report, fallbackScenarioName: null, now: NOW });
}

/** jsdom은 레이아웃이 없다 — data-measure 가진 요소마다 같은 높이(mm)를 준다. */
function spyHeights(mm: number) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const h = this.hasAttribute("data-measure") ? mm * PX_PER_MM : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: h,
      width: 0,
      height: h,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

async function renderHtml(kind: PrintKind): Promise<{ html: string; sheetHidden: string | null }> {
  const { container } = render(
    <div className="p-root">
      <PrintDocument doc={makeDoc()} kind={kind} />
    </div>,
  );
  const root = container.querySelector(".p-doc") as HTMLElement;
  expect(root).toHaveAttribute("data-layout-ready", "false");
  const sheetHidden = root.querySelector(".p-sheet")?.getAttribute("aria-hidden") ?? null;
  await waitFor(() => expect(root).toHaveAttribute("data-layout-ready", "true"));
  return { html: container.querySelector(".p-doc")!.outerHTML, sheetHidden };
}

afterEach(() => vi.restoreAllMocks());

describe("PrintDocument 쪽 나누기 틀 (출력 고정)", () => {
  it("표준판 출력이 고정되고 측정 시트는 aria-hidden", async () => {
    spyHeights(40);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { html, sheetHidden } = await renderHtml("standard");
    expect(warn).not.toHaveBeenCalled();
    expect(sheetHidden).toBe("true");
    expect(html).not.toMatch(/\d{1,2}:\d{2}/);
    await expect(html).toMatchFileSnapshot("./__snapshots__/paged-standard.html");
  });

  it("요약판 출력이 고정되고 측정 시트는 aria-hidden", async () => {
    spyHeights(40);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { html, sheetHidden } = await renderHtml("summary");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/does not fit one page/));
    expect(sheetHidden).toBe("true");
    expect(html).not.toMatch(/\d{1,2}:\d{2}/);
    await expect(html).toMatchFileSnapshot("./__snapshots__/paged-summary.html");
  });
});
