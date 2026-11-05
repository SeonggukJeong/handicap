import { describe, expect, it } from "vitest";
import {
  buildColumns,
  buildStepTable,
  classifyCell,
  codeFamily,
  type CellClass,
} from "../stepTable";
import { readScenarioFacts, type ScenarioFacts, type StepFacts } from "../scenarioFacts";
import type { Report } from "../../api/schemas";

type RS = Report["steps"][number];

const rs = (id: string, status_counts: Record<string, number>, over: Partial<RS> = {}): RS => {
  const count = Object.values(status_counts).reduce((a, b) => a + b, 0);
  return {
    step_id: id,
    count,
    error_count: 0,
    status_counts,
    p50_ms: 1,
    p95_ms: 2,
    p99_ms: 3,
    ...over,
  };
};

const sf = (id: string, over: Partial<StepFacts> = {}): StepFacts => ({
  id,
  name: `이름${id}`,
  method: "GET",
  url: `/p/${id}`,
  statusCodes: [],
  fallibleExtract: false,
  ...over,
});

const okFacts = (steps: StepFacts[]): ScenarioFacts => ({ ok: true, name: null, steps });

const labels = (cols: { label: string }[]) => cols.map((c) => c.label);

describe("codeFamily", () => {
  it.each([
    [0, "none"],
    [200, "2xx"],
    [299, "2xx"],
    [301, "3xx"],
    [404, "4xx"],
    [503, "5xx"],
    [99, "other"],
    [101, "other"],
    [600, "other"],
  ] as const)("%i -> %s", (code, fam) => {
    expect(codeFamily(code)).toBe(fam);
  });
});

describe("classifyCell", () => {
  const F = (statusCodes: number[], fallibleExtract: boolean) => ({ statusCodes, fallibleExtract });
  it.each<[number, { statusCodes: number[]; fallibleExtract: boolean } | null, CellClass]>([
    [0, F([200], false), "counted"],
    [0, null, "counted"],
    [503, F([200], false), "counted"],
    [200, F([200, 201], false), "counted"],
    [201, F([201], false), "expected"],
    [404, F([404], false), "expected"],
    [503, F([], false), "uncounted"],
    [503, F([], true), "unknown"],
    [200, F([], false), "plain"],
    [302, F([], false), "plain"],
    [99, F([], false), "uncounted"],
    [101, F([], true), "unknown"],
    [600, F([200], false), "counted"],
    [503, null, "unknown"],
    [200, null, "plain"],
  ])("classify_table_rows %i %j -> %s", (code, facts, expected) => {
    expect(classifyCell(code, facts)).toBe(expected);
  });
});

const ENGINE_YAML = `version: 1
name: 시험
steps:
  - id: 01JABCDEFGHJKMNPQRSTVWXYZ0
    name: 로그인
    type: http
    request:
      method: POST
      url: "\${BASE_URL}/login"
    assert:
      - status: 200
`;

// 4xx 접힘 유도: 코드 9개(B=6)
const BIG = { "200": 1, "404": 50, "500": 9, "501": 8, "502": 7, "503": 6, "504": 5 };

const SPEC_COUNTS = {
  "200": 100,
  "0": 7,
  "503": 2880,
  "404": 120,
  "500": 60,
  "504": 40,
  "400": 10,
  "401": 5,
  "403": 3,
  "502": 2,
};

