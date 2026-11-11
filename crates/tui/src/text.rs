//! 사용자 노출 한국어 문구 — `ui/src/i18n/ko.ts`(`ko.monitor.*`) 값을 그대로 복사한 유일한 자리.

use crate::judge::PanelState;

pub const STATS_AVG: &str = "평균";
/// 시각 줄의 기준선 숫자 열 아래 단위 표시.
pub const AXIS_UNIT: &str = "(ms)";
/// L·M 큰 응답 시간 블록 맨 아래 줄 오른쪽 끝의 단위(`format_ms`의 꼬리와 같다).
pub const LATENCY_UNIT: &str = "ms";
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
pub const KEYS_BORDER: &str = "b 테두리";
pub const KEYS_HELP_OPEN: &str = "? 도움말";
pub const KEYS_QUIT: &str = "q 종료";
pub const KEYS_RETRY: &str = "r 다시 시도";
pub const KEYS_HELP: &str = "Esc 닫기";
pub const KEYS_CONFIRM_YES: &str = "y 종료";
pub const KEYS_CONFIRM_CANCEL: &str = "다른 키 취소";
pub const KEYS_ERRORS: &str = "e 오류 보기";
pub const KEYS_SETTINGS: &str = "Enter 칸 설정";

/// 오류 보기·칸 설정 화면 키 줄 조각(목업 §1–§4 — 앞 조각부터 통째로 빠진다).
pub const KEYS_PICK: &str = "↑↓ 고르기";
pub const KEYS_PICK_STEP: &str = "↑↓ 스텝 고르기";
pub const KEYS_SCROLL: &str = "↑↓ PgUp PgDn 스크롤";
pub const KEYS_SCROLL_SHORT: &str = "↑↓ 스크롤";
pub const KEYS_ALL_ON: &str = "a 전체 회차";
pub const KEYS_ALL_OFF: &str = "a 실패만";
pub const KEYS_DETAIL: &str = "Enter 자세히";
pub const KEYS_BODY: &str = "Enter 요청·응답 보기";
pub const KEYS_STEP_NAV: &str = "←→ 이전·다음 스텝";
pub const KEYS_REVEAL: &str = "v 요청 본문 보기";
pub const KEYS_HIDE: &str = "v 가리기";
pub const KEYS_TO_MONITOR: &str = "Esc 모니터로";
pub const KEYS_TO_LIST: &str = "Esc 목록으로";
pub const KEYS_TO_DETAIL: &str = "Esc 자세히로";

pub const HELP_TITLE: &str = "도움말";
pub const HELP_KEYS: [(&str, &str); 10] = [
    (
        "Ctrl + + / -",
        // 터미널 글꼴 크기 — 고정은 자동 시작 줄의 `--zoom=` (50칸 터미널에서도 통째로 보이게 짧게).
        "글자 크기 · 고정: --zoom=1.6",
    ),
    ("방향키 / h j k l", "칸 선택 이동"),
    ("Tab / Shift+Tab", "다음 / 이전 보드"),
    ("e", "선택 칸 오류 보기(실패 목록 → 자세히 → 요청·응답)"),
    ("Enter", "선택 칸 설정 보기"),
    ("b", "테두리 모양 바꾸기(굵은 선 / 반 칸 블록, 기억됨)"),
    ("?", "도움말"),
    ("q / Ctrl+C", "종료 확인창"),
    ("Esc", "한 단계 뒤로"),
    ("마우스 왼쪽 클릭", "그 칸 선택"),
];
pub const HELP_IDLE: &str = "오류 보기·칸 설정 화면은 5분 동안 입력이 없으면 모니터로 돌아갑니다";
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

