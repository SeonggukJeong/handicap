const LOG_HEADROOM = 1.6;
const LINEAR_HEADROOM = 1.1;

function positives(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
}

/** 로그축 범위: 그려지는 값의 최솟값/1.6 ~ 최댓값×1.6 — 최고점 라벨과 아래 선이 테두리에 붙지 않는다. */
export function logDomain(values: (number | null | undefined)[]): [number, number] {
  const v = positives(values);
  if (v.length === 0) return [1, 10];
  return [Math.min(...v) / LOG_HEADROOM, Math.max(...v) * LOG_HEADROOM];
}

/** 선형축 범위: 0 ~ 최댓값×1.1 위쪽 여유(최댓값 선이 위 테두리를 따라 달리지 않게). */
export function linearDomain(values: (number | null | undefined)[]): [number, number] {
  const v = positives(values);
  if (v.length === 0) return [0, 1];
  return [0, Math.ceil(Math.max(...v) * LINEAR_HEADROOM)];
}
