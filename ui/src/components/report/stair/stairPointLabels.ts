import type { StairStep } from "../../../api/schemas";

/** 계단이 이 수 이하면 측정된 모든 점에 라벨, 넘으면 의미 있는 점에만(라벨끼리 겹치지 않게). */
export const LABEL_ALL_MAX_STEPS = 12;

type LabelRow = { p99: number | null; state: StairStep["state"]; knee: boolean };

/** 라벨을 달 점의 index: knee, 튐·포화·확인 못 함 구간의 첫 점, 전체 최대 p99. */
export function labeledIndices(rows: LabelRow[]): Set<number> {
  const out = new Set<number>();
  if (rows.length <= LABEL_ALL_MAX_STEPS) {
    rows.forEach((r, i) => {
      if (r.p99 != null) out.add(i);
    });
    return out;
  }
  let maxIdx = -1;
  rows.forEach((r, i) => {
    if (r.p99 == null) return;
    if (maxIdx < 0 || r.p99 > (rows[maxIdx].p99 as number)) maxIdx = i;
    const flagged = r.state === "spike" || r.state === "saturated" || r.state === "unconfirmed";
    if (r.knee || (flagged && (i === 0 || rows[i - 1].state !== r.state))) out.add(i);
  });
  if (maxIdx >= 0) out.add(maxIdx);
  return out;
}
