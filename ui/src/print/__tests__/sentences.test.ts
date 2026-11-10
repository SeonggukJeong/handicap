import { describe, expect, it } from "vitest";
import { shortSummary, summaryLines, type SummaryInput, type SummaryLine } from "../sentences";
import { buildChartModel } from "../chartModel";
import type { RankedRow, RowStatus } from "../stepStatus";
import type { BoxState, Matched } from "../verdict";
import type { StepRow } from "../stepTable";
import type { Criteria, Report } from "../../api/schemas";

type W = Report["windows"][number];
const win = (
  ts: number,
  step: string,
  count: number,
  err = 0,
  codes: Record<string, number> = {},
): W => ({
  ts_second: ts,
  step_id: step,
  count,
  error_count: err,
  status_counts: codes,
  p50_ms: 1,
  p95_ms: 1,
  p99_ms: 1,
});

const mkRow = (
  index: number,
  name: string,
  over: Partial<StepRow> = {},
  status: Partial<RowStatus> = {},
): RankedRow => ({
  index,
  no: String.fromCharCode(0x2460 + index),
  stepId: `s${index}`,
  name,
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
  status: { tags: ["ok"], grade: 1, errorRate: 0, ...status },
});

const summary = (over: Partial<Report["summary"]> = {}): Report["summary"] =>
  ({
    count: 1000,
    errors: 0,
    rps: 10,
    mean_ms: 100,
    p50_ms: 100,
    p95_ms: 2400,
    p99_ms: 3000,
    ...over,
  }) as Report["summary"];

const base = (over: Partial<SummaryInput> = {}): SummaryInput => {
  const windows = over.windows ?? [];
  const rows = over.rows ?? [];
  const t0 = over.t0 ?? null;
  return {
    status: "completed",
    message: null,
    startedMs: 1_000_000,
    endedMs: 1_600_000,
    summary: summary(),
    box: { kind: "noCriteria" },
    matched: [],
    ranked: rows as RankedRow[],
    rows,
    windows,
    t0,
    chart: buildChartModel(windows, t0, rows),
    stepName: (id) => id,
    criteria: null,
    ...over,
  };
};

const mk = (
  metric: string,
  op: "max" | "min",
  threshold: number,
  actual: number | null,
  passed = false,
): Matched => ({
  spec: { metric, op, threshold, target: null },
  row:
    actual === null
      ? null
      : ({ metric, direction: op, threshold, actual, passed, target: null } as Matched["row"]),
});

const kindLine = (ls: SummaryLine[], kind: SummaryLine["kind"]) =>
  ls.find((l) => l.kind === kind)?.text;

describe("verdict_line_verbs", () => {
  const fail = (n: number): BoxState => ({ kind: "fail", evaluated: n, failed: n });
  it("upper bound verb", () => {
    const l = summaryLines(base({ box: fail(1), matched: [mk("error_rate", "max", 0.01, 0.026)] }));
    expect(kindLine(l, "verdict")).toBe("오류율이 기준을 넘었습니다 (측정 2.6%, 기준 1.0% 이하)");
  });
  it("lower bound verb", () => {
    const l = summaryLines(base({ box: fail(1), matched: [mk("rps", "min", 200, 150)] }));
    expect(kindLine(l, "verdict")).toBe(
      "처리량이 기준에 못 미쳤습니다 (측정 150건/초, 기준 200건/초 이상)",
    );
  });
  it("three misses -> first + 외 2개", () => {
    const l = summaryLines(
      base({
        box: fail(3),
        matched: [
          mk("error_rate", "max", 0.01, 0.026),
          mk("rps", "min", 200, 150),
          mk("p95_ms", "max", 1000, 2400),
        ],
      }),
    );
    expect(kindLine(l, "verdict")).toBe(
      "오류율이 기준을 넘었습니다 (측정 2.6%, 기준 1.0% 이하) 외 2개",
    );
  });
  it("pass / notJudged / notEvaluable / none", () => {
    expect(kindLine(summaryLines(base({ box: { kind: "pass", evaluated: 3 } })), "verdict")).toBe(
      "기준 3개를 모두 지켰습니다",
    );
    expect(
      kindLine(summaryLines(base({ box: { kind: "notJudged", reason: "aborted" } })), "verdict"),
    ).toBe("측정이 중단되어 기준 판정은 하지 않았습니다");
    expect(
      kindLine(summaryLines(base({ box: { kind: "notJudged", reason: "failed" } })), "verdict"),
    ).toBe("측정이 실패해 기준 판정은 하지 않았습니다");
    expect(
      kindLine(
        summaryLines(
          base({ box: { kind: "notJudged", reason: "zero" }, summary: summary({ count: 0 }) }),
        ),
        "verdict",
      ),
    ).toBeUndefined();
    expect(kindLine(summaryLines(base({ box: { kind: "notEvaluable" } })), "verdict")).toBe(
      "기준은 있었지만 평가할 데이터가 부족했습니다",
    );
    expect(
      kindLine(summaryLines(base({ box: { kind: "noCriteria" } })), "verdict"),
    ).toBeUndefined();
  });
});

