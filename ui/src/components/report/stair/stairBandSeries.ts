import type { StairBandSecondRow } from "./stairBandTypes";

/** 초 단위 행: count 0 초의 p99(0으로 직렬화됨)와 빠진 초는 null — 선이 끊긴다(보간 없음). */
export function buildBandSeries(seconds: StairBandSecondRow[]): {
  offset_s: number;
  launched: number | null;
  p99_ms: number | null;
}[] {
  if (seconds.length === 0) return [];
  const byOffset = new Map(seconds.map((s) => [s.offset_s, s]));
  const offs = seconds.map((s) => s.offset_s);
  const lo = Math.min(...offs);
  const hi = Math.max(...offs);
  const rows = [];
  for (let o = lo; o <= hi; o++) {
    const s = byOffset.get(o);
    rows.push({
      offset_s: o,
      launched: s?.launched ?? null,
      p99_ms: s && s.count > 0 ? s.p99_us / 1000 : null,
    });
  }
  return rows;
}
