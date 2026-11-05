import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { PrintDocument } from "../PrintDocument";
import { buildPrintDoc, type PrintDoc, type PrintKind } from "../buildPrintDoc";
import { PX_PER_MM } from "../paginate";
import { requestLineBudget } from "../redact";
import { LABEL_CHAR_MM, PLOT_X1_MM } from "../chartModel";
import type { Report, Run } from "../../api/schemas";

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const T0 = 1_700_000_000_000;

const baseProfile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 300,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

type StepSpec = {
  id: string;
  name: string;
  method?: string;
  url?: string;
  assert?: number[];
  extract?: boolean;
  counts: Record<string, number>;
  errors: number;
  p95?: number;
};

const q = (s: string) => JSON.stringify(s);

function yamlFor(name: string, steps: StepSpec[]): string {
  let y = `version: 1\nname: ${q(name)}\nsteps:\n`;
  for (const s of steps) {
    y += `  - id: ${q(s.id)}\n    name: ${q(s.name)}\n    request:\n`;
    y += `      method: ${s.method ?? "GET"}\n      url: ${q(s.url ?? `https://api.example.com/${s.id}`)}\n`;
    if (s.assert && s.assert.length > 0) {
      y += `    assert:\n`;
      for (const c of s.assert) y += `      - status: ${c}\n`;
    }
    if (s.extract) {
      y += `    extract:\n      - name: tok\n        from: body\n        path: "$.t"\n`;
    }
  }
  return y;
}

type Fixture = {
  steps: StepSpec[];
  yaml?: string;
  name?: string;
  status?: string;
  startedAt?: number | null;
  env?: Record<string, string> | null;
  profile?: Record<string, unknown>;
  verdict?: Report["verdict"];
  summary?: Partial<Report["summary"]>;
  windows?: Report["windows"];
};

function makeDoc(f: Fixture): PrintDoc {
  const startedAt = f.startedAt === undefined ? T0 : f.startedAt;
  const status = f.status ?? "completed";
  const profile = f.profile ?? baseProfile;
  const env = f.env ?? null;
  const count = f.steps.reduce((a, s) => a + Object.values(s.counts).reduce((x, y) => x + y, 0), 0);
  const errors = f.steps.reduce((a, s) => a + s.errors, 0);
  const run: Run = {
    id: "01HZZZZZZZZZZZZZZZZZa91f3c",
    scenario_id: "sc1",
    scenario_yaml: f.yaml ?? yamlFor(f.name ?? "민원 신청 흐름", f.steps),
    status: status as Run["status"],
    profile: profile as Run["profile"],
    env,
    started_at: startedAt,
    ended_at: T0 + 300_000,
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
      status,
      profile,
      env,
      started_at: startedAt,
      ended_at: T0 + 300_000,
      created_at: T0,
    },
    scenario_yaml: run.scenario_yaml,
    summary: {
      count,
      errors,
      rps: count / 300,
      duration_seconds: 300,
      mean_ms: 840,
      p50_ms: 500,
      p95_ms: 2400,
      p99_ms: 3000,
      ...f.summary,
    },
    windows: f.windows ?? [],
    steps: f.steps.map((s) => ({
      step_id: s.id,
      count: Object.values(s.counts).reduce((x, y) => x + y, 0),
      error_count: s.errors,
      status_counts: s.counts,
      p50_ms: 100,
      p95_ms: s.p95 ?? 600,
      p99_ms: 900,
    })),
    status_distribution: {},
    verdict: f.verdict ?? null,
    dropped: 0,
    latency: null,
  };
  return buildPrintDoc({ run, report, fallbackScenarioName: null, now: NOW });
}

const t0s = Math.floor(T0 / 1000);
const win = (
  sec: number,
  stepId: string,
  count: number,
  errors: number,
  codes: Record<string, number>,
) => ({
  ts_second: t0s + sec,
  step_id: stepId,
  count,
  error_count: errors,
  status_counts: codes,
  p50_ms: 100,
  p95_ms: 600,
  p99_ms: 900,
});

