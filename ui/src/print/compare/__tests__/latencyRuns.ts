import { expect } from "vitest";
import { ReportSchema, type Report, type SecondLatency } from "../../../api/schemas";
import { buildRunModel, type RunModel } from "../runModel";
import { mkMeta, mkReport, scenarioYaml } from "./fixtures";

export const T0_SEC = 1_700_000_000;

type W = Report["windows"][number];
export const win = (sec: number, count: number, err: number): W => ({
  ts_second: T0_SEC + sec,
  n: 0,
  step_id: "s1",
  count,
  error_count: err,
  status_counts: {},
  p50_ms: 0,
  p95_ms: 0,
  p99_ms: 0,
});

/** 초마다 `count`건, `errFrom`초부터 오류 `err`건. */
export const secs = (n: number, count: number, errFrom = Infinity, err = 0): W[] =>
  Array.from({ length: n }, (_, i) => win(i, count, i >= errFrom ? err : 0));

/** 초별 응답 시간 한 줄. p95는 평균과 다른 값 — 세로 눈금이 p95를 섞어 넣으면 yTicks 단언이 깨진다. */
export const L = (sec: number, n: number, mean_us?: number, capped?: boolean): SecondLatency => ({
  ts_second: T0_SEC + sec,
  n,
  ...(mean_us === undefined ? {} : { mean_us, p95_us: Math.min(mean_us * 3, 60_000_000) }),
  ...(capped ? { capped: true } : {}),
});

/** `lat`이 빈 배열이면 키를 넣지 않는다 — 서버가 빈 목록을 빼고 보낸다. */
export function run(id: string, windows: W[], lat: SecondLatency[] = []): RunModel {
  const report = {
    ...mkReport({
      id,
      steps: [{ id: "s1", counts: { "200": 10 }, errors: 0 }],
      yaml: scenarioYaml([{ id: "s1", name: "접수" }]),
    }),
    windows,
    ...(lat.length > 0 ? { latency_by_second: lat } : {}),
  };
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id), report);
}
