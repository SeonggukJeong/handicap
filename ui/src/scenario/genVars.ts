import { z } from "zod";
import { ko } from "../i18n/ko";
import {
  POSITIONS_MAX_CHARS,
  PICK_ARRAY_MAX_LEN,
  candidatesOf,
  formatValueLiteral,
  isFullRange,
  isPickLength,
  parsePositions,
  pickValueTooLong,
  samplePickArray,
} from "./pickArray";

export const OFFSET_RE = /^[+-]\d{1,9}[smhd]$/;

const DateGenModel = z
  .object({
    gen: z.literal("date"),
    format: z.string().optional(),
    offset: z.string().regex(OFFSET_RE, "offset").optional(),
    tz: z.string().optional(),
  })
  .strict();
const RandomIntGenModel = z
  .object({
    gen: z.literal("random_int"),
    min: z.number().int(),
    max: z.number().int(),
    step: z.number().int().min(1).optional(),
  })
  .strict();
const UuidGenModel = z.object({ gen: z.literal("uuid") }).strict();
const RandomStringGenModel = z
  .object({
    gen: z.literal("random_string"),
    length: z.number().int().min(1).max(64).optional(),
  })
  .strict();
// 문자열 64자(코드 포인트) 상한 — 엔진 present_value와 lockstep(증폭 방지, pickArray.PICK_VALUE_MAX_CHARS).
const JsonScalarModel = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().refine((s) => !pickValueTooLong(s), "value too long"),
  z.null(),
]);
const PickArrayGenModel = z
  .object({
    gen: z.literal("pick_array"),
    length: z.number().int().min(1).max(PICK_ARRAY_MAX_LEN),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    // yaml 패키지는 `positions: 8`을 숫자로 읽는다 — 엔진(serde_yaml 평문 스칼라=문자열)과
    // 맞추려 정수를 문자열로 정규화(spec §4.1). 필드 레벨 transform이라 멤버는 ZodObject 유지.
    positions: z
      .union([z.string(), z.number().int().min(0)])
      .transform(String)
      .optional(),
    pick: JsonScalarModel.optional(),
    rest: JsonScalarModel.optional(),
  })
  .strict();

// cross-field(min≤max)는 union 레벨 superRefine — 멤버에 붙이면 ZodEffects라
// discriminatedUnion이 거부한다 (BodyModel/StepModel 함정).
export const GenSpecModel = z
  .discriminatedUnion("gen", [
    DateGenModel,
    RandomIntGenModel,
    UuidGenModel,
    RandomStringGenModel,
    PickArrayGenModel,
  ])
  .superRefine((v, ctx) => {
    if (v.gen === "random_int" && v.min > v.max)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > max", path: ["min"] });
    if (v.gen === "pick_array") {
      if (v.min > v.max)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > max", path: ["min"] });
      if (v.max > v.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "max > length", path: ["max"] });
      // length가 필드 검증(.int/.min/.max)에 실패해도 zod는 superRefine을 돌린다 — 그 length로
      // positions/후보를 계산하면 2.5는 throw, 1e9는 대량 할당. 필드 issue가 이미 보고하므로 건너뛴다.
      if (!isPickLength(v.length)) return;
      if (v.positions !== undefined && v.positions.length > POSITIONS_MAX_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "positions too long",
          path: ["positions"],
        });
        return;
      }
      const cand = v.positions === undefined ? null : parsePositions(v.positions, v.length);
      if (cand !== null && !cand.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "positions invalid",
          path: ["positions"],
        });
        return;
      }
      const c = cand === null ? v.length : cand.set.length;
      if (c === 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "no candidates",
          path: ["positions"],
        });
      else if (v.min > c)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > candidates", path: ["min"] });
    }
  });
export type GenSpec = z.infer<typeof GenSpecModel>;
export type VarDeclValue = string | GenSpec;
export type PickArraySpec = Extract<GenSpec, { gen: "pick_array" }>;
export const PICK_ARRAY_DEFAULT: PickArraySpec = { gen: "pick_array", length: 10, min: 1, max: 3 };
export function isPickArray(v: VarDeclValue): v is PickArraySpec {
  return typeof v !== "string" && v.gen === "pick_array";
}

