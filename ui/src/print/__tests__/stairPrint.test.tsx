import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { PrintDocument } from "../PrintDocument";
import {
  buildPrintDoc,
  standardBlocks,
  summaryBlocks,
  type Heights,
  type PrintDoc,
} from "../buildPrintDoc";
import { PAGE_BODY_MM, paginate, type Block, type LadderLevel } from "../paginate";
import { buildStairRows } from "../stairTable";
import { headlineParts, headlineText } from "../../components/report/stair/stairFormat";
import { StairReportSchema, type Report, type Run, type StairReport } from "../../api/schemas";
import { ko } from "../../i18n/ko";

const golden = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);

const yaml =
  "version: 1\nname: x\nsteps:\n  - id: s0\n    name: a\n    type: http\n    method: GET\n    url: http://a/\n";
const run = {
  id: "01HZZZZZZZZZZZZZZZZZa91f3c",
  scenario_id: "s",
  status: "completed",
  started_at: 1,
  ended_at: 2,
  created_at: 1,
  label: null,
} as unknown as Run;

const mkReport = (stair?: StairReport): Report =>
  ({
    run: {
      id: run.id,
      scenario_id: "s",
      status: "completed",
      profile: {
        vus: 10,
        ramp_up_seconds: 0,
        duration_seconds: 60,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
      },
      env: null,
      started_at: 1,
      ended_at: 2,
      created_at: 1,
    },
    scenario_yaml: yaml,
    summary: {
      count: 10,
      errors: 0,
      rps: 1,
      duration_seconds: 60,
      mean_ms: 1,
      p50_ms: 1,
      p95_ms: 1,
      p99_ms: 1,
    },
    windows: [],
    steps: [
      {
        step_id: "s0",
        count: 10,
        error_count: 0,
        status_counts: { "200": 10 },
        p50_ms: 1,
        p95_ms: 1,
        p99_ms: 1,
      },
    ],
    status_distribution: { "200": 10 },
    verdict: null,
    dropped: 0,
    latency: null,
    ...(stair ? { stair } : {}),
  }) as unknown as Report;

const build = (stair?: StairReport): PrintDoc =>
  buildPrintDoc({ run, report: mkReport(stair), fallbackScenarioName: null, now: 0 });

function bigStair(n: number): StairReport {
  const st = structuredClone(golden);
  const proto = st.steps[0];
  st.steps = Array.from({ length: n }, (_, i) => ({
    ...proto,
    index: i,
    target: 1_000_000 - (n - 1 - i) * 1000,
    p99_us: 45_000_000 + i,
    p50_us: 30_000_000,
    p95_us: 40_000_000,
  }));
  return st;
}

const ids = (blocks: Block[]): string[] => blocks.map((b) => b.id);

describe("비계단 run 인쇄 블록 불변", () => {
  it("standardBlocks id 목록 == 변경 전 실측 리터럴", () => {
    expect(ids(standardBlocks(build(), new Map()))).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
  });
  it("summaryBlocks(0) id 목록 == 변경 전 실측 리터럴", () => {
    expect(ids(summaryBlocks(build(), new Map(), 0))).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "table",
      "legend:full",
    ]);
  });
});

describe("계단 인쇄 블록", () => {
  it("standard: kpis 다음 머리말 + 계단 표, 요약은 머리말 한 줄만", () => {
    const doc = build(golden);
    const std = ids(standardBlocks(doc, new Map()));
    expect(std.slice(0, 5)).toEqual(["header", "verdict:full", "kpis", "stair:headline", "stair"]);
    for (let l = 0; l <= 8; l++) {
      const sum = ids(summaryBlocks(doc, new Map(), l as LadderLevel));
      expect(sum).toContain("stair:headline:short");
      expect(sum).not.toContain("stair");
      expect(sum).not.toContain("stair:headline");
    }
  });

  it("stair_print_table_paginates_50_rows", () => {
    const doc = build(bigStair(50));
    const h: Heights = new Map();
    for (const id of [
      "header",
      "verdict:full",
      "kpis",
      "stair:headline",
      "stair:title",
      "stair:header",
      "legend:full",
      "chart",
      "conditions",
      "glossary",
      "signature",
      "table:title",
      "table:header",
    ])
      h.set(id, 10);
    for (let i = 0; i < 50; i++) h.set(`stair:row:${i}`, 7);
    const r = paginate(standardBlocks(doc, h), PAGE_BODY_MM);
    const parts = r.pages.flat().filter((it) => it.kind === "tableSlice" && it.id === "stair");
    expect(parts.length).toBeGreaterThan(1);
    const spans = parts.map((p) => (p.kind === "tableSlice" ? [p.from, p.to] : [0, 0]));
    expect(spans[0][0]).toBe(0);
    expect(spans[spans.length - 1][1]).toBe(50);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1]);
  });

  it("⚠ 버림 부족 계단이 있으면 표 뒤 stair:warnings 블록, 없으면 없음 — 단위 안내는 늘 표 뒤", () => {
    const st = structuredClone(golden);
    st.steps[1] = { ...st.steps[1], discard_warning: true, head_p99_ratio: 2.5 };
    expect(ids(standardBlocks(build(st), new Map())).slice(3, 7)).toEqual([
      "stair:headline",
      "stair",
      "stair:warnings",
      "stair:units",
    ]);
    for (const s of st.steps) s.discard_warning = false;
    const std = ids(standardBlocks(build(st), new Map()));
    expect(std).not.toContain("stair:warnings");
    expect(std.slice(3, 6)).toEqual(["stair:headline", "stair", "stair:units"]);
  });

  it("표 행 모델은 화면 표와 같은 열·형식", () => {
    const st = structuredClone(golden);
    st.steps[0] = { ...st.steps[0], error_rate: 0.0004 };
    const m = buildStairRows(st);
    expect(m.columns).toEqual(Object.values(ko.report.stair.cols));
    expect(m.rows).toHaveLength(st.steps.length);
    expect(m.rows[0].cells[7]).toBe("<0.1%");
    expect(m.rows[0].cells).toHaveLength(11);
  });
});

