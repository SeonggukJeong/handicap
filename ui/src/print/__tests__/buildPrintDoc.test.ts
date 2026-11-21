import { describe, expect, it } from "vitest";
import { build as buildSpeed, case1Input } from "./speedFixtures";
import {
  MEASURE_IDS,
  buildPrintDoc,
  standardBlocks,
  summaryBlocks,
  summaryRows,
  type Heights,
  type PrintDoc,
} from "../buildPrintDoc";
import { totalHeight, type Block, type LadderLevel } from "../paginate";
import { shortSummary } from "../sentences";
import { PLOT_X1_MM, chartReadingLine, markerX } from "../chartModel";
import { basisLine } from "../../components/report/basisText";
import type { Report, ReportBasis, Run } from "../../api/schemas";

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);

const profile = {
  vus: 10,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

const yamlOf = (n: number, name = "민원"): string =>
  `version: 1\nname: ${name}\nsteps:\n` +
  Array.from(
    { length: n },
    (_, i) =>
      `  - id: s${i}\n    name: 단계${i}\n    request:\n      method: GET\n      url: https://api.example.com/p${i}\n`,
  ).join("");

const mkRun = (over: Partial<Run> = {}): Run => ({
  id: "01HZZZZZZZZZZZZZZZZZa91f3c",
  scenario_id: "sc1",
  scenario_yaml: yamlOf(2),
  status: "completed",
  profile: profile as Run["profile"],
  env: null,
  started_at: 1_700_000_000_000,
  ended_at: 1_700_000_060_000,
  created_at: 1_700_000_000_000,
  message: null,
  verdict: null,
  last_metric_ts: null,
  label: null,
  ...over,
});

const mkReport = (n = 2, over: Partial<Report> = {}): Report => ({
  run: {
    id: "01HZZZZZZZZZZZZZZZZZa91f3c",
    scenario_id: "sc1",
    status: "completed",
    profile,
    env: null,
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_060_000,
    created_at: 1_700_000_000_000,
  },
  scenario_yaml: yamlOf(n),
  summary: {
    count: 1000,
    errors: 10,
    rps: 50,
    duration_seconds: 60,
    mean_ms: 20,
    p50_ms: 15,
    p95_ms: 80,
    p99_ms: 120,
  },
  windows: [],
  steps: Array.from({ length: n }, (_, i) => ({
    step_id: `s${i}`,
    count: 100 + i,
    error_count: i,
    status_counts: { "200": 100, ...(i > 0 ? { "503": i } : {}) },
    p50_ms: 10,
    p95_ms: 50 + i,
    p99_ms: 90,
  })),
  status_distribution: { "200": 990, "503": 10 },
  verdict: null,
  dropped: 0,
  latency: null,
  ...over,
});

const build = (run: Run, report: Report, fallback: string | null = null): PrintDoc =>
  buildPrintDoc({ run, report, fallbackScenarioName: fallback, now: NOW });

describe("buildPrintDoc", () => {
  it("speed_bands 유무에 따라 speed·절 번호가 정해진다", () => {
    const withBands = mkReport(2, {
      speed_bands: {
        overall: { slow_ms: 3000, basis: "default", own: false, fast: 10, within: 5, over: 0 },
        steps: [],
      },
    });
    const d1 = build(mkRun(), withBands);
    expect(d1.speed).not.toBeNull();
    expect(d1.speed?.rows).toHaveLength(3);
    expect(d1.sectionNo).toEqual({
      chart: "4. 시간에 따른 변화",
      conditions: "5. 측정 조건과 해석 범위",
      glossary: "6. 용어 풀이",
    });
    const d2 = build(mkRun(), mkReport());
    expect(d2.speed).toBeNull();
    expect(d2.sectionNo).toEqual({
      chart: "3. 시간에 따른 변화",
      conditions: "4. 측정 조건과 해석 범위",
      glossary: "5. 용어 풀이",
    });
  });

  it("title_falls_back", () => {
    expect(build(mkRun(), mkReport()).title).toBe("민원 부하 측정");
    const broken = mkReport(2, { scenario_yaml: "a: [unclosed" });
    expect(build(mkRun(), broken, "현재이름").title).toBe("현재이름 부하 측정");
    expect(build(mkRun(), broken, null).title).toBe("시나리오 부하 측정");
  });

  it("ident_with_label", () => {
    const d1 = build(mkRun({ label: "릴리즈 2.4 전" }), mkReport());
    expect(d1.meta.ident).toBe('#a91f3c · "릴리즈 2.4 전"');
    expect(d1.shortId).toBe("#a91f3c");
    expect(build(mkRun({ label: null }), mkReport()).meta.ident).toBe("#a91f3c");
  });

  it("claims_null_when_empty", () => {
    expect(build(mkRun(), mkReport()).claims).toBeNull();
    const empty = mkReport(2, { narrative: { can_claim: [], cannot_claim: [] } });
    expect(build(mkRun(), empty).claims).toBeNull();
    const some = mkReport(2, {
      narrative: { can_claim: ["throughput_measured", "weird_code"], cannot_claim: [] },
    });
    expect(build(mkRun(), some).claims).toEqual({
      can: ["처리량(요청 수·RPS)은 측정되었습니다", "weird_code"],
      cannot: [],
    });
  });

  it("profile_unparseable", () => {
    const report = mkReport(2, { run: { ...mkReport().run, profile: { vus: "x" } } });
    const doc = build(mkRun(), report);
    expect(doc.meta.load).toBe("–");
    expect(doc.conditions).toEqual({ ok: false });
    expect(doc.boxText.big).toBe("기준 미설정");
  });

  it("env_values_only_in_hosts", () => {
    const env = { BASE: "https://secret-host.example.com", TOKEN: "s3cr3t" };
    const run = mkRun({ env });
    const report = mkReport(1, {
      run: { ...mkReport().run, env },
      scenario_yaml: yamlOf(1).replace("https://api.example.com", "${BASE}/x?t=${TOKEN}"),
    });
    const doc = build(run, report);
    expect(doc.meta.targets).toBe("secret-host.example.com");
    expect(JSON.stringify(doc)).not.toContain("s3cr3t");
    expect(JSON.stringify(doc)).not.toContain("secret-host.example.com/x");
  });

  it("criteria_path_flows_to_kpis_other_rows_and_box", () => {
    const prof = { ...profile, criteria: { max_p95_ms: 100, max_p99_ms: 50 } };
    const report = mkReport(2, {
      run: { ...mkReport().run, profile: prof },
      verdict: {
        passed: false,
        criteria: [
          { metric: "p95_ms", direction: "max", threshold: 100, actual: 80, passed: true },
          { metric: "p99_ms", direction: "max", threshold: 50, actual: 120, passed: false },
        ],
      },
    });
    const doc = build(mkRun({ profile: prof as Run["profile"] }), report);
    const p95 = doc.kpis.find((k) => k.key === "p95")!;
    expect(p95.target).toContain("목표 ");
    expect(p95.target).not.toBe("목표 없음 (참고값)");
    expect(doc.box.kind).toBe("fail");
    expect(doc.otherRows.some((r) => r.name === "99% 응답시간" && r.judgement === "fail")).toBe(
      true,
    );
  });

  it("clean_no_criteria_run_short_summary_not_empty", () => {
    const clean = mkReport(2, {
      summary: { ...mkReport().summary, errors: 0 },
      steps: mkReport().steps.map((s) => ({ ...s, error_count: 0, status_counts: { "200": 100 } })),
      status_distribution: { "200": 1000 },
    });
    const doc = build(mkRun(), clean);
    expect(doc.box.kind).toBe("noCriteria");
    expect(idsOf(summaryBlocks(doc, new Map(), 6))).toContain("verdict:short");
    expect(shortSummary(doc.lines).map((l) => l.text)).toEqual([
      "오류 없이 끝났습니다. 95% 응답시간은 0.08초입니다.",
    ]);
  });

  it("broken_yaml_sets_unreadable_and_note_block", () => {
    const doc = build(mkRun(), mkReport(2, { scenario_yaml: "a: [unclosed" }));
    expect(doc.table.scenarioUnreadable).toBe(true);
    const got = idsOf(summaryBlocks(doc, new Map([["notes:unreadable", 5]]), 0));
    expect(got).toContain("notes:unreadable");
    expect(idsOf(standardBlocks(doc, new Map()))).toContain("notes:unreadable");
  });
});

const ladderDoc = (): PrintDoc => {
  const base = build(mkRun({ scenario_yaml: yamlOf(12) }), mkReport(12));
  return {
    ...base,
    table: {
      ...base.table,
      foldNotes: [{ columnLabel: "기타 5xx", parts: [{ code: 502, count: 3 }] }],
    },
    callouts: { uncounted: "확인 필요: 가", unknown: null, affectedSteps: 2 },
    otherRows: [0, 1, 2, 3].map((i) => ({
      name: `기준${i}`,
      target: "목표",
      actual: "값",
      judgement: "fail" as const,
    })),
    lines: [
      { kind: "verdict", text: "a" },
      { kind: "problemSteps", text: "b" },
      { kind: "slow", text: "c" },
    ],
  };
};

const heights = (doc: PrintDoc): Heights => {
  const h: Heights = new Map();
  const names = [
    "header",
    "kpis",
    "other:standard",
    "table:title",
    "table:header",
    "notes:fold",
    "notes:unreadable",
    "chart",
    "conditions",
    "glossary",
    "appendix:title",
    "appendix:header",
    "signature",
    "table:remainder:8",
    "table:remainder:6",
    "table:remainder:4",
  ];
  for (const id of names) h.set(id, 10);
  h.set("verdict:short", 6);
  h.set("verdict:full", 12);
  h.set("legend:short", 4);
  h.set("legend:full", 9);
  h.set("callouts:line", 4);
  h.set("callouts:full", 11);
  h.set("other:summary3", 15);
  h.set("other:summary1", 9);
  h.set("other:line", 4);
  for (const r of doc.table.rows) h.set(`row:${r.stepId}`, 7);
  return h;
};

const tableOf = (blocks: Block[]) =>
  blocks.find((b): b is Extract<Block, { kind: "table" }> => b.kind === "table")!;
const idsOf = (blocks: Block[]): string[] => blocks.map((b) => b.id);

describe("summary ladder", () => {
  it("summary_ladder_shrinks_each_step", () => {
    const doc = ladderDoc();
    const h = heights(doc);
    for (let l = 0; l < 8; l++) {
      const a = totalHeight(summaryBlocks(doc, h, l as LadderLevel));
      const b = totalHeight(summaryBlocks(doc, h, (l + 1) as LadderLevel));
      expect(b).toBeLessThan(a);
    }
    for (let l = 0; l <= 8; l++) {
      const blocks = summaryBlocks(doc, h, l as LadderLevel);
      const got = idsOf(blocks);
      expect(got).toContain("header");
      expect(got.some((x) => x.startsWith("verdict"))).toBe(true);
      expect(got).toContain("kpis");
      expect(tableOf(blocks).rowsMm.length).toBe(l <= 6 ? 9 : l === 7 ? 7 : 5);
    }
  });

  it("summary_no_other_block_without_failures", () => {
    const doc = ladderDoc();
    const ok = {
      ...doc,
      otherRows: doc.otherRows.map((r) => ({ ...r, judgement: "pass" as const })),
    };
    for (let l = 0; l <= 8; l++) {
      const got = idsOf(summaryBlocks(ok, heights(ok), l as LadderLevel));
      expect(got.some((x) => x.startsWith("other"))).toBe(false);
    }
  });

  it("unreadable_note_survives_ladder", () => {
    const base = ladderDoc();
    const doc = { ...base, table: { ...base.table, scenarioUnreadable: true } };
    for (let l = 0; l <= 8; l++) {
      const got = idsOf(summaryBlocks(doc, heights(doc), l as LadderLevel));
      expect(got).toContain("notes:unreadable");
      if (l >= 1) expect(got).not.toContain("notes:fold");
      else expect(got).toContain("notes:fold");
    }
  });

  it("ladder_order_pinned", () => {
    const doc = ladderDoc();
    const at = (l: number) => idsOf(summaryBlocks(doc, heights(doc), l as LadderLevel));
    expect(at(1)).not.toContain("notes:fold");
    expect(at(1)).toContain("legend:full");
    expect(at(2)).toContain("legend:short");
    expect(at(2)).toContain("callouts:full");
    expect(at(3)).toContain("callouts:line");
    expect(at(3)).toContain("other:summary3");
    expect(at(4)).toContain("other:summary1");
    expect(at(5)).toContain("other:line");
    expect(at(5)).toContain("verdict:full");
    expect(at(6)).toContain("verdict:short");
  });

  it("summaryRows_counts", () => {
    const doc = ladderDoc();
    expect(summaryRows(doc, 0).shown.length).toBe(8);
    expect(summaryRows(doc, 7).shown.length).toBe(6);
    expect(summaryRows(doc, 8).shown.length).toBe(4);
    expect(summaryRows(doc, 8).remainderLine).not.toBeNull();
  });
});

describe("standard blocks", () => {
  it("standard_appendix_only_when_truncated", () => {
    const base = ladderDoc();
    const mk = (n: number): PrintDoc => ({
      ...base,
      otherRows: Array.from({ length: n }, (_, i) => ({
        name: `기준${i}`,
        target: "t",
        actual: "a",
        judgement: "pass" as const,
      })),
    });
    const withAppendix = standardBlocks(mk(7), heights(base));
    expect(idsOf(withAppendix)).toContain("appendix");
    expect(tableOf(withAppendix.filter((b) => b.id === "appendix")).rowsMm.length).toBe(7);
    expect(idsOf(standardBlocks(mk(5), heights(base)))).not.toContain("appendix");
  });

  it("speed 표 블록은 notes류 뒤·chart 앞, 없으면 블록 없음, 요약판엔 없다", () => {
    const base = ladderDoc();
    expect(idsOf(standardBlocks(base, heights(base)))).not.toContain("speed");
    expect(idsOf(standardBlocks(base, heights(base)))).not.toContain("speed:notes");
    const speed = buildSpeed(case1Input());
    const doc: PrintDoc = { ...base, speed };
    const ids = idsOf(standardBlocks(doc, heights(doc)));
    expect(ids.indexOf("speed")).toBeGreaterThan(ids.indexOf("notes:fold"));
    expect(ids.indexOf("speed")).toBeLessThan(ids.indexOf("chart"));
    expect(ids[ids.indexOf("speed") + 1]).toBe("speed:notes");
    const blk = standardBlocks(doc, heights(doc)).find((b) => b.id === "speed");
    expect(blk?.kind).toBe("table");
    expect(blk?.kind === "table" && blk.rowsMm.length).toBe(speed.rows.length);
    const h = heights(doc);
    h.set(MEASURE_IDS.speedTitle, 7);
    h.set(MEASURE_IDS.speedHeader, 9);
    for (const r of speed.rows) h.set(MEASURE_IDS.speedRowId(r.key), 6);
    const withH = standardBlocks(doc, h).find((b) => b.id === "speed");
    expect(withH?.kind === "table" && [withH.titleMm, withH.headerMm, ...withH.rowsMm]).toEqual([
      7, 9, 6, 6, 6, 6, 6, 6,
    ]);
    for (let l = 0; l < 9; l++) {
      expect(idsOf(summaryBlocks(doc, heights(doc), l as LadderLevel))).not.toContain("speed");
      expect(idsOf(summaryBlocks(doc, heights(doc), l as LadderLevel))).not.toContain(
        "speed:notes",
      );
    }
  });

  it("standard_order", () => {
    const doc = ladderDoc();
    expect(idsOf(standardBlocks(doc, heights(doc)))).toEqual([
      "header",
      "verdict:full",
      "kpis",
      "other:standard",
      "table",
      "legend:full",
      "callouts:full",
      "notes:fold",
      "chart",
      "conditions",
      "glossary",
      "signature",
    ]);
  });
});

describe("buildPrintDoc — 집계 기준", () => {
  const T0S = 1_700_000_000;
  const mkBasis = (
    selected: "steady" | "whole",
    over: Partial<ReportBasis> = {},
    from = 25,
    to = 60,
  ): ReportBasis => ({
    selected,
    default: "steady",
    state: "measured",
    config: { ramp_seconds: 20, hold_seconds: 45, discard_seconds: 5 },
    window: {
      start_ms: (T0S + from) * 1000,
      end_ms: (T0S + to) * 1000,
      measured_seconds: to - from,
    },
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

  // 1초 칸마다 s1 요청 10건. errSecs(실행 시작 기준 초)에는 status 0(전송 실패) 오류 1건.
  const wins = (total: number, errSecs: number[]): Report["windows"] =>
    Array.from({ length: total }, (_, i) => {
      const err = errSecs.includes(i) ? 1 : 0;
      return {
        ts_second: T0S + i,
        step_id: "s1",
        count: 10,
        error_count: err,
        status_counts: (err ? { "200": 9, "0": 1 } : { "200": 10 }) as Record<string, number>,
        p50_ms: 1,
        p95_ms: 1,
        p99_ms: 1,
      };
    });

  const withErrors = (basis: ReportBasis, total: number, errSecs: number[]): Report => {
    const base = mkReport(2);
    return mkReport(2, {
      basis,
      windows: wins(total, errSecs),
      summary: { ...base.summary, errors: errSecs.length },
      steps: base.steps.map((st) =>
        st.step_id === "s1"
          ? {
              ...st,
              error_count: errSecs.length,
              status_counts: { "200": 100 - errSecs.length, "0": errSecs.length } as Record<
                string,
                number
              >,
            }
          : { ...st, error_count: 0, status_counts: { "200": 100 } as Record<string, number> },
      ),
    });
  };

  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

  it("basis 없는 리포트의 meta는 네 키 그대로", () => {
    const doc = build(mkRun(), mkReport());
    expect(Object.keys(doc.meta).sort()).toEqual(["ident", "load", "targets", "window"]);
  });

  it("steady 기준 리포트: meta.basis가 화면 기준 줄과 같은 글자, meta.basisOther가 참고 줄", () => {
    const report = mkReport(2, { basis: mkBasis("steady") });
    const doc = build(mkRun(), report);
    expect(doc.meta.basis).toBe(basisLine(report.basis!));
    expect(doc.meta.basis).toContain("유지 구간");
    expect(doc.meta.basisOther).toContain("전체 구간");
    expect(doc.meta.basisOther).toBe("전체 구간: 초당 요청 40.5 · p95 90 ms · 오류 1.0%");
  });

  it("print_basis_line_follows_selected_not_requested: selected whole(not_reached)이면 기준 줄이 '전체 구간'으로 시작하고 basisOther가 없다", () => {
    const report = mkReport(2, {
      basis: mkBasis("whole", { state: "not_reached", window: null, other: null }),
    });
    const doc = build(mkRun(), report);
    expect(doc.meta.basis).toBe("전체 구간 · 상승 20초 포함");
    expect(doc.meta.basis).not.toContain("유지 구간");
    expect("basisOther" in doc.meta).toBe(false);
  });

  it("창이 있는 리포트: chart.steady가 경과 초이고 readingLine이 '긴 점선 사이'를 담는다", () => {
    const steady = build(mkRun(), withErrors(mkBasis("steady"), 90, []));
    expect(steady.chart.steady).toEqual({ startSec: 25, endSec: 60 });
    expect(steady.readingLine).toBe(
      `${chartReadingLine(steady.chart)} 긴 점선 사이(25초–1분)가 유지 구간입니다. 표와 판정은 이 구간의 값입니다.`,
    );
    expect(steady.readingLine).toContain("긴 점선 사이(25초–1분)가 유지 구간입니다.");

    const whole = build(mkRun(), withErrors(mkBasis("whole"), 90, []));
    expect(whole.chart.steady).toEqual({ startSec: 25, endSec: 60 });
    expect(whole.readingLine).toBe(
      "측정 내내 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다. 긴 점선 사이(25초–1분)가 유지 구간입니다.",
    );
    expect(whole.readingLine).not.toContain("표와 판정은");
  });

  it("오류가 있는 리포트: 앞 문장과 유지 구간 문장 사이에 마침표가 있다", () => {
    const doc = build(mkRun(), withErrors(mkBasis("steady"), 90, range(30, 40)));
    expect(doc.readingLine).toContain("생깁니다. 긴 점선 사이(");
  });

  it("창의 마지막 초들에 메트릭이 없어도 끝 점선이 그림 안에 있다", () => {
    const doc = build(mkRun(), withErrors(mkBasis("steady"), 51, []));
    expect(doc.chart.steady?.endSec).toBe(60);
    expect(doc.chart.durationSec).toBe(60);
    expect(markerX(doc.chart.steady!.endSec, doc.chart.durationSec)).toBeLessThanOrEqual(
      PLOT_X1_MM,
    );
  });

  it("basis 없는 리포트: chart.steady가 없고 readingLine이 chartReadingLine(chart)와 같다", () => {
    const base = mkReport(2);
    const doc = build(mkRun(), { ...base, windows: wins(30, [5]) });
    expect(doc.chart.steady).toBeUndefined();
    expect(doc.readingLine).toBe(chartReadingLine(doc.chart));
    expect(doc.readingLine).not.toContain("긴 점선");
  });

  it("유지 구간 기준에서 창 안 내내 난 오류는 창 뒤에 칸이 더 있어도 '계속 났습니다'다", () => {
    const doc = build(mkRun(), withErrors(mkBasis("steady"), 120, range(25, 60)));
    const line = doc.lines.find((l) => l.kind === "errorIdentity");
    expect(line?.text).toContain("시작 25초 뒤부터 계속 났습니다.");
  });

  it("유지 구간 기준에서 '처음 보인 시각'은 창 안의 초만 본다", () => {
    const steady = build(mkRun(), withErrors(mkBasis("steady"), 60, [3, 40]));
    const steadyText = steady.lines.find((l) => l.kind === "errorIdentity")?.text ?? "";
    expect(steadyText).toContain("시작 40초 뒤");
    expect(steadyText).not.toContain("시작 3초 뒤");

    const whole = build(mkRun(), withErrors(mkBasis("whole"), 60, [3, 40]));
    const wholeText = whole.lines.find((l) => l.kind === "errorIdentity")?.text ?? "";
    expect(wholeText).toContain("시작 3초 뒤");
  });
});
