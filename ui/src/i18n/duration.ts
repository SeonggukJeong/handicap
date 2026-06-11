/** 초 → "1시간 5분" / "1분 30초" / "30초" (한국어 자연 표기, 음수는 0초). */
export function formatDurationKo(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}초`);
  return parts.join(" ");
}

/** ms → 초 단위 사람 표기. 1초 미만 "0.21초", 10초 미만 "1.2초", 그 이상 "12초". */
export function formatSecondsKo(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)}초`;
  if (s < 10) return `${s.toFixed(1)}초`;
  return `${Math.round(s)}초`;
}