export function isGenSpec(v: VarDeclValue): v is GenSpec {
  return typeof v !== "string";
}

const OFFSET_UNIT_KO: Record<string, string> = { d: "일", h: "시간", m: "분", s: "초" };

export function offsetKo(offset: string | undefined): string {
  if (!offset) return ko.editor.genDateToday; // "오늘"
  const unit = offset[offset.length - 1];
  return `${ko.editor.genDateToday}${offset.slice(0, -1)}${OFFSET_UNIT_KO[unit] ?? unit}`;
}
export function genTypeLabel(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return ko.editor.genTypeDate;
    case "random_int":
      return ko.editor.genTypeRandomInt;
    case "uuid":
      return ko.editor.genTypeUuid;
    case "random_string":
      return ko.editor.genTypeRandomString;
    case "pick_array":
      return ko.editor.genTypePickArray;
  }
}

export function canonicalGenKey(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return `date:${spec.format ?? ""}:${spec.offset ?? ""}:${spec.tz ?? ""}`;
    case "random_int":
      return `ri:${spec.min}:${spec.max}:${spec.step ?? 1}`;
    case "uuid":
      return "uuid";
    case "random_string":
      return `rs:${spec.length ?? 8}`;
    case "pick_array":
      return `pa:${spec.length}:${spec.min}:${spec.max}:${spec.positions ?? ""}:${JSON.stringify(spec.pick ?? true)}:${JSON.stringify(spec.rest ?? false)}`;
  }
}

// FNV-1a 32-bit — 시드 파생 전용(암호학적 용도 아님)
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — 결정적 PRNG(미리보기 전용)
export function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 예시 미리보기 단일 진입점 — (이름·파라미터·틱)의 순수 함수라 어느 마운트에서든 동일 텍스트.
 *  date 분기는 rand 미사용(시계 기반)이라 자연히 영향 없음. */
export function samplePreview(spec: GenSpec, name: string, tick: number): SamplePreview {
  return sampleFor(
    spec,
    new Date(),
    seededRand(hashSeed(`${name}|${canonicalGenKey(spec)}|${tick}`)),
  );
}

/** 접힘 요약 줄용 — 타입명은 배지가 담당하므로 파라미터만. uuid는 빈 문자열(배지 단독). */
export function genParamsSummary(spec: GenSpec): string {
  switch (spec.gen) {
    case "date":
      return `${offsetKo(spec.offset)} · ${spec.tz ?? ko.editor.genTzWorkerLocal}`;
    case "random_int": {
      const base = `${spec.min} ~ ${spec.max}`;
      const step = spec.step ?? 1;
      return step === 1 ? base : `${base} · ${step} ${ko.editor.genStepUnit}`;
    }
    case "uuid":
      return "";
    case "random_string":
      return `${spec.length ?? 8}${ko.editor.genLengthSuffix}`;
    case "pick_array": {
      const cand = candidatesOf(spec);
      const full = cand === null || isFullRange(cand, spec.length);
      const pick = spec.pick === undefined ? true : spec.pick;
      const rest = spec.rest === undefined ? false : spec.rest;
      const values =
        pick === true && rest === false
          ? null
          : `${formatValueLiteral(pick)}/${formatValueLiteral(rest)}`;
      return ko.editor.pickSummary(
        spec.length,
        spec.min,
        spec.max,
        full ? null : cand.length,
        values,
      );
    }
  }
}

// commit 술어와 바이트 동일 규칙(동작-보존): Number() + isInteger + 범위 — 정규식 강화 금지
// (기존 commitLength/commitStep이 "5e0" 같은 지수 표기도 Number 경유로 수용하므로 그대로 미러)
export function lengthDraftValue(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
}
export function stepDraftValue(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function declSearchText(v: VarDeclValue): string {
  return isGenSpec(v) ? `${genTypeLabel(v)} ${genParamsSummary(v)}`.trim() : v;
}

// ---- 샘플 미리보기: strftime 부분집합 (spec §6.3 — %Y %y %m %d %H %M %S %s %%만; 밖이면 unsupported) ----
type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsIn(tz: string | undefined, at: Date): Parts {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, // undefined = 브라우저 로컬 ("워커 로컬" 근사 — spec §6.3)
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
  };
}

