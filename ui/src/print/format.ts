import { ko } from "../i18n/ko";
import { msNumberText } from "../components/report/format";

const f = ko.print.fmt;

/** 길이(ms) → 사람이 읽는 표기(대기 시간 등). Math.round 기반(toFixed 반올림 오차 회피). */
export function fmtDurMs(ms: number): string {
  if (ms <= 0) return f.msUnderOne;
  if (ms < 10) return f.ms(Math.round(ms));
  if (ms < 1000) {
    const v = Math.round(ms / 10) / 100;
    if (v < 1) return f.sec(v.toFixed(2));
  }
  return f.sec((Math.round(ms / 100) / 10).toFixed(1));
}

/** 응답 시간(ms) 글자 — 60초 칸(≥ 60,000)은 「60초 이상」, 그 밖은 길이 글자. */
export function fmtMs(ms: number): string {
  return ms >= 60000 ? f.capSec : fmtDurMs(ms);
}

/** 평균 글자 — 분포가 잘렸으면 하한이라 「이상」(이미 60초 칸이면 한 번만). */
export function fmtMeanMs(ms: number, capped: boolean): string {
  return capped && ms < 60000 ? f.orMore(fmtMs(ms)) : fmtMs(ms);
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** fraction(0–1) → 소수 1자리 %. 0이 아닌데 0.1% 미만이면 "0.1% 미만". */
export function fmtPct(fraction: number): string {
  const p = fraction * 100;
  if (fraction === 0) return "0.0%";
  if (p > 0 && p < 0.1) return f.pctUnderTenth;
  return `${p.toFixed(1)}%`;
}

export function fmtRps(n: number): string {
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return `${s}${f.rpsUnit}`;
}

const MAX_DIGITS = 6;

function roundTo(v: number, d: number): number {
  return Math.round(v * 10 ** d) / 10 ** d;
}

export function pctText(fraction: number, d: number): string {
  const p = roundTo(fraction * 100, d);
  if (fraction > 0 && p === 0) return f.pctUnder((10 ** -d).toFixed(d));
  return `${p.toFixed(d)}%`;
}

export function rpsText(v: number, d: number): string {
  const s = roundTo(v, d).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return `${s}${f.rpsUnit}`;
}

export type PairText = { actual: string; threshold: string; tiny: boolean };

function digitPair(
  actual: number,
  threshold: number,
  base: number,
  text: (v: number, d: number) => string,
): PairText {
  if (actual !== threshold) {
    for (let d = base; d <= MAX_DIGITS; d++) {
      const a = text(actual, d);
      const t = text(threshold, d);
      if (a !== t) return { actual: a, threshold: t, tiny: false };
    }
    return { actual: text(actual, base), threshold: text(threshold, base), tiny: true };
  }
  return { actual: text(actual, base), threshold: text(threshold, base), tiny: false };
}

/** ms → "3,040ms". 소수가 있으면 소수 3자리까지 뒤 0 제거("2,999.5ms"). */
export function fmtMsExact(ms: number): string {
  return f.msExact(msNumberText(ms));
}

/** 경계값 글자: 0 → "0ms", 0이 아닌 1000의 배수 → "3초", 그 밖 → fmtMsExact. */
export function fmtBoundary(ms: number): string {
  if (ms !== 0 && ms % 1000 === 0) return f.sec(String(ms / 1000));
  return fmtMsExact(ms);
}

/** fraction(0–1) 쌍 → 같은 자릿수의 % 글자 둘. 값이 다른데 글자가 같으면 6자리까지 늘리고, 그래도 같으면 tiny. */
export function fmtPctPair(actual: number, threshold: number, base: number): PairText {
  return digitPair(actual, threshold, base, pctText);
}

/** rps 쌍(단위 포함, 기본 1자리, 같은 규칙). */
export function fmtRpsPair(actual: number, threshold: number): PairText {
  return digitPair(actual, threshold, 1, rpsText);
}

/** 시간 쌍: fmtMsExact 둘. 값이 다른데 글자가 같으면 tiny=true. */
export function fmtMsPair(actual: number, threshold: number): PairText {
  const a = fmtMsExact(actual);
  const t = fmtMsExact(threshold);
  return { actual: a, threshold: t, tiny: actual !== threshold && a === t };
}

/** metric으로 갈래를 골라 주는 진입점. 모르는 metric → String(v) 둘. */
export function fmtCriterionPair(
  metric: string,
  actual: number,
  threshold: number,
  capped = false,
): PairText {
  if (metric.endsWith("_ms")) {
    const p = fmtMsPair(actual, threshold);
    // 상한에 걸려 잘린 실측 — 실제 값은 이보다 크다
    return capped ? { ...p, actual: `≥ ${p.actual}`, tiny: false } : p;
  }
  if (metric.endsWith("_rate")) return fmtPctPair(actual, threshold, 2);
  if (metric === "rps" || metric === "min_window_rps") return fmtRpsPair(actual, threshold);
  if (metric.endsWith("_count")) {
    return {
      actual: ko.print.criteria.count(fmtCount(actual)),
      threshold: ko.print.criteria.count(fmtCount(threshold)),
      tiny: false,
    };
  }
  return { actual: String(actual), threshold: String(threshold), tiny: false };
}

/** 측정값 없이 기준값만: 같은 갈래의 기본 자릿수. */
export function fmtCriterionThreshold(metric: string, threshold: number): string {
  if (metric.endsWith("_ms")) return fmtMsExact(threshold);
  if (metric.endsWith("_rate")) return pctText(threshold, 2);
  if (metric === "rps" || metric === "min_window_rps") return rpsText(threshold, 1);
  if (metric.endsWith("_count")) return ko.print.criteria.count(fmtCount(threshold));
  return String(threshold);
}

export function stepNo(index0: number): string {
  if (index0 < 20) return String.fromCharCode(0x2460 + index0);
  return `${index0 + 1}.`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtDateTime(ms: number): string {
  return `${fmtDate(ms)} ${fmtTime(ms)}`;
}