describe("PrintDocument 계단", () => {
  async function renderKind(doc: PrintDoc, kind: "standard" | "summary") {
    const utils = render(
      <div className="p-root">
        <PrintDocument doc={doc} kind={kind} />
      </div>,
    );
    const root = utils.container.querySelector(".p-doc") as HTMLElement;
    await waitFor(() => expect(root).toHaveAttribute("data-layout-ready", "true"));
    return utils;
  }

  it("standard: 머리말 문장과 50행 표가 모두 그려진다", async () => {
    const st = bigStair(50);
    await renderKind(build(st), "standard");
    for (const line of headlineText(st))
      expect(screen.getAllByText(line).length).toBeGreaterThan(0);
    const table = screen.getByRole("table", { name: ko.report.stair.tableLabel });
    expect(within(table).getAllByRole("row")).toHaveLength(51);
  });

  it("standard: 계단 표 제목은 1절 아래 소제목 「계단 부하 판정 결과」(h3, 「단계별 결과」와 헷갈리지 않게)", async () => {
    await renderKind(build(golden), "standard");
    const h = screen.getAllByRole("heading", { level: 3, name: "계단 부하 판정 결과" });
    expect(h.length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 2, name: /계단/ })).toBeNull();
    expect(document.body.textContent).not.toContain("계단별 결과");
  });

  it("standard: 화면처럼 안내 줄 둘(t0 추정·예전 부하기)과 표 아래 단위 안내", async () => {
    const st = structuredClone(golden);
    st.notes = { t0_estimated: true, open_loop_unknown: true };
    await renderKind(build(st), "standard");
    expect(screen.getAllByText(ko.report.stair.noteT0).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ko.report.stair.noteOpenLoopUnknown).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ko.report.stair.unitsNote).length).toBeGreaterThan(0);
  });

  it("standard: 안내 줄은 notes가 꺼져 있으면 없다", async () => {
    const st = structuredClone(golden);
    st.notes = { t0_estimated: false, open_loop_unknown: false };
    await renderKind(build(st), "standard");
    expect(screen.queryByText(ko.report.stair.noteT0)).toBeNull();
    expect(screen.queryByText(ko.report.stair.noteOpenLoopUnknown)).toBeNull();
  });

  it("summary: 머리말 한 줄 + 안내, 계단 표 없음", async () => {
    const st = structuredClone(golden);
    await renderKind(build(st), "summary");
    expect(screen.getAllByText(headlineText(st)[0]).length).toBeGreaterThan(0);
    expect(screen.getByText(ko.print.stair.summaryNote)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: ko.report.stair.tableLabel })).toBeNull();
  });

  it("standard: ⚠ 버림 부족 문구가 화면과 같은 형식으로 그려진다", async () => {
    const st = structuredClone(golden);
    st.steps[1] = { ...st.steps[1], discard_warning: true, head_p99_ratio: 2.5 };
    await renderKind(build(st), "standard");
    expect(
      screen.getByText(ko.report.stair.discardWarning(2, "2.5", st.config.discard_seconds)),
    ).toBeInTheDocument();
  });

  it("summary: 슬롯 부족 의심이면 머리말 첫 줄 + 슬롯 경고 줄, 아니면 첫 줄 + 안내만", async () => {
    const slotLine = (st: StairReport) =>
      headlineParts(st).lines.find((l) => l.kind === "slot")!.text;
    const st = structuredClone(golden);
    st.slot_limited_targets = [300];
    st.max_in_flight = 8;
    const first = await renderKind(build(st), "summary");
    expect(screen.getByText(slotLine(st))).toBeInTheDocument();
    first.unmount();
    const plain = structuredClone(golden);
    plain.slot_limited_targets = [];
    await renderKind(build(plain), "summary");
    expect(screen.queryByText(/동시 실행 한도/)).toBeNull();
  });
});
