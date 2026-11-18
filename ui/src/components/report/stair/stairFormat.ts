import type { StairReport, StairState, StairStep } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const t = ko.report.stair;

/** 지연(µs) 표시: 1 ms 미만은 소수 둘째, 이상은 정수 ms. */
export function formatMs(us: number): string {
  if (us < 1000) return (us / 1000).toFixed(2);
  return String(Math.round(us / 1000));
}

/** 비율(0–1)을 % 소수 첫째로 *내림*해 표시 — 94.96%가 95%로 보여 기준 통과처럼 읽히지 않게 한다. */
export function floorPct1(ratio: number): string {
  return `${(Math.floor(ratio * 1000 + 1e-9) / 10).toFixed(1)}%`;
}

/** 표 오류율 칸: 0이 아닌데 내림하면 0.0%인 값은 「<0.1%」로 — 오류가 있었는데 없던 것처럼 읽히지 않게. */
export function errorRateText(rate: number): string {
  const txt = floorPct1(rate);
  return rate > 0 && txt === "0.0%" ? t.tinyErrorRate : txt;
}

/** 숫자(달성·처리량·지연…)를 보여 줄 수 있는 상태 — 서버 `shows_numbers()`와 같은 집합. */
export function showsNumbers(s: StairState): boolean {
  return !(s === "not_measured" || s === "emergency_stopped" || s === "partial" || s === "skipped");
}

export function stateLabel(s: StairState): string {
  return t.states[s];
}

export function formatCount(v: number): string {
  return Number(v.toFixed(1)).toLocaleString("en-US");
}

/** 이 계단 앞에서 가장 가까운 `ok` 계단(판정 기준 계단). */
function refStep(steps: StairStep[], idx: number): StairStep | undefined {
  for (let i = idx - 1; i >= 0; i--) if (steps[i].state === "ok") return steps[i];
  return undefined;
}

export function reasonTexts(stair: StairReport, step: StairStep): string[] {
  const out = step.reasons.map((r) => {
    switch (r.kind) {
      case "achieved":
        return t.reasonAchieved(floorPct1(r.value));
      case "dropped":
        return t.reasonDropped(Math.round(r.value).toLocaleString("en-US"));
      case "errors":
        return t.reasonErrors(floorPct1(r.value));
      case "p99_cap":
        return t.reasonP99Cap;
      case "p99_relative": {
        const ref = refStep(stair.steps, step.index);
        return ref && ref.p99_us < 1000 ? t.reasonP99Fast : t.reasonP99Relative(r.value.toFixed(1));
      }
    }
  });
  if (step.slot_limited) out.push(t.reasonSlotLimited);
  return out;
}

export type HeadlineLineKind = "hint" | "knee" | "spike" | "dropped" | "slot";
export type HeadlineParts = {
  first: string;
  lines: { kind: HeadlineLineKind; text: string }[];
};

export function headlineParts(stair: StairReport): HeadlineParts {
  const h = stair.headline;
  const n = (v: number | null | undefined) => (v == null ? "—" : String(v));
  const lastOrThrough = h.last_ok_target ?? h.through_target;
  const lines: HeadlineParts["lines"] = [];
  let first: string;
  switch (h.kind) {
    case "saturated":
      if (h.last_ok_target != null) {
        first = t.headlineSaturated(n(h.saturated_target), String(h.last_ok_target));
      } else {
        first = t.headlineSaturatedNoLast(n(h.saturated_target));
        if (h.first_fail_hint) lines.push({ kind: "hint", text: t.firstFailHint });
      }
      break;
    case "unconfirmed":
      first =
        h.last_ok_target != null
          ? t.headlineUnconfirmed(n(h.saturated_target), String(h.last_ok_target))
          : t.headlineUnconfirmedNoLast(n(h.saturated_target));
      break;
    case "all_ok":
      first = t.headlineAllOk(n(lastOrThrough));
      break;
    case "ok_then_unmeasured":
      first = t.headlineOkThenUnmeasured(n(lastOrThrough));
      break;
    case "no_data":
      first = t.headlineNoData;
      break;
  }

  if (stair.knee_target != null) {
    const ki = stair.steps.findIndex((s) => s.target === stair.knee_target);
    const ref = ki > 0 ? refStep(stair.steps, ki) : undefined;
    lines.push({
      kind: "knee",
      text:
        ki >= 0 && ref && ref.p99_us > 0
          ? t.knee(String(stair.knee_target), (stair.steps[ki].p99_us / ref.p99_us).toFixed(1))
          : t.kneeNoRatio(String(stair.knee_target)),
    });
  }
  if (stair.spike_targets.length > 0) {
    lines.push({
      kind: "spike",
      text: t.spikes(stair.spike_targets.length, stair.spike_targets.join(", ")),
    });
  }
  if (stair.dropped_explained && (stair.dropped_total ?? 0) > 0) {
    lines.push({
      kind: "dropped",
      text: t.droppedExplained((stair.dropped_total ?? 0).toLocaleString("en-US")),
    });
  }
  if (stair.slot_limited_targets.length > 0) {
    const list = stair.slot_limited_targets.join(", ");
    lines.push({
      kind: "slot",
      text:
        stair.max_in_flight != null
          ? t.slotLimited(list, String(stair.max_in_flight))
          : t.slotLimitedNoCap(list),
    });
  }
  return { first, lines };
}

/** 안내 줄(계단 시작 시각 추정·예전 부하기) — 머리말 상자 아래에 붙는다. */
export function noteTexts(stair: StairReport): string[] {
  const out: string[] = [];
  if (stair.notes.t0_estimated) out.push(t.noteT0);
  if (stair.notes.open_loop_unknown) out.push(t.noteOpenLoopUnknown);
  return out;
}

/** 머리말 첫 줄 + 둘째 줄들(인쇄 보고서가 재사용). */
export function headlineText(stair: StairReport): string[] {
  const p = headlineParts(stair);
  return [p.first, ...p.lines.map((l) => l.text)];
}