const coreSteps: StepSpec[] = [
  {
    id: "s0",
    name: "로그인",
    method: "POST",
    url: "https://api.example.com/auth/login",
    assert: [200],
    counts: { "200": 1000 },
    errors: 0,
  },
  {
    id: "s1",
    name: "민원 목록",
    url: "https://api.example.com/petitions",
    assert: [200],
    counts: { "200": 990, "404": 10 },
    errors: 10,
  },
  {
    id: "s2",
    name: "민원 상세",
    url: "https://api.example.com/petitions/{{id}}",
    assert: [200],
    counts: { "200": 1000 },
    errors: 0,
  },
  {
    id: "s3",
    name: "첨부 업로드",
    method: "POST",
    url: "https://api.example.com/files",
    counts: { "200": 400, "502": 600 },
    errors: 0,
  },
  {
    id: "s4",
    name: "신청 제출",
    method: "POST",
    url: "https://api.example.com/petitions",
    assert: [200],
    counts: { "200": 700, "503": 300 },
    errors: 300,
  },
];

const coreFixture: Fixture = {
  steps: coreSteps,
  profile: {
    ...baseProfile,
    criteria: { max_error_rate: 0.01, max_p95_ms: 3000, min_rps: 10 },
  },
  verdict: {
    passed: false,
    criteria: [
      { metric: "p95_ms", direction: "max", threshold: 3000, actual: 2400, passed: true },
      { metric: "error_rate", direction: "max", threshold: 0.01, actual: 0.062, passed: false },
      { metric: "rps", direction: "min", threshold: 10, actual: 16.7, passed: true },
    ],
  },
  windows: [
    win(0, "s0", 100, 0, { "200": 100 }),
    win(60, "s4", 100, 0, { "200": 100 }),
    win(240, "s4", 100, 80, { "200": 20, "503": 80 }),
    win(299, "s1", 50, 10, { "200": 40, "404": 10 }),
  ],
};

function renderDoc(doc: PrintDoc, kind: PrintKind = "standard", onLadder?: (l: number) => void) {
  const utils = render(
    <div className="p-root">
      <PrintDocument doc={doc} kind={kind} onLadder={onLadder} />
    </div>,
  );
  const root = utils.container.querySelector(".p-doc") as HTMLElement;
  return { ...utils, root };
}

async function ready(root: HTMLElement) {
  await waitFor(() => expect(root).toHaveAttribute("data-layout-ready", "true"));
}

/** jsdom은 레이아웃이 없다 — data-measure 값으로 높이(mm)를 정한다. */
function spyHeights(mmFor: (id: string) => number) {
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.getAttribute("data-measure") ?? "";
    const h = mmFor(id) * PX_PER_MM;
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

const manySteps = (n: number): StepSpec[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `단계${i}`,
    assert: [200],
    counts: { "200": 100 },
    errors: 0,
  }));

