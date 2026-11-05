import { describe, expect, it } from "vitest";
import {
  BIN_CHOICES,
  CHART_H_MM,
  CHART_W_MM,
  LABEL_CHAR_MM,
  PLOT_X0_MM,
  PLOT_X1_MM,
  buildChartModel,
  chartReadingLine,
  fmtElapsed,
  markerX,
  niceTicks,
  pickBinSeconds,
  runT0,
  timeTicks,
  type ChartModel,
} from "../chartModel";
import type { StepRow } from "../stepTable";
import type { Report } from "../../api/schemas";

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

const row = (index: number, id: string): StepRow => ({
  index,
  no: String.fromCharCode(0x2460 + index),
  stepId: id,
  name: `단계${id}`,
  requestLine: null,
  executed: true,
  count: 1,
  errorCount: 0,
  p95Ms: 1,
  perCode: [],
  cells: {},
  residual: 0,
  residualUncertain: false,
  factsKnown: true,
});

const rows = ["A", "B", "C", "D", "E"].map((id, i) => row(i, id));

describe("bin_choice", () => {
  it("picks the smallest bin giving <=120 bars", () => {
    expect(pickBinSeconds(120)).toBe(1);
    expect(pickBinSeconds(121)).toBe(2);
    expect(pickBinSeconds(600)).toBe(5);
    expect(pickBinSeconds(3600)).toBe(30);
    expect(pickBinSeconds(0)).toBe(1);
    expect(BIN_CHOICES).toEqual([1, 2, 5, 10, 15, 30, 60, 120, 300]);
  });
});

describe("bins_average_and_partial_last", () => {
  it("averages per second and shortens the last bin", () => {
    const ws = [win(1000, "A", 10), win(1001, "A", 10), win(1597, "A", 20), win(1598, "A", 40)];
    const m = buildChartModel(ws, 1000, rows);
    expect(m.durationSec).toBe(599);
    expect(m.binSeconds).toBe(5);
    expect(m.bins).toHaveLength(120);
    expect(m.bins[0].rps).toBe(4);
    const last = m.bins[119];
    expect(last.startSec).toBe(595);
    expect(last.seconds).toBe(4);
    expect(last.rps).toBe(15);
  });
  it("short run keeps 1 s bins", () => {
    const m = buildChartModel([win(50, "A", 3), win(56, "A", 6)], 50, rows);
    expect(m.durationSec).toBe(7);
    expect(m.bins).toHaveLength(7);
    expect(m.bins[6].rps).toBe(6);
  });
});

describe("top_error_step_split", () => {
  it("splits the stack into top step and the rest", () => {
    const ws = [win(0, "A", 10, 4), win(1, "A", 10, 6), win(1, "B", 10, 3), win(2, "A", 10, 0)];
    const m = buildChartModel(ws, 0, rows);
    expect(m.topStepId).toBe("A");
    expect(m.hasErrors).toBe(true);
    expect(m.bins[0].topErr).toBe(4);
    expect(m.bins[0].otherErr).toBe(0);
    expect(m.bins[1].topErr).toBe(6);
    expect(m.bins[1].otherErr).toBe(3);
    expect(m.errTicks.length).toBeGreaterThan(1);
  });
  it("no errors -> no stack, no ticks, no markers", () => {
    const m = buildChartModel([win(0, "A", 10), win(1, "A", 10)], 0, rows);
    expect(m.hasErrors).toBe(false);
    expect(m.errTicks).toEqual([]);
    expect(m.markers).toEqual([]);
    expect(m.topStepId).toBeNull();
  });
});

describe("ticks", () => {
  it("niceTicks", () => {
    expect(niceTicks(237, 5)).toEqual([0, 100, 200, 300]);
    expect(niceTicks(0, 5)).toEqual([0, 1]);
  });
  it("timeTicks", () => {
    expect(timeTicks(600)).toEqual([0, 120, 240, 360, 480, 600]);
    expect(timeTicks(30)).toEqual([0, 30]);
    expect(timeTicks(0)).toEqual([0]);
  });
  it("fmtElapsed", () => {
    expect(fmtElapsed(0)).toBe("0");
    expect(fmtElapsed(30)).toBe("30초");
    expect(fmtElapsed(60)).toBe("1분");
    expect(fmtElapsed(150)).toBe("2분 30초");
  });
});

