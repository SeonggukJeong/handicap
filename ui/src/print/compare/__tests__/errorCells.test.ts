import { describe, expect, it } from "vitest";
import { ReportSchema } from "../../../api/schemas";
import { buildRunModel, type RunModel } from "../runModel";
import {
  biggestCodeChange,
  countsAsError,
  hasStar,
  remainingIssues,
  starFootnote,
  stepPairs,
  type StepPair,
} from "../errorCells";
import {
  baseProfile,
  mkMeta,
  mkReport,
  scenarioYaml,
  type ReportStepSpec,
  type StepSpec,
} from "./fixtures";

function model(id: string, steps: StepSpec[], rep: ReportStepSpec[], yaml?: string): RunModel {
  const report = mkReport({ id, steps: rep, yaml: yaml ?? scenarioYaml(steps) });
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id), report);
}

const S = (id: string, name: string, over: Partial<StepSpec> = {}): StepSpec => ({
  id,
  name,
  ...over,
});
const R = (id: string, counts: Record<string, number>, errors = 0): ReportStepSpec => ({
  id,
  counts,
  errors,
});

function codeOf(pairs: StepPair[], stepId: string, code: number | "notSent" | "residual") {
  const c = pairs.find((p) => p.stepId === stepId)?.codes.find((x) => x.code === code);
  if (!c) throw new Error(`no code ${code} on ${stepId}`);
  return c;
}

describe("countsAsError", () => {
  it("다섯 분류를 센다/안 센다/알 수 없음으로 옮긴다", () => {
    expect(countsAsError("counted")).toBe("yes");
    expect(countsAsError("plain")).toBe("no");
    expect(countsAsError("expected")).toBe("no");
    expect(countsAsError("uncounted")).toBe("no");
    expect(countsAsError("unknown")).toBe("maybe");
  });
});

