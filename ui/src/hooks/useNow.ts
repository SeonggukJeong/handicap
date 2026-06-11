import { useEffect, useState } from "react";

/** intervalMs 간격으로 갱신되는 현재 시각(ms epoch). null이면 틱 없이 mount 시각 고정.
 *  서버 폴링과 무관한 순수 클라 시계 — running 경과 시간 표시용(§7.4, 신규 fetch 없음). */
export function useNow(intervalMs: number | null = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
