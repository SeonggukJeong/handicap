import { describe, expect, it } from "vitest";
import { ReportSchema } from "../../../api/schemas";
import { buildErrorTable, ERR_MAX_COLS } from "../errorTable";
import { stepPairs } from "../errorCells";
import { buildRunModel, type RunModel } from "../runModel";
import { mkMeta, mkReport, scenarioYaml, type ReportStepSpec, type StepSpec } from "./fixtures";

function model(id: string, steps: StepSpec[], rep: ReportStepSpec[]): RunModel {
  const report = mkReport({ id, steps: rep, yaml: scenarioYaml(steps) });
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id), report);
}

const S = (id: string, name: string, over: Partial<StepSpec> = {}): StepSpec => ({
  id,
  name,
  ...over,
});
const R = (
  id: string,
  counts: Record<string, number>,
  errors = 0,
  notSent?: number,
): ReportStepSpec => ({ id, counts, errors, ...(notSent ? { notSent } : {}) });

/** NaN·undefined 값과 그 글자가 든 문자열이 어디에도 없다(JSON.stringify는 NaN을 null로 바꿔 못 잡는다). */
function expectClean(v: unknown, path = "$"): void {
  if (typeof v === "number") expect(Number.isNaN(v), path).toBe(false);
  else if (v === undefined) throw new Error(`undefined at ${path}`);
  else if (typeof v === "string") {
    expect(v.includes("NaN"), path).toBe(false);
    expect(v.includes("undefined"), path).toBe(false);
  } else if (Array.isArray(v)) v.forEach((x, i) => expectClean(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) expectClean(x, `${path}.${k}`);
  }
}

function table(before: RunModel, after: RunModel, incomparable = false) {
  return buildErrorTable({ before, after, pairs: stepPairs(before, after), incomparable });
}

// 시안 2쪽 표: 5단계
const mock = () => {
  const names = ["접수", "조회", "목록", "첨부 업로드", "결제"];
  // ②③⑤는 양쪽 다 200 검사가 있어 4xx/5xx가 오류로 센다. ④는 이전엔 검사가 없었다.
  const asserted = (i: number) => i === 1 || i === 2 || i === 4;
  const bSteps = names.map((n, i) =>
    asserted(i) ? S(`s${i + 1}`, n, { assert: [200] }) : S(`s${i + 1}`, n),
  );
  const aSteps = names.map((n, i) =>
    asserted(i) || i === 3 ? S(`s${i + 1}`, n, { assert: [200] }) : S(`s${i + 1}`, n),
  );
  const before = model("b", bSteps, [
    R("s1", { "200": 10000 }),
    R("s2", { "200": 9640, "429": 360 }, 360),
    R("s3", { "200": 9880, "404": 120 }, 120),
    R("s4", { "200": 9400, "502": 600 }, 0),
    R("s5", { "200": 6808, "503": 2880, "504": 312 }, 3192),
  ]);
  const after = model("a", aSteps, [
    R("s1", { "200": 10000 }),
    R("s2", { "200": 9640, "429": 360 }, 360),
    R("s3", { "200": 9952, "404": 48 }, 48),
    R("s4", { "200": 10000 }, 0),
    R("s5", { "200": 9976, "504": 24 }, 24),
  ]);
  return table(before, after);
};

