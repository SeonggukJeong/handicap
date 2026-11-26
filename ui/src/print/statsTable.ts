// 「단계별 응답 시간 통계」 절의 순수 모델(④b R-B8).

import { ko } from "../i18n/ko";
import type { LatencyStats, Report, ReportSampleName } from "../api/schemas";
import { CAP_US } from "../components/report/format";
import { hasLatency } from "../report/hasLatency";
import type { StepRow } from "./stepTable";
import { fmtCount } from "./format";

const K = ko.print.stats;
const DASH = ko.print.fmt.noTarget;

/** µs → 칸 글자. 60초 칸·1ms 미만(µs)·그 밖(floor/round ms, 천 단위 쉼표). */
export function printStatText(us: number, round: "floor" | "round"): string {
  if (us >= CAP_US) return ko.report.stats.capped;
  if (us < 1000) return K.us(us);
  return fmtCount(round === "floor" ? Math.floor(us / 1000) : Math.round(us / 1000));
}

export type StatsRow = { label: string; cells: string[] };
export type StatsModel = {
  rows: StatsRow[];
  total: StatsRow;
  caption: string;
  cappedNote: boolean;
};

const dashes = (): string[] => Array<string>(8).fill(DASH);

/** 최소·평균·p50·p90·p95·p99·최대·표준편차 — 평균·표준편차만 반올림. */
function cellsOf(s: LatencyStats): string[] {
  return [
    printStatText(s.min_us, "floor"),
    printStatText(s.mean_us, "round"),
    printStatText(s.p50_us, "floor"),
    printStatText(s.p90_us, "floor"),
    printStatText(s.p95_us, "floor"),
    printStatText(s.p99_us, "floor"),
    printStatText(s.max_us, "floor"),
    printStatText(s.stdev_us, "round"),
  ];
}

/** 모든 스텝 행과 합계가 「–」이면 null(절 없음). */
export function buildStatsModel(a: {
  rows: StepRow[];
  summary: Report["summary"];
  sample: ReportSampleName;
  hasTime: boolean;
}): StatsModel | null {
  let capped = false;
  let drawn = false;
  const draw = (s: LatencyStats): string[] => {
    const c = cellsOf(s);
    drawn = true;
    if (s.capped || c.includes(ko.report.stats.capped)) capped = true;
    return c;
  };
  const rows: StatsRow[] = a.rows.map((r) => {
    const ok =
      r.stats !== undefined &&
      hasLatency({ count: r.count, errors: r.errorCount, notSent: r.notSent }, a.sample);
    return { label: `${r.no} ${r.name}`, cells: ok && r.stats ? draw(r.stats) : dashes() };
  });
  const sum = a.summary.stats;
  const total: StatsRow = {
    label: K.total,
    cells: sum && a.hasTime ? draw(sum) : dashes(),
  };
  if (!drawn) return null;
  return {
    rows,
    total,
    caption: K.caption(a.sample === "passed" ? K.samplePassed : K.sampleAll),
    cappedNote: capped,
  };
}