describe("stepPairs 별(*)", () => {
  it("600* → 0: 이전 502는 검사가 없어 안 셌고 이후는 센다", () => {
    const before = model("b", [S("s4", "첨부 업로드")], [R("s4", { "200": 9400, "502": 600 })]);
    const after = model(
      "a",
      [S("s4", "첨부 업로드", { assert: [200] })],
      [R("s4", { "200": 10000 })],
    );
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s4", 502);
    expect(c.before).toBe(600);
    expect(c.after).toBe(0);
    expect(c.starBefore).toBe(true);
    expect(c.starAfter).toBe(false);
    expect(c.countsBefore).toBe("no");
    expect(c.countsAfter).toBe("yes");
    expect(hasStar(pairs)).toBe(true);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("첨부 업로드");
    expect(note).toContain("502");
    expect(note).toContain("600");
    expect(note).toContain("이전");
    expect(note).toContain("포함되지 않았습니다");
  });

  it("201 검사 제거: 양쪽 200 칸에 별, 각주는 이후의 안 센다 문장 하나", () => {
    const before = model("b", [S("s1", "접수", { assert: [201] })], [R("s1", { "200": 500 }, 500)]);
    const after = model("a", [S("s1", "접수")], [R("s1", { "200": 500 }, 0)]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 200);
    expect(c.starBefore).toBe(true);
    expect(c.starAfter).toBe(true);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("이후");
    expect(note).not.toContain("이전");
    expect(note).toContain("500");
    expect(note).toContain("포함되지 않았습니다");
  });

  it("expected ↔ uncounted: 둘 다 안 세므로 별 없음", () => {
    const before = model("b", [S("s1", "목록", { assert: [404] })], [R("s1", { "404": 30 })]);
    const after = model("a", [S("s1", "목록")], [R("s1", { "404": 30 })]);
    const pairs = stepPairs(before, after);
    expect(codeOf(pairs, "s1", 404).starBefore).toBe(false);
    expect(codeOf(pairs, "s1", 404).starAfter).toBe(false);
    expect(hasStar(pairs)).toBe(false);
    expect(starFootnote(pairs)).toBeNull();
  });

  it("센다 ↔ 알 수 없음, 센 쪽만 건수가 있으면 '세었지만 … 확정할 수 없습니다' 문장", () => {
    const before = model("b", [S("s1", "조회", { assert: [200] })], [R("s1", { "503": 10 }, 10)]);
    const after = model("a", [S("s1", "조회", { extract: true })], [R("s1", { "200": 10 })]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 503);
    expect([c.countsBefore, c.countsAfter]).toEqual(["yes", "maybe"]);
    expect([c.starBefore, c.starAfter]).toEqual([true, false]);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("이전 측정에서 오류로 세었지만");
    expect(note).toContain("이후 측정에서는 같은 응답을 오류로 세는지 확정할 수 없습니다");
    expect(note).not.toContain("이전 측정에서 오류로 세었는지 확정할 수 없습니다");
  });

  it("안 센다 ↔ 알 수 없음, 안 센 쪽만 건수가 있으면 상대는 확정할 수 없다고 적는다", () => {
    const before = model("b", [S("s1", "조회")], [R("s1", { "502": 600 })]);
    const after = model("a", [S("s1", "조회", { extract: true })], [R("s1", { "200": 10 })]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 502);
    expect([c.countsBefore, c.countsAfter]).toEqual(["no", "maybe"]);
    expect([c.starBefore, c.starAfter]).toEqual([true, false]);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("이전 측정에서 오류율에 포함되지 않았습니다");
    expect(note).toContain("이후 측정에서는 같은 응답을 오류로 세는지 확정할 수 없습니다");
    expect(note).not.toContain("다른 측정에서는 오류로 셉니다");
  });

  it("센다 ↔ 알 수 없음, 양쪽 별이면 알 수 없음 쪽을 짚는다", () => {
    const before = model("b", [S("s1", "조회", { assert: [200] })], [R("s1", { "503": 10 }, 10)]);
    const after = model("a", [S("s1", "조회", { extract: true })], [R("s1", { "503": 7 })]);
    const note = starFootnote(stepPairs(before, after)) ?? "";
    expect(note).toContain("503 7건이 이후 측정에서 오류로 세었는지 확정할 수 없습니다");
    expect(note).not.toContain("세었지만");
  });

  it("안 센다 ↔ 알 수 없음, 양쪽 별이면 안 센다 쪽을 짚는다", () => {
    const before = model("b", [S("s1", "조회")], [R("s1", { "502": 600 })]);
    const after = model("a", [S("s1", "조회", { extract: true })], [R("s1", { "502": 5 })]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 502);
    expect([c.countsBefore, c.countsAfter]).toEqual(["no", "maybe"]);
    expect([c.starBefore, c.starAfter]).toEqual([true, true]);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("502 600건은 이전 측정에서 오류율에 포함되지 않았습니다");
    expect(note).toContain("이후 측정에서는 같은 응답을 오류로 세는지 확정할 수 없습니다");
  });

  it("알 수 없음 ↔ 안 센다, 알 수 없음 쪽만 건수가 있으면 그 쪽을 건수와 함께 짚는다", () => {
    const before = model("b", [S("s1", "조회", { extract: true })], [R("s1", { "502": 6 })]);
    const after = model("a", [S("s1", "조회")], [R("s1", { "200": 10 })]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 502);
    expect([c.countsBefore, c.countsAfter]).toEqual(["maybe", "no"]);
    expect([c.starBefore, c.starAfter]).toEqual([true, false]);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("502 6건이 이전 측정에서 오류로 세었는지 확정할 수 없습니다");
  });

  it("알 수 없음 ↔ 센다, 알 수 없음 쪽만 건수가 있으면 그 쪽을 건수와 함께 짚는다", () => {
    const before = model("b", [S("s1", "조회", { extract: true })], [R("s1", { "503": 4 })]);
    const after = model("a", [S("s1", "조회", { assert: [200] })], [R("s1", { "200": 10 })]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 503);
    expect([c.countsBefore, c.countsAfter]).toEqual(["maybe", "yes"]);
    expect([c.starBefore, c.starAfter]).toEqual([true, false]);
    const note = starFootnote(pairs) ?? "";
    expect(note).toContain("503 4건이 이전 측정에서 오류로 세었는지 확정할 수 없습니다");
  });

  it("센다 ↔ 안 센다인데 센 쪽만 건수가 있으면 '에서만 오류로 세었습니다' 문장", () => {
    const before = model("b", [S("s1", "조회", { assert: [200] })], [R("s1", { "503": 10 }, 10)]);
    const after = model("a", [S("s1", "조회")], [R("s1", { "200": 10 })]);
    const note = starFootnote(stepPairs(before, after)) ?? "";
    expect(note).toContain("이전 측정에서만 오류로 세었습니다");
  });

  it("각주는 단계가 아니라 별 (단계, 코드) 자리 기준: 큰 순 2개 + 외 N곳", () => {
    const before = model(
      "b",
      [S("s1", "A"), S("s2", "B")],
      [R("s1", { "502": 600, "503": 100 }), R("s2", { "504": 300 })],
    );
    const after = model(
      "a",
      [S("s1", "A", { assert: [200] }), S("s2", "B", { assert: [200] })],
      [R("s1", { "200": 10 }), R("s2", { "200": 10 })],
    );
    const note = starFootnote(stepPairs(before, after)) ?? "";
    expect(note).toContain("'① A'의 502 600건");
    expect(note).toContain("'② B'의 504 300건");
    expect(note).not.toContain("503");
    expect(note).toContain("외 1곳");
  });

  it("한쪽에만 있는 단계는 presence로 표시하고 별이 없다", () => {
    const before = model(
      "b",
      [S("s1", "A"), S("s2", "옛 단계")],
      [R("s1", { "200": 5 }), R("s2", { "500": 7 }, 7)],
    );
    const after = model(
      "a",
      [S("s1", "A"), S("s3", "새 단계", { assert: [200] })],
      [R("s1", { "200": 5 }), R("s3", { "500": 2 }, 2)],
    );
    const pairs = stepPairs(before, after);
    expect(pairs.map((p) => [p.stepId, p.presence])).toEqual([
      ["s1", "both"],
      ["s3", "afterOnly"],
      ["s2", "beforeOnly"],
    ]);
    expect(pairs[2].label).toBe("옛 단계");
    expect(hasStar(pairs)).toBe(false);
  });

  it("깨진 YAML 한쪽: throw 없이 사실 없음으로 분류", () => {
    const before = model("b", [], [R("s1", { "502": 4 }, 4)], "steps: [unclosed");
    expect(before.facts.ok).toBe(false);
    const after = model("a", [S("s1", "조회", { assert: [200] })], [R("s1", { "502": 4 }, 4)]);
    const pairs = stepPairs(before, after);
    const c = codeOf(pairs, "s1", 502);
    expect(c.countsBefore).toBe("maybe");
    expect(c.countsAfter).toBe("yes");
    expect(() => remainingIssues(after, pairs)).not.toThrow();
  });

  it("보내지 않음·잔차·코드 0은 별이 없다", () => {
    const before = model(
      "b",
      [S("s1", "A")],
      [{ id: "s1", counts: { "0": 3, "200": 10 }, errors: 9, notSent: 4 }],
    );
    const after = model("a", [S("s1", "A")], [R("s1", { "200": 10 })]);
    const pairs = stepPairs(before, after);
    expect(codeOf(pairs, "s1", 0).starBefore).toBe(false);
    const ns = codeOf(pairs, "s1", "notSent");
    expect([ns.before, ns.after, ns.starBefore]).toEqual([4, 0, false]);
    const rs = codeOf(pairs, "s1", "residual");
    expect(rs.before).toBe(2);
  });
});

