//! 사용자 노출 한국어 문구 — `ui/src/i18n/ko.ts`(`ko.monitor.*`) 값을 그대로 복사한 유일한 자리.

use crate::judge::PanelState;

pub const STATS_AVG: &str = "평균";
pub const STATS_MAX: &str = "최대";
pub const SERVER_DOWN: &str = "서버 응답 없음";
/// `ko.monitor.noValue`
pub const NO_VALUE: &str = "—";

pub fn state_label(s: PanelState) -> &'static str {
    match s {
        PanelState::Ok => "✔ 정상",
        PanelState::Slow => "▲ 느림",
        PanelState::Fail => "✖ 실패",
        PanelState::ConfigError => "⚠ 설정 오류",
        PanelState::Blocked => "― 확인 못 함",
        PanelState::Skipped => "○ 분기 제외",
        PanelState::Stale => "– 확인 불가",
        PanelState::StaleOff => "– 확인 불가 · 점검 꺼짐",
        PanelState::Pending => "… 확인 중",
    }
}

pub fn consecutive(n: u32, hms: &str) -> String {
    format!("{n}회 연속 · {hms}부터")
}

/// 머리 줄 점검 상태(끊김이면 `SERVER_DOWN`)
pub const MONITOR_RUNNING: &str = "점검 중";
pub const MONITOR_TITLE: &str = "Handicap 모니터";

pub const KEYS_MONITOR: &str = "←↑↓→ 칸 이동  Tab 다음 보드  ? 도움말  q 종료";
pub const KEYS_MONITOR_SINGLE: &str = "←↑↓→ 칸 이동  ? 도움말  q 종료";
pub const KEYS_ERROR: &str = "r 다시 시도  q 종료";
pub const KEYS_HELP: &str = "Esc 닫기";

pub const HELP_TITLE: &str = "도움말";
pub const HELP_KEYS: [(&str, &str); 6] = [
    ("방향키 / h j k l", "칸 선택 이동"),
    ("Tab / Shift+Tab", "다음 / 이전 보드"),
    ("?", "도움말"),
    ("q / Ctrl+C", "종료 확인창"),
    ("Esc", "한 단계 뒤로"),
    ("마우스 왼쪽 클릭", "그 칸 선택"),
];
pub const HELP_COPY: &str = "글자 복사는 Shift+드래그";
pub const HELP_FILE: &str = "보드 파일";
pub const HELP_LOG: &str = "로그";

pub const QUIT_CONFIRM: &str = "종료할까요? y 종료 · 다른 키 취소";

pub const USAGE: &str = "사용법: handicap-tui <보드 파일.json>";
pub const USAGE_MANUAL: &str = "자세한 사용법은 함께 받은 tui-monitor.md를 보세요.";

pub const ERROR_SUFFIX: &str = "실패";
pub const FILE_LABEL: &str = "파일";

pub fn too_small(have: (u16, u16), need: (u16, u16)) -> String {
    format!(
        "창을 키워 주세요(현재 {}×{}, 필요 {}×{})",
        have.0, have.1, need.0, need.1
    )
}

pub fn log_unavailable(cause: &str) -> String {
    format!("로그 없음: {cause}")
}

/// 조건 판정 "본문 전체 글자 포함" 실패의 큰 값.
pub fn not_contained(needle: &str) -> String {
    format!("\"{needle}\" 포함 안 됨")
}

pub fn board_pos(pos: usize, total: usize) -> String {
    format!("({pos}/{total})")
}