describe("buildErrorTable", () => {
  it("상수", () => {
    expect(ERR_MAX_COLS).toBe(5);
  });

  it("시안 표", () => {
    const m = mock();
    expect(m.cols.map((c) => c.key)).toEqual(["c404", "c429", "c502", "c503", "c504"]);
    expect(m.cols[3]).toMatchObject({ label: "503", sub: "서버가 바쁨" });
    const r = (i: number) => m.rows[i]!;
    expect(r(0).cells.c404).toBeNull();
    expect(r(0).change).toEqual({ cls: "similar", glyph: "=", word: "비슷" });
    expect(r(1).cells.c429).toEqual({
      before: "360",
      after: "360",
      starBefore: false,
      starAfter: false,
      tone: "flat",
    });
    expect(r(1).remaining).toBe(true);
    expect(r(2).cells.c404).toMatchObject({ before: "120", after: "48", tone: "down" });
    expect(r(3).cells.c502).toEqual({
      before: "600",
      after: "0",
      starBefore: true,
      starAfter: false,
      tone: null,
    });
    expect(r(3).rate).toMatchObject({ starBefore: true, starAfter: false });
    expect(r(3).change).toEqual({ cls: "reference", glyph: "", word: "참고용" });
    expect(r(4).cells.c503).toMatchObject({ before: "2,880", after: "0", tone: "down" });
    expect(r(4).change).toEqual({ cls: "better", glyph: "▼", word: "좋아짐" });
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toContain("600");
  });

  it("접기: 코드 8종 + 응답 없음 + 보내지 않음 → 상위 2코드 · other · none · notSent", () => {
    const before = model(
      "b",
      [S("s1", "목록")],
      [
        R(
          "s1",
          {
            "401": 1,
            "403": 2,
            "404": 3,
            "409": 4,
            "429": 50,
            "500": 60,
            "502": 7,
            "503": 8,
            "0": 5,
            "200": 100,
          },
          8,
          3,
        ),
      ],
    );
    const after = model("a", [S("s1", "목록")], [R("s1", { "200": 100 })]);
    const m = table(before, after);
    expect(m.cols.map((c) => c.key)).toEqual(["c429", "c500", "other", "none", "notSent"]);
    expect(m.cols[2]).toMatchObject({
      label: "그 밖의 코드",
      codes: [401, 403, 404, 409, 502, 503],
    });
    expect(m.cols[3]).toMatchObject({ label: "응답 없음" });
    expect(m.cols[4]).toMatchObject({ label: "보내지 않음" });
    expect(m.rows[0]!.cells.other).toMatchObject({ before: "25", after: "0", tone: "down" });
    expect(m.notes[m.notes.length - 1]).toBe(
      "그 밖의 코드: 401 1건 → 0건, 403 2건 → 0건, 404 3건 → 0건, 409 4건 → 0건, 502 7건 → 0건, 503 8건 → 0건",
    );
  });

  it("고정 열 3개(응답 받은 뒤 실패 포함) + 코드 3종 → 코드 1개 + other", () => {
    const before = model(
      "b",
      [S("s1", "목록")],
      [R("s1", { "500": 30, "502": 20, "503": 10, "0": 5, "200": 100 }, 10, 3)],
    );
    const after = model("a", [S("s1", "목록")], [R("s1", { "200": 100 })]);
    const m = table(before, after);
    expect(m.cols.map((c) => c.key)).toEqual(["c500", "other", "none", "notSent", "residual"]);
    expect(m.cols[4]).toMatchObject({ label: "응답 받은 뒤 실패", kind: "residual" });
  });

  it("코드가 자리와 같으면 other 없음", () => {
    const before = model(
      "b",
      [S("s1", "목록")],
      [R("s1", { "500": 30, "502": 20, "0": 5, "200": 100 }, 10, 3)],
    );
    const after = model("a", [S("s1", "목록")], [R("s1", { "200": 100 })]);
    const m = table(before, after);
    expect(m.cols.map((c) => c.key)).toEqual(["c500", "c502", "none", "notSent", "residual"]);
    expect(m.notes).toEqual([]);
  });

  it("별이 붙은 2xx: 그 단계 칸만 별, 다른 단계 칸은 null", () => {
    const before = model(
      "b",
      [S("s1", "A", { assert: [201] }), S("s2", "B")],
      [R("s1", { "200": 1000 }, 1000), R("s2", { "200": 1000 })],
    );
    const after = model(
      "a",
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "200": 1000 }), R("s2", { "200": 1000 })],
    );
    const m = table(before, after);
    expect(m.cols.map((c) => c.key)).toEqual(["c200"]);
    expect(m.rows[0]!.cells.c200).toMatchObject({ starBefore: true, starAfter: true, tone: null });
    expect(m.rows[1]!.cells.c200).toBeNull();
  });

  it("expected ↔ uncounted: 별 없는 칸, 변화는 reference가 아님", () => {
    const before = model("b", [S("s1", "목록", { assert: [404] })], [R("s1", { "404": 30 })]);
    const after = model("a", [S("s1", "목록")], [R("s1", { "404": 30 })]);
    const m = table(before, after);
    expect(m.rows[0]!.cells.c404).toMatchObject({ starBefore: false, starAfter: false });
    expect(m.rows[0]!.change.cls).not.toBe("reference");
  });

  it("양쪽 다 오류 없음 → 열 없음, 비슷", () => {
    const steps = [S("s1", "A"), S("s2", "B")];
    const rep = () => [R("s1", { "200": 10 }), R("s2", { "200": 10 })];
    const m = table(model("b", steps, rep()), model("a", steps, rep()));
    expect(m.cols).toEqual([]);
    expect(m.rows.map((r) => r.change.word)).toEqual(["비슷", "비슷"]);
    expect(m.notes).toEqual([]);
  });

  it("오류율 글자가 같아도 분류가 다르면 자릿수를 늘린다", () => {
    const before = model("b", [S("s1", "A")], [R("s1", { "200": 9895, "500": 105 }, 105)]);
    const after = model("a", [S("s1", "A")], [R("s1", { "200": 9889, "500": 111 }, 111)]);
    const r = table(before, after).rows[0]!;
    expect(r.rate.before).not.toBe(r.rate.after);
    expect(r.change.cls).toBe("worse");
    expect(r.change.glyph).toBe("▲");
  });

  it("한쪽에만 있는 단계는 note와 '–', 분류 없음", () => {
    const before = model(
      "b",
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "200": 10 }), R("s2", { "500": 4 }, 4)],
    );
    const after = model(
      "a",
      [S("s1", "A"), S("s3", "C")],
      [R("s1", { "200": 10 }), R("s3", { "500": 4 }, 4)],
    );
    const m = table(before, after);
    const b = m.rows.find((r) => r.stepId === "s2")!;
    const c = m.rows.find((r) => r.stepId === "s3")!;
    expect(b.note).toBe("(이후 측정에 없음)");
    expect(b.rate.after).toBe("–");
    expect(b.change.cls).toBe("none");
    expect(c.note).toBe("(이전 측정에 없음)");
    expect(c.rate.before).toBe("–");
    expect(c.change).toEqual({ cls: "none", glyph: "", word: "–" });
    // 없는 쪽은 0이 아니라 "–"(측정하지 않음), 톤 없음
    expect(b.cells.c500).toEqual({
      before: "4",
      after: "–",
      starBefore: false,
      starAfter: false,
      tone: null,
    });
    expect(c.cells.c500).toEqual({
      before: "–",
      after: "4",
      starBefore: false,
      starAfter: false,
      tone: null,
    });
    for (const r of [b, c]) {
      expect(r.rate.starBefore || r.rate.starAfter).toBe(false);
      for (const cell of Object.values(r.cells)) {
        expect(cell?.starBefore || cell?.starAfter).toBeFalsy();
      }
    }
  });

  it("한쪽에만 있는 단계가 오류 없는 쪽만 있으면 칸 전체가 null", () => {
    const before = model(
      "b",
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "500": 4, "200": 6 }, 4), R("s2", { "200": 10 })],
    );
    const after = model("a", [S("s1", "A")], [R("s1", { "500": 4, "200": 6 }, 4)]);
    const m = table(before, after);
    expect(m.rows.find((r) => r.stepId === "s2")!.cells.c500).toBeNull();
    expect(m.rows.find((r) => r.stepId === "s1")!.cells.c500).toMatchObject({
      before: "4",
      after: "4",
      tone: "flat",
    });
  });

  it("단계가 하나도 안 겹치면 모든 행 none, NaN·undefined 없음", () => {
    const before = model(
      "b",
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "500": 4, "200": 6 }, 4), R("s2", { "200": 10 })],
    );
    const after = model(
      "a",
      [S("t1", "C"), S("t2", "D")],
      [R("t1", { "200": 10 }), R("t2", { "503": 2, "200": 8 }, 2)],
    );
    const m = table(before, after);
    expect(m.rows).toHaveLength(4);
    expect(m.rows.every((r) => r.change.cls === "none")).toBe(true);
    expectClean(m);
  });

  it("incomparable이면 모든 행 none · remaining false · 별 각주 없음", () => {
    const before = model(
      "b",
      [S("s1", "접수"), S("s2", "조회")],
      [R("s1", { "200": 9400, "502": 600 }), R("s2", { "429": 360, "200": 100 }, 360)],
    );
    const after = model(
      "a",
      [S("s1", "접수", { assert: [200] }), S("s2", "조회")],
      [R("s1", { "200": 10000 }), R("s2", { "429": 360, "200": 100 }, 360)],
    );
    const m = table(before, after, true);
    expect(m.rows.every((r) => r.change.cls === "none" && !r.remaining)).toBe(true);
    expect(m.notes).toEqual([]);
  });
});