/// 상태 문구를 폭 `w`에 맞춘다 — ` · `로 나뉜 뒤 조각부터 통째로 뺀다
/// (`– 확인 불가 · 점검 꺼짐` → `– 확인 불가`). 첫 조각조차 안 들어가면 마지막 수단으로 말줄임.
pub fn label_for_width(label: &str, w: usize) -> String {
    use crate::view::{fit, text_width};
    let mut shown = label;
    loop {
        if text_width(shown) <= w {
            return shown.to_string();
        }
        match shown.rsplit_once(" · ") {
            Some((head, _)) => shown = head,
            None => return fit(shown, w),
        }
    }
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

// ---------- 오류 보기 (1b) ----------

/// `ko.monitor.loading`
pub const LOADING: &str = "불러오는 중…";

/// `ko.monitor.recordLoadError`
pub fn record_load_error(msg: &str) -> String {
    format!("기록을 불러오지 못했습니다: {msg}")
}

/// 목록 줄의 404(기록이 이미 지워짐) — TUI 전용 짧은 문구.
pub const RECORD_GONE_SHORT: &str = "기록 지남";
pub const ERRORS_TITLE: &str = "오류 보기";

/// 오류 목록 개수(실패만 보기) — `span`은 `span_text`.
pub fn errors_count(failures: usize, total: usize, span: &str) -> String {
    format!("실패 {failures}회 · 최근 {total}회({span}) 중")
}

/// 오류 목록 개수(전체 회차 보기).
pub fn errors_count_all(total: usize) -> String {
    format!("전체 {total}회")
}

/// 막대 구간 길이 — 60초 이상이면 반올림 분, 아니면 초.
pub fn span_text(secs: u64) -> String {
    if secs >= 60 {
        format!("약 {}분", (secs + 30) / 60)
    } else {
        format!("약 {secs}초")
    }
}

/// 오류 목록 열 이름(시각, 상태, 사유).
pub const ERRORS_COLS: (&str, &str, &str) = ("시각", "상태", "사유");
pub const ERRORS_EMPTY: &str = "이 구간에 실패가 없습니다";
pub const ERRORS_EMPTY_ALL: &str = "아직 점검 결과가 없습니다";

/// 새 화면(오류 보기·칸 설정)의 무입력 자동 복귀 안내 줄.
pub const IDLE_NOTICE: &str = "5분 동안 입력이 없으면 모니터로 돌아갑니다";

// ---------- 기록 상세 (1b) ----------

/// `ko.monitor.recordTitle`
pub fn record_title(title: &str, when: &str) -> String {
    format!("{title} · {when}")
}

/// `ko.monitor.recordMissing`
pub const RECORD_MISSING: &str =
    "이 점검의 기록이 없습니다 — 기록은 막대 구간만큼만 보관되어 이미 지워졌습니다";
/// `ko.monitor.recordNoTraceConfig`
pub const RECORD_NO_TRACE_CONFIG: &str =
    "요청을 보내기 전에 멈췄습니다(설정 오류) — 요청·응답 기록 없음";
/// `ko.monitor.recordNoTraceTimeout`
pub const RECORD_NO_TRACE_TIMEOUT: &str = "응답이 오기 전에 시간 초과 — 요청·응답 기록 없음";

/// `ko.monitor.recordTraceError`
pub fn record_trace_error(e: &str) -> String {
    format!("점검 준비 중 오류: {e}")
}

/// `ko.monitor.recordTraceCut`
pub const RECORD_TRACE_CUT: &str = "점검이 중간에 끊겨 그 전 스텝까지만 기록됐습니다";

/// `ko.monitor.recordIfRow`
pub fn record_if_row(branch: &str) -> String {
    format!("조건 분기 → {branch}")
}

/// `ui/src/scenario/chipResults.ts` `BRANCH_LABEL.none`
pub const BRANCH_NONE: &str = "(미매치)";
/// 기록 상세의 사유·판정 상세 칸 이름(TUI 전용, spec §5.3-2 용어).
pub const REASON_LABEL: &str = "사유";
pub const JUDGE_DETAIL: &str = "판정 상세";
/// `ko.monitor.scenario`
pub const SET_SCENARIO: &str = "시나리오";
/// `ko.monitor.environment`
pub const SET_ENV: &str = "환경";
/// 기록 상세 스텝 표 열 이름(#, 스텝, 요청, 응답, 지연).
pub const RECORD_COLS: (&str, &str, &str, &str, &str) = ("#", "스텝", "요청", "응답", "지연");
/// 스텝이 요청 시간 초과로 실패(지연 자리).
pub const TIMED_OUT: &str = "시간 초과";
/// 스텝 칸이 보는 그 스텝 줄 표시(사용자 확정 9).
pub const THIS_PANEL: &str = "◀ 이 칸";

// ---------- 요청·응답 본문 (1b) ----------

/// `ko.monitor.recordReqHeaders`
pub const RECORD_REQ_HEADERS: &str = "요청 헤더";
/// `ko.monitor.recordReqBody`
pub const RECORD_REQ_BODY: &str = "요청 본문";
/// `ko.monitor.recordRespHeaders`
pub const RECORD_RESP_HEADERS: &str = "응답 헤더";
/// `ko.monitor.recordRespBody`
pub const RECORD_RESP_BODY: &str = "응답 본문";
/// `ko.monitor.recordReqBodyHidden`
pub const RECORD_REQ_BODY_HIDDEN: &str = "요청 본문은 가려져 있습니다";

/// `ko.monitor.recordClipped`
pub fn record_clipped(kb: u32) -> String {
    format!("기록 상한 {kb}KB에서 잘림")
}

/// `ko.monitor.recordEngineTruncated`
pub const RECORD_ENGINE_TRUNCATED: &str = "1 MiB에서 잘림 — 실제 응답은 더 큼";
/// `ko.monitor.recordTreeTooLarge`
pub const RECORD_TREE_TOO_LARGE: &str = "64KB를 넘는 본문은 원문으로 표시합니다";
/// `ko.monitor.recordTreeTooDeep`
pub const RECORD_TREE_TOO_DEEP: &str = "너무 깊게 중첩된 본문은 원문으로 표시합니다";
/// `ko.monitor.recordMaskedHint`
pub const RECORD_MASKED_HINT: &str = "인증 값은 ••••로 가렸습니다";

/// 본문 화면 줄 위치(TUI 전용, 목업 §3).
pub fn line_pos(end: usize, total: usize) -> String {
    format!("{end}/{total}줄")
}

// ---------- 칸 설정 보기 (1b) ----------

/// 화면 제목(TUI 전용).
pub const SETTINGS_TITLE: &str = "칸 설정";
/// 제목 줄 오른쪽(TUI 전용, 목업 §4).
pub const SETTINGS_READONLY: &str = "보기 전용 — 수정은 다음 버전";
/// 기준선·조건·표시 항목이 없을 때(TUI 전용).
pub const NONE: &str = "없음";
/// 표시할 응답 시간이 칸이 보는 그 스텝일 때(TUI 전용, 목업 §4).
pub const THIS_STEP: &str = "이 스텝";
/// 묶음 값 표시(TUI 전용).
pub const GROUP_MARK: &str = "(묶음)";

/// `ko.monitor.groupTitle`
pub fn group_title(n: impl std::fmt::Display) -> String {
    format!("점검 묶음 {n}")
}

/// 묶음 칸 각주(TUI 전용).
pub fn group_note(n: usize) -> String {
    format!(
        "{GROUP_MARK} = {}의 값 — 칸마다 따로 못 바꿉니다",
        group_title(n)
    )
}

/// 묶음 번호를 모를 때의 각주(TUI 전용).
pub const GROUP_NOTE_PLAIN: &str = "(묶음) = 점검 묶음의 값 — 칸마다 따로 못 바꿉니다";

/// `ko.monitor.panelTitle`
pub const SET_TITLE: &str = "제목";
/// `ko.monitor.stepPick`
pub const SET_STEP: &str = "볼 스텝";
/// `ko.monitor.interval`
pub const SET_INTERVAL: &str = "점검 주기(초)";
/// `ko.monitor.timeout`
pub const SET_TIMEOUT: &str = "제한 시간(초)";
/// `ko.monitor.latencySource`
pub const SET_LATENCY: &str = "표시할 응답 시간";
/// `ko.monitor.thresholds`
pub const SET_THRESHOLDS: &str = "응답속도 기준선";
/// `ko.monitor.barCount`
pub const SET_BAR_COUNT: &str = "막대 개수";
/// `ko.monitor.graphMax`
pub const SET_GRAPH_MAX: &str = "그래프 최대 높이(ms)";
/// `ko.monitor.conditions`
pub const SET_CONDITIONS: &str = "성공 조건";
/// `ko.monitor.displayTitle`
pub const SET_DISPLAY: &str = "화면에 표시";

/// `ko.monitor.noTitle`
pub const NO_TITLE: &str = "(제목 없음)";
/// `ko.monitor.wholeScenario`
pub const WHOLE_SCENARIO: &str = "시나리오 전체";
/// `ko.monitor.environmentNone`
pub const ENV_NONE: &str = "환경 없음";
/// `ko.monitor.latencyTotal`
pub const LATENCY_TOTAL: &str = "시나리오 전체";
/// `ko.monitor.thresholdMs`
pub const THRESHOLD_MS: &str = "ms 이상";
/// `ko.monitor.condStepGone`
pub const COND_STEP_GONE: &str = "⚠ 스텝 없음";
/// `ko.monitor.condIgnoreCase`
pub const COND_IGNORE_CASE: &str = "대소문자 무시";
/// `ko.monitor.condTrim`
pub const COND_TRIM: &str = "앞뒤 공백 무시";
/// `ko.monitor.condTargetBodyRoot`
pub const COND_TARGET_BODY_ROOT: &str = "본문";
/// `ko.monitor.condTargetStatus`
pub const COND_TARGET_STATUS: &str = "상태코드";
/// `ko.monitor.condTargetBodyText`
pub const COND_TARGET_BODY_TEXT: &str = "본문 전체";

/// `ko.monitor.condTargetHeader`
pub fn cond_target_header(n: &str) -> String {
    format!("헤더 {n}")
}

/// `ko.monitor.displayRank`
pub const DISPLAY_RANK: [&str; 2] = ["① 큰 글자", "② 작은 줄"];

/// `ko.monitor.condOpLabel`
pub fn cond_op_label(op: handicap_controller::monitor::config::ConditionOp) -> &'static str {
    use handicap_controller::monitor::config::ConditionOp as O;
    match op {
        O::Eq => "=",
        O::Ne => "≠",
        O::Exists => "키 있음",
        O::NotEmpty => "값 있음",
        O::Contains => "글자 포함",
        O::Gt => ">",
        O::Lt => "<",
        O::Gte => "≥",
        O::Lte => "≤",
        O::OneOf => "∈",
    }
}
