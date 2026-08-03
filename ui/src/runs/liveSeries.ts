import type { WindowSummary } from "../api/schemas";

export type LiveSecond = { ts_second: number; count: number; errors: number };

// 최신 초는 멀티워커 도착 skew로 부분합일 수 있어 표시에서 제외 — 단일 워커 행은
// 도착 즉시 완성값이다(엔진 drain_completed는 지난 초만 내보낸다). spec N2.
export const LIVE_TRIM_TRAILING_SECONDS = 1;

// ts_second별 스텝 간 합산(워커 간 merge는 서버 선처리) + 오름차순 + 후미 트림.
// 무-트래픽 초는 채우지 않는다 — 리포트 bySecond와 동일 정책(라이브·리포트 궤적 일치).
export function liveBySecond(windows: WindowSummary[]): LiveSecond[] {
  if (windows.length === 0) return [];
  const buckets = new Map<number, LiveSecond>();
  let maxTs = windows[0].ts_second;
  for (const win of windows) {
    if (win.ts_second > maxTs) maxTs = win.ts_second;
    const cur = buckets.get(win.ts_second) ?? { ts_second: win.ts_second, count: 0, errors: 0 };
    cur.count += win.count;
    cur.errors += win.error_count;
    buckets.set(win.ts_second, cur);
  }
  const cutoff = maxTs - LIVE_TRIM_TRAILING_SECONDS;
  return Array.from(buckets.values())
    .filter((s) => s.ts_second <= cutoff)
    .sort((a, b) => a.ts_second - b.ts_second);
}
