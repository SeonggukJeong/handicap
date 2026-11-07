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

/// 키 안내 줄 조각 — 좁으면 앞에서부터 통째로 뺀다(마지막 `q 종료`는 끝까지 남는다).
pub const KEYS_MOVE: &str = "←↑↓→ 칸 이동";
pub const KEYS_NEXT_BOARD: &str = "Tab 다음 보드";
pub const KEYS_HELP_OPEN: &str = "? 도움말";
pub const KEYS_QUIT: &str = "q 종료";
pub const KEYS_RETRY: &str = "r 다시 시도";
pub const KEYS_HELP: &str = "Esc 닫기";
pub const KEYS_CONFIRM_YES: &str = "y 종료";
pub const KEYS_CONFIRM_CANCEL: &str = "다른 키 취소";

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

/// 도움말·오류 화면의 로그 줄.
pub fn log_line(loc: &crate::logging::LogLoc) -> String {
    match loc {
        crate::logging::LogLoc::Path(p) => format!("{HELP_LOG}: {}", p.display()),
        crate::logging::LogLoc::Unavailable(cause) => log_unavailable(cause),
    }
}

/// UI 스레드 패닉 시 stderr 한 줄의 머리(뒤에 `log_line`이 붙는다).
pub const PANIC_EXIT: &str = "핸디캡 모니터 오류로 종료합니다.";

pub const NO_BOARDS: &str = "파일에 보드가 없습니다";

pub const STARTING: &str = "점검 엔진을 시작하는 중…";

/// `y` 종료 확인 뒤·종료 신호 뒤 세션을 내리는 동안 보여 주는 한 줄.
pub const CLOSING: &str = "종료 중…";

/// `--check` 중 종료 신호를 받았을 때.
pub const CHECK_INTERRUPTED: &str = "종료 신호를 받아 점검을 중단했습니다";

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

/// 조건 판정 "본문 전체 글자 포함" 실패의 큰 값 꼬리(`"{needle}" 포함 안 됨`의 `" 포함 안 됨`).
pub const NOT_CONTAINED_TAIL: &str = "\" 포함 안 됨";

/// `N회 연속 · HH:MM:SS부터`에서 `N회 연속`만.
pub fn consecutive_short(full: &str) -> &str {
    full.split_once(" · ").map_or(full, |(head, _)| head)
}

pub fn board_pos(pos: usize, total: usize) -> String {
    format!("({pos}/{total})")
}

/// 평균·최대 줄을 칸 폭 `w`에 맞춘다 — 통째 구간 단위로 줄인다:
/// `평균 N · 최대 M ms` → 단위 뺀 `평균 N · 최대 M` → `최대 M` → (마지막 수단) 말줄임.
/// `full`은 `STATS_AVG N · STATS_MAX M ms` 꼴(model.rs가 만든다).
pub fn stats_for_width(full: &str, w: usize) -> String {
    use crate::view::{fit, text_width};
    let no_unit = full.strip_suffix(" ms").unwrap_or(full);
    let max_only = no_unit.split_once(" · ").map_or(no_unit, |(_, m)| m);
    for v in [full, no_unit, max_only] {
        if text_width(v) <= w {
            return v.to_string();
        }
    }
    fit(max_only, w)
}
