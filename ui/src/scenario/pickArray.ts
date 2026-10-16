// 선택 배열(pick_array) 순수 헬퍼 — 엔진 crates/engine/src/genvars.rs와 lockstep
// (판정 벡터: testdata/pick_array_vectors.json). 무의존: genVars.ts가 이 모듈을 import한다.

export const PICK_ARRAY_MAX_LEN = 1000;
export const POSITIONS_MAX_CHARS = 4096;
/** pick/rest 문자열 상한 — 엔진 PICK_VALUE_MAX_CHARS와 lockstep. 엔진은 chars().count()(Unicode
 *  스칼라)로 세므로 여기서도 코드 포인트(`[...s].length`)로 센다 — `s.length`(UTF-16)는 이모지 등
 *  astral 문자를 2로 세 엔진과 판정이 갈린다. */
export const PICK_VALUE_MAX_CHARS = 64;
export const pickValueTooLong = (s: string): boolean => [...s].length > PICK_VALUE_MAX_CHARS;

/** length가 엔진 게이트 범위(1..=PICK_ARRAY_MAX_LEN 정수)인가 — 헬퍼들이 할당 전에 확인한다. */
export const isPickLength = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= PICK_ARRAY_MAX_LEN;

export type PositionsError =
  | { kind: "badLength" }
  | { kind: "tooLong" }
  | { kind: "badItem"; index: number }
  | { kind: "outOfRange"; index: number }
  | { kind: "reversed"; index: number };

export type PositionsResult = { ok: true; set: number[] } | { ok: false; error: PositionsError };

const NUM = /^[0-9]{1,4}$/;
// ASCII 공백만 — 엔진 trim_ascii_ws와 lockstep(JS trim()은 NBSP·U+FEFF까지 지워 엔진과 갈린다).
const trimAscii = (s: string) => s.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");

export function parsePositions(text: string, length: number): PositionsResult {
  // 무검증 length(2.5·1e9)로 new Array가 throw·대량 할당하지 않게 먼저 거부(엔진 parse_positions 동일).
  if (!isPickLength(length)) return { ok: false, error: { kind: "badLength" } };
  if (text.length > POSITIONS_MAX_CHARS) return { ok: false, error: { kind: "tooLong" } };
  if (trimAscii(text) === "") return { ok: true, set: [] };
  const mark = new Array<boolean>(length).fill(false);
  const items = text.split(",");
  for (let i = 0; i < items.length; i++) {
    const item = trimAscii(items[i]);
    const dash = item.indexOf("-");
    const [x, y] = dash === -1 ? [item, item] : [item.slice(0, dash), item.slice(dash + 1)];
    const xs = trimAscii(x);
    const ys = trimAscii(y);
    if (!NUM.test(xs) || !NUM.test(ys))
      return { ok: false, error: { kind: "badItem", index: i + 1 } };
    const a = Number(xs);
    const b = Number(ys);
    if (a > b) return { ok: false, error: { kind: "reversed", index: i + 1 } };
    if (a < 1 || b > length) return { ok: false, error: { kind: "outOfRange", index: i + 1 } };
    for (let p = a; p <= b; p++) mark[p - 1] = true;
  }
  const set: number[] = [];
  for (let p = 1; p <= length; p++) if (mark[p - 1]) set.push(p);
  return { ok: true, set };
}

export function formatPositions(set: readonly number[]): string {
  const xs = [...new Set(set)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function isFullRange(set: readonly number[], length: number): boolean {
  return set.length === length && set.every((p, i) => p === i + 1);
}

/** 길이 변경 시 positions 깎기 규칙(spec §6.3). 같은 길이·파싱 실패면 원문 그대로. */
export function trimPositionsForLength(
  text: string,
  baseLength: number,
  newLength: number,
): string {
  if (newLength === baseLength) return text;
  const r = parsePositions(text, baseLength);
  if (!r.ok) return text;
  if (isFullRange(r.set, baseLength)) return `1-${newLength}`;
  return formatPositions(r.set.filter((p) => p <= newLength));
}

export type JsonScalar = boolean | number | string | null;
export type LiteralResult =
  | { ok: true; value: JsonScalar }
  | { ok: false; reason: "empty" | "badQuoted" | "nonFinite" | "tooLong" };

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export function parseValueLiteral(text: string): LiteralResult {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "empty" };
  if (t.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v !== "string") return { ok: false, reason: "badQuoted" };
      return pickValueTooLong(v) ? { ok: false, reason: "tooLong" } : { ok: true, value: v };
    } catch {
      return { ok: false, reason: "badQuoted" };
    }
  }
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (t === "null") return { ok: true, value: null };
  if (JSON_NUMBER.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "nonFinite" };
  }
  return pickValueTooLong(t) ? { ok: false, reason: "tooLong" } : { ok: true, value: t };
}

export function formatValueLiteral(v: JsonScalar): string {
  if (typeof v !== "string") return JSON.stringify(v);
  const r = parseValueLiteral(v);
  return r.ok && r.value === v ? v : JSON.stringify(v);
}

export function jsonScalarKind(v: JsonScalar): "boolean" | "number" | "string" | "null" {
  if (v === null) return "null";
  return typeof v as "boolean" | "number" | "string";
}

export const VALUE_PRESETS: ReadonlyArray<{ pick: JsonScalar; rest: JsonScalar }> = [
  { pick: true, rest: false },
  { pick: "True", rest: "False" },
  { pick: 1, rest: 0 },
  { pick: "Y", rest: "N" },
];

export function presetIndexOf(pick: JsonScalar, rest: JsonScalar): number {
  return VALUE_PRESETS.findIndex((p) => Object.is(p.pick, pick) && Object.is(p.rest, rest));
}

export type PickParams = {
  length: number;
  min: number;
  max: number;
  positions?: string;
  pick?: JsonScalar;
  rest?: JsonScalar;
};

export function candidatesOf(p: PickParams): number[] | null {
  if (!isPickLength(p.length)) return null;
  if (p.positions === undefined) return Array.from({ length: p.length }, (_, i) => i + 1);
  const r = parsePositions(p.positions, p.length);
  return r.ok ? r.set : null;
}

/** 엔진 eval_pick_array와 같은 분포: k ~ U[min, min(max, c)], 후보 비복원 균등. */
export function samplePickArray(p: PickParams, rand: () => number): string | null {
  const cand = candidatesOf(p);
  if (cand === null || cand.length === 0) return null;
  const hi = Math.min(p.max, cand.length);
  const lo = Math.min(p.min, hi);
  const k = lo + Math.floor(rand() * (hi - lo + 1));
  const pool = [...cand];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const pick = p.pick === undefined ? true : p.pick;
  const rest = p.rest === undefined ? false : p.rest;
  const out: JsonScalar[] = new Array<JsonScalar>(p.length).fill(rest);
  for (const q of pool.slice(0, k)) out[q - 1] = pick;
  return JSON.stringify(out);
}