const OFFSET_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function offsetSeconds(offset: string | undefined): number {
  if (!offset || !OFFSET_RE.test(offset)) return 0;
  const sign = offset[0] === "-" ? -1 : 1;
  return sign * Number(offset.slice(1, -1)) * OFFSET_SECS[offset[offset.length - 1]];
}

export function formatStrftimeSubset(fmt: string, p: Parts, epochSecs: number): string | null {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") {
      out += fmt[i];
      continue;
    }
    const c = fmt[++i];
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    switch (c) {
      case "Y":
        out += String(p.year);
        break;
      case "y":
        out += pad(p.year % 100, 2);
        break;
      case "m":
        out += pad(p.month, 2);
        break;
      case "d":
        out += pad(p.day, 2);
        break;
      case "H":
        out += pad(p.hour, 2);
        break;
      case "M":
        out += pad(p.minute, 2);
        break;
      case "S":
        out += pad(p.second, 2);
        break;
      case "s":
        out += String(epochSecs);
        break;
      case "%":
        out += "%";
        break;
      default:
        return null; // 부분집합 밖 — 거짓 미리보기 금지
    }
  }
  return out;
}

export type SamplePreview = { kind: "ok"; text: string } | { kind: "unsupported" };

export function sampleFor(
  spec: GenSpec,
  now: Date = new Date(),
  rand: () => number = Math.random,
): SamplePreview {
  switch (spec.gen) {
    case "date": {
      const at = new Date(now.getTime() + offsetSeconds(spec.offset) * 1000);
      // 게이트 정규식 `^[+-]\d{1,9}[smhd]$`는 9자리 `d`(예: +99999999d)를 수용해 ±8.64e15ms를
      // 넘는 Invalid Date를 만들 수 있다 — 이후 dtf.formatToParts가 RangeError를 throw하므로
      // (dynamic-vars final review I1) 여기서 먼저 걸러 unsupported로 처리한다.
      if (Number.isNaN(at.getTime())) return { kind: "unsupported" };
      const fmt = spec.format ?? "%Y-%m-%d";
      if (fmt === "unix") return { kind: "ok", text: String(Math.floor(at.getTime() / 1000)) };
      if (fmt === "unix_ms") return { kind: "ok", text: String(at.getTime()) };
      const tz = spec.tz; // undefined → 브라우저 로컬
      const text = formatStrftimeSubset(fmt, partsIn(tz, at), Math.floor(at.getTime() / 1000));
      return text === null ? { kind: "unsupported" } : { kind: "ok", text };
    }
    case "random_int": {
      const step = spec.step ?? 1;
      const k = Math.floor(rand() * (Math.floor((spec.max - spec.min) / step) + 1));
      return { kind: "ok", text: String(spec.min + k * step) };
    }
    case "uuid": {
      const b = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.map((x) => x.toString(16).padStart(2, "0"));
      return {
        kind: "ok",
        text: `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`,
      };
    }
    case "random_string": {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      const n = spec.length ?? 8;
      return {
        kind: "ok",
        text: Array.from({ length: n }, () => chars[Math.floor(rand() * chars.length)]).join(""),
      };
    }
    case "pick_array": {
      const text = samplePickArray(spec, rand);
      return text === null ? { kind: "unsupported" } : { kind: "ok", text };
    }
  }
}

export const DATE_FORMAT_PRESETS: { value: string; labelKey: string }[] = [
  { value: "%Y-%m-%d", labelKey: "%Y-%m-%d" },
  { value: "%Y-%m-%dT%H:%M:%S", labelKey: "%Y-%m-%dT%H:%M:%S" },
  { value: "unix", labelKey: "unix" },
  { value: "unix_ms", labelKey: "unix_ms" },
];