const problemRows = (): RankedRow[] => [
  mkRow(0, "홈", { errorCount: 3 }, { tags: ["hasErrors"], grade: 2 }),
  mkRow(1, "목록", { errorCount: 5 }, { tags: ["hasErrors"], grade: 2 }),
  mkRow(2, "상세", { errorCount: 2 }, { tags: ["hasErrors"], grade: 2 }),
  mkRow(3, "첨부 업로드", { errorCount: 10, p95Ms: 4800 }, { tags: ["slow"], grade: 2 }),
  mkRow(4, "신청 제출", { errorCount: 870 }, { tags: ["error"], grade: 3 }),
];

describe("problem_steps_line", () => {
  it("top 3 by rank with first tag, then 외 N개", () => {
    const rows = problemRows();
    const l = summaryLines(base({ rows, ranked: rows }));
    expect(kindLine(l, "problemSteps")).toBe(
      "문제 단계: ⑤ 신청 제출(오류), ④ 첨부 업로드(느림), ② 목록(오류 있음) 외 2개",
    );
  });
  it("no problem steps -> no line", () => {
    const rows = [mkRow(0, "홈")];
    expect(kindLine(summaryLines(base({ rows, ranked: rows })), "problemSteps")).toBeUndefined();
  });
});

describe("error_identity_line", () => {
  const T = (over: Partial<StepRow> = {}) =>
    mkRow(
      4,
      "신청 제출",
      {
        stepId: "T",
        errorCount: 870,
        perCode: [
          { code: 503, count: 800, cls: "counted" },
          { code: 500, count: 70, cls: "counted" },
        ],
        ...over,
      },
      { tags: ["error"], grade: 3 },
    );
  const filler = [win(0, "Z", 1), win(599, "Z", 1)];
  const run = (
    row: RankedRow,
    windows: W[],
    errors = 1000,
    over: Partial<SummaryInput> = {},
  ): string | undefined => {
    const rows = [row];
    return kindLine(
      summaryLines(
        base({
          rows,
          ranked: rows,
          windows: [...filler, ...windows],
          t0: 0,
          summary: summary({ errors }),
          ...over,
        }),
      ),
      "errorIdentity",
    );
  };

  it("first appearance only", () => {
    expect(run(T(), [win(240, "T", 10, 5, { "503": 5 })])).toBe(
      "오류의 87%는 '신청 제출'에서 났고, 대부분 503(서버가 바쁨)입니다. 시작 4분 뒤 처음 나타났습니다.",
    );
  });
  it("continuing when >=50% of later bins show the code", () => {
    const ws: W[] = [];
    for (let s = 240; s < 600; s += 5) ws.push(win(s, "T", 10, 5, { "503": 5 }));
    expect(run(T(), ws)).toBe(
      "오류의 87%는 '신청 제출'에서 났고, 대부분 503(서버가 바쁨)입니다. 시작 4분 뒤부터 계속 났습니다.",
    );
  });
  it("under a minute uses seconds", () => {
    expect(run(T(), [win(30, "T", 10, 5, { "503": 5 })])).toContain("시작 30초 뒤 처음");
  });
  it("code 0 and unknown code wording", () => {
    expect(
      run(T({ perCode: [{ code: 0, count: 800, cls: "counted" }] }), [
        win(240, "T", 10, 5, { "0": 5 }),
      ]),
    ).toBe(
      "오류의 87%는 '신청 제출'에서 났고, 대부분 응답 없음(코드 없음)입니다. 시작 4분 뒤 처음 나타났습니다.",
    );
    expect(
      run(T({ perCode: [{ code: 418, count: 800, cls: "counted" }] }), [
        win(240, "T", 10, 5, { "418": 5 }),
      ]),
    ).toContain("대부분 418입니다.");
  });
  it("residual-only errors", () => {
    expect(run(T({ perCode: [] }), [win(240, "T", 10, 5)])).toBe(
      "오류의 87%는 '신청 제출'에서 났고, 응답은 받았지만 값을 꺼내거나 본문을 읽지 못했습니다. 시작 4분 뒤 처음 나타났습니다.",
    );
  });
  it("scattered below 50%", () => {
    expect(run(T({ errorCount: 400 }), [win(240, "T", 10, 5, { "503": 5 })])).toBe(
      "오류가 여러 단계에 흩어져 있습니다(가장 많은 곳: '신청 제출' 40%).",
    );
  });
  it("boundary follows the displayed rounded percent", () => {
    const w = [win(240, "T", 10, 5, { "503": 5 })];
    expect(run(T({ errorCount: 496 }), w)).toBe(
      "오류의 50%는 '신청 제출'에서 났고, 대부분 503(서버가 바쁨)입니다. 시작 4분 뒤 처음 나타났습니다.",
    );
    expect(run(T({ errorCount: 494 }), w)).toBe(
      "오류가 여러 단계에 흩어져 있습니다(가장 많은 곳: '신청 제출' 49%).",
    );
  });
  it("no errors -> no line", () => {
    expect(run(T({ errorCount: 0, perCode: [] }), [], 0)).toBeUndefined();
  });
});

