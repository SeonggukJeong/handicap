const LOG_MIN_PAD = Math.log10(1.6);
const LOG_SPAN_PAD = 0.15;
const LINEAR_HEADROOM = 1.1;

function positives(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
}

/** 로그축 범위: 위아래 여유 = max(log10(1.6), 범위의 15%) 자리 — 범위가 넓어도 최고점 라벨이 plot 안에 든다. */
export function logDomain(values: (number | null | undefined)[]): [number, number] {
  const v = positives(values);
  if (v.length === 0) return [1, 10];
  const lo = Math.log10(Math.min(...v));
  const hi = Math.log10(Math.max(...v));
  const pad = Math.max(LOG_MIN_PAD, LOG_SPAN_PAD * (hi - lo));
  return [10 ** (lo - pad), 10 ** (hi + pad)];
}

/** 선형축 범위: 0 ~ 최댓값×1.1 위쪽 여유(최댓값 선이 위 테두리를 따라 달리지 않게). */
export function linearDomain(values: (number | null | undefined)[]): [number, number] {
  const v = positives(values);
  if (v.length === 0) return [0, 1];
  return [0, Math.ceil(Math.max(...v) * LINEAR_HEADROOM)];
}
