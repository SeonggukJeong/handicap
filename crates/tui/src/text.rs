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
