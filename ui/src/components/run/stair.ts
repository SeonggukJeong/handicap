import type { Stage, StairConfig } from "../../api/schemas";
import { ko } from "../../i18n/ko";

export type StairDraft = {
  targets: string;
  hold: string;
  ramp: string;
  discard: string;
  p99Cap: string;
};

export const STAIR_DEFAULTS: StairDraft = {
  targets: "",
  hold: "60",
  ramp: "5",
  discard: "15",
  p99Cap: "",
};

export type StairTargetsError =
  | "empty"
  | "notInteger"
  | "outOfRange"
  | "notIncreasing"
  | "tooFew"
  | "tooMany";

const MIN_TARGETS = 2;
const MAX_TARGETS = 50;
const MAX_TARGET = 1_000_000;

/** 쉼표 구분 목표 목록. 공백과 끝 쉼표 하나는 허용, 그 밖의 빈 칸은 오류. */
export function parseTargets(
  s: string,
): { ok: true; values: number[] } | { ok: false; error: StairTargetsError } {
  const tokens = s.split(",").map((t) => t.trim());
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  if (tokens.every((t) => t === "")) return { ok: false, error: "empty" };
  const values: number[] = [];
  for (const t of tokens) {
    if (!/^-?\d+$/.test(t)) return { ok: false, error: "notInteger" };
    const n = Number(t);
    if (n < 1 || n > MAX_TARGET) return { ok: false, error: "outOfRange" };
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    if (values[i] <= values[i - 1]) return { ok: false, error: "notIncreasing" };
  }
  if (values.length < MIN_TARGETS) return { ok: false, error: "tooFew" };
  if (values.length > MAX_TARGETS) return { ok: false, error: "tooMany" };
  return { ok: true, values };
}

/** 목표의 25%·50%·75%·100%, 이후 25%p씩 최대 배수까지. 반올림·0 제거·중복 제거. */
export function generateTargets(goal: number, maxMultiple: 1.5 | 2 | 2.5 | 3): number[] {
  const out: number[] = [];
  const quarters = Math.round(maxMultiple * 4);
  for (let i = 1; i <= quarters; i++) {
    const v = Math.round((goal * i) / 4);
    if (v < 1) continue;
    if (out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/** 서버 expand_stair와 같은 수식: 목표마다 [상승 구간, 유지 구간]. 미리보기 전용. */
export function expandStair(c: StairConfig): Stage[] {
  return c.targets.flatMap((target) => [
    { target, duration_seconds: c.ramp_seconds },
    { target, duration_seconds: c.hold_seconds },
  ]);
}

export function stairSummary(c: StairConfig): {
  steps: number;
  totalSeconds: number;
  measureSeconds: number;
} {
  return {
    steps: c.targets.length,
    totalSeconds: c.targets.length * (c.ramp_seconds + c.hold_seconds),
    measureSeconds: c.hold_seconds - c.discard_seconds,
  };
}

const TARGETS_MSG: Record<StairTargetsError, string> = {
  empty: ko.loadModel.stairTargetsEmpty,
  notInteger: ko.loadModel.stairTargetsNotInteger,
  outOfRange: ko.loadModel.stairTargetsOutOfRange,
  notIncreasing: ko.loadModel.stairTargetsNotIncreasing,
  tooFew: ko.loadModel.stairTargetsTooFew,
  tooMany: ko.loadModel.stairTargetsTooMany,
};

function intIn(s: string, lo: number, hi: number): number | null {
  if (!/^-?\d+$/.test(s.trim())) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

/** 필드별 오류 문구(한국어, 고치는 방법과 예시 포함). 오류 없으면 빈 객체. */
export function stairErrors(
  d: StairDraft,
): Partial<Record<"targets" | "hold" | "ramp" | "discard" | "p99Cap", string>> {
  const e: Partial<Record<"targets" | "hold" | "ramp" | "discard" | "p99Cap", string>> = {};
  const t = parseTargets(d.targets);
  if (!t.ok) e.targets = TARGETS_MSG[t.error];
  const hold = intIn(d.hold, 20, 3600);
  if (hold === null) e.hold = ko.loadModel.stairHoldInvalid;
  if (intIn(d.ramp, 1, 600) === null) e.ramp = ko.loadModel.stairRampInvalid;
  const maxDiscard = hold === null ? null : hold - 10;
  if (intIn(d.discard, 0, maxDiscard ?? Number.MAX_SAFE_INTEGER) === null)
    e.discard = ko.loadModel.stairDiscardInvalid(maxDiscard);
  if (d.p99Cap.trim() !== "" && intIn(d.p99Cap, 1, 600_000) === null)
    e.p99Cap = ko.loadModel.stairP99CapInvalid;
  return e;
}

/** 저장된 StairConfig → 입력칸 draft(프리셋·재실행·스케줄 prefill). */
export function stairDraftFromConfig(c: StairConfig): StairDraft {
  return {
    targets: c.targets.join(", "),
    hold: String(c.hold_seconds),
    ramp: String(c.ramp_seconds),
    discard: String(c.discard_seconds),
    p99Cap: c.p99_cap_ms != null ? String(c.p99_cap_ms) : "",
  };
}

/** 입력이 모두 유효할 때만 StairConfig. 호출부는 stairErrors가 비었음을 먼저 확인한다. */
export function draftToStairConfig(d: StairDraft): StairConfig | null {
  const t = parseTargets(d.targets);
  if (!t.ok || Object.keys(stairErrors(d)).length > 0) return null;
  return {
    targets: t.values,
    hold_seconds: Number(d.hold),
    ramp_seconds: Number(d.ramp),
    discard_seconds: Number(d.discard),
    ...(d.p99Cap.trim() !== "" ? { p99_cap_ms: Number(d.p99Cap) } : {}),
  };
}
