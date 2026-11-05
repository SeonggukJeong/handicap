import { describe, expect, it } from "vitest";
import {
  calloutOneLine,
  callouts,
  glossary,
  legendItems,
  LEGEND_SHORT,
  rankRows,
  selectTopRows,
  stepStatus,
  stepThresholds,
  type RankedRow,
} from "../stepStatus";
import type { Cell, CellClass, StepRow, StepTableModel } from "../stepTable";
import type { Criteria, Report } from "../../api/schemas";

const row = (index: number, over: Partial<StepRow> = {}): StepRow => ({
  index,
  no: String(index + 1),
  stepId: `s${index}`,
  name: `단계${index}`,
  requestLine: null,
  executed: true,
  count: 1000,
  errorCount: 0,
  p95Ms: 100,
  perCode: [],
  cells: {},
  residual: 0,
  residualUncertain: false,
  factsKnown: true,
  ...over,
});

const rk = (r: StepRow, crit: Criteria | null = null): RankedRow => ({
  ...r,
  status: stepStatus(r, crit),
});

describe("threshold_source_order", () => {
  it("step-level smallest wins over run-level, run-level fallback, null", () => {
    const c: Criteria = {
      max_error_rate: 0.5,
      max_p95_ms: 900,
      step_criteria: [
        { metric: "error_rate", op: "max", threshold: 0.2, target: "a" },
        { metric: "error_rate", op: "max", threshold: 0.05, target: "a" },
        { metric: "error_rate", op: "min", threshold: 0.001, target: "a" },
        { metric: "p95_ms", op: "max", threshold: 700, target: "a" },
        { metric: "p95_ms", op: "max", threshold: 300, target: "a" },
        { metric: "p50_ms", op: "max", threshold: 10, target: "a" },
        { metric: "error_rate", op: "max", threshold: 0.01, target: "b" },
      ],
    };
    expect(stepThresholds("a", c)).toEqual({ errorRate: 0.05, p95Ms: 300 });
    expect(stepThresholds("zz", c)).toEqual({ errorRate: 0.5, p95Ms: 900 });
    expect(stepThresholds("a", {})).toEqual({ errorRate: null, p95Ms: null });
    expect(stepThresholds("a", null)).toEqual({ errorRate: null, p95Ms: null });
    expect(stepThresholds("a", undefined)).toEqual({ errorRate: null, p95Ms: null });
  });
});

describe("status_priority", () => {
  const crit: Criteria = { max_error_rate: 0.01, max_p95_ms: 500 };
  it("error", () => {
    const s = stepStatus(row(0, { errorCount: 20 }), crit);
    expect(s.tags).toEqual(["error"]);
    expect(s.grade).toBe(3);
    expect(s.errorRate).toBeCloseTo(0.02);
  });
  it("slow + uncounted", () => {
    const s = stepStatus(
      row(0, { p95Ms: 800, perCode: [{ code: 404, count: 5, cls: "uncounted" }] }),
      crit,
    );
    expect(s.tags).toEqual(["slow", "uncounted"]);
    expect(s.grade).toBe(2);
  });
  it("hasErrors when no error criterion", () => {
    const s = stepStatus(row(0, { errorCount: 1 }), null);
    expect(s.tags).toEqual(["hasErrors"]);
    expect(s.grade).toBe(2);
  });
  it("ok keeps errorRate", () => {
    const s = stepStatus(row(0, { count: 4000, errorCount: 10 }), crit);
    expect(s.tags).toEqual(["ok"]);
    expect(s.grade).toBe(1);
    expect(s.errorRate).toBe(0.0025);
  });
  it("exactly at threshold is not flagged", () => {
    const s = stepStatus(row(0, { count: 1000, errorCount: 10, p95Ms: 500 }), crit);
    expect(s.tags).toEqual(["ok"]);
    expect(s.grade).toBe(1);
  });
  it("unknown tag and notRun", () => {
    expect(
      stepStatus(row(0, { perCode: [{ code: 500, count: 1, cls: "unknown" }] }), crit).tags,
    ).toEqual(["unknown"]);
    const n = stepStatus(row(0, { executed: false, count: 0 }), crit);
    expect(n.tags).toEqual(["notRun"]);
    expect(n.grade).toBe(0);
  });
});