describe("remainingIssues", () => {
  const steps = [S("s1", "목록")];
  const issues = (b: Record<string, number>, a: Record<string, number>) => {
    const before = model("b", steps, [R("s1", b)]);
    const after = model("a", steps, [R("s1", a)]);
    return remainingIssues(after, stepPairs(before, after));
  };

  it("이후에 ✕/▲ 단계가 있으면 첫 항목으로 상태 낱말과 함께", () => {
    const before = model("b", steps, [R("s1", { "200": 100 })]);
    const after = model("a", steps, [{ id: "s1", counts: { "200": 99, "500": 1 }, errors: 1 }]);
    const list = remainingIssues(after, stepPairs(before, after));
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("목록");
    expect(list[0]).toContain("오류 있음");
  });

  it("줄지 않은 오류: 같으면 그대로", () => {
    const list = issues({ "429": 360 }, { "429": 360 });
    expect(list.some((t) => t.includes("429") && t.includes("360") && t.includes("그대로"))).toBe(
      true,
    );
  });

  it("늘었으면 N건 → M건으로 늘었습니다", () => {
    const list = issues({ "429": 360 }, { "429": 400 });
    expect(list.join("\n")).toContain("360건 → 400건으로 늘었습니다");
  });

  it("5.6% 감소는 항목 없음", () => {
    const list = issues({ "429": 360 }, { "429": 340 });
    expect(list.join("\n")).not.toContain("그대로");
    expect(list.join("\n")).not.toContain("늘었습니다");
  });

  it("4.2% 감소(≥ 0.95배)는 그대로", () => {
    expect(issues({ "429": 360 }, { "429": 345 }).join("\n")).toContain("그대로");
  });

  it("딱 0.95배(360 → 342)도 그대로 쪽", () => {
    expect(issues({ "429": 360 }, { "429": 342 }).join("\n")).toContain("그대로");
    expect(issues({ "429": 360 }, { "429": 341 }).join("\n")).not.toContain("그대로");
  });

  it("검사가 있는 단계의 기대한 200은 대상이 아니다", () => {
    const st = [S("s1", "목록", { assert: [200] })];
    const before = model("b", st, [R("s1", { "200": 9000 })]);
    const after = model("a", st, [R("s1", { "200": 9000 })]);
    expect(remainingIssues(after, stepPairs(before, after))).toEqual([]);
  });

  it("새로 생긴 오류: 0 → 48", () => {
    const list = issues({ "200": 10 }, { "200": 10, "503": 48 });
    expect(list.join("\n")).toContain("48건이 새로 생겼습니다");
  });

  it("같은 단계가 문제 단계와 줄지 않은 오류에 다 걸리면 항목 하나", () => {
    const list = issues({ "429": 360 }, { "429": 360 });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("목록");
    expect(list[0]).toContain("그대로");
    expect(list[0]).toContain("오류 제외");
  });

  it("201 검사를 지운 뒤 200은 성공 응답이라 새로 생겼다고 하지 않는다", () => {
    const before = model(
      "b",
      [S("s1", "접수", { assert: [201] })],
      [R("s1", { "201": 9000 }, 9000)],
    );
    const after = model("a", [S("s1", "접수")], [R("s1", { "200": 9000 })]);
    expect(remainingIssues(after, stepPairs(before, after))).toEqual([]);
  });

  it("201 검사 제거: 양쪽 200은 이후에 plain이라 항목 없음", () => {
    const before = model("b", [S("s1", "접수", { assert: [201] })], [R("s1", { "200": 500 }, 500)]);
    const after = model("a", [S("s1", "접수")], [R("s1", { "200": 500 })]);
    expect(remainingIssues(after, stepPairs(before, after))).toEqual([]);
  });

  it("이후에 검사가 생겨 expected가 된 429는 항목 없음", () => {
    const before = model("b", [S("s1", "목록")], [R("s1", { "429": 360 })]);
    const after = model("a", [S("s1", "목록", { assert: [429] })], [R("s1", { "429": 360 })]);
    expect(remainingIssues(after, stepPairs(before, after))).toEqual([]);
  });

  it("순서: 문제 단계(✕ → ▲) → 그대로·늘었습니다(큰 순) → 새로 생겼습니다", () => {
    const profile = { ...baseProfile, criteria: { max_error_rate: 0.01 } };
    const st = [
      S("s1", "가"),
      S("s2", "나"),
      S("s3", "다", { assert: [200] }),
      S("s4", "라", { assert: [200] }),
    ];
    const mk = (id: string, rep: ReportStepSpec[]) =>
      buildRunModel(mkMeta(id), mkReport({ id, steps: rep, yaml: scenarioYaml(st), profile }));
    const before = mk("b", [
      R("s1", { "429": 100 }),
      R("s2", { "429": 360 }),
      R("s3", { "200": 100 }),
      R("s4", { "200": 10000 }),
    ]);
    const after = mk("a", [
      R("s1", { "429": 100 }),
      R("s2", { "429": 400 }),
      { id: "s3", counts: { "200": 50, "500": 50 }, errors: 50 },
      { id: "s4", counts: { "200": 9990, "500": 10 }, errors: 10 },
    ]);
    const list = remainingIssues(after, stepPairs(before, after));
    expect(list).toHaveLength(4);
    expect(list[0]).toContain("③ 다");
    expect(list[0]).toContain("오류");
    expect(list[1]).toContain("② 나");
    expect(list[1]).toContain("360건 → 400건으로 늘었습니다");
    expect(list[2]).toContain("① 가");
    expect(list[2]).toContain("100건은 그대로입니다");
    expect(list[3]).toBe("④ 라의 500 서버 오류 10건이 새로 생겼습니다.");
  });

  it("문제 단계가 아닌 항목: 그대로·늘었습니다가 새로 생겼습니다보다 앞, 같은 종류는 큰 건수 먼저", () => {
    const profile = { ...baseProfile, criteria: { max_error_rate: 0.01 } };
    const names = ["가", "나", "다", "라", "마"];
    const st = names.map((n, i) => S(`s${i + 1}`, n, { assert: [200] }));
    const row = (i: number, e: number): ReportStepSpec => ({
      id: `s${i}`,
      counts: e > 0 ? { "200": 10000, "500": e } : { "200": 10000 },
      errors: e,
    });
    const mk = (id: string, errs: number[]) =>
      buildRunModel(
        mkMeta(id),
        mkReport({
          id,
          steps: errs.map((e, i) => row(i + 1, e)),
          yaml: scenarioYaml(st),
          profile,
        }),
      );
    const before = mk("b", [10, 36, 20, 0, 0]);
    const after = mk("a", [10, 40, 25, 7, 48]);
    const list = remainingIssues(after, stepPairs(before, after));
    expect(list).toEqual([
      "② 나의 500 서버 오류 36건 → 40건으로 늘었습니다.",
      "③ 다의 500 서버 오류 20건 → 25건으로 늘었습니다.",
      "① 가의 500 서버 오류 10건은 그대로입니다.",
      "⑤ 마의 500 서버 오류 48건이 새로 생겼습니다.",
      "④ 라의 500 서버 오류 7건이 새로 생겼습니다.",
    ]);
  });

  it("아무것도 없으면 빈 배열", () => {
    expect(issues({ "200": 10 }, { "200": 10 })).toEqual([]);
  });
});

