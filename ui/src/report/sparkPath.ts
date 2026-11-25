export type SparkBox = {
  xMax: number;
  yMax: number;
  x0: number;
  x1: number;
  yTop: number;
  yBottom: number;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 작은 평균 그래프(화면 격자·인쇄 부록 공용)의 SVG 경로. 값이 없는 점(null)은 선을 끊는다. */
export function sparkPath(points: { x: number; y: number | null }[], box: SparkBox): string {
  const { xMax, yMax, x0, x1, yTop, yBottom } = box;
  const runs: string[][] = [];
  let cur: string[] | null = null;
  for (const p of points) {
    if (p.y === null) {
      cur = null;
      continue;
    }
    const x = r2(x0 + (p.x / Math.max(xMax, 1)) * (x1 - x0));
    const y = r2(yBottom - (Math.min(p.y, yMax) / yMax) * (yBottom - yTop));
    if (cur === null) {
      cur = [`M${x},${y}`];
      runs.push(cur);
    } else {
      cur.push(`L${x},${y}`);
    }
  }
  return runs.map((r) => (r.length === 1 ? `${r[0]} L${r[0].slice(1)}` : r.join(" "))).join(" ");
}
