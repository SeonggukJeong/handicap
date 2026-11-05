import { describe, expect, it } from "vitest";
import {
  buildPrintDoc,
  standardBlocks,
  summaryBlocks,
  summaryRows,
  type Heights,
  type PrintDoc,
} from "../buildPrintDoc";
import { totalHeight, type Block, type LadderLevel } from "../paginate";
import { shortSummary } from "../sentences";
import type { Report, Run } from "../../api/schemas";

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
