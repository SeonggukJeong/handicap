import { ko } from "../i18n/ko";
import { formatDurationKo } from "../i18n/duration";
import { ProfileSchema, type Profile } from "../api/schemas";
import { deriveLoadMode } from "../components/run/loadModel";
import { profileDurationSeconds } from "../api/runPrefill";
import { fmtDate, fmtDateTime, fmtMs, fmtTime } from "./format";

const c = ko.print.conditions;
const DASH = ko.print.fmt.noTarget;

export function measuredWindow(
  startedMs: number | null,
  endedMs: number | null,
  status: string,
): string {
  const start = startedMs === null ? DASH : fmtDateTime(startedMs);
  let end: string = DASH;
  if (endedMs !== null) {
    end =
      startedMs !== null && fmtDate(startedMs) === fmtDate(endedMs)
        ? fmtTime(endedMs)
        : fmtDateTime(endedMs);
  }
  const suffix = status === "aborted" ? c.aborted : status === "failed" ? c.failed : "";
  return `${start}${c.windowSep}${end}${suffix}`;
}

function peak(stages: { target: number }[] | undefined): number {
  return (stages ?? []).reduce((m, s) => Math.max(m, s.target), 0);
}

export function loadConditionLine(profile: Profile): string {
  const { loadModel, rateMode } = deriveLoadMode(profile);
  const d = formatDurationKo(profileDurationSeconds(profile));
  if (loadModel === "closed") {
    return rateMode === "curve"
      ? c.lineClosedCurve(peak(profile.vu_stages), d)
      : c.lineClosedFixed(profile.vus, d);
  }
  if (rateMode === "stair" && profile.stair) {
    const t = profile.stair.targets;
    return c.lineOpenStair(t.length, Math.min(...t), Math.max(...t));
  }
  return rateMode === "curve"
    ? c.lineOpenCurve(peak(profile.stages), d)
    : c.lineOpenFixed(profile.target_rps ?? 0, d);
}

/** envCount만 받는다 — env 값은 구조적으로 이 함수에 도달할 수 없다. */
/** 워커 2개 이상이면 그 수, 아니면 0(표시 안 함). 워커별 내역 길이가 우선, 없으면 open-loop의 worker_count. */
export function workerCount(profile: Profile | null, breakdownLen: number): number {
  if (breakdownLen >= 2) return breakdownLen;
  if (profile && deriveLoadMode(profile).loadModel === "open" && (profile.worker_count ?? 1) > 1) {
    return profile.worker_count ?? 1;
  }
  return 0;
}

export function conditionsBox(a: {
  profileRaw: unknown;
  workerBreakdownLen: number;
  envCount: number;
}): { ok: true; rows: Array<{ label: string; value: string }> } | { ok: false } {
  const parsed = ProfileSchema.safeParse(a.profileRaw);
  if (!parsed.success) return { ok: false };
  const p = parsed.data;
  const { loadModel, rateMode } = deriveLoadMode(p);
  const L = c.labels;
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string) => rows.push({ label, value });

  if (loadModel === "closed") {
    add(L.model, rateMode === "curve" ? c.modelClosedCurve : c.modelClosedFixed);
    add(
      L.size,
      rateMode === "curve"
        ? c.sizeClosedCurve(peak(p.vu_stages), p.vu_stages?.length ?? 0)
        : c.sizeClosedFixed(p.vus),
    );
  } else {
    if (rateMode === "stair" && p.stair) {
      const t = p.stair.targets;
      add(L.model, c.modelOpenStair);
      add(L.size, c.sizeOpenStair(t.length, Math.min(...t), Math.max(...t)));
    } else {
      add(L.model, rateMode === "curve" ? c.modelOpenCurve : c.modelOpenFixed);
      add(
        L.size,
        rateMode === "curve"
          ? c.sizeOpenCurve(peak(p.stages), p.stages?.length ?? 0)
          : c.sizeOpenFixed(p.target_rps ?? 0),
      );
    }
  }
  add(L.duration, formatDurationKo(profileDurationSeconds(p)));
  if (p.ramp_up_seconds > 0) add(L.ramp, c.ramp(formatDurationKo(p.ramp_up_seconds)));
  if (p.think_time) add(L.think, c.think(fmtMs(p.think_time.min_ms), fmtMs(p.think_time.max_ms)));
  add(L.timeout, formatDurationKo(p.http_timeout_seconds));
  const workers = workerCount(p, a.workerBreakdownLen);
  if (workers > 0) add(L.workers, c.workers(workers));
  const bindings = p.data_bindings?.length || (p.data_binding ? 1 : 0);
  if (bindings > 0) add(L.data, c.data(bindings));
  if (a.envCount > 0) add(L.env, c.env(a.envCount));
  return { ok: true, rows };
}