describe("status_uses_profile_criteria_not_verdict", () => {
  it("aborted run still flags error from criteria", () => {
    const s = stepStatus(row(0, { errorCount: 500 }), { max_error_rate: 0.1 });
    expect(s.tags).toEqual(["error"]);
  });
});

describe("rank_and_select", () => {
  const mk = (): RankedRow[] => {
    const crit: Criteria = { max_error_rate: 0.01 };
    const rows = [
      row(0), // ok
      row(1, { errorCount: 50 }), // error
      row(2, { perCode: [{ code: 404, count: 5, cls: "uncounted" }] }), // caution
      row(3, { perCode: [{ code: 404, count: 50, cls: "uncounted" }] }), // caution bigger
      row(4, { p95Ms: 900, perCode: [{ code: 404, count: 5, cls: "unknown" }] }), // caution
      row(5),
      row(6),
      row(7),
      row(8, { executed: false, count: 0 }),
      row(9),
    ];
    return rows.map((r) => rk(r, crit));
  };
  it("selects top 8 in scenario order with remainder line", () => {
    const rows = mk();
    const ranked = rankRows(rows);
    expect(ranked[0].index).toBe(1);
    expect(ranked.slice(1, 4).map((r) => r.index)).toEqual([3, 4, 2]);
    const { shown, remainderLine } = selectTopRows(rows, 8);
    expect(shown).toHaveLength(8);
    expect(shown.map((r) => r.index)).toEqual([...shown.map((r) => r.index)].sort((a, b) => a - b));
    expect(remainderLine).toBe("나머지 2개 단계: 정상 1 · 실행 안 됨 1 (전체 목록은 표준판)");
  });
  it("errorCount breaks ties within a grade (all other keys equal)", () => {
    const crit: Criteria = { max_error_rate: 0.01 };
    const rows = [
      rk(row(0, { errorCount: 20 }), crit),
      rk(row(1, { errorCount: 90 }), crit),
      rk(row(2, { errorCount: 50 }), crit),
    ];
    expect(rankRows(rows).map((r) => r.index)).toEqual([1, 2, 0]);
  });
  it("all ok remainder, zero remainder", () => {
    const rows = [1, 2, 3].map((i) => rk(row(i - 1)));
    expect(selectTopRows(rows, 1).remainderLine).toBe("나머지 2개 단계: 모두 정상");
    const all = selectTopRows(rows, 3);
    expect(all.shown).toHaveLength(3);
    expect(all.remainderLine).toBeNull();
    expect(selectTopRows(rows, 9).remainderLine).toBeNull();
  });
  it("remainder with 오류·주의 labels", () => {
    const crit: Criteria = { max_error_rate: 0.01 };
    const rows = [
      rk(row(0, { errorCount: 50 }), crit),
      rk(row(1, { errorCount: 40 }), crit),
      rk(row(2, { errorCount: 30, p95Ms: 5 }), crit),
      rk(row(3, { perCode: [{ code: 404, count: 5, cls: "uncounted" }] }), crit),
    ];
    expect(selectTopRows(rows, 1).remainderLine).toBe(
      "나머지 3개 단계: 오류 2 · 주의 1 (전체 목록은 표준판)",
    );
  });
});

