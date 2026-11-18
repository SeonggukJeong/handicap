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

type PartialRun = NonNullable<StairStep["partial"]>;

function partialWhere(p: PartialRun): string {
  switch (p.phase) {
    case "ramp":
      return t.stopPartialRamp(p.seconds);
    case "discard":
      return t.stopPartialDiscard(p.seconds);
    case "measure":
      return t.stopPartialMeasure(p.seconds);
  }
}

export function reasonTexts(stair: StairReport, step: StairStep): string[] {
  if (step.state === "emergency_stopped") return [t.rowEmergency];
  if (step.state === "skipped") return [t.rowSkipped];
  if (step.state === "partial") {
    const p = step.partial;
    if (!p) return [t.rowPartial];
    const where = partialWhere(p);
    return [p.phase === "ramp" ? t.rowPartialRamp(where) : t.rowPartialBand(where)];
  }
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

/** 화면 정지 시각: 지역 `HH:MM:SS`(0 채움). CSV·XLSX는 UTC ISO를 쓴다. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

type StopRecord = NonNullable<NonNullable<StairReport["auto_stop"]>["stop"]>;

/** 정지 머리말 — 줄·배지가 같이 쓴다(단계 라벨·구간 이름 매핑은 여기 한 곳). */
export function stopHeadText(stop: StopRecord, targets: ReadonlyArray<number | undefined>): string {
  const n = stop.decided_step;
  const label = t.stopLabel(n + 1, targets[n]);
  if (stop.kind === "saturation") return t.stopSaturationHead(label);
  const phase =
    t.stopPhaseName[stop.phase === "ramp" || stop.phase === "discard" ? stop.phase : "measure"];
  return t.stopEmergencyHead(label, phase);
}

/** 자동 정지 줄 — Rust `export.rs::stair_stop_line`과 같은 글자. 정지 기록이 없으면 null. */
export function stopLineText(stair: StairReport, timeText: string): string | null {
  const stop = stair.auto_stop?.stop;
  if (!stop) return null;
  const label = (i: number) => {
    const s = stair.steps[i];
    return s ? t.stopLabel(i + 1, s.target) : t.stopLabel(i + 1);
  };
  const parts: string[] = [];
  const head = stopHeadText(
    stop,
    stair.steps.map((s) => s.target),
  );
  if (stop.kind === "saturation") {
    const list = stop.failed_steps.map((i) => String(i + 1)).join("·");
    let reason =
      stop.mode === "first_fail" ? t.stopFirstFailReason(list) : t.stopTwoFailsReason(list);
    if (stop.slot_limited) reason += t.stopSlotLimitedSuffix;
    parts.push(reason);
  } else {
    const e = stop.emergency;
    if (e) {
      const secs = t.stopConsecutive(e.seconds);
      const err = t.stopErrorRate(errorRateText(e.max_error_rate));
      const p99 = t.stopP99(formatMs(e.max_p99_us));
      if (e.error_hit && e.p99_hit) {
        parts.push(err);
        parts.push(`${p99} ${secs}`);
      } else if (e.error_hit) {
        parts.push(`${err} ${secs}`);
      } else {
        parts.push(`${p99} ${secs}`);
      }
    }
    const lastOk = stair.headline.last_ok_target;
    if (lastOk == null) {
      parts.push(t.stopNoOk);
    } else {
      const i = stair.steps.findIndex((s) => s.target === lastOk);
      parts.push(i >= 0 ? t.stopLastOk(label(i)) : t.stopLastOkTarget(lastOk));
    }
  }
  stair.steps.forEach((s, i) => {
    if (s.partial) parts.push(t.stopPartialClause(i + 1, partialWhere(s.partial)));
  });
  const skipped = stair.steps.flatMap((s, i) => (s.state === "skipped" ? [i + 1] : []));
  if (skipped.length > 0) {
    const a = skipped[0];
    const b = skipped[skipped.length - 1];
    parts.push(a === b ? t.stopSkippedOne(a) : t.stopSkippedRange(a, b));
  }
  parts.push(timeText);
  return `${head} — ${parts.join(" · ")}`;
}

/** 정지 없이 감시 보류만 있었을 때의 줄. */
export function suspendedLineText(stair: StairReport): string | null {
  const rec = stair.auto_stop;
  if (!rec || rec.stop || rec.suspended_seconds === 0) return null;
  return t.stopSuspendedLine(rec.suspended_seconds);
}
