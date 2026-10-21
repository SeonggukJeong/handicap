/**
 * The widest fixed reasons the controller can send (wire values, not UI copy):
 * `crates/controller/src/monitor/check.rs` REASON_* plus the longest timeout
 * form (`timeout_seconds` is capped at 30). Used only by the size probe to fix
 * the reason line's own scale from settings (spec §7.3, R18) — keep in sync
 * with check.rs. `HTTP {status}` is short and omitted.
 */
export const WIDEST_REASON_CANDIDATES: readonly string[] = [
  "시나리오를 찾을 수 없음",
  "환경을 찾을 수 없음",
  "시나리오 오류",
  "응답 시간 기준 스텝 없음",
  "요청 수 상한(50) 초과",
  "시나리오 실행 오류",
  "요청 구성 오류",
  "응답 본문 읽기 실패",
  "값 추출 실패",
  "요청 실패",
  "변수 미설정",
  "시간 초과(30초)",
];