describe("hidden_line", () => {
  it("largest uncounted cell", () => {
    const rows = [
      mkRow(0, "A", { perCode: [{ code: 502, count: 100, cls: "uncounted" }] }),
      mkRow(1, "B", {
        perCode: [
          { code: 502, count: 600, cls: "uncounted" },
          { code: 404, count: 900, cls: "unknown" },
        ],
      }),
    ];
    expect(kindLine(summaryLines(base({ rows, ranked: rows })), "hidden")).toBe(
      "'B'에서 502 응답 600건이 있었지만 응답 코드 검사가 없어 오류에서 제외됐습니다.",
    );
  });
  it("unknown only", () => {
    const rows = [mkRow(1, "B", { perCode: [{ code: 502, count: 600, cls: "unknown" }] })];
    expect(kindLine(summaryLines(base({ rows, ranked: rows })), "hidden")).toBe(
      "'B'에서 502 응답 600건이 있었지만 오류에 포함됐는지 확정할 수 없습니다.",
    );
  });
});

describe("slow_line", () => {
  const crit: Criteria = { max_p95_ms: 3000 };
  it("worst p95 + 외 N개", () => {
    const rows = [
      mkRow(0, "목록", { p95Ms: 3500 }, { tags: ["slow"], grade: 2 }),
      mkRow(1, "첨부 업로드", { p95Ms: 4800 }, { tags: ["slow"], grade: 2 }),
    ];
    expect(kindLine(summaryLines(base({ rows, ranked: rows, criteria: crit })), "slow")).toBe(
      "'첨부 업로드'(은)는 느립니다 (95% 응답 4.8초, 기준 3.0초) 외 1개",
    );
  });
  it("single", () => {
    const rows = [mkRow(1, "첨부 업로드", { p95Ms: 4800 }, { tags: ["slow"], grade: 2 })];
    expect(kindLine(summaryLines(base({ rows, ranked: rows, criteria: crit })), "slow")).toBe(
      "'첨부 업로드'(은)는 느립니다 (95% 응답 4.8초, 기준 3.0초)",
    );
  });
});