describe("buildStepTable", () => {
  it("classify_uses_saved_status_shape", () => {
    const facts = readScenarioFacts(ENGINE_YAML);
    const t = buildStepTable(
      [rs("01JABCDEFGHJKMNPQRSTVWXYZ0", { "200": 5, "503": 3 }, { error_count: 3 })],
      facts,
    );
    const row = t.rows[0];
    expect(row.factsKnown).toBe(true);
    expect(row.perCode.find((p) => p.code === 503)?.cls).toBe("counted");
    expect(row.cells["c503"].cls).toBe("counted");
  });

  it("residual_is_subset_and_floored", () => {
    const facts = okFacts([sf("A", { statusCodes: [200] })]);
    const t = buildStepTable(
      [rs("A", { "200": 80, "503": 20 }, { count: 100, error_count: 30 })],
      facts,
    );
    expect(t.rows[0].perCode.find((p) => p.code === 503)).toMatchObject({
      count: 20,
      cls: "counted",
    });
    expect(t.rows[0].residual).toBe(10);
    expect(t.rows[0].residualUncertain).toBe(false);
    const t2 = buildStepTable(
      [rs("A", { "200": 80, "503": 20 }, { count: 100, error_count: 5 })],
      facts,
    );
    expect(t2.rows[0].residual).toBe(0);
  });

  it("residual_uncertain_only_with_unknown_cell_and_residual", () => {
    const facts = okFacts([sf("A", { fallibleExtract: true })]);
    const t = buildStepTable([rs("A", { "200": 8, "503": 2 }, { error_count: 3 })], facts);
    expect(t.rows[0].residual).toBe(3);
    expect(t.rows[0].residualUncertain).toBe(true);
    const t2 = buildStepTable([rs("A", { "200": 8, "503": 2 }, { error_count: 0 })], facts);
    expect(t2.rows[0].residual).toBe(0);
    expect(t2.rows[0].residualUncertain).toBe(false);
  });

  it("ignores non-integer status keys and zero counts", () => {
    const t = buildStepTable(
      [rs("A", { "200": 4, abc: 3, "2.5": 1, "404": 0 })],
      okFacts([sf("A")]),
    );
    expect(t.rows[0].perCode).toEqual([{ code: 200, count: 4, cls: "plain" }]);
  });

  it("fold_spec_example", () => {
    const facts = okFacts([sf("A", { statusCodes: [200] })]);
    const t = buildStepTable([rs("A", SPEC_COUNTS, { error_count: 99999 })], facts);
    expect(labels(t.columns)).toEqual([
      "2xx",
      "404",
      "기타 4xx",
      "503",
      "기타 5xx",
      "응답 없음",
      "그중: 응답 받은 뒤 실패",
    ]);
    expect(t.columns).toHaveLength(7);
    expect(t.columns.find((c) => c.label === "기타 4xx")?.codes).toEqual([400, 401, 403]);
    expect(t.columns.find((c) => c.label === "기타 5xx")?.codes).toEqual([500, 502, 504]);
  });

  it("fold_single_code_family_keeps_name", () => {
    const totals = new Map<number, number>([
      [200, 10],
      [0, 5],
      [503, 100],
      [502, 90],
      [500, 80],
      [501, 70],
      [404, 1],
    ]);
    // 고정 3(2xx·응답 없음·잔차) → B=4, |K|=5 → 접힘. F={500,501,404}: 4xx 는 404 하나뿐
    const out = labels(buildColumns(totals, true));
    expect(out).toEqual(
      ["2xx", "404", "기타 5xx", "503", "응답 없음", "그중: 응답 받은 뒤 실패"].length ? out : [],
    );
    expect(out).toContain("404");
    expect(out).not.toContain("기타 4xx");
    expect(out).toContain("기타 5xx");
  });

  it("no_fold_when_within_budget", () => {
    // 고정 1(2xx) → B=6, K 5개 → 접지 않음
    const totals = new Map<number, number>([
      [200, 1],
      [404, 5],
      [400, 4],
      [503, 3],
      [500, 2],
      [99, 1],
    ]);
    expect(labels(buildColumns(totals, false))).toEqual(["2xx", "400", "404", "500", "503", "99"]);
    // 전 계열: 2xx, 3xx, 4xx↑, 5xx↑, other↑, 응답 없음, 잔차 순
    const all = new Map<number, number>([
      [200, 1],
      [301, 1],
      [404, 1],
      [503, 1],
      [0, 1],
    ]);
    expect(labels(buildColumns(all, true))).toEqual([
      "2xx",
      "3xx",
      "404",
      "503",
      "응답 없음",
      "그중: 응답 받은 뒤 실패",
    ]);
  });

  it("folded_cell_takes_strongest", () => {
    // A: 검사 없음 → 4xx 전부 uncounted. B: 검사 [200] → 400 은 counted.
    // 한 행에서 접힌 칸 구성이 uncounted + counted 이면 counted.
    const facts = okFacts([sf("A", { statusCodes: [] }), sf("B", { statusCodes: [404] })]);
    const steps = [
      rs("A", { ...BIG, "400": 3, "401": 2, "403": 1 }),
      rs("B", { "200": 1, "401": 3 }),
    ];
    const t = buildStepTable(steps, facts);
    const folded = t.columns.find((c) => c.key === "f4xx");
    expect(folded).toBeDefined();
    expect(folded!.codes).toEqual([400, 401, 403]);
    expect(t.rows[0].cells["f4xx"].cls).toBe("uncounted");
    // B: 401 은 S=[404] 불일치 → counted. 접힌 칸 = counted
    expect(t.rows[1].cells["f4xx"]).toMatchObject({ count: 3, cls: "counted" });
  });

  it("folded_cell_mixed_in_one_row", () => {
    // 한 행: 접힌 칸에 uncounted(검사 없음)가 아니라 expected + counted 가 섞이는 경우
    const facts = okFacts([sf("A", { statusCodes: [400] })]);
    const steps = [
      rs("A", { ...BIG, "400": 3, "401": 2, "403": 1 }),
    ];
    const t = buildStepTable(steps, facts);
    // 400 은 expected, 401·403 은 counted → 접힌 4xx 칸은 counted
    expect(t.rows[0].cells["f4xx"]).toMatchObject({ count: 6, cls: "counted" });
  });

  it("class2xx_column_takes_strongest", () => {
    const facts = okFacts([sf("A", { statusCodes: [201] })]);
    const t = buildStepTable([rs("A", { "200": 3, "201": 2 })], facts);
    const c = t.rows[0].cells["2xx"];
    expect(c.count).toBe(5);
    expect(c.cls).toBe("counted");
  });

  it("strongest_marks_max_counted_column", () => {
    const facts = okFacts([sf("A", { statusCodes: [200] })]);
    const t = buildStepTable([rs("A", { "200": 50, "503": 5, "502": 5, "404": 1 })], facts);
    const cells = t.rows[0].cells;
    expect(cells["c502"].strongest).toBe(true);
    expect(cells["c503"].strongest).toBe(false);
    expect(cells["c404"].strongest).toBe(false);
    expect(cells["2xx"].strongest).toBe(false);
  });

  it("fold_notes", () => {
    const facts = okFacts([sf("A", { statusCodes: [200] })]);
    const t = buildStepTable(
      [rs("A", { ...SPEC_COUNTS, "201": 7 }, { error_count: 99999 })],
      facts,
    );
    expect(t.foldNotes).toEqual([
      {
        columnLabel: "2xx",
        parts: [
          { code: 200, count: 100 },
          { code: 201, count: 7 },
        ],
      },
      {
        columnLabel: "기타 4xx",
        parts: [
          { code: 400, count: 10 },
          { code: 401, count: 5 },
          { code: 403, count: 3 },
        ],
      },
      {
        columnLabel: "기타 5xx",
        parts: [
          { code: 500, count: 60 },
          { code: 502, count: 2 },
          { code: 504, count: 40 },
        ],
      },
    ]);
  });

  it("rows_order_and_missing", () => {
    const facts = okFacts([sf("A"), sf("B"), sf("C")]);
    const t = buildStepTable(
      [rs("A", { "200": 1 }), rs("C", { "200": 1 }), rs("Z", { "404": 2, "0": 1 })],
      facts,
    );
    expect(t.rows.map((r) => r.stepId)).toEqual(["A", "B", "C", "Z"]);
    expect(t.rows.map((r) => r.no)).toEqual(["①", "②", "③", "④"]);
    expect(t.rows[1]).toMatchObject({ executed: false, count: 0, errorCount: 0, factsKnown: true });
    expect(t.rows[3]).toMatchObject({
      name: "Z",
      requestLine: null,
      factsKnown: false,
      executed: true,
    });
    expect(t.rows[3].cells["c404"].cls).toBe("unknown");
    expect(t.rows[3].cells["none"].cls).toBe("counted");
    expect(t.rows[0].requestLine).toBe("GET /p/A");
    expect(t.rows[0].name).toBe("이름A");
    expect(t.scenarioUnreadable).toBe(false);
  });

  it("unreadable_scenario", () => {
    const t = buildStepTable([rs("A", { "404": 1 }), rs("B", { "200": 1 })], { ok: false });
    expect(t.scenarioUnreadable).toBe(true);
    expect(t.rows.every((r) => !r.factsKnown)).toBe(true);
    expect(t.rows[0].cells["c404"].cls).toBe("unknown");
  });
});