describe("markers_cap_and_stack", () => {
  // [step, firstErrSec, totalErr]; the run lasts 600 s so bins are 5 s wide
  const mk = (firsts: Array<[string, number, number]>): ChartModel => {
    const ws: W[] = [win(0, "Z", 1), win(599, "Z", 1)];
    for (const [id, sec, tot] of firsts) {
      ws.push(win(sec, id, 10, 1));
      ws.push(win(sec + 5, id, 10, tot - 1));
    }
    return buildChartModel(ws, 0, rows);
  };
  it("keeps only the top 3 error steps, labelled with elapsed time and step number", () => {
    const m = mk([
      ["A", 100, 50],
      ["B", 250, 40],
      ["C", 400, 30],
      ["D", 500, 20],
    ]);
    expect(m.markers.map((x) => x.label)).toEqual([
      "1분 40초: ① 오류 시작",
      "4분 10초: ② 오류 시작",
      "6분 40초: ③ 오류 시작",
    ]);
    expect(m.markers.every((x) => x.level === 0)).toBe(true);
  });
  it("marker label for 4 minutes", () => {
    const m = mk([["E", 240, 9]]);
    expect(m.markers).toEqual([{ sec: 240, label: "4분: ⑤ 오류 시작", level: 0 }]);
  });
  it("close markers stack on level 1, a third overlapping one is dropped", () => {
    const m = mk([
      ["A", 100, 50],
      ["B", 105, 40],
      ["C", 110, 30],
    ]);
    expect(m.markers.map((x) => [x.label, x.level])).toEqual([
      ["1분 40초: ① 오류 시작", 0],
      ["1분 45초: ② 오류 시작", 1],
    ]);
    expect(LABEL_CHAR_MM).toBe(1.9);
  });
});

describe("zero_request_run_chart", () => {
  const finiteAll = (v: unknown): boolean => {
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(finiteAll);
    if (v && typeof v === "object") return Object.values(v).every(finiteAll);
    return true;
  };
  it("empty windows -> empty finite model", () => {
    const m = buildChartModel([], null, []);
    expect(m.bins).toEqual([]);
    expect(m.durationSec).toBe(0);
    expect(m.hasErrors).toBe(false);
    expect(m.timeTicks).toEqual([0]);
    expect(finiteAll(m)).toBe(true);
    expect(Number.isFinite(markerX(0, 0))).toBe(true);
    expect(markerX(0, 0)).toBe(PLOT_X0_MM);
    expect(CHART_W_MM).toBe(180);
    expect(CHART_H_MM).toBe(55);
    expect(PLOT_X1_MM).toBeGreaterThan(PLOT_X0_MM);
    expect(chartReadingLine(m)).toBe(
      "측정 내내 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다.",
    );
  });
  it("finiteAll helper has teeth", () => {
    expect(finiteAll({ a: [1, NaN] })).toBe(false);
  });
});

describe("runT0", () => {
  it("min of started seconds and first window", () => {
    expect(runT0(1_000_900, [win(1005, "A", 1)])).toBe(1000);
    expect(runT0(null, [win(1005, "A", 1), win(1003, "A", 1)])).toBe(1003);
    expect(runT0(null, [])).toBeNull();
    expect(runT0(2_000_000, [win(1500, "A", 1)])).toBe(1500);
  });
});

describe("reading_line", () => {
  const model = (before: number[], after: number[], errAtBin: number): ChartModel => {
    const all = [...before, ...after];
    return {
      durationSec: all.length * 10,
      binSeconds: 10,
      bins: all.map((rps, i) => ({
        startSec: i * 10,
        seconds: 10,
        rps,
        topErr: i >= errAtBin ? 1 : 0,
        otherErr: 0,
      })),
      topStepId: "A",
      hasErrors: true,
      rpsTicks: [0],
      errTicks: [0, 1],
      timeTicks: [0],
      markers: [{ sec: errAtBin * 10, label: "x", level: 0 }],
    };
  };
  it("error start without drop", () => {
    expect(chartReadingLine(model([100, 100, 100], [100, 100, 100], 3))).toBe(
      "30초부터 빨간 막대(오류)가 생깁니다",
    );
  });
  it("error start at 4 minutes", () => {
    const rps = new Array<number>(30).fill(100);
    expect(chartReadingLine(model(rps.slice(0, 24), rps.slice(24), 24))).toBe(
      "4분부터 빨간 막대(오류)가 생깁니다",
    );
  });
  it("drop of 10% or more is appended", () => {
    expect(chartReadingLine(model([100, 100, 100], [80, 80, 80], 3))).toBe(
      "30초부터 빨간 막대(오류)가 생깁니다, 같은 시점에 처리량 선이 내려갑니다",
    );
    expect(chartReadingLine(model([100, 100, 100], [90, 90, 90], 3))).toContain("내려갑니다");
    expect(chartReadingLine(model([100, 100, 100], [95, 95, 95], 3))).not.toContain("내려갑니다");
  });
  it("first-bin marker and zero baseline add nothing", () => {
    expect(chartReadingLine(model([], [100, 10, 10], 0))).toBe(
      "0초부터 빨간 막대(오류)가 생깁니다",
    );
    expect(chartReadingLine(model([0, 0, 0], [10, 10, 10], 3))).not.toContain("내려갑니다");
  });
  it("no errors", () => {
    const m = model([1], [1], 5);
    m.hasErrors = false;
    m.markers = [];
    expect(chartReadingLine(m)).toBe(
      "측정 내내 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다.",
    );
  });
});
