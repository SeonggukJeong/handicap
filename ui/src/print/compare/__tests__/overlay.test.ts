import { describe, expect, it } from "vitest";
import { ReportSchema, type Report } from "../../../api/schemas";
import { buildOverlay } from "../overlay";
import { buildRunModel, type RunModel } from "../runModel";
import { mkMeta, mkReport, scenarioYaml } from "./fixtures";

const T0_SEC = 1_700_000_000;

type W = Report["windows"][number];
const win = (sec: number, count: number, err: number): W => ({
  ts_second: T0_SEC + sec,
  step_id: "s1",
  count,
  error_count: err,
  status_counts: {},
  p50_ms: 0,
  p95_ms: 0,
  p99_ms: 0,
});

function run(id: string, windows: W[]): RunModel {
  const report = {
    ...mkReport({
      id,
      steps: [{ id: "s1", counts: { "200": 10 }, errors: 0 }],
      yaml: scenarioYaml([{ id: "s1", name: "접수" }]),
    }),
    windows,
  };
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id), report);
}

/** 초마다 `count`건, `errFrom`초부터 오류 `err`건. */
const secs = (n: number, count: number, errFrom = Infinity, err = 0): W[] =>
  Array.from({ length: n }, (_, i) => win(i, count, i >= errFrom ? err : 0));

/** NaN·undefined가 어디에도 없다(JSON.stringify는 NaN을 null로 바꿔 못 잡는다). */
function expectClean(v: unknown, path = "$"): void {
  if (typeof v === "number") expect(Number.isNaN(v) || !Number.isFinite(v), path).toBe(false);
  else if (v === undefined) throw new Error(`undefined at ${path}`);
  else if (typeof v === "string") {
    expect(v.includes("NaN"), path).toBe(false);
    expect(v.includes("undefined"), path).toBe(false);
  } else if (Array.isArray(v)) v.forEach((x, i) => expectClean(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) expectClean(x, `${path}.${k}`);
  }
}

describe("buildOverlay 묶음", () => {
  it("공통 묶음: 이전 60초 · 이후 1,800초 → 15초 묶음, 4개 · 120개, 기간이 다르다는 글", () => {
    const m = buildOverlay(run("b", secs(60, 10)), run("a", secs(1800, 10)), false);
    expect(m.durationSec).toBe(1800);
    expect(m.binSeconds).toBe(15);
    expect(m.before.bins).toHaveLength(4);
    expect(m.after.bins).toHaveLength(120);
    expect(m.durationNote).toContain("1분");
    expect(m.durationNote).toContain("30분");
    expect(m.durationNote).toBe("(측정 시간이 다릅니다: 이전 1분, 이후 30분)");
  });

  it("묶음 값: 초마다 100건, 6초째부터 오류 10건", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", secs(10, 100)), false);
    expect(m.binSeconds).toBe(1);
    expect(m.before.bins[5]).toEqual({ startSec: 5, seconds: 1, rps: 100, err: 10 });
    expect(m.before.firstErrSec).toBe(5);
    expect(m.before.errTotal).toBe(50);
    expect(m.after.firstErrSec).toBeNull();
    expect(m.hasErrors).toBe(true);
    expect(m.errTicks.length).toBeGreaterThan(1);
  });

  it("마지막 묶음은 남은 초만큼의 길이이고 건/초는 그 길이로 나눈다", () => {
    const m = buildOverlay(run("b", secs(125, 10)), run("a", secs(125, 10)), false);
    expect(m.binSeconds).toBe(2);
    const last = m.before.bins[m.before.bins.length - 1]!;
    expect(last).toEqual({ startSec: 124, seconds: 1, rps: 10, err: 0 });
    expect(m.before.bins[0]).toEqual({ startSec: 0, seconds: 2, rps: 10, err: 0 });
  });

  it("오류가 없으면 hasErrors false · 오류 눈금 없음", () => {
    const m = buildOverlay(run("b", secs(10, 5)), run("a", secs(10, 5)), false);
    expect(m.hasErrors).toBe(false);
    expect(m.errTicks).toEqual([]);
    expect(m.rpsTicks.length).toBeGreaterThan(1);
  });
});