describe("special_lines", () => {
  it("zero requests with reason", () => {
    const l = summaryLines(
      base({ summary: summary({ count: 0, errors: 0 }), message: "connection refused" }),
    );
    expect(l[0]).toEqual({
      kind: "special",
      text: "요청이 하나도 실행되지 않았습니다. 사유: connection refused",
    });
  });
  it("aborted with elapsed", () => {
    const l = summaryLines(base({ status: "aborted", startedMs: 1_000_000, endedMs: 1_250_000 }));
    expect(l[0].text).toBe("측정이 도중에 중단되었습니다(4분 10초까지 측정).");
  });
  it("aborted before start", () => {
    const l = summaryLines(base({ status: "aborted", startedMs: null, endedMs: null }));
    expect(l[0].text).toBe("측정이 시작되기 전에 중단되었습니다.");
  });
  it("failed with reason", () => {
    const l = summaryLines(base({ status: "failed", message: "worker crashed" }));
    expect(l[0].text).toBe("측정이 실패로 끝났습니다. 사유: worker crashed");
  });
});

describe("fallback_line", () => {
  it("clean run", () => {
    expect(summaryLines(base())).toEqual([
      { kind: "fallback", text: "오류 없이 끝났습니다. 95% 응답시간은 2.4초입니다." },
    ]);
  });
});

describe("cap_five_lines", () => {
  it("specials first, cut after five, fixed order", () => {
    const rows = [
      ...problemRows().slice(0, 4),
      mkRow(
        4,
        "신청 제출",
        {
          stepId: "T",
          errorCount: 870,
          perCode: [
            { code: 503, count: 800, cls: "counted" },
            { code: 502, count: 50, cls: "uncounted" },
          ],
        },
        { tags: ["error"], grade: 3 },
      ),
    ];
    const l = summaryLines(
      base({
        status: "aborted",
        message: "x",
        summary: summary({ count: 0, errors: 1000 }),
        rows,
        ranked: rows,
        box: { kind: "fail", evaluated: 1, failed: 1 },
        matched: [mk("error_rate", "max", 0.01, 0.026)],
        criteria: { max_p95_ms: 3000 },
        windows: [win(0, "T", 10, 5, { "503": 5 })],
        t0: 0,
      }),
    );
    expect(l.map((x) => x.kind)).toEqual([
      "special",
      "special",
      "verdict",
      "problemSteps",
      "errorIdentity",
    ]);
  });
});

describe("short_summary", () => {
  it("keeps special, verdict, problemSteps only", () => {
    const ls: SummaryLine[] = [
      { kind: "special", text: "a" },
      { kind: "verdict", text: "b" },
      { kind: "problemSteps", text: "c" },
      { kind: "errorIdentity", text: "d" },
      { kind: "hidden", text: "e" },
      { kind: "slow", text: "f" },
      { kind: "fallback", text: "g" },
    ];
    expect(shortSummary(ls).map((x) => x.text)).toEqual(["a", "b", "c"]);
  });
  it("fallback-only list is kept (clean run without criteria)", () => {
    const ls = summaryLines(base());
    expect(shortSummary(ls)).toEqual([
      { kind: "fallback", text: "오류 없이 끝났습니다. 95% 응답시간은 2.4초입니다." },
    ]);
  });
});

describe("zero_request_run_sentences", () => {
  it("no NaN / Infinity / undefined", () => {
    const l = summaryLines(
      base({
        status: "aborted",
        startedMs: null,
        endedMs: null,
        summary: summary({ count: 0, errors: 0, p95_ms: 0, rps: 0 }),
        box: { kind: "notJudged", reason: "zero" },
      }),
    );
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) {
      expect(x.text).not.toContain("NaN");
      expect(x.text).not.toContain("Infinity");
      expect(x.text).not.toContain("undefined");
    }
  });
});
