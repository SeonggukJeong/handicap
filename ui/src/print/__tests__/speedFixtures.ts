// 응답 속도 구간 절 테스트 공용 입력 — 시안 v2의 경우 1·4·7. 구간 모델 테스트와 표 컴포넌트 테스트가 같이 쓴다.
import type { Criteria, Report, SpeedBands } from "../../api/schemas";
import { stepNo } from "../format";
import { buildSpeedModel, type SpeedModel } from "../speedBands";
import { stepStatus, type RankedRow } from "../stepStatus";
import type { StepRow } from "../stepTable";
import { expandCriteria, matchVerdict, type Matched } from "../verdict";

type BandIn = {
  slow_ms: number;
  slow_us?: number;
  basis: "p95" | "p99" | "p50" | "default";
  own?: boolean;
  fast: number | null;
  within: number;
  over: number;
};
export const band = (b: BandIn) => ({ own: false, ...b });

export function rr(
  index: number,
  name: string,
  o: { count?: number; errorCount?: number; executed?: boolean; notSent?: number },
  criteria: Criteria | null,
): RankedRow {
  const base: StepRow = {
    index,
    no: stepNo(index),
    stepId: `s${index + 1}`,
    name,
    requestLine: null,
    executed: o.executed ?? true,
    count: o.count ?? 1000,
    errorCount: o.errorCount ?? 0,
    p95Ms: 100,
    perCode: [],
    cells: {},
    residual: 0,
    notSent: o.notSent ?? 0,
    residualUncertain: false,
    factsKnown: true,
  };
  return { ...base, status: stepStatus(base, criteria, null) };
}

/** failing: 미달 행 키 — run 수준은 metric, 단계 기준은 `${target}:${metric}`. null = 서버 판정 없음. */
export function matchedOf(criteria: Criteria | null, failing: string[] | null): Matched[] {
  const specs = expandCriteria(criteria);
  if (failing === null) return matchVerdict(specs, null);
  const rows = specs.map((s) => ({
    metric: s.metric,
    direction: s.op,
    threshold: s.threshold,
    actual: 0,
    passed: !failing.includes(s.target ? `${s.target}:${s.metric}` : s.metric),
    target: s.target ?? undefined,
  }));
  return matchVerdict(specs, { passed: failing.length === 0, criteria: rows });
}

export const summ = (count: number, errors: number): Report["summary"] => ({
  count,
  errors,
  rps: 10,
  duration_seconds: 10,
  mean_ms: 20,
  p50_ms: 10,
  p95_ms: 30,
  p99_ms: 40,
});

export type BuildIn = {
  bands: SpeedBands;
  ranked: RankedRow[];
  summary: Report["summary"];
  criteria: Criteria | null;
  failing: string[] | null;
  anyNotSent?: boolean;
};

export function build(a: BuildIn): SpeedModel {
  return buildSpeedModel({
    bands: a.bands,
    ranked: a.ranked,
    summary: a.summary,
    matched: matchedOf(a.criteria, a.failing),
    criteria: a.criteria,
    anyNotSent: a.anyNotSent ?? false,
  });
}

/** 시안 경우 1: 고른 표·95% 응답 3000ms·미달 (⑤ 신청 제출이 빠른 실패). */
export function case1Input(): BuildIn {
  const criteria: Criteria = { max_p95_ms: 3000, max_error_rate: 0.01 };
  const p95 = (fast: number, within: number, over: number) =>
    band({ slow_ms: 3000, basis: "p95", fast, within, over });
  const bands: SpeedBands = {
    overall: p95(7240, 2060, 700),
    steps: [
      { step_id: "s1", ...p95(960, 40, 0) },
      { step_id: "s2", ...p95(820, 180, 0) },
      { step_id: "s3", ...p95(740, 258, 2) },
      { step_id: "s4", ...p95(220, 460, 320) },
      { step_id: "s5", ...p95(880, 90, 30) },
    ],
  };
  const ranked = [
    rr(0, "로그인", {}, criteria),
    rr(1, "민원 목록", {}, criteria),
    rr(2, "민원 상세", { errorCount: 3 }, criteria),
    rr(3, "첨부 업로드", {}, criteria),
    rr(4, "신청 제출", { errorCount: 266 }, criteria),
  ];
  return {
    bands,
    ranked,
    summary: summ(10000, 540),
    criteria,
    failing: ["p95_ms", "error_rate"],
  };
}

/** 시안 경우 4: 기준 800ms — 두 구간. */
export function case4Input(): BuildIn {
  const criteria: Criteria = { max_p95_ms: 800 };
  const p = (within: number, over: number) =>
    band({ slow_ms: 800, basis: "p95", fast: null, within, over });
  const bands: SpeedBands = {
    overall: p(956, 44),
    steps: [
      { step_id: "s1", ...p(988, 12) },
      { step_id: "s2", ...p(910, 90) },
    ],
  };
  const ranked = [rr(0, "조회", {}, criteria), rr(1, "저장", { errorCount: 4 }, criteria)];
  return { bands, ranked, summary: summ(1000, 2), criteria, failing: [] };
}

/** 시안 경우 7: 단계 기준만 있는 run + 합친 칸 + 실행 안 된 단계 + 별표. */
export function case7Input(): BuildIn {
  const criteria: Criteria = {
    max_error_rate: 0.006999999999999999,
    step_criteria: [
      { metric: "p95_ms", op: "max", threshold: 800, target: "s1" },
      { metric: "p95_ms", op: "max", threshold: 5000, target: "s2" },
    ],
  };
  const d = (fast: number, within: number, over: number) =>
    band({ slow_ms: 3000, basis: "default", fast, within, over });
  const bands: SpeedBands = {
    overall: d(610, 362, 28),
    steps: [
      {
        step_id: "s1",
        ...band({ slow_ms: 800, basis: "p95", own: true, fast: null, within: 910, over: 90 }),
      },
      {
        step_id: "s2",
        ...band({ slow_ms: 5000, basis: "p95", own: true, fast: 200, within: 772, over: 28 }),
      },
      { step_id: "s3", ...d(740, 245, 15) },
      { step_id: "s4", ...d(600, 380, 20) },
      { step_id: "s5", ...d(880, 110, 10) },
    ],
  };
  const ranked = [
    rr(0, "로그인", {}, criteria),
    rr(1, "첨부 업로드", {}, criteria),
    rr(2, "민원 상세", {}, criteria),
    rr(3, "신청 제출", { errorCount: 7 }, criteria),
    rr(4, "결과 확인", { errorCount: 400 }, criteria),
    rr(5, "로그아웃", { executed: false, count: 0 }, criteria),
  ];
  return {
    bands,
    ranked,
    summary: summ(1000, 4),
    criteria,
    failing: ["s1:p95_ms"],
    anyNotSent: true,
  };
}
