import type { LoopExit, ReportStep } from "../../api/schemas";
import { findStepById, flattenHttpSteps, type Step } from "../../scenario/model";

export type LoopExitRowKind = "first" | "retried" | "exhausted" | "truncated";
export type LoopExitRow = {
  kind: LoopExitRowKind;
  /** first/retried 줄의 회차(1부터). null = 21번째 이후. exhausted/truncated 줄은 null. */
  pass: number | null;
  count: number;
  /** 진입 대비 비율 0–100. */
  pct: number;
};
export type LoopExitView = {
  stepId: string;
  name: string;
  maxPasses: number | null;
  entered: number;
  passes: number;
  retries: number;
  /** 본문 실행 중 재시도 비율 0–100. */
  retryPct: number;
  exhausted: number;
  truncated: number;
  retriedStepIds: string[];
  rows: LoopExitRow[];
};

function retriedSteps(bodyIds: string[], retries: number, byId: Map<string, ReportStep>): string[] {
  return bodyIds.filter((id) => {
    const breakdown = byId.get(id)?.loop_breakdown ?? [];
    if (breakdown.length === 0) return retries > 0; // 루프 집계 상한 0 — loop 단위로만 안다
    // 2번째 이후 회차(loop_index ≥ 1, 또는 상한 초과 줄 null)에서 요청된 스텝만.
    return breakdown.some((b) => b.loop_index !== 0 && b.count > 0);
  });
}

export function buildLoopExitViews(
  loopExits: LoopExit[] | undefined,
  steps: ReportStep[],
  scenarioSteps: ReadonlyArray<Step> | null,
): LoopExitView[] {
  if (!loopExits || loopExits.length === 0) return [];
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  return loopExits.map((le) => {
    const node = scenarioSteps ? findStepById(scenarioSteps, le.step_id) : null;
    const loop = node && node.type === "loop" ? node : null;
    const retries = Math.max(0, le.passes - le.entered);
    const bodyIds = loop ? flattenHttpSteps(loop.do).map((s) => s.id) : [];
    const pct = (n: number) => (le.entered > 0 ? (n / le.entered) * 100 : 0);
    const rows: LoopExitRow[] = [];
    for (const b of le.buckets) {
      if (b.completed > 0) {
        rows.push({
          kind: b.pass === 1 ? "first" : "retried",
          pass: b.pass,
          count: b.completed,
          pct: pct(b.completed),
        });
      }
    }
    if (le.exhausted > 0) {
      rows.push({ kind: "exhausted", pass: null, count: le.exhausted, pct: pct(le.exhausted) });
    }
    if (le.truncated > 0) {
      rows.push({ kind: "truncated", pass: null, count: le.truncated, pct: pct(le.truncated) });
    }
    return {
      stepId: le.step_id,
      name: loop?.name ?? le.step_id,
      maxPasses: loop?.repeat ?? null,
      entered: le.entered,
      passes: le.passes,
      retries,
      retryPct: le.passes > 0 ? (retries / le.passes) * 100 : 0,
      exhausted: le.exhausted,
      truncated: le.truncated,
      retriedStepIds: retriedSteps(bodyIds, retries, byId),
      rows,
    };
  });
}

/** 표지를 붙일 스텝 id 전체(모든 loop의 retriedStepIds 합집합). */
export function retriedStepIdSet(views: LoopExitView[]): ReadonlySet<string> {
  return new Set(views.flatMap((v) => v.retriedStepIds));
}

/** 맨 위 안내 대상: retries ≥ 1 또는 exhausted ≥ 1, 재시도 비율 내림차순 → 중단 내림차순. */
export function noticeLoops(views: LoopExitView[]): LoopExitView[] {
  return views
    .filter((v) => v.retries >= 1 || v.exhausted >= 1)
    .sort((a, b) => b.retryPct - a.retryPct || b.exhausted - a.exhausted);
}
