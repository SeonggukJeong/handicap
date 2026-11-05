import { ko } from "../i18n/ko";

const f = ko.print.fmt;

/** 응답 시간(ms) → 사람이 읽는 표기. Math.round 기반(toFixed 반올림 오차 회피). */
export function fmtMs(ms: number): string {
  if (ms <= 0) return f.msUnderOne;
  if (ms < 10) return f.ms(Math.round(ms));
  if (ms < 1000) {
    const v = Math.round(ms / 10) / 100;
    if (v < 1) return f.sec(v.toFixed(2));
  }
  return f.sec((Math.round(ms / 100) / 10).toFixed(1));
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