describe("biggestCodeChange", () => {
  it("건수 변화가 가장 큰 코드", () => {
    const steps = [S("s1", "A"), S("s2", "B")];
    const before = model("b", steps, [
      R("s1", { "503": 2880 }, 2880),
      R("s2", { "504": 312 }, 312),
    ]);
    const after = model("a", steps, [R("s1", { "200": 5 }), R("s2", { "504": 24 }, 24)]);
    const big = biggestCodeChange(stepPairs(before, after));
    expect(big).toEqual({ label: "① A", code: 503, before: 2880, after: 0 });
  });

  it("성공 응답(200)의 큰 변화는 무시하고 오류 코드를 고른다", () => {
    const steps = [S("s1", "A")];
    const before = model("b", steps, [R("s1", { "200": 1_000_000, "503": 2880 }, 2880)]);
    const after = model("a", steps, [R("s1", { "200": 1_200_000 })]);
    expect(biggestCodeChange(stepPairs(before, after))).toEqual({
      label: "① A",
      code: 503,
      before: 2880,
      after: 0,
    });
  });

  it("후보가 모두 그대로면 null", () => {
    const steps = [S("s1", "A")];
    const before = model("b", steps, [R("s1", { "503": 5 }, 5)]);
    const after = model("a", steps, [R("s1", { "503": 5 }, 5)]);
    expect(biggestCodeChange(stepPairs(before, after))).toBeNull();
  });

  it("plain·expected 코드만 바뀌면 null", () => {
    const steps = [S("s1", "A", { assert: [404] }), S("s2", "B")];
    const before = model("b", steps, [R("s1", { "404": 30 }), R("s2", { "200": 10 })]);
    const after = model("a", steps, [R("s1", { "404": 40 }), R("s2", { "200": 20 })]);
    expect(biggestCodeChange(stepPairs(before, after))).toBeNull();
  });

  it("코드가 없으면 null", () => {
    expect(biggestCodeChange([])).toBeNull();
  });
});