describe("callout_text", () => {
  const summary = {
    count: 150000,
    errors: 3900,
    rps: 1,
    duration_seconds: 1,
    mean_ms: 1,
    p50_ms: 1,
    p95_ms: 1,
    p99_ms: 1,
  } satisfies Report["summary"];
  const un = (i: number, name: string, code: number, n: number, cls: CellClass): RankedRow =>
    rk(row(i, { name, perCode: [{ code, count: n, cls }] }));

  it("uncounted: two + 외 1곳, A% -> B%", () => {
    const rows = [
      un(0, "B", 502, 600, "uncounted"),
      un(1, "C", 404, 30, "uncounted"),
      un(2, "D", 500, 5, "uncounted"),
    ];
    const c = callouts(rows, summary);
    expect(c.uncounted).toBe(
      "확인 필요: 'B'의 502 응답 600건, 'C'의 404 응답 30건 외 1곳은 응답 코드 검사가 없어 오류율에 포함되지 않았습니다. 포함하면 오류율은 2.6% → 3.0%가 됩니다. 이 단계에 응답 코드 검사를 추가하길 권합니다.",
    );
    expect(c.unknown).toBeNull();
    expect(c.affectedSteps).toBe(3);
  });
  it("single has no 외; unknown verbatim", () => {
    const rows = [un(0, "B", 502, 600, "uncounted"), un(1, "E", 503, 7, "unknown")];
    const c = callouts(rows, summary);
    expect(c.uncounted?.startsWith("확인 필요: 'B'의 502 응답 600건은 응답 코드 검사가")).toBe(
      true,
    );
    expect(c.unknown).toBe(
      "'E'의 503 응답 7건은 오류로 세었는지 확정할 수 없습니다(응답 코드 검사 없이 값을 꺼내는 단계). 응답 코드 검사를 추가하면 정확히 셀 수 있습니다.",
    );
    expect(c.affectedSteps).toBe(2);
  });
  it("per-step largest cell; 외 N counts remaining steps, not cells", () => {
    const b = rk(
      row(0, {
        name: "B",
        perCode: [
          { code: 404, count: 30, cls: "uncounted" },
          { code: 502, count: 600, cls: "uncounted" },
        ],
      }),
    );
    const rows = [b, un(1, "C", 404, 30, "uncounted"), un(2, "D", 500, 5, "uncounted")];
    const c = callouts(rows, summary);
    expect(c.uncounted).toBe(
      "확인 필요: 'B'의 502 응답 600건, 'C'의 404 응답 30건 외 1곳은 응답 코드 검사가 없어 오류율에 포함되지 않았습니다. 포함하면 오류율은 2.6% → 3.0%가 됩니다. 이 단계에 응답 코드 검사를 추가하길 권합니다.",
    );
    const two = callouts([b, un(1, "C", 404, 30, "uncounted")], summary);
    expect(
      two.uncounted?.startsWith("확인 필요: 'B'의 502 응답 600건, 'C'의 404 응답 30건은 "),
    ).toBe(true);
    const u = (i: number, name: string, code: number, n: number) => un(i, name, code, n, "unknown");
    const bu = rk(
      row(0, {
        name: "B",
        perCode: [
          { code: 404, count: 300, cls: "unknown" },
          { code: 502, count: 600, cls: "unknown" },
        ],
      }),
    );
    expect(callouts([bu, u(1, "C", 404, 30), u(2, "D", 500, 5)], summary).unknown).toBe(
      "'B'의 502 응답 600건, 'C'의 404 응답 30건 외 1곳은 오류로 세었는지 확정할 수 없습니다(응답 코드 검사 없이 값을 꺼내는 단계). 응답 코드 검사를 추가하면 정확히 셀 수 있습니다.",
    );
  });
  it("affectedSteps counts a step with both classes once", () => {
    const both = rk(
      row(0, {
        perCode: [
          { code: 404, count: 3, cls: "uncounted" },
          { code: 500, count: 2, cls: "unknown" },
        ],
      }),
    );
    expect(callouts([both], summary).affectedSteps).toBe(1);
  });
  it("none", () => {
    expect(callouts([rk(row(0))], summary)).toEqual({
      uncounted: null,
      unknown: null,
      affectedSteps: 0,
    });
  });
  it("one line", () => {
    expect(calloutOneLine(2)).toBe("확인 필요: 응답 코드 검사가 없는 단계 2곳 — 표준판 참조");
  });
});

const col = (
  key: string,
  kind: StepTableModel["columns"][number]["kind"],
  label: string,
  codes: number[],
) => ({ key, kind, label, sub: null, codes });
const model = (columns: StepTableModel["columns"], rows: StepRow[]): StepTableModel => ({
  columns,
  rows,
  foldNotes: [],
  scenarioUnreadable: false,
});

