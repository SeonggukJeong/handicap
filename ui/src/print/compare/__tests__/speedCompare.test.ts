import { describe, expect, it } from "vitest";
import type { Report } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { buildSpeedCompare } from "../speedCompare";
import type { RunModel } from "../runModel";
import { sceneModel } from "./scene";

type Band = NonNullable<Report["speed_bands"]>["overall"];
const b3 = (slow_ms: number, basis: Band["basis"] = "p95"): Band => ({
  slow_ms,
  basis,
  own: false,
  fast: 580,
  within: 330,
  over: 90,
});
const b2 = (slow_ms: number, basis: Band["basis"] = "p95"): Band => ({
  slow_ms,
  basis,
  own: false,
  fast: null,
  within: 910,
  over: 90,
});

/** speed_bands는 overall만 의미가 있다 — steps는 비워 둔다. */
function run(id: string, overall: Band | null, count = 1000, errors = 0): RunModel {
  const m = sceneModel({ id, summary: { count, errors } });
  const speed_bands = overall ? { overall, steps: [] } : undefined;
  return { ...m, report: { ...m.report, speed_bands } };
}

function expectClean(v: unknown, path = "$"): void {
  if (typeof v === "number") expect(Number.isFinite(v), path).toBe(true);
  else if (v === undefined) throw new Error(`undefined at ${path}`);
  else if (typeof v === "string") {
    expect(v.includes("NaN"), path).toBe(false);
    expect(v.includes("undefined"), path).toBe(false);
  } else if (Array.isArray(v)) v.forEach((x, i) => expectClean(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) expectClean(x, `${path}.${k}`);
  }
}

describe("buildSpeedCompare", () => {
  it("경계가 같으면 머리 하나를 공유하고 경고·경계 글자가 없다", () => {
    const m = buildSpeedCompare(run("b", b3(3000)), run("a", b3(3000)))!;
    expect(m.same).toBe(true);
    expect(m.threeCols).toBe(true);
    expect(m.warn).toBeNull();
    expect(m.rows[0].role).toBe("이전");
    expect(m.rows[1].role).toBe("이후");
    expect(m.rows[0].boundary).toBeNull();
    expect(m.rows[1].boundary).toBeNull();
    expect(m.head.within).toBe(ko.print.speed.headWithin("3초"));
    expect(m.head.within).toBe("1초–3초");
    expect(m.head.fast).toBe("1초 미만");
    expect(m.head.over).toBe("3초 초과");
    expect(m.legend.map((l) => l.band)).toEqual(["fast", "within", "over"]);
    expect(m.legend.map((l) => l.text)).toEqual(["1초 미만", "1초–3초", "3초 초과"]);
    expect(m.rows[0].merged).toBe(false);
    expectClean(m);
  });

  it("두 구간끼리 같으면 이내/초과 머리, 범례는 두 색", () => {
    const m = buildSpeedCompare(run("b", b2(3000)), run("a", b2(3000)))!;
    expect(m.same).toBe(true);
    expect(m.threeCols).toBe(false);
    expect(m.head).toEqual({ fast: null, within: "3초 이내", over: "3초 초과" });
    expect(m.legend.map((l) => l.band)).toEqual(["fast", "over"]);
    expect(m.legend.map((l) => l.text)).toEqual(["3초 이내", "3초 초과"]);
    expect(m.rows[0].merged).toBe(false);
  });

  it("경계가 다르면(3,000 vs 2,000) 줄마다 경계·공통 머리는 일반 이름·경고", () => {
    const m = buildSpeedCompare(run("b", b3(3000)), run("a", b3(2000)))!;
    expect(m.same).toBe(false);
    expect(m.rows[0].boundary).toBe("3초 기준");
    expect(m.rows[1].boundary).toBe("2초 기준");
    expect(m.warn).toContain("기준이 달라");
    expect(m.warn).toBe("▲ 두 측정의 응답 시간 기준이 달라 구간을 그대로 비교할 수 없습니다.");
    expect(m.head.over).toBe(ko.print.speed.headOverMixed);
    expect(m.head.within).toBe("1초–기준");
    expectClean(m);
  });

  it("basis만 다르면(p95 vs p99) 다르다", () => {
    const m = buildSpeedCompare(run("b", b3(3000, "p95")), run("a", b3(3000, "p99")))!;
    expect(m.same).toBe(false);
    expect(m.rows[0].boundary).toBe("3초 기준");
    expect(m.warn).not.toBeNull();
  });

  it("세 구간 vs 두 구간 → 세 칸 표, 두 구간 행은 합친 칸", () => {
    const m = buildSpeedCompare(run("b", b3(3000)), run("a", b2(3000)))!;
    expect(m.same).toBe(false);
    expect(m.threeCols).toBe(true);
    expect(m.head.fast).toBe("1초 미만");
    expect(m.head.within).toBe("1초–기준");
    expect(m.rows[0].merged).toBe(false);
    expect(m.rows[0].mergedText).toBeNull();
    expect(m.rows[1].merged).toBe(true);
    expect(m.rows[1].mergedText).toBe("3초 이내 91.0%");
    expect(m.legend.map((l) => l.band)).toEqual(["fast", "within", "over"]);
  });

  it("두 구간 vs 세 구간(이전이 두 구간)이면 이전 행이 합친 칸", () => {
    const m = buildSpeedCompare(run("b", b2(2000)), run("a", b3(3000)))!;
    expect(m.rows[0].merged).toBe(true);
    expect(m.rows[0].mergedText).toBe("2초 이내 91.0%");
    expect(m.rows[1].merged).toBe(false);
  });

  it("합친 칸인데 구간 합이 0이면 합치지 않고 대시 칸을 쓴다", () => {
    const zero: Band = { slow_ms: 3000, basis: "p95", own: false, fast: null, within: 0, over: 0 };
    const m = buildSpeedCompare(run("b", zero, 0), run("a", b3(3000)))!;
    expect(m.rows[0].merged).toBe(false);
    expect(m.rows[0].band.bar).toBeNull();
    expectClean(m);
  });

  it("한쪽 speed_bands가 없으면 null (옛 리포트)", () => {
    expect(buildSpeedCompare(run("b", null), run("a", b3(3000)))).toBeNull();
    expect(buildSpeedCompare(run("b", b3(3000)), run("a", null))).toBeNull();
  });

  it("둘 다 없으면 null", () => {
    expect(buildSpeedCompare(run("b", null), run("a", null))).toBeNull();
  });
});