describe("buildOverlay 읽는 법", () => {
  it("이전에만 오류 → 첫 갈래", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", secs(10, 100)), false);
    expect(m.reading).toBe("이전에는 5초 지점부터 오류가 쌓였지만, 이후에는 거의 없습니다.");
  });

  it("0초부터 오류면 「0초」", () => {
    const m = buildOverlay(run("b", secs(10, 100, 0, 10)), run("a", secs(10, 100)), false);
    expect(m.reading).toBe("이전에는 0초 지점부터 오류가 쌓였지만, 이후에는 거의 없습니다.");
  });

  it("경계: 이전 100건 · 이후 5건 → 첫 갈래, 6건 → 둘째 갈래", () => {
    const before = run("b", [win(0, 1000, 100)]);
    const five = buildOverlay(before, run("a", [win(0, 1000, 5)]), false);
    expect(five.reading).toContain("거의 없습니다");
    const six = buildOverlay(before, run("a", [win(0, 1000, 6)]), false);
    expect(six.reading).toBe("두 측정 모두 오류가 있습니다(이전 0초부터, 이후 0초부터).");
  });

  it("둘 다 오류: 지점이 다르면 각자 적는다", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", secs(10, 100, 7, 10)), false);
    expect(m.reading).toBe("두 측정 모두 오류가 있습니다(이전 5초부터, 이후 7초부터).");
  });

  it("이후에만 오류 → 셋째 갈래", () => {
    const m = buildOverlay(run("b", secs(10, 100)), run("a", secs(10, 100, 7, 10)), false);
    expect(m.reading).toBe("이후 측정에서 7초 지점부터 오류가 생겼습니다.");
  });

  it("둘 다 없음 → 넷째 갈래", () => {
    const m = buildOverlay(run("b", secs(10, 100)), run("a", secs(10, 100)), false);
    expect(m.reading).toBe("두 측정 모두 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다.");
  });
});

describe("buildOverlay 기간 차이", () => {
  it("300초 vs 310초(묶음 5초, 5% = 15.5초) → 글 없음", () => {
    const m = buildOverlay(run("b", secs(300, 1)), run("a", secs(310, 1)), false);
    expect(m.binSeconds).toBe(5);
    expect(m.durationNote).toBeNull();
  });

  it("300초 vs 400초 → 글 있음", () => {
    const m = buildOverlay(run("b", secs(300, 1)), run("a", secs(400, 1)), false);
    expect(m.durationNote).toBe("(측정 시간이 다릅니다: 이전 5분, 이후 6분 40초)");
  });
});

describe("buildOverlay 요청 0건인 측정(windows 빔)", () => {
  it("이후가 비면 이전 선만 있고 읽는 법은 비교하지 않았다는 글", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", []), true);
    expect(m.after.bins).toEqual([]);
    expect(m.after.durationSec).toBe(0);
    expect(m.durationSec).toBe(10);
    expect(m.before.bins.length).toBeGreaterThan(0);
    expect(m.reading).toBe("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.");
    expect(m.reading).not.toContain("거의 없습니다");
    expect(m.reading).not.toContain("없었습니다");
    expect(m.durationNote).toBeNull();
    expect(buildOverlay(run("b", []), run("a", secs(10, 100)), true).durationNote).toBeNull();
    expect(JSON.stringify(m)).not.toContain("NaN");
    expectClean(m);
  });

  it("둘 다 비면 길이 0 · 묶음 1초 · 눈금 [0, 1]", () => {
    const m = buildOverlay(run("b", []), run("a", []), true);
    expect(m.durationSec).toBe(0);
    expect(m.binSeconds).toBe(1);
    expect(m.before.bins).toEqual([]);
    expect(m.after.bins).toEqual([]);
    expect(m.rpsTicks).toEqual([0, 1]);
    expect(m.reading).toBe("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.");
    expect(m.durationNote).toBeNull();
    expect(JSON.stringify(m)).not.toContain("NaN");
    expectClean(m);
  });
});
