// 설정 key → 배포 환경 적용 범위 분류 (UI 정적 단일 소스).
// pool scope = is_pool_mode() 게이트로 비-풀 배포에서 무효인 reaper 2종만.
// pool_keepalive_seconds는 전 모드 gRPC 서버 keepalive라 공통(spec F1).
// 미매핑 key는 "common"으로 폴백 → 새 knob이 추가돼도 거짓 "풀 전용" 배지 불가.
export type SettingScope = "common" | "pool";

const POOL_KEYS = new Set<string>([
  "pool_heartbeat_interval_seconds",
  "pool_stale_timeout_seconds",
]);

export function scopeOf(key: string): SettingScope {
  return POOL_KEYS.has(key) ? "pool" : "common";
}

// 환경별로 의미가 다른 설정 → ko.opsSettings.envNote.* 키.
export type EnvNoteKey = "workerCapacityPoolIgnored" | "poolKeepaliveAllModes";

export const ENV_NOTE_KEY: Record<string, EnvNoteKey> = {
  worker_capacity_vus: "workerCapacityPoolIgnored",
  pool_keepalive_seconds: "poolKeepaliveAllModes",
};