describe("PrintDocument", () => {
  it("renders_core_sections", async () => {
    const { root, container } = renderDoc(makeDoc(coreFixture));
    await ready(root);
    expect(screen.getByText("✕ 부적합")).toBeInTheDocument();
    expect(screen.getByText("평가한 기준 3개 중 1개 미달")).toBeInTheDocument();
    for (const label of ["처리량", "평균 응답시간", "95% 응답시간", "오류율"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const th503 = screen.getByText("503").closest("th");
    expect(th503).not.toBeNull();
    expect(within(th503 as HTMLElement).getByText("서버가 바쁨")).toBeInTheDocument();
    expect(screen.getByText("안 셈")).toBeInTheDocument();
    const callout = container.querySelector(".p-callout");
    expect(callout?.textContent?.startsWith("확인 필요:")).toBe(true);
    expect(screen.getByRole("img", { name: "시간에 따른 처리량과 오류 차트" })).toBeInTheDocument();
    expect(screen.getByText("503: 서버가 바쁨")).toBeInTheDocument();
    expect(screen.getByText("시험자")).toBeInTheDocument();
    expect(screen.getByText("Handicap 부하 테스트 도구로 생성")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByText("민원 신청 흐름 부하 측정 · #a91f3c")).toBeInTheDocument();
  });

  it("measure_sheet_unmounted_after_layout", async () => {
    const { root, container } = renderDoc(makeDoc(coreFixture));
    expect(root).toHaveAttribute("data-layout-ready", "false");
    const measured = container.querySelectorAll("[data-measure]");
    expect(measured.length).toBeGreaterThan(0);
    for (const el of measured) expect(el.closest('[aria-hidden="true"]')).not.toBeNull();
    await ready(root);
    expect(container.querySelectorAll("[data-measure]").length).toBe(0);
    expect(container.querySelector('[aria-hidden="true"].p-sheet')).toBeNull();
  });

  it("multi_page_continuation", async () => {
    const spy = spyHeights((id) => (id.startsWith("row:") ? 30 : 10));
    try {
      const { root, container } = renderDoc(makeDoc({ steps: manySteps(20) }));
      await ready(root);
      const pages = [...container.querySelectorAll<HTMLElement>(".p-page")];
      expect(pages.length).toBeGreaterThanOrEqual(2);
      const n = pages.length;
      pages.forEach((p, i) => {
        expect(p.classList.contains("p-page--last")).toBe(i === n - 1);
      });
      const p2 = within(pages[1]);
      expect(p2.getByText("요청 수")).toBeInTheDocument();
      expect(p2.getByText("2. 어디가 문제인가 — 단계별 결과 (이어짐)")).toBeInTheDocument();
      expect(within(pages[0]).getByText("2. 어디가 문제인가 — 단계별 결과")).toBeInTheDocument();
      expect(within(pages[0]).getByText(`1 / ${n}`)).toBeInTheDocument();
      expect(within(pages[n - 1]).getByText(`${n} / ${n}`)).toBeInTheDocument();
      // 모든 단계가 정확히 한 번씩 쪽에 실린다
      expect(container.querySelectorAll("tbody tr").length).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it("long_names_clamp", async () => {
    const longName = "가".repeat(120);
    const longPath = "/" + "p".repeat(199);
    const doc = makeDoc({
      steps: [
        {
          id: "s0",
          name: longName,
          url: `https://api.example.com${longPath}`,
          assert: [200],
          counts: { "200": 100, "400": 5, "404": 5, "500": 5, "503": 5, "0": 5 },
          errors: 30,
        },
      ],
    });
    expect(doc.table.columns.length).toBe(7);
    const { root, container } = renderDoc(doc);
    await ready(root);
    const nameMm = 180 - (15 + 13 + 6 * 12 + 16 + 20);
    const budget = requestLineBudget(nameMm);
    expect(budget).toBe(33);
    const name = container.querySelector(".p-name");
    expect(name?.textContent).toContain(longName);
    const req = container.querySelector(".p-req");
    expect(req?.textContent?.length).toBe(budget);
    expect(req?.textContent).toContain("…");
    const firstCol = container.querySelector(".p-steps colgroup col") as HTMLElement;
    expect(firstCol.style.width).toBe(`${nameMm}mm`);
  });

  it("no_code_columns", async () => {
    const doc = makeDoc({ steps: [], yaml: "a: [unclosed" });
    const { root, container } = renderDoc(doc);
    await ready(root);
    expect(container.textContent).not.toContain("응답 코드별 건수");
    expect(container.querySelectorAll('[colspan="0"]').length).toBe(0);
    expect(screen.getByText("요청 수")).toBeInTheDocument();
  });

  it("never_prints_env_values", async () => {
    const doc = makeDoc({
      env: { BASE_URL: "https://admin:pw@api.local", TOKEN: "S3CR3T" },
      steps: [
        {
          id: "s0",
          name: "조회",
          url: "${BASE_URL}/x?t=${TOKEN}",
          assert: [200],
          counts: { "200": 100 },
          errors: 0,
        },
      ],
    });
    const { root, container } = renderDoc(doc);
    await ready(root);
    for (const secret of ["admin", "pw@", "S3CR3T"]) {
      expect(container.textContent).not.toContain(secret);
      expect(container.innerHTML).not.toContain(secret);
    }
    expect(container.textContent).toContain("api.local");
  });

  it("renders_zero_request_aborted_run", async () => {
    const doc = makeDoc({
      steps: [],
      yaml: "a: [unclosed",
      status: "aborted",
      startedAt: null,
      windows: [],
      summary: { count: 0, errors: 0, rps: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
    });
    const { root, container } = renderDoc(doc);
    await ready(root);
    expect(screen.getByText("판정 안 함")).toBeInTheDocument();
    expect(screen.getByText("요청이 실행되지 않아 판정하지 않았습니다")).toBeInTheDocument();
    expect(screen.getByText("오류 없음")).toBeInTheDocument();
    expect(container.querySelector(".p-steps thead")).not.toBeNull();
    expect(screen.getByText("단계")).toBeInTheDocument();
    for (const bad of ["NaN", "Infinity", "undefined"]) {
      expect(container.innerHTML).not.toContain(bad);
    }
  });

  it("summary_kind_has_no_chart", async () => {
    const { root, container } = renderDoc(makeDoc(coreFixture), "summary");
    await ready(root);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("시험자")).toBeNull();
    expect(container.textContent).not.toContain("5. 용어 풀이");
    expect(container.textContent).not.toContain("3. 시간에 따른 변화");
    expect(screen.getByText("✕ 부적합")).toBeInTheDocument();
    expect(screen.getByText("평균 응답시간")).toBeInTheDocument();
    expect(screen.getByText("요청 수")).toBeInTheDocument();
    expect(container.querySelectorAll(".p-page").length).toBe(1);
  });

  it("summary_ladder_reports_level", async () => {
    const steps: StepSpec[] = manySteps(20);
    const onLadder = vi.fn();
    const spy = spyHeights((id) => (id.startsWith("row:") ? 30 : 10));
    try {
      const { root, container } = renderDoc(makeDoc({ steps }), "summary", onLadder);
      await ready(root);
      // 8행(240) + 나머지 줄 + 머리 등 → 넘침, 6행이면 들어간다(사다리 7단계)
      await waitFor(() => expect(onLadder).toHaveBeenLastCalledWith(7));
      expect(container.querySelectorAll(".p-page").length).toBe(1);
      expect(container.querySelectorAll("tbody tr").length).toBe(7);
      expect(screen.getByText("나머지 14개 단계: 모두 정상")).toBeInTheDocument();
      const remainder = screen.getByText("나머지 14개 단계: 모두 정상").closest("td");
      const cols = container.querySelectorAll("table.p-steps colgroup col").length;
      expect(remainder?.getAttribute("colspan")).toBe(String(cols));
    } finally {
      spy.mockRestore();
    }
  });

  it("standard_reports_level_zero", async () => {
    const onLadder = vi.fn();
    const { root } = renderDoc(makeDoc(coreFixture), "standard", onLadder);
    await ready(root);
    await waitFor(() => expect(onLadder).toHaveBeenCalledWith(0));
  });

  it("bw_markers", async () => {
    const steps: StepSpec[] = [
      ...coreSteps,
      { id: "s5", name: "토큰 꺼내기", extract: true, counts: { "200": 90, "500": 10 }, errors: 4 },
    ];
    const { root, container } = renderDoc(makeDoc({ ...coreFixture, steps }));
    await ready(root);
    const strongest = [...container.querySelectorAll(".p-cell--strongest")];
    const s4 = strongest.find((el) => el.textContent === "300");
    expect(s4).toBeDefined();
    expect(s4?.classList.contains("p-cell--counted")).toBe(true);
    const uncounted = container.querySelector(".p-cell--uncounted");
    expect(uncounted?.textContent).toContain("600");
    expect(uncounted?.textContent).toContain("안 셈");
    const unknown = container.querySelector(".p-cell--unknown");
    expect(unknown?.textContent).toContain("10");
    expect(unknown?.textContent).toContain("?");
    // 잔차(4건)는 확인 불가 칸이 있는 단계라 접미가 붙는다
    expect(container.textContent).toContain("(일부는 ? 칸과 같은 응답)");
  });

  it("colgroup_fixed", async () => {
    const doc = makeDoc(coreFixture);
    const { root, container } = renderDoc(doc);
    await ready(root);
    const table = container.querySelector("table.p-steps") as HTMLTableElement;
    expect(table.classList.contains("p-table")).toBe(true);
    const cols = table.querySelectorAll("colgroup col");
    expect(cols.length).toBe(3 + doc.table.columns.length + 1);
    const firstRowCells = table.querySelectorAll("tbody tr:first-child td");
    expect(firstRowCells.length).toBe(cols.length);
  });

  it("chart_marker_label_stays_inside_plot", async () => {
    // 오류가 마지막 몇 초에만 → 표시선이 오른쪽 끝 근처
    const doc = makeDoc({
      ...coreFixture,
      windows: [
        win(0, "s0", 100, 0, { "200": 100 }),
        win(299, "s4", 100, 80, { "200": 20, "503": 80 }),
      ],
    });
    expect(doc.chart.markers.length).toBe(1);
    const { root, container } = renderDoc(doc);
    await ready(root);
    const label = container.querySelector("svg .p-chart-marker-label") as SVGTextElement;
    expect(label).not.toBeNull();
    const x = Number(label.getAttribute("x"));
    const anchor = label.getAttribute("text-anchor") ?? "start";
    const w = [...(label.textContent ?? "")].length * LABEL_CHAR_MM;
    const right = anchor === "end" ? x : anchor === "middle" ? x + w / 2 : x + w;
    expect(anchor).toBe("end");
    expect(right).toBeLessThanOrEqual(PLOT_X1_MM);
    expect(x - w).toBeGreaterThanOrEqual(0);
  });
});