describe("glossary_only_present", () => {
  it("lists only present terms", () => {
    const m = model(
      [
        col("c503", "code", "503", [503]),
        col("f4xx", "folded", "기타 4xx", [400, 401]),
        col("none", "none", "응답 없음", [0]),
      ],
      [],
    );
    const g = glossary(
      m,
      [],
      [
        { kind: "timeout", count: 3 },
        { kind: "connect_refused", count: 2 },
      ],
    );
    expect(g.entries.map((e) => e.term)).toEqual([
      "처리량",
      "평균 응답시간",
      "95% 응답시간",
      "오류율",
      "400",
      "401",
      "503",
      "응답 없음",
    ]);
    expect(g.entries.find((e) => e.term === "503")?.text).toBe("서버가 바쁨");
    expect(g.entries.find((e) => e.term === "400")?.text).toBe("잘못된 요청");
    expect(g.entries.find((e) => e.term === "401")?.text).toBe("인증 필요");
    expect(g.errorKindLine).toBe("응답 없음 내역: 요청 타임아웃 3 · 연결 거부 2");
  });
  it("both 2xx and 3xx present -> one combined entry", () => {
    const m = model(
      [col("2xx", "class2xx", "2xx", [200]), col("3xx", "class3xx", "3xx", [302])],
      [],
    );
    const e = glossary(m, [], []).entries;
    expect(e.map((x) => x.term)).toContain("2xx(성공 계열)·3xx(이동 계열)");
  });
  it("no none column -> null; unknown code fallback; 2xx/uncounted/unknown/residual", () => {
    const r = rk(
      row(0, {
        perCode: [
          { code: 404, count: 1, cls: "uncounted" },
          { code: 599, count: 1, cls: "unknown" },
        ],
      }),
    );
    const m = model(
      [
        col("2xx", "class2xx", "2xx", [200]),
        col("c599", "code", "599", [599]),
        col("residual", "residual", "그중", []),
      ],
      [r],
    );
    const g = glossary(m, [r], [{ kind: "timeout", count: 3 }]);
    expect(g.errorKindLine).toBeNull();
    const terms = g.entries.map((e) => e.term);
    expect(terms).toContain("2xx(성공 계열)");
    expect(terms).not.toContain("2xx(성공 계열)·3xx(이동 계열)");
    expect(g.entries.find((e) => e.term === "599")?.text).toBe("표준 HTTP 응답 코드");
    expect(terms).toEqual(
      expect.arrayContaining(["응답 받은 뒤 실패", "검사 없음(안 셈)", "확인 불가(?)"]),
    );
    const plain = glossary(model([], []), [], []);
    expect(plain.entries.map((e) => e.term)).toEqual([
      "처리량",
      "평균 응답시간",
      "95% 응답시간",
      "오류율",
    ]);
  });
});

describe("legend_only_present", () => {
  const cell = (cls: CellClass, strongest = false, count = 5): Cell => ({ count, cls, strongest });
  it("only present classes", () => {
    const crit: Criteria = { max_error_rate: 0.01 };
    const r = rk(row(0, { errorCount: 50, cells: { a: cell("counted", true) } }), crit);
    const m = model([col("a", "code", "503", [503])], [r]);
    expect(legendItems(m, [r])).toEqual([
      "✕ 오류: 단계 오류율이 기준을 넘음",
      "오류로 센 응답",
      "그중 가장 많은 것",
    ]);
  });
  it("uncounted, unknown, residual, ok/caution", () => {
    const r1 = rk(
      row(0, {
        perCode: [{ code: 404, count: 1, cls: "uncounted" }],
        cells: { a: cell("uncounted") },
      }),
    );
    const r2 = rk(row(1));
    const m = model([col("res", "residual", "그중", [])], [r1, r2]);
    expect(legendItems(m, [r1, r2])).toEqual([
      "▲ 주의: 느림·오류 있음·검사 확인 필요",
      "● 정상",
      "오류로 안 센 응답(검사 없음)",
      "‘그중’ 열은 앞 칸들에 이미 포함된 건수입니다(더하지 마세요)",
    ]);
    const r3 = rk(
      row(2, { perCode: [{ code: 500, count: 1, cls: "unknown" }], cells: { a: cell("unknown") } }),
    );
    expect(legendItems(model([], [r3]), [r3])).toContain("확인 불가(?)");
  });
  it("short legend", () => {
    expect(LEGEND_SHORT).toBe("✕ 오류 · ▲ 주의 · ● 정상");
  });
});
