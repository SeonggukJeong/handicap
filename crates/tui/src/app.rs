//! 앱 루프 — 메인 스레드의 동기 UI 루프(`event::poll`)가 tokio 런타임을 `block_on`으로 부린다.
//! 키·마우스 해석과 격자 이동은 순수 함수로 분리했다.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use ratatui::Terminal;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use tokio::runtime::{Handle, Runtime};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use handicap_controller::monitor::check::CheckResult;
use handicap_controller::monitor::config::{
    BoardConfig, Condition, ConditionSource, DisplayItem, LatencySource, PanelConfig,
};

use crate::api::Api;
use crate::edit;
use crate::filesave::{FileState, WriteError, WriteStage};
use crate::input::{InputMode, InputOutcome, LineInput};
use crate::inspect::{
    BodyInput, BodyState, ErrorsInput, ErrorsState, Reason, RecordLoad, RecordOrigin, RecordState,
    StepLine, clip_flags, error_results, errors_view, initial_step_cursor, load_of, move_cursor,
    neighbor_http, reason_of, record_view, step_lines, visible_results,
};
use crate::judge::{format_hms, grid_for};
use crate::logging::LogLoc;
use crate::names::Names;
use crate::panel_settings::{
    condition_summary, condition_target, display_target, edit_menu_lines, ensure_visible,
    group_note, settings_items_edit,
};
use crate::pick;
use crate::poll::{PollSnapshot, spawn_poller};
use crate::prefs::{self, BorderStyle, Loaded, Prefs};
use crate::session::{Session, Stage, StartError};
use crate::terminal::TerminalGuard;
use crate::text;
use crate::view::edit::{
    CondFormView, ListRow, ListView, VarRow, VarsView, cond_form_value_width, env_display,
    fit_keys, render_list_with_form, render_vars,
};
use crate::view::error::{render_error, render_usage};
use crate::view::inspect::{
    body_height, errors_list_height, render_body, render_errors, render_record, sub_layout,
};
use crate::view::model::build_panels;
use crate::view::monitor::{HeaderNotice, HeaderView};
use crate::view::monitor::{KeyBar, Layout, MonitorScreen, layout, panel_at, render_with_keys};
use crate::view::overlay::{render_help, render_quit_confirm};
use crate::view::settings::{
    EditMenuView, OverlayView, overlay_rows, render_edit_menu, settings_height,
};
use crate::view::values::{ValuesView, render_values};
use crate::wire::{BoardResponse, CheckRecord, EnvironmentResponse, ScenarioResponse};
use crate::yaml_var;
use handicap_controller::monitor::config::ConditionOp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    Starting,
    Monitor,
    Help,
    QuitConfirm(Box<Screen>),
    Error(StartError),
    Usage,
    /// 오류 목록(spec §5.3-1). 화면 상태는 `SubViews`에.
    Errors,
    /// 기록 자세히(§5.3-2)
    Record,
    /// 요청·응답 본문(§5.3-3)
    Body,
    /// 칸 설정 보기(§5.4) — 편집 모드에선 편집 메뉴(§6.1)
    Settings,
    /// 하위 목록(기준선·성공 조건·화면에 표시, §6.1 8·11·12)
    EditList,
    /// 환경 변수 화면(§6.3, 13)
    EnvVars,
    /// 시나리오 변수 화면(§6.4, 14)
    ScenarioVars,
    /// 값 목록(tui-2b §3.1) — 요청·응답의 응답 값을 골라 조건·표시 값으로. 상태는 `EditUi.values`.
    Values,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Move(Dir),
    Select(usize),
    NextBoard,
    PrevBoard,
    OpenHelp,
    Back,
    AskQuit,
    Quit,
    Retry,
    ToggleBorder,
    OpenErrors,
    CheckNow,
    OpenSettings,
    Activate,
    ToggleAll,
    ToggleReveal,
    /// 요청·응답 화면의 `a` — 값 목록 열기(tui-2b §3.3).
    AddValue,
    PrevStep,
    NextStep,
    Up,
    Down,
    PageUp,
    PageDown,
    Home,
    End,
}

/// 대문자(Caps Lock)와 한글 2벌식 자모(같은 물리 키)를 소문자 영문 키로 맞춘다.
fn normalize_char(c: char) -> char {
    match c {
        'ㅂ' => 'q',
        'ㅛ' => 'y',
        'ㅗ' => 'h',
        'ㅓ' => 'j',
        'ㅏ' => 'k',
        'ㅣ' => 'l',
        'ㄱ' => 'r',
        'ㅠ' => 'b',
        'ㄷ' => 'e',
        'ㅁ' => 'a',
        'ㅍ' => 'v',
        c => c.to_ascii_lowercase(),
    }
}

pub fn handle_key(screen: &Screen, k: KeyEvent, n_boards: usize) -> Action {
    let code = match k.code {
        KeyCode::Char(c) => KeyCode::Char(normalize_char(c)),
        other => other,
    };
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let ctrl_c = ctrl && code == KeyCode::Char('c');
    let quit_key = ctrl_c || code == KeyCode::Char('q');
    let k = KeyEvent::new(code, k.modifiers);
    // Ctrl이 눌린 문자 키(Ctrl+C·Ctrl+Q 밖)는 모니터·새 화면 넷에서 무동작 — Ctrl+B가 `b`로 읽히지 않게(§B46 (2)).
    let ctrl_letter = ctrl && matches!(code, KeyCode::Char(_)) && !quit_key;
    if ctrl_letter && (matches!(screen, Screen::Monitor) || is_sub(screen)) {
        return Action::None;
    }
    match screen {
        Screen::Starting => Action::None,
        Screen::Monitor => {
            if quit_key {
                return Action::AskQuit;
            }
            match k.code {
                KeyCode::Left | KeyCode::Char('h') => Action::Move(Dir::Left),
                KeyCode::Right | KeyCode::Char('l') => Action::Move(Dir::Right),
                KeyCode::Up | KeyCode::Char('k') => Action::Move(Dir::Up),
                KeyCode::Down | KeyCode::Char('j') => Action::Move(Dir::Down),
                KeyCode::Tab if n_boards > 1 => Action::NextBoard,
                KeyCode::BackTab if n_boards > 1 => Action::PrevBoard,
                KeyCode::Char('b') => Action::ToggleBorder,
                KeyCode::Char('?') => Action::OpenHelp,
                KeyCode::Char('e') => Action::OpenErrors,
                KeyCode::Char('r') => Action::CheckNow,
                KeyCode::Enter => Action::OpenSettings,
                _ => Action::None,
            }
        }
        // 편집 화면 넷(Settings·EditList·EnvVars·ScenarioVars)은 `edit` 상태가 있으면 `edit_key`로 간다 — 여기 오는 건
        // 닿지 않는 방어 경로(`OpenSettings`가 늘 `EditUi`를 만든다).
        Screen::Errors
        | Screen::Record
        | Screen::Body
        | Screen::Settings
        | Screen::EditList
        | Screen::EnvVars
        | Screen::ScenarioVars
        | Screen::Values => {
            if quit_key {
                return Action::AskQuit;
            }
            sub_screen_key(screen, k.code)
        }
        Screen::Help => {
            if quit_key {
                Action::AskQuit
            } else if matches!(k.code, KeyCode::Esc | KeyCode::Char('?')) {
                Action::Back
            } else {
                Action::None
            }
        }
        Screen::QuitConfirm(_) => {
            // `y`만 종료 — Ctrl+C 연타 같은 실수 한 키로 꺼지지 않게 나머지는 모두 취소.
            if !ctrl && matches!(k.code, KeyCode::Char('y')) {
                Action::Quit
            } else {
                Action::Back
            }
        }
        Screen::Error(_) => {
            if quit_key {
                Action::Quit
            } else if matches!(k.code, KeyCode::Char('r')) {
                Action::Retry
            } else {
                Action::None
            }
        }
        Screen::Usage => {
            if quit_key || matches!(k.code, KeyCode::Esc) {
                Action::Quit
            } else {
                Action::None
            }
        }
    }
}

/// 새 화면(오류 목록·자세히·본문·칸 설정 + 편집 하위 목록·환경 변수·시나리오 변수).
fn is_sub(screen: &Screen) -> bool {
    matches!(
        screen,
        Screen::Errors
            | Screen::Record
            | Screen::Body
            | Screen::Settings
            | Screen::EditList
            | Screen::EnvVars
            | Screen::ScenarioVars
            | Screen::Values
    )
}

/// 새 화면 넷의 키(종료 키는 호출 쪽이 먼저 본다).
fn sub_screen_key(screen: &Screen, code: KeyCode) -> Action {
    let common = match code {
        KeyCode::Up | KeyCode::Char('k') => Some(Action::Up),
        KeyCode::Down | KeyCode::Char('j') => Some(Action::Down),
        KeyCode::PageUp => Some(Action::PageUp),
        KeyCode::PageDown => Some(Action::PageDown),
        KeyCode::Home => Some(Action::Home),
        KeyCode::End => Some(Action::End),
        KeyCode::Esc => Some(Action::Back),
        _ => None,
    };
    if let Some(a) = common {
        return a;
    }
    match (screen, code) {
        (Screen::Errors, KeyCode::Char('a')) => Action::ToggleAll,
        (Screen::Errors | Screen::Record, KeyCode::Enter) => Action::Activate,
        (Screen::Body, KeyCode::Left | KeyCode::Char('h')) => Action::PrevStep,
        (Screen::Body, KeyCode::Right | KeyCode::Char('l')) => Action::NextStep,
        (Screen::Body, KeyCode::Char('v')) => Action::ToggleReveal,
        (Screen::Body, KeyCode::Char('a')) => Action::AddValue,
        _ => Action::None,
    }
}

/// 새 화면 넷의 키 줄 조각을 고르는 데 쓰는 화면 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCtx {
    pub quit_confirm: bool,
    pub show_all: bool,
    pub reveal: bool,
    /// 본문 화면의 스텝에 요청 본문이 있는가
    pub has_req_body: bool,
    /// 자세히 화면을 칸 설정에서 열었는가(`Esc`가 칸 설정으로 — 아니면 목록으로)
    pub record_from_settings: bool,
}

/// 새 화면 네 개의 키 줄 조각(앞 조각부터 통째로 빠진다 — 덜 중요한 것을 앞에). 목업처럼
/// `q 종료`는 쓰지 않는다(`q`는 동작하고 도움말에 있다). 새 화면이 아니면 빈 목록.
pub fn sub_keys(screen: &Screen, c: KeyCtx) -> Vec<&'static str> {
    if c.quit_confirm && is_sub(screen) {
        return vec![text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL];
    }
    match screen {
        Screen::Errors => vec![
            text::KEYS_PICK,
            if c.show_all {
                text::KEYS_ALL_OFF
            } else {
                text::KEYS_ALL_ON
            },
            text::KEYS_DETAIL,
            text::KEYS_TO_MONITOR,
        ],
        Screen::Record => vec![
            text::KEYS_PICK_STEP,
            text::KEYS_BODY,
            if c.record_from_settings {
                text::KEYS_TO_SETTINGS
            } else {
                text::KEYS_TO_LIST
            },
        ],
        Screen::Body => {
            let mut keys = vec![text::KEYS_SCROLL, text::KEYS_STEP_NAV];
            if c.has_req_body {
                keys.push(if c.reveal {
                    text::KEYS_HIDE
                } else {
                    text::KEYS_REVEAL
                });
            }
            // `a`는 `Esc` 다음으로 오래 남는다(앞 조각부터 빠진다).
            keys.push(text::KEYS_ADD_VALUE);
            keys.push(text::KEYS_TO_DETAIL);
            keys
        }
        // 편집 메뉴(overlay 없음). overlay·하위 목록·변수 화면의 키 줄은 `edit_keys`. `edit` 상태 없는 Settings용 —
        // 닿지 않는 방어 경로(`OpenSettings`가 늘 `EditUi`를 만든다).
        Screen::Settings => vec![
            text::KEYS_PICK,
            text::KEYS_NUMBER,
            text::KEYS_EDIT,
            text::KEYS_TO_MONITOR,
        ],
        _ => vec![],
    }
}

// ---- 편집 모드 상태·키 판정(tui-2a-1, spec §6.7) — 순수. App 연결은 `App::edit_key_event`·`run_edit` ----

/// 지금 점검 대기의 단계 — `Sent` = 요청 결과를 기다리는 중, `After(last)` = 요청이 받아들여져 `last`(요청 시점 마지막 결과 시각)
/// **보다 새** 결과를 기다리는 중.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckWait {
    Sent,
    After(Option<i64>),
}

/// 편집 화면 위에 뜨는 입력줄·목록 창·조건 수정·확인·저장 중·안내.
/// `Debug`는 손으로 — 종류 이름만(입력값·서버 문구·환경 키 이름이 `{:?}`로 새지 않게).
#[derive(Clone, PartialEq, Eq)]
pub enum Overlay {
    Input {
        target: InputTarget,
        input: LineInput,
        error: Option<String>,
        share: Option<String>,
    },
    Pick {
        pick: edit::Pick,
        options: Vec<(Option<String>, String)>,
        cursor: usize,
    },
    CondForm {
        target: CondTarget,
        ops: Vec<ConditionOp>,
        op: usize,
        value: LineInput,
        ignore_case: bool,
        trim: bool,
        focus: CondFocus,
        error: Option<String>,
    },
    Confirm {
        text: String,
        then: Pending,
        y_only: bool,
    },
    /// 저장 중. `restore` = 서버가 거절하면 되살릴 overlay(Input·CondForm은 오류 줄을 채워서). Pick·Confirm(삭제·단계·환경 빠짐)·
    /// 자리 바꾸기에서 온 저장은 `restore = None` — 거절이면 `Notice(서버 문구)`로 보인다.
    Saving { restore: Option<Box<Overlay>> },
    /// 칸 설정의 `r`(지금 점검) 결과 대기. `seq` = 대기 번호(`App.check_seq`), `wait` = 요청 결과를 받았는가.
    Checking { seq: u64, wait: CheckWait },
    /// ReadOnly 안내·서버 거절 — 다음 키 하나로 닫힘(그 키는 메뉴로 넘어가지 않는다).
    Notice(String),
    /// 값 목록에서 고른 뒤의 창(tui-2b §2.3) — 0 = `조건으로 추가`, 1 = `화면에 추가`. 고른 줄은 `EditUi.values`의
    /// 커서가 가리킨다(창이 값을 품지 않는다). 막힌 줄은 이유를 들고 `Enter`를 받지 않는다.
    AddChoice {
        cursor: usize,
        cond_block: Option<&'static str>,
        display_block: Option<&'static str>,
    },
}

/// 조건 칸이 고치는 것 — 2a의 기존 조건(목록 위치) 또는 값 목록에서 새로 더할 조건(tui-2b §2.4).
/// `New`는 응답 값을 품는다(`shown`·`path`) — `Debug`는 종류만.
#[derive(Clone, PartialEq, Eq)]
pub enum CondTarget {
    Existing(usize),
    New {
        step_id: String,
        source: ConditionSource,
        path: String,
        /// 받은 값 글자(원격 — 그릴 때 `sanitize`)
        shown: String,
        hint: Option<pick::Hint>,
    },
}

impl std::fmt::Debug for CondTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CondTarget::Existing(i) => write!(f, "Existing({i})"),
            CondTarget::New { .. } => f.write_str("New"),
        }
    }
}

impl std::fmt::Debug for Overlay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Overlay::{}", self.kind())
    }
}

impl Overlay {
    /// 로그·`Debug`용 이름 — 내용(입력·서버 문구)은 담지 않는다.
    fn kind(&self) -> &'static str {
        match self {
            Overlay::Input { .. } => "Input",
            Overlay::Pick { .. } => "Pick",
            Overlay::CondForm { .. } => "CondForm",
            Overlay::Confirm { .. } => "Confirm",
            Overlay::Saving { .. } => "Saving",
            Overlay::Checking { .. } => "Checking",
            Overlay::Notice(_) => "Notice",
            Overlay::AddChoice { .. } => "AddChoice",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CondFocus {
    Op,
    Value,
    IgnoreCase,
    Trim,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputTarget {
    Field(edit::Field),
    ThresholdNew,
    Threshold(usize),
    EnvVar(String),
    ScenarioVar(String),
}

/// 확인 뒤 할 일(저장 요청을 만들 재료).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pending {
    SetStep(String),
    SetEnv(Option<String>),
    Remove(edit::ListKind, usize),
}

#[derive(Clone)]
pub enum EnvLoad {
    Loading { id: String },
    Loaded(EnvironmentResponse),
    Failed(String),
}

#[derive(Clone)]
pub enum ScenLoad {
    Loading {
        id: String,
    },
    Loaded {
        id: String,
        yaml: String,
        version: i64,
        vars: Vec<yaml_var::StaticVar>,
    },
    Failed(String),
}

/// 편집 모드 화면 상태. `PartialEq` 없음(환경 응답을 품는다).
#[derive(Clone, Default)]
pub struct EditUi {
    pub board_id: String,
    pub panel_id: String,
    /// 메뉴 항목 0..14
    pub cursor: usize,
    /// 하위 목록·변수 화면 줄
    pub list_cursor: usize,
    /// `1` 뒤 1초(번호, 누른 시각)
    pub digit: Option<(u8, Instant)>,
    pub overlay: Option<Overlay>,
    /// 환경 값 보기(`EnvVars`를 나가면 false)
    pub reveal: bool,
    pub env: Option<EnvLoad>,
    pub scen: Option<ScenLoad>,
    /// 값 목록(tui-2b §4.2) — 줄·안내·이유·스텝·**자기 커서**(`list_cursor`가 아님). 응답 값을 품는다.
    pub values: Option<pick::ValuesState>,
}

/// 값이 로그로 새지 않게 손으로 쓴 `Debug` — `env`·`scen`은 있는지만, overlay는 종류만(입력줄·서버 문구 가림).
impl std::fmt::Debug for EditUi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EditUi")
            .field("board_id", &self.board_id)
            .field("panel_id", &self.panel_id)
            .field("cursor", &self.cursor)
            .field("list_cursor", &self.list_cursor)
            .field("digit", &self.digit.map(|(d, _)| d))
            .field("overlay", &self.overlay.as_ref().map(Overlay::kind))
            .field("reveal", &self.reveal)
            .field("env", &self.env.as_ref().map(|_| "<가림>"))
            .field("scen", &self.scen.as_ref().map(|_| "<가림>"))
            .field("values", &self.values.is_some())
            .finish()
    }
}

impl EditUi {
    /// `EnvVars`를 나갈 때: 값 보기를 끄고 받은 환경을 버린다.
    pub fn leave_env(&mut self) {
        self.reveal = false;
        self.env = None;
        self.list_cursor = 0;
    }

    /// `ScenarioVars`를 나갈 때: 받은 시나리오를 버린다.
    pub fn leave_scen(&mut self) {
        self.scen = None;
        self.list_cursor = 0;
    }

    /// 숫자 대기 표시 갱신. **호출 쪽은 편집 화면의 모든 키 뒤에 이걸 부른다**: `DigitJump`면 그 `pending`을 저장하고,
    /// 그 밖의 모든 액션이면 지운다(`1`, `↓`, `2`가 12로 가지 않게 — spec "`1` 뒤 1초 안에").
    pub fn track_digit(&mut self, a: &EditAction) {
        self.digit = match a {
            EditAction::DigitJump { pending, .. } => *pending,
            _ => None,
        };
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditAction {
    None,
    AskQuit,
    /// overlay 없음: 한 단계 뒤(`SubViews::back`).
    Back,
    /// 목록 창(`Pick`) 취소 — overlay만 닫는다.
    PickCancel,
    MoveCursor(isize),
    /// 절대 위치(0-기반): Home=0, End=`usize::MAX`(호출 쪽이 마지막 줄로 자른다)
    Jump(usize),
    /// 메뉴의 숫자 키 — `edit_key`가 `digit_jump`로 푼 이동 번호(1..=14)와 새 대기 표시. 대기 표시는 `EditUi::track_digit`이 저장.
    DigitJump {
        no: usize,
        pending: Option<(u8, Instant)>,
    },
    /// Enter
    Activate,
    Remove,
    Swap,
    Add,
    ToggleReveal,
    /// 입력줄(Input overlay 또는 CondForm의 값 칸)에 들어간 키의 결과 + 그 키를 적용한 **뒤의** 입력줄.
    /// `edit_key`는 원래 버퍼를 바꾸지 않는다(복제본에 적용). 호출 쪽(`apply_edit`)은 진짜 입력줄을 두 번째 값으로
    /// **교체**만 한다 — 키를 다시 적용하지 않는다(이중 적용·미적용 불가).
    Input(InputOutcome, LineInput),
    PickMove(isize),
    PickChoose,
    /// 조건 수정 칸의 폼 키(Tab·Shift+Tab·←→·Space·Enter·Esc) — 원시 키 그대로.
    CondKey(KeyEvent),
    ConfirmYes,
    ConfirmNo,
    CloseNotice,
    /// 메뉴의 `r` — 지금 점검 요청 + 대기 창(호출 쪽 `run_edit`이 `start_check`로 처리).
    CheckNow,
    /// 대기 창의 `Esc` — 창만 닫는다(점검 취소가 아니다).
    CheckCancel,
}

/// 대기 표시가 유효한 시간 — **1초 미만**만 대기 안(정확히 1.0초는 지난 것: `<`).
const DIGIT_WINDOW: Duration = Duration::from_secs(1);

fn digit_pending(prev: Option<(u8, Instant)>, now: Instant) -> bool {
    // 시계 역전은 0초(대기 안)로 본다.
    matches!(prev, Some((1, at)) if now.saturating_duration_since(at) < DIGIT_WINDOW)
}

/// 숫자는 **언제나 즉시** 이동한다: `1`–`9` → 그 번호(그리고 `1`이면 1초 대기 표시를 남김). 대기 중(1초 안)에
/// `0`–`4`가 오면 10–14로 **다시** 이동하고 대기를 지운다(`1`→`1`은 11 — 항목 11에 닿는 길이다, spec §6.7 표).
/// 대기 중 `5`–`9`는 그 번호로(대기는 지운다). 타이머가 필요 없다 — `1`만 누르고 기다리면 이미 1번에 가 있다.
/// 대기 없이 `0`이면 이동 없음 `(0, None)`(번호 0은 없다 — `edit_key`는 이 경우 `EditAction::None`).
pub fn digit_jump(
    prev: Option<(u8, Instant)>,
    d: u8,
    now: Instant,
) -> (usize, Option<(u8, Instant)>) {
    if digit_pending(prev, now) && d <= 4 {
        return (10 + d as usize, None);
    }
    match d {
        0 => (0, None),
        1 => (1, Some((1, now))),
        d => (d as usize, None),
    }
}

/// 입력 중인 overlay(Input·Pick·CondForm·Confirm·Notice)를 버린다. `Saving`은 남기되 그 안의 되살릴 입력줄
/// (`restore` — 환경 토큰 평문일 수 있다)은 버린다: 늦은 거절은 입력줄 대신 `Notice`(spec §6.6 "입력 중이던 값은 버린다").
/// 값도 놓는다: 환경(값 보기 포함)·시나리오 받은 것·숫자 대기 — 5분 복귀 뒤 `edit`가 저장 중이라 살아 있어도 비밀이 남지 않게.
pub fn idle_drop(ui: &mut EditUi) {
    match &mut ui.overlay {
        Some(Overlay::Saving { restore }) => *restore = None,
        _ => ui.overlay = None,
    }
    ui.leave_env();
    ui.leave_scen();
    ui.digit = None;
    ui.values = None;
}

/// 칸 설정 메뉴의 `r` — 대기 번호를 하나 올리고(`*seq` = `App.check_seq`: 프로세스 안에서 줄지 않는다) 대기 창을 띄운 뒤,
/// 조회 작업자에 보낼 요청을 돌려준다. 보드·칸은 `ui`의 것.
pub fn start_check(ui: &mut EditUi, seq: &mut u64) -> FetchReq {
    *seq += 1;
    ui.overlay = Some(Overlay::Checking {
        seq: *seq,
        wait: CheckWait::Sent,
    });
    FetchReq::CheckNow {
        board_id: ui.board_id.clone(),
        panel_id: ui.panel_id.clone(),
        wait: Some(*seq),
    }
}

/// 칸 설정에서 보낸 지금 점검의 응답(대기 번호 `seq`)을 반영한다. 창이 `Checking { seq, wait: Sent }`(같은 번호)일 때만 —
/// 아니면(`Esc`로 닫음·5분 복귀로 버려짐·다시 눌러 번호가 다름·이미 `After`·다른 창) 상태를 건드리지 않고 `false`.
pub fn check_reply(ui: &mut EditUi, seq: u64, result: CheckReply) -> bool {
    if !matches!(
        ui.overlay,
        Some(Overlay::Checking {
            seq: s,
            wait: CheckWait::Sent
        }) if s == seq
    ) {
        return false;
    }
    ui.overlay = Some(match result {
        Ok(last) => Overlay::Checking {
            seq,
            wait: CheckWait::After(last),
        },
        Err(Some(409)) => Overlay::Notice(text::CHECK_OFF.to_string()),
        Err(_) => Overlay::Notice(text::CHECK_NOW_FAILED.to_string()),
    });
    true
}

/// 대기 창이 `After(last)`일 때 그 칸 결과 목록(오래된 → 최신)의 가장 새 결과가 `last`보다 새것이면 그 결과
/// (`last`가 없으면 결과가 하나라도 있으면). 그 밖(창 없음·`Sent`·아직 새 결과 없음) → None.
pub fn check_ready(ui: &EditUi, results: &[CheckResult]) -> Option<CheckResult> {
    let Some(Overlay::Checking {
        wait: CheckWait::After(last),
        ..
    }) = &ui.overlay
    else {
        return None;
    };
    let newest = results.last()?;
    match last {
        Some(l) if newest.at_ms <= *l => None,
        _ => Some(newest.clone()),
    }
}

/// 대기 창이 자세히를 열어도 되는 화면 — **정확히 칸 설정 메뉴**일 때만(종료 확인창 등이 떠 있으면 미룬다).
pub fn check_open_allowed(screen: &Screen) -> bool {
    matches!(screen, Screen::Settings)
}

/// 화면 규칙용 정규화: `normalize_char` + 새로 `ㅇ`→`d`·`ㄴ`→`s`(편집 화면 경로에서만 — 기존 화면 불변).
fn normalize_edit_char(c: char) -> char {
    match c {
        'ㅇ' => 'd',
        'ㄴ' => 's',
        c => normalize_char(c),
    }
}

/// 편집 모드의 키 → 동작. 순서: overlay 있음 → overlay 규칙(입력줄은 **원시 키** — 정규화 없음, `q`·`j`·`?`·한글이
/// 글자, Ctrl+C만 종료 확인), 없음 → 화면 규칙(정규화 + `q`/Ctrl+C 종료 확인). `now`는 두 자리 번호 판정용.
pub fn edit_key(screen: &Screen, ui: &EditUi, k: KeyEvent, now: Instant) -> EditAction {
    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let norm = match k.code {
        KeyCode::Char(c) => KeyCode::Char(normalize_edit_char(c)),
        other => other,
    };
    let ctrl_c = ctrl && norm == KeyCode::Char('c');
    // 기존 `handle_key`와 같다: Ctrl+C·`q`(Ctrl+Q 포함)가 종료 확인.
    let quit_key = ctrl_c || norm == KeyCode::Char('q');
    if let Some(o) = &ui.overlay {
        return overlay_key(o, k, norm, ctrl, ctrl_c, quit_key);
    }
    if quit_key {
        return EditAction::AskQuit;
    }
    if ctrl {
        // 그 밖의 Ctrl+문자는 무동작(Ctrl+B가 `b`로 읽히지 않게).
        return EditAction::None;
    }
    let menu = matches!(screen, Screen::Settings);
    let sub = matches!(
        screen,
        Screen::EditList | Screen::EnvVars | Screen::ScenarioVars | Screen::Values
    );
    if !menu && !sub {
        return EditAction::None;
    }
    match norm {
        KeyCode::Up | KeyCode::Char('k') => EditAction::MoveCursor(-1),
        KeyCode::Down | KeyCode::Char('j') => EditAction::MoveCursor(1),
        KeyCode::PageUp => EditAction::MoveCursor(-10),
        KeyCode::PageDown => EditAction::MoveCursor(10),
        KeyCode::Home => EditAction::Jump(0),
        KeyCode::End => EditAction::Jump(usize::MAX),
        KeyCode::Enter => EditAction::Activate,
        KeyCode::Esc => EditAction::Back,
        KeyCode::Char(c @ '0'..='9') if menu && !k.modifiers.contains(KeyModifiers::ALT) => {
            let (no, pending) = digit_jump(ui.digit, c as u8 - b'0', now);
            if no == 0 {
                EditAction::None
            } else {
                EditAction::DigitJump { no, pending }
            }
        }
        KeyCode::Char('r') if menu => EditAction::CheckNow,
        KeyCode::Char('a') if matches!(screen, Screen::EditList) => EditAction::Add,
        KeyCode::Char('d') if matches!(screen, Screen::EditList) => EditAction::Remove,
        KeyCode::Char('s') if matches!(screen, Screen::EditList) => EditAction::Swap,
        KeyCode::Char('v') if matches!(screen, Screen::EnvVars) => EditAction::ToggleReveal,
        _ => EditAction::None,
    }
}

/// 입력줄에 **원시 키**를 넣어 본 결과(복제본 — `edit_key`는 상태를 바꾸지 않는다) + 적용 뒤의 입력줄.
fn probe(li: &LineInput, k: KeyEvent) -> EditAction {
    let mut next = li.clone();
    let out = next.key(k);
    EditAction::Input(out, next)
}

fn overlay_key(
    o: &Overlay,
    k: KeyEvent,
    norm: KeyCode,
    ctrl: bool,
    ctrl_c: bool,
    quit_key: bool,
) -> EditAction {
    match o {
        Overlay::Input { input, .. } => probe(input, k),
        Overlay::CondForm { value, focus, .. } => {
            if *focus == CondFocus::Value {
                // 값 칸 = 입력줄 규칙. 폼 이동·저장·취소 키만 폼으로.
                return if matches!(
                    k.code,
                    KeyCode::Tab | KeyCode::BackTab | KeyCode::Enter | KeyCode::Esc
                ) {
                    EditAction::CondKey(k)
                } else {
                    probe(value, k)
                };
            }
            if ctrl_c {
                return EditAction::AskQuit;
            }
            if !ctrl
                && matches!(
                    k.code,
                    KeyCode::Tab
                        | KeyCode::BackTab
                        | KeyCode::Left
                        | KeyCode::Right
                        | KeyCode::Char(' ')
                        | KeyCode::Enter
                        | KeyCode::Esc
                )
            {
                EditAction::CondKey(k)
            } else {
                EditAction::None
            }
        }
        // 값 목록의 선택 창도 목록 창과 같은 키 — `edit_apply`가 창 종류로 갈라 처리한다.
        Overlay::Pick { .. } | Overlay::AddChoice { .. } => {
            if quit_key {
                return EditAction::AskQuit;
            }
            if ctrl {
                return EditAction::None;
            }
            match norm {
                KeyCode::Up | KeyCode::Char('k') => EditAction::PickMove(-1),
                KeyCode::Down | KeyCode::Char('j') => EditAction::PickMove(1),
                KeyCode::Enter => EditAction::PickChoose,
                KeyCode::Esc => EditAction::PickCancel,
                _ => EditAction::None,
            }
        }
        Overlay::Confirm { y_only, .. } => {
            // spec §6.7: Enter(또는 삭제 확인은 y) 계속 · 그 밖 취소.
            let yes = !ctrl
                && if *y_only {
                    norm == KeyCode::Char('y')
                } else {
                    k.code == KeyCode::Enter
                };
            if yes {
                EditAction::ConfirmYes
            } else {
                EditAction::ConfirmNo
            }
        }
        Overlay::Notice(_) => EditAction::CloseNotice,
        // 지금 점검 대기: Esc는 창만 닫는다(점검은 서버에서 그대로 돈다). 종료 확인만 더 열린다.
        Overlay::Checking { .. } => {
            if quit_key {
                EditAction::AskQuit
            } else if !ctrl && norm == KeyCode::Esc {
                EditAction::CheckCancel
            } else {
                EditAction::None
            }
        }
        // 저장 중: 다른 편집 키는 받지 않는다(Esc도 저장을 멈추지 않는다). 종료 확인만 열린다.
        Overlay::Saving { .. } => {
            if quit_key {
                EditAction::AskQuit
            } else {
                EditAction::None
            }
        }
    }
}

/// 입력 없이 이만큼 지나면 모니터 화면으로.
pub const IDLE_RETURN: Duration = Duration::from_secs(300);

/// 새 화면 넷, 또는 그 넷을 감싼 종료 확인창일 때만 대상 — 입력 없이 `IDLE_RETURN`이 지났으면 true.
/// 도움말·모니터·모니터 위 종료 확인창·오류/사용법/시작 화면은 항상 false. 시계 역전은 0초로 본다.
pub fn idle_expired(screen: &Screen, last_input: Instant, now: Instant) -> bool {
    let target = match screen {
        Screen::QuitConfirm(inner) => is_sub(inner),
        s => is_sub(s),
    };
    target && now.saturating_duration_since(last_input) >= IDLE_RETURN
}

/// 5분 자동 복귀를 미루는 입력 — 키와 마우스 **조작**(누름·뗌·끌기·휠). 마우스 캡처가 움직임
/// 보고까지 켜므로(`EnableMouseCapture`) 마우스가 화면 위를 스치기만 해도 복귀가 미뤄지지 않게
/// 단순 이동은 뺀다. 크기 바뀜·포커스는 입력이 아니다. 붙여넣기는 입력이다.
pub fn is_user_input(ev: &Event) -> bool {
    match ev {
        Event::Key(_) | Event::Paste(_) => true,
        Event::Mouse(m) => !matches!(m.kind, MouseEventKind::Moved),
        _ => false,
    }
}

/// 기록 조회 요청(`spawn_fetch_worker`가 차례로 처리).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchReq {
    /// 목록 사유 칸용(응답에서 reason·detail만 남긴다)
    Reason {
        board_id: String,
        panel_id: String,
        at_ms: i64,
    },
    /// 자세히 화면용
    Record {
        board_id: String,
        panel_id: String,
        at_ms: i64,
    },
    /// 지금 점검 깨우기(`wait`은 호출 쪽이 결과와 짝 지을 표지)
    CheckNow {
        board_id: String,
        panel_id: String,
        wait: Option<u64>,
    },
}

/// 지금 점검 응답 — 성공 = 호출 시점 마지막 결과 시각, 실패 = HTTP 상태만(서버 문구는 싣지 않는다).
pub type CheckReply = Result<Option<i64>, Option<u16>>;

/// 기록 조회 결과.
#[derive(Debug)]
pub enum Fetched {
    Reason {
        board_id: String,
        panel_id: String,
        at_ms: i64,
        reason: Reason,
    },
    Record {
        board_id: String,
        panel_id: String,
        at_ms: i64,
        load: RecordLoad,
    },
    CheckNow {
        board_id: String,
        panel_id: String,
        wait: Option<u64>,
        result: CheckReply,
    },
}

/// 기록 조회 작업자 — 요청을 **하나씩 차례로** 처리한다(동시에 기록 둘을 메모리에 들지 않는다 —
/// 한 기록이 최대 1 MiB 본문 × 스텝 수). `Reason` 요청은 응답에서 reason·detail만 남기고 기록을 버린다.
/// 돌려받은 Sender를 버리면 작업자는 **큐에 남은 요청까지 다 처리한 뒤** 끝난다(tokio mpsc 의미) —
/// 세션을 내릴 때는 그래서 돌려받은 핸들을 abort·await한다(`App::stop_session`). 결과 수신자가 사라져도 끝난다.
/// `CheckNow` 요청은 기록을 싣지 않는다 — 지금 점검을 요청하고 HTTP 상태(성공이면 `last_at_ms`)만 돌려준다.
/// 로그를 남기지 않는다(URL·본문·사유가 로그로 새지 않게).
pub fn spawn_fetch_worker(
    handle: &Handle,
    api: Api,
    out: mpsc::Sender<Fetched>,
) -> (UnboundedSender<FetchReq>, JoinHandle<()>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<FetchReq>();
    let worker = handle.spawn(async move {
        while let Some(req) = rx.recv().await {
            let msg = match req {
                FetchReq::Reason {
                    board_id,
                    panel_id,
                    at_ms,
                } => {
                    let reason = reason_of(api.record(&board_id, &panel_id, at_ms).await);
                    Fetched::Reason {
                        board_id,
                        panel_id,
                        at_ms,
                        reason,
                    }
                }
                FetchReq::Record {
                    board_id,
                    panel_id,
                    at_ms,
                } => {
                    let load = load_of(api.record(&board_id, &panel_id, at_ms).await);
                    Fetched::Record {
                        board_id,
                        panel_id,
                        at_ms,
                        load,
                    }
                }
                FetchReq::CheckNow {
                    board_id,
                    panel_id,
                    wait,
                } => {
                    let result = api
                        .check_now(&board_id, &panel_id)
                        .await
                        .map(|r| r.last_at_ms)
                        .map_err(|e| e.status);
                    Fetched::CheckNow {
                        board_id,
                        panel_id,
                        wait,
                        result,
                    }
                }
            };
            if out.send(msg).is_err() {
                return;
            }
        }
    });
    (tx, worker)
}

/// 새 화면 상태 묶음 + 화면 전환(순수). App은 이 메서드만 부른다.
#[derive(Debug, Default)]
pub struct SubViews {
    pub errors: Option<ErrorsState>,
    pub record: Option<RecordState>,
    pub body: Option<BodyState>,
    pub settings_scroll: usize,
    /// 편집 모드 상태(`Action::OpenSettings`가 연다). `clear()`는 이것도 비우므로, 진행 중 저장(`Overlay::Saving`)이
    /// 있을 때의 5분 복귀는 호출 쪽이 `idle_drop` 뒤 `edit`를 남겨야 한다.
    pub edit: Option<EditUi>,
}

impl SubViews {
    /// 전부 비운다(재시도·보드 전환·5분 자동 복귀).
    pub fn clear(&mut self) {
        *self = SubViews::default();
    }

    /// 오류 보기를 연다. `rows_at` = 지금 목록(최신 순 at_ms) — 커서를 첫 줄의 at_ms에 고정한다.
    pub fn open_errors(&mut self, board_id: &str, panel_id: &str, rows_at: &[i64]) -> Screen {
        let mut st = ErrorsState {
            board_id: board_id.to_string(),
            panel_id: panel_id.to_string(),
            ..ErrorsState::default()
        };
        st.pin_cursor(rows_at);
        self.errors = Some(st);
        self.record = None;
        self.body = None;
        Screen::Errors
    }

    pub fn open_settings(&mut self) -> Screen {
        self.settings_scroll = 0;
        Screen::Settings
    }

    /// 칸 설정 보기 스크롤: `Up`/`Down` ±1, `PageUp`/`PageDown` ±`height`, `Home`/`End` 처음/끝,
    /// 그 밖(`None` 등)은 가두기만. 상한 = `n_lines − height`(끝까지 내려도 빈 화면이 되지 않게 —
    /// 화면 크기가 바뀌면 다음 호출이 다시 가둔다).
    pub fn scroll_settings(&mut self, a: Action, n_lines: usize, height: usize) {
        let max = n_lines.saturating_sub(height) as isize;
        let page = height.max(1) as isize;
        let cur = (self.settings_scroll as isize).min(max);
        let next = match a {
            Action::Up => cur.saturating_sub(1),
            Action::Down => cur.saturating_add(1),
            Action::PageUp => cur.saturating_sub(page),
            Action::PageDown => cur.saturating_add(page),
            Action::Home => 0,
            Action::End => max,
            _ => cur,
        };
        self.settings_scroll = next.clamp(0, max) as usize;
    }

    /// 목록 → 자세히. errors가 없으면 None.
    pub fn open_record(&mut self, clicked: CheckResult) -> Option<(Screen, FetchReq)> {
        let e = self.errors.as_ref()?;
        let (board_id, panel_id) = (e.board_id.clone(), e.panel_id.clone());
        Some(self.set_record(board_id, panel_id, clicked, RecordOrigin::Errors))
    }

    /// 칸 설정(지금 점검 대기 창) → 자세히. `edit`의 보드·칸으로 연다 — `errors`는 건드리지 않고, 편집 상태·메뉴 커서는
    /// 두며 대기 창만 닫는다. `edit`가 없으면 None.
    pub fn open_record_from_settings(
        &mut self,
        clicked: CheckResult,
    ) -> Option<(Screen, FetchReq)> {
        let e = self.edit.as_mut()?;
        e.overlay = None;
        let (board_id, panel_id) = (e.board_id.clone(), e.panel_id.clone());
        Some(self.set_record(board_id, panel_id, clicked, RecordOrigin::Settings))
    }

    /// 자세히 상태를 새로 만들고(본문은 비운다) 여는 요청을 돌려준다 — 두 여는 길이 함께 쓴다.
    fn set_record(
        &mut self,
        board_id: String,
        panel_id: String,
        clicked: CheckResult,
        origin: RecordOrigin,
    ) -> (Screen, FetchReq) {
        let req = FetchReq::Record {
            board_id: board_id.clone(),
            panel_id: panel_id.clone(),
            at_ms: clicked.at_ms,
        };
        self.record = Some(RecordState {
            board_id,
            panel_id,
            at_ms: clicked.at_ms,
            clicked,
            load: RecordLoad::Loading,
            cursor: 0,
            origin,
        });
        self.body = None;
        (Screen::Record, req)
    }

    /// 자세히 → 본문. `lines[cursor]`가 Http가 아니면 None. 본문은 언제나 새로(가림·스크롤·캐시 초기화).
    pub fn open_body(&mut self, lines: &[StepLine]) -> Option<Screen> {
        let cursor = self.record.as_ref()?.cursor;
        if !matches!(lines.get(cursor), Some(StepLine::Http { .. })) {
            return None;
        }
        self.body = Some(BodyState::new(cursor));
        Some(Screen::Body)
    }

    /// 값 목록을 열 수 있는 자리인가(tui-2b §2.2): 화면이 정확히 요청·응답 · 기록을 받았음 · 보던 줄이 HTTP 스텝 →
    /// 그 스텝의 `trace` 인덱스. 아니면 None.
    pub fn value_target(&self, screen: &Screen, lines: &[StepLine]) -> Option<usize> {
        if !matches!(screen, Screen::Body) {
            return None;
        }
        let record = self.record.as_ref()?;
        if !matches!(record.load, RecordLoad::Loaded(_)) {
            return None;
        }
        match lines.get(self.body.as_ref()?.line_idx) {
            Some(StepLine::Http { trace_idx, .. }) => Some(*trace_idx),
            _ => None,
        }
    }

    /// 요청·응답 → 값 목록(tui-2b §4.2 "`EditUi`가 누구 것인가"). `edit`가 없거나 기록의 보드·칸 것이 아니면 그 기록의
    /// 보드·칸으로 새로 만든다(남아 있던 다른 칸의 것은 버린다 — 5분 복귀 뒤 저장이 끝나 남은 `EditUi`로 다른 칸의 값을
    /// 저장하지 않게). 진행 중 저장은 `OpenSettings`와 같은 규칙(`overlay_for_ticket`). 기록이 없으면 None.
    pub fn enter_values(
        &mut self,
        state: pick::ValuesState,
        ticket: Option<&SaveTicket>,
    ) -> Option<Screen> {
        let r = self.record.as_ref()?;
        let same = self
            .edit
            .as_ref()
            .is_some_and(|e| e.board_id == r.board_id && e.panel_id == r.panel_id);
        if !same {
            self.edit = Some(EditUi {
                board_id: r.board_id.clone(),
                panel_id: r.panel_id.clone(),
                overlay: overlay_for_ticket(ticket, &r.board_id, &r.panel_id),
                ..EditUi::default()
            });
        }
        if let Some(e) = &mut self.edit {
            e.values = Some(state);
        }
        Some(Screen::Values)
    }

    /// 본문에서 옆 HTTP 스텝으로(사용자 확정 6). 옮겼으면 true — `BodyState`를 새로 만든다
    /// (캐시 키에 스텝이 없어 그대로 두면 이전 스텝의 줄이 남는다).
    pub fn step_body(&mut self, lines: &[StepLine], dir: isize) -> bool {
        let (Some(body), Some(record)) = (self.body.as_mut(), self.record.as_mut()) else {
            return false;
        };
        match neighbor_http(lines, body.line_idx, dir) {
            Some(n) => {
                *body = BodyState::new(n);
                record.cursor = n;
                true
            }
            None => false,
        }
    }

    /// `Esc` 한 단계 뒤. 그 외 화면은 None(상태 불변).
    pub fn back(&mut self, screen: &Screen) -> Option<Screen> {
        match screen {
            // 값 목록 → 요청·응답(스크롤·가림 그대로). 오류 보기에서 연 기록이면 `EditUi`째 버리고(그 경로엔 원래
            // 없다), 칸 설정에서 열었으면 값만 버리고 메뉴 커서는 둔다(tui-2b §4.2).
            Screen::Values => {
                // 저장 중엔 무시 — 진행 중 저장의 `EditUi`를 버리지 않는다(키 길이 어긋나도).
                if self
                    .edit
                    .as_ref()
                    .is_some_and(|e| matches!(e.overlay, Some(Overlay::Saving { .. })))
                {
                    return None;
                }
                let from_errors = self
                    .record
                    .as_ref()
                    .is_some_and(|r| r.origin == RecordOrigin::Errors);
                if from_errors {
                    self.edit = None;
                } else if let Some(e) = &mut self.edit {
                    e.values = None;
                }
                Some(Screen::Body)
            }
            Screen::Body => {
                self.body = None;
                Some(Screen::Record)
            }
            Screen::Record => {
                // 온 곳으로: 칸 설정에서 열었으면 `errors`가 없으니 목록이 아니라 칸 설정(편집 상태 그대로).
                let from_settings = self
                    .record
                    .as_ref()
                    .is_some_and(|r| r.origin == RecordOrigin::Settings);
                self.record = None;
                self.body = None;
                Some(if from_settings {
                    Screen::Settings
                } else {
                    Screen::Errors
                })
            }
            Screen::Errors => {
                self.clear_inspect();
                Some(Screen::Monitor)
            }
            // 메뉴 → 모니터: 커서·대기·값이 남지 않게 비운다(저장 중엔 Esc가 무시되므로 `Saving`이 버려지지 않는다).
            Screen::Settings => {
                self.edit = None;
                Some(Screen::Monitor)
            }
            Screen::Help => Some(Screen::Monitor),
            Screen::EditList => {
                if let Some(e) = &mut self.edit {
                    e.list_cursor = 0;
                }
                Some(Screen::Settings)
            }
            Screen::EnvVars => {
                if let Some(e) = &mut self.edit {
                    e.leave_env();
                }
                Some(Screen::Settings)
            }
            Screen::ScenarioVars => {
                if let Some(e) = &mut self.edit {
                    e.leave_scen();
                }
                Some(Screen::Settings)
            }
            _ => None,
        }
    }

    fn clear_inspect(&mut self) {
        self.errors = None;
        self.record = None;
        self.body = None;
    }

    /// 현재 보고 있는 보드·칸·회차의 것만 받아들인다. 받아들였으면 true.
    /// 묶음 칸들은 같은 at_ms를 나눠 쓰므로 Record는 보드·칸·회차 셋 다 맞춰 본다.
    pub fn accept(&mut self, msg: Fetched) -> bool {
        match msg {
            Fetched::Reason {
                board_id,
                panel_id,
                at_ms,
                reason,
            } => match self.errors.as_mut() {
                Some(e) if e.board_id == board_id && e.panel_id == panel_id => {
                    e.cache.put(at_ms, reason);
                    true
                }
                _ => false,
            },
            Fetched::Record {
                board_id,
                panel_id,
                at_ms,
                load,
            } => match self.record.as_mut() {
                Some(r) if r.board_id == board_id && r.panel_id == panel_id && r.at_ms == at_ms => {
                    r.load = load;
                    true
                }
                _ => false,
            },
            // 지금 점검 결과는 `App::pump`가 가로챈다(모니터발 = 머리 줄 알림, 칸 설정발 = 대기 창) — 여기까지 오면 받아들이지 않는다.
            Fetched::CheckNow { .. } => false,
        }
    }
}

// ---- 편집 작업자·저장 연결(tui-2a-1, spec §6.2) ----

/// 편집 작업자 요청. `Debug`는 손으로 — 종류·id·길이만(환경 값·YAML·이름이 `{:?}`로 새지 않게).
pub enum EditReq {
    LoadEnv {
        id: String,
    },
    LoadScenario {
        id: String,
    },
    SaveBoard {
        seq: u64,
        board_id: String,
        panel_id: String,
        /// 서버 문구 `칸 {n}: ` 접두를 뗄 번호(1부터)
        panel_no: usize,
        name: String,
        config: BoardConfig,
    },
    SaveEnv {
        seq: u64,
        id: String,
        name: String,
        vars: BTreeMap<String, String>,
    },
    SaveScenario {
        seq: u64,
        id: String,
        yaml: String,
        version: i64,
    },
}

impl std::fmt::Debug for EditReq {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditReq::LoadEnv { id } => f.debug_struct("LoadEnv").field("id", id).finish(),
            EditReq::LoadScenario { id } => f.debug_struct("LoadScenario").field("id", id).finish(),
            EditReq::SaveBoard {
                seq,
                board_id,
                panel_id,
                panel_no,
                ..
            } => f
                .debug_struct("SaveBoard")
                .field("seq", seq)
                .field("board_id", board_id)
                .field("panel_id", panel_id)
                .field("panel_no", panel_no)
                .finish_non_exhaustive(),
            EditReq::SaveEnv { seq, id, vars, .. } => f
                .debug_struct("SaveEnv")
                .field("seq", seq)
                .field("id", id)
                .field("vars", &format_args!("<{} keys>", vars.len()))
                .finish_non_exhaustive(),
            EditReq::SaveScenario {
                seq,
                id,
                yaml,
                version,
            } => f
                .debug_struct("SaveScenario")
                .field("seq", seq)
                .field("id", id)
                .field("yaml", &format_args!("<{} bytes>", yaml.len()))
                .field("version", version)
                .finish(),
        }
    }
}

/// 서버 반영 뒤 단계 실패: 내보내기 실패(`Export`, 서버 문구) 또는 파일 쓰기 실패.
#[derive(Clone, PartialEq, Eq)]
pub enum FileErr {
    Export(String),
    Write(WriteError),
}

impl std::fmt::Debug for FileErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileErr::Export(_) => f.write_str("Export(<가림>)"),
            FileErr::Write(w) => write!(f, "Write({w:?})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedWhat {
    Board { board_id: String },
    Env { id: String },
    Scenario { id: String },
}

/// 서버가 돌려준 저장 결과. `Debug`는 id만(환경·시나리오 거울은 이미 손 Debug).
#[derive(Clone)]
pub enum SavedValue {
    Board(BoardResponse),
    Env(EnvironmentResponse),
    Scenario(ScenarioResponse),
}

impl std::fmt::Debug for SavedValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SavedValue::Board(b) => write!(f, "Board({})", b.id),
            SavedValue::Env(e) => write!(f, "Env({e:?})"),
            SavedValue::Scenario(s) => write!(f, "Scenario({s:?})"),
        }
    }
}

pub enum EditDone {
    Env {
        id: String,
        result: Result<EnvironmentResponse, String>,
    },
    Scenario {
        id: String,
        result: Result<ScenarioResponse, String>,
    },
    /// server: 서버 반영 결과(오류는 접두 뗀 문구). file: 서버 반영이 됐을 때만 Some — 파일 쓰기 결과.
    Saved {
        seq: u64,
        req: SavedWhat,
        server: Result<SavedValue, String>,
        file: Option<Result<(), FileErr>>,
    },
}

/// 서버 문구는 `<가림>`(사유에 값이 실릴 수 있다).
fn hide_err<T: std::fmt::Debug>(r: &Result<T, String>) -> String {
    match r {
        Ok(v) => format!("Ok({v:?})"),
        Err(_) => "Err(<가림>)".to_string(),
    }
}

impl std::fmt::Debug for EditDone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EditDone::Env { id, result } => f
                .debug_struct("Env")
                .field("id", id)
                .field("result", &format_args!("{}", hide_err(result)))
                .finish(),
            EditDone::Scenario { id, result } => f
                .debug_struct("Scenario")
                .field("id", id)
                .field("result", &format_args!("{}", hide_err(result)))
                .finish(),
            EditDone::Saved {
                seq,
                req,
                server,
                file,
            } => f
                .debug_struct("Saved")
                .field("seq", seq)
                .field("req", req)
                .field("server", &format_args!("{}", hide_err(server)))
                .field("file", file)
                .finish(),
        }
    }
}

/// 편집 상태를 새로 만들 때의 창: 진행 중 저장이 그 칸이면 `저장 중…`(결과가 오면 닫힌다), 다른 칸이면 안내 한 번,
/// 없으면 창 없음. `OpenSettings`·`SubViews::enter_values`가 함께 쓴다.
fn overlay_for_ticket(
    ticket: Option<&SaveTicket>,
    board_id: &str,
    panel_id: &str,
) -> Option<Overlay> {
    ticket.map(|t| {
        if t.board_id == board_id && t.panel_id == panel_id {
            Overlay::Saving { restore: None }
        } else {
            Overlay::Notice(text::SAVING.to_string())
        }
    })
}

/// 편집 화면(메뉴·하위 목록·변수 화면·값 목록)인가 — 편집 상태가 있으면 키는 `edit_key`가 먼저 받는다.
/// 값 목록이 빠지면 그 화면의 `Esc`가 `Action::Back`으로 흘러 저장 중 `Esc` 무시를 건너뛴다.
pub fn is_edit_screen(screen: &Screen) -> bool {
    matches!(
        screen,
        Screen::Settings
            | Screen::EditList
            | Screen::EnvVars
            | Screen::ScenarioVars
            | Screen::Values
    )
}

/// 진행 중인 저장 하나(App이 든다 — 보드 전환·5분 복귀 뒤에도 남는다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveTicket {
    pub seq: u64,
    pub board_id: String,
    pub panel_id: String,
}

/// 작업자가 쓰는 파일 상태와 시작 바이트(`write_bundle`이 처음 성공하면 시작 바이트는 비운다).
type FileSlot = Arc<Mutex<(FileState, Vec<u8>)>>;

fn log_api_fail(stage: &'static str, e: &crate::api::ApiError) {
    // 문구·URL은 남기지 않는다 — 단계와 HTTP 상태만.
    tracing::warn!(stage, http_status = ?e.status, "edit request failed");
}

/// 서버 반영 뒤: export(세션 보드 전부, 가져온 순서) → 파일 쓰기(블로킹 풀에서).
async fn persist(api: &Api, board_ids: &[String], slot: &FileSlot) -> Result<(), FileErr> {
    let bytes = api.export(board_ids).await.map_err(|e| {
        log_api_fail("export", &e);
        FileErr::Export(e.message)
    })?;
    let slot = Arc::clone(slot);
    let joined = tokio::task::spawn_blocking(move || {
        let mut g = slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (st, start) = &mut *g;
        let r = crate::filesave::write_bundle(st, start, &bytes);
        // `.orig.bak` 판단은 첫 **성공**까지 다시 일어난다 — 시작 바이트는 성공한 뒤에만 놓는다.
        if st.first_done {
            *start = Vec::new();
        }
        r
    })
    .await;
    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(we)) => {
            tracing::warn!(stage = ?we.stage, kind = ?we.kind, "board file write failed");
            Err(FileErr::Write(we))
        }
        Err(_) => {
            tracing::error!("board file write task failed");
            Err(FileErr::Write(WriteError {
                stage: WriteStage::Temp,
                kind: None,
            }))
        }
    }
}

/// 편집 작업자 — 요청을 하나씩. 저장은 서버 PUT → (성공 시) export(세션 보드 전부, 가져온 순서) → `filesave::write_bundle`
/// 까지 한 번에(다음 요청은 앞 요청의 파일 쓰기까지 끝난 뒤). `FileState`·시작 바이트를 소유. 로그엔 단계·상태·ErrorKind만.
/// 세션을 내릴 때는 돌려받은 핸들을 abort·await한다(통로를 닫기만 하면 큐를 다 처리한다).
pub fn spawn_edit_worker(
    handle: &Handle,
    api: Api,
    board_ids: Vec<String>,
    file: FileState,
    start_bytes: Vec<u8>,
    out: mpsc::Sender<EditDone>,
) -> (UnboundedSender<EditReq>, JoinHandle<()>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EditReq>();
    let slot: FileSlot = Arc::new(Mutex::new((file, start_bytes)));
    let worker = handle.spawn(async move {
        while let Some(req) = rx.recv().await {
            let done = match req {
                EditReq::LoadEnv { id } => {
                    let result = api.environment(&id).await.map_err(|e| {
                        log_api_fail("load_env", &e);
                        e.message
                    });
                    EditDone::Env { id, result }
                }
                EditReq::LoadScenario { id } => {
                    let result = api.scenario(&id).await.map_err(|e| {
                        log_api_fail("load_scenario", &e);
                        e.message
                    });
                    EditDone::Scenario { id, result }
                }
                EditReq::SaveBoard {
                    seq,
                    board_id,
                    panel_no,
                    name,
                    config,
                    ..
                } => {
                    let server = api
                        .put_board(&board_id, &name, &config)
                        .await
                        .map(SavedValue::Board)
                        .map_err(|e| {
                            log_api_fail("put_board", &e);
                            edit::strip_panel_prefix(&e.message, panel_no).to_string()
                        });
                    let file = match server {
                        Ok(_) => Some(persist(&api, &board_ids, &slot).await),
                        Err(_) => None,
                    };
                    EditDone::Saved {
                        seq,
                        req: SavedWhat::Board { board_id },
                        server,
                        file,
                    }
                }
                EditReq::SaveEnv {
                    seq,
                    id,
                    name,
                    vars,
                } => {
                    let server = api
                        .put_environment(&id, &name, &vars)
                        .await
                        .map(SavedValue::Env)
                        .map_err(|e| {
                            log_api_fail("put_environment", &e);
                            e.message
                        });
                    let file = match server {
                        Ok(_) => Some(persist(&api, &board_ids, &slot).await),
                        Err(_) => None,
                    };
                    EditDone::Saved {
                        seq,
                        req: SavedWhat::Env { id },
                        server,
                        file,
                    }
                }
                EditReq::SaveScenario {
                    seq,
                    id,
                    yaml,
                    version,
                } => {
                    // 409 = 버전 어긋남 — `EditDone`엔 상태 코드가 없으니 문구는 여기서 바꾼다(spec §6.4).
                    let server = api
                        .put_scenario(&id, &yaml, version)
                        .await
                        .map(SavedValue::Scenario)
                        .map_err(|e| {
                            log_api_fail("put_scenario", &e);
                            if e.status == Some(409) {
                                text::SCENARIO_CONFLICT.to_string()
                            } else {
                                e.message
                            }
                        });
                    let file = match server {
                        Ok(_) => Some(persist(&api, &board_ids, &slot).await),
                        Err(_) => None,
                    };
                    EditDone::Saved {
                        seq,
                        req: SavedWhat::Scenario { id },
                        server,
                        file,
                    }
                }
            };
            if out.send(done).is_err() {
                return;
            }
        }
    });
    (tx, worker)
}

/// 편집 한 건(서버에 보낼 칸 설정 변환의 재료). `Debug`는 종류만(값 가림).
#[derive(Clone, PartialEq, Eq)]
pub enum Change {
    Field(edit::Field, String),
    Env(Option<String>),
    Step(String),
    Latency(Option<String>),
    ThresholdAdd(u32),
    ThresholdSet(usize, u32),
    Remove(edit::ListKind, usize),
    Swap,
    Condition {
        index: usize,
        op: ConditionOp,
        value: String,
        ignore_case: bool,
        trim: bool,
    },
    /// 값 목록에서 새 조건(끝에 붙임, tui-2b §2.4)
    AddCondition(Condition),
    /// 값 목록에서 새 표시 값(끝에 붙임, §2.5)
    AddDisplay(DisplayItem),
}

impl std::fmt::Debug for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let k = match self {
            Change::Field(field, _) => return write!(f, "Field({field:?})"),
            Change::Env(_) => "Env",
            Change::Step(_) => "Step",
            Change::Latency(_) => "Latency",
            Change::ThresholdAdd(_) => "ThresholdAdd",
            Change::ThresholdSet(..) => "ThresholdSet",
            Change::Remove(kind, i) => return write!(f, "Remove({kind:?}, {i})"),
            Change::Swap => "Swap",
            Change::Condition { index, .. } => return write!(f, "Condition({index})"),
            Change::AddCondition(_) => "AddCondition",
            Change::AddDisplay(_) => "AddDisplay",
        };
        f.write_str(k)
    }
}

/// `edit.rs` 변환으로 새 보드 설정.
pub fn apply_change(cfg: &BoardConfig, panel_idx: usize, c: &Change) -> BoardConfig {
    match c {
        Change::Field(f, v) => edit::set_field(cfg, panel_idx, *f, v),
        Change::Env(e) => edit::set_env(cfg, panel_idx, e.clone()),
        Change::Step(s) => edit::set_step(cfg, panel_idx, s),
        Change::Latency(s) => edit::set_latency(cfg, panel_idx, s.as_deref()),
        Change::ThresholdAdd(ms) => edit::threshold_add(cfg, panel_idx, *ms),
        Change::ThresholdSet(i, ms) => edit::threshold_set(cfg, panel_idx, *i, *ms),
        Change::Remove(k, i) => edit::remove_at(cfg, panel_idx, *k, *i),
        Change::Swap => edit::swap_display(cfg, panel_idx),
        Change::Condition {
            index,
            op,
            value,
            ignore_case,
            trim,
        } => edit::set_condition(cfg, panel_idx, *index, *op, value, *ignore_case, *trim),
        Change::AddCondition(c) => edit::add_condition(cfg, panel_idx, c.clone()),
        Change::AddDisplay(d) => edit::add_display(cfg, panel_idx, d.clone()),
    }
}

/// 저장 전 확인이 필요하면 (문구, y_only). 볼 스텝을 **다른** 스텝으로 바꾸고 조건·표시 값이 있으면 단계 확인,
/// 환경을 바꿔 옛 환경을 아무 칸도 안 쓰게 되면 빠짐 확인(이름 — 모르면 id), 삭제는 y_only. 그 밖 None.
/// (plan 시그니처에 `names`를 더함 — 빠지는 환경의 이름이 필요하다.)
pub fn confirm_for(
    boards: &[BoardConfig],
    board_idx: usize,
    panel_idx: usize,
    change: &Change,
    names: &Names,
) -> Option<(String, bool)> {
    let p = boards.get(board_idx)?.panels.get(panel_idx)?;
    match change {
        Change::Step(s) => {
            if p.step_id.as_deref() == Some(s.as_str()) {
                return None;
            }
            let (c, d) = edit::step_change_counts(p);
            ((c, d) != (0, 0)).then(|| (text::step_change_confirm(c, d), false))
        }
        Change::Env(new) => {
            edit::dropped_env(boards, board_idx, panel_idx, new.as_deref()).map(|id| {
                let name = names.env_name(&id).unwrap_or(&id).to_string();
                (text::env_drop_confirm(&name), false)
            })
        }
        Change::Remove(_, i) => Some((text::delete_confirm(i + 1), true)),
        _ => None,
    }
}

fn pending_of(c: &Change) -> Option<Pending> {
    match c {
        Change::Step(s) => Some(Pending::SetStep(s.clone())),
        Change::Env(e) => Some(Pending::SetEnv(e.clone())),
        Change::Remove(k, i) => Some(Pending::Remove(*k, *i)),
        _ => None,
    }
}

fn change_of(p: Pending) -> Change {
    match p {
        Pending::SetStep(s) => Change::Step(s),
        Pending::SetEnv(e) => Change::Env(e),
        Pending::Remove(k, i) => Change::Remove(k, i),
    }
}

/// 거절 문구를 되살린 overlay에 싣는다(Input·CondForm은 오류 줄, 그 밖은 Notice).
fn with_error(o: Overlay, m: String) -> Overlay {
    match o {
        Overlay::Input {
            target,
            input,
            share,
            ..
        } => Overlay::Input {
            target,
            input,
            error: Some(m),
            share,
        },
        Overlay::CondForm {
            target,
            ops,
            op,
            value,
            ignore_case,
            trim,
            focus,
            ..
        } => Overlay::CondForm {
            target,
            ops,
            op,
            value,
            ignore_case,
            trim,
            focus,
            error: Some(m),
        },
        _ => Overlay::Notice(m),
    }
}

/// 메뉴 커서(0부터) → 하위 목록 종류(8·11·12번).
pub fn list_kind_at(cursor: usize) -> Option<edit::ListKind> {
    match cursor {
        7 => Some(edit::ListKind::Thresholds),
        10 => Some(edit::ListKind::Conditions),
        11 => Some(edit::ListKind::Display),
        _ => None,
    }
}

fn list_len(p: &PanelConfig, k: edit::ListKind) -> usize {
    match k {
        edit::ListKind::Thresholds => p.thresholds.len(),
        edit::ListKind::Conditions => p.conditions.len(),
        edit::ListKind::Display => p.display_items.len(),
    }
}

/// 받은 시나리오 → 화면 상태(고정 변수 줄은 `static_vars`로 — 줄마다 한 줄 모양으로 고칠 수 있어 보이는지 포함.
/// ⑦ 검증만 잡는 모양은 저장 때 `submit_var`의 `splice_static_var`가 입력줄 오류 줄로 거절한다).
fn scen_loaded(r: ScenarioResponse) -> ScenLoad {
    let vars = yaml_var::static_vars(&r.yaml);
    ScenLoad::Loaded {
        id: r.id,
        yaml: r.yaml,
        version: r.version,
        vars,
    }
}

/// 편집 작업자가 없거나 멈춰 결과가 영영 오지 않을 때(리뷰 B2): 저장 표를 풀고, 그 칸 화면의 `저장 중…`은
/// `Notice(SAVE_LOST)`, 기다리던 조회는 `Failed(LOAD_LOST)`. 바꾼 게 있으면 true.
pub fn worker_gone(edit: Option<&mut EditUi>, ticket: &mut Option<SaveTicket>) -> bool {
    let t = ticket.take();
    let mut changed = t.is_some();
    let Some(e) = edit else {
        return changed;
    };
    if matches!(e.overlay, Some(Overlay::Saving { .. }))
        && t.as_ref()
            .is_none_or(|t| t.board_id == e.board_id && t.panel_id == e.panel_id)
    {
        e.overlay = Some(Overlay::Notice(text::SAVE_LOST.to_string()));
        changed = true;
    }
    if matches!(e.env, Some(EnvLoad::Loading { .. })) {
        e.env = Some(EnvLoad::Failed(text::LOAD_LOST.to_string()));
        changed = true;
    }
    if matches!(e.scen, Some(ScenLoad::Loading { .. })) {
        e.scen = Some(ScenLoad::Failed(text::LOAD_LOST.to_string()));
        changed = true;
    }
    changed
}

/// 저장 결과 반영(순수). 표와 seq가 다른 `Saved`는 버린다. 캐시·알림은 **항상** 반영하고(`Notice(저장 중…)`도
/// 어느 칸 화면이든 닫는다), overlay 복원·`Notice`는
/// `edit`가 표의 보드·칸일 때만. 돌려주는 알림: 파일 Ok → `Saved(now_ms)`, 밖에서 바뀜 → `ChangedOutside`,
/// 그 밖 파일 실패 → `FileFailed`, 서버 거절 → None(지금 알림 유지).
/// 환경·시나리오 조회 결과(`Env`·`Scenario`)는 지금 그 id를 `Loading`으로 기다릴 때만 받는다 — 화면을 나갔거나
/// (`None`) 다른 것을 기다리면 버린다(값이 다시 메모리에 들지 않게). 환경·시나리오 저장 성공은 그 화면에 같은 id가
/// 이미 `Loaded`일 때만 응답으로 바꾼다(나간 뒤 온 성공은 알림만).
pub fn apply_done(
    edit: Option<&mut EditUi>,
    boards: &mut [BoardResponse],
    ticket: &mut Option<SaveTicket>,
    done: EditDone,
    now_ms: i64,
) -> Option<HeaderNotice> {
    let (seq, server, file) = match done {
        EditDone::Env { id, result } => {
            if let Some(e) = edit
                && matches!(&e.env, Some(EnvLoad::Loading { id: want }) if *want == id)
            {
                e.env = Some(match result {
                    Ok(r) => EnvLoad::Loaded(r),
                    Err(m) => EnvLoad::Failed(m),
                });
                e.list_cursor = 0;
            }
            return None;
        }
        EditDone::Scenario { id, result } => {
            if let Some(e) = edit
                && matches!(&e.scen, Some(ScenLoad::Loading { id: want }) if *want == id)
            {
                e.scen = Some(match result {
                    Ok(r) => scen_loaded(r),
                    Err(m) => ScenLoad::Failed(m),
                });
                e.list_cursor = 0;
            }
            return None;
        }
        EditDone::Saved {
            seq, server, file, ..
        } => (seq, server, file),
    };
    let t = match ticket.take() {
        Some(t) if t.seq == seq => t,
        other => {
            *ticket = other;
            return None;
        }
    };
    let mut edit = edit;
    // `저장 중…` 안내(표가 있을 때 저장·다른 칸 열기)는 "지금 저장 중"이라는 뜻뿐 — 표의 칸과 화면 칸이 달라도
    // 그 저장이 끝났으니 닫는다.
    if let Some(e) = edit.as_deref_mut()
        && matches!(&e.overlay, Some(Overlay::Notice(s)) if s == text::SAVING)
    {
        e.overlay = None;
    }
    let here = edit.filter(|e| e.board_id == t.board_id && e.panel_id == t.panel_id);
    match server {
        Err(m) => {
            if let Some(e) = here
                && let Some(Overlay::Saving { restore }) = &mut e.overlay
            {
                let r = restore.take();
                e.overlay = Some(match r {
                    Some(o) => with_error(*o, m),
                    None => Overlay::Notice(m),
                });
            }
            None
        }
        Ok(v) => {
            let mut here = here;
            match v {
                SavedValue::Board(b) => {
                    if let Some(slot) = boards.iter_mut().find(|x| x.id == b.id) {
                        *slot = b;
                    }
                }
                SavedValue::Env(r) => {
                    if let Some(e) = here.as_deref_mut()
                        && matches!(&e.env, Some(EnvLoad::Loaded(cur)) if cur.id == r.id)
                    {
                        e.env = Some(EnvLoad::Loaded(r));
                    }
                }
                SavedValue::Scenario(r) => {
                    if let Some(e) = here.as_deref_mut()
                        && matches!(&e.scen, Some(ScenLoad::Loaded { id, .. }) if *id == r.id)
                    {
                        e.scen = Some(scen_loaded(r));
                    }
                }
            }
            if let Some(e) = here {
                if matches!(e.overlay, Some(Overlay::Saving { .. })) {
                    e.overlay = None;
                }
                // 삭제 뒤 목록 커서를 남은 줄 안으로.
                let p = boards
                    .iter()
                    .find(|b| b.id == e.board_id)
                    .and_then(|b| b.config.panels.iter().find(|p| p.id == e.panel_id));
                if let (Some(p), Some(k)) = (p, list_kind_at(e.cursor)) {
                    e.list_cursor = e.list_cursor.min(list_len(p, k).saturating_sub(1));
                }
            }
            match file {
                Some(Ok(())) => Some(HeaderNotice::Saved(now_ms)),
                Some(Err(FileErr::Write(WriteError {
                    stage: WriteStage::ChangedOutside,
                    ..
                }))) => Some(HeaderNotice::ChangedOutside),
                Some(Err(_)) => Some(HeaderNotice::FileFailed),
                None => None,
            }
        }
    }
}

/// `edit_apply`가 쓰는 세션 쪽 값.
pub struct EditCtx<'a> {
    pub boards: &'a [BoardResponse],
    pub names: &'a Names,
    pub ticket: &'a mut Option<SaveTicket>,
    /// 마지막으로 쓴 저장 번호(새 저장마다 +1)
    pub seq: &'a mut u64,
}

/// `edit_apply`의 결과 — 화면 전환·작업자 요청·종료 확인.
#[derive(Debug, Default)]
pub struct EditOut {
    pub screen: Option<Screen>,
    pub req: Option<EditReq>,
    /// 입력줄의 Ctrl+C — 종료 확인창(입력 유지)
    pub ask_quit: bool,
}

const MENU_ITEMS: usize = 14;
/// 글자 입력줄 상한(spec §6.7).
const TEXT_MAX: usize = 2000;
/// 숫자 입력줄 상한(자리 수).
const DIGITS_MAX: usize = 6;

fn locate(boards: &[BoardResponse], ui: &EditUi) -> Option<(usize, usize)> {
    let bi = boards.iter().position(|b| b.id == ui.board_id)?;
    let pi = boards[bi]
        .config
        .panels
        .iter()
        .position(|p| p.id == ui.panel_id)?;
    Some((bi, pi))
}

/// 초기값이 입력 규칙(받는 글자·상한)을 그대로 통과할 때만 입력줄 — 아니면 안내(몰래 잘라 저장하지 않게).
fn open_input(v: &str, mode: InputMode, mk: impl FnOnce(LineInput) -> Overlay) -> Overlay {
    let li = LineInput::new(v, mode);
    if li.text() == v {
        mk(li)
    } else {
        Overlay::Notice(text::VALUE_UNEDITABLE.to_string())
    }
}

fn field_input(target: InputTarget, v: &str, mode: InputMode) -> Overlay {
    open_input(v, mode, |input| Overlay::Input {
        target,
        input,
        error: None,
        share: None,
    })
}

fn parse_ms(s: &str) -> u32 {
    s.trim().parse().unwrap_or(0)
}

/// 목록 창 옵션과 지금 값의 위치.
fn pick_options(
    pick: edit::Pick,
    p: &PanelConfig,
    names: &Names,
) -> (Vec<(Option<String>, String)>, usize) {
    let steps = || {
        edit::step_options(names, &p.scenario_id)
            .into_iter()
            .map(|(id, l)| (Some(id), l))
    };
    let (opts, cur): (Vec<(Option<String>, String)>, Option<String>) = match pick {
        edit::Pick::Env => (
            std::iter::once((None, text::ENV_NONE.to_string()))
                .chain(
                    names
                        .env_order()
                        .iter()
                        .map(|(id, n)| (Some(id.clone()), n.clone())),
                )
                .collect(),
            p.environment_id.clone(),
        ),
        edit::Pick::Step => (steps().collect(), p.step_id.clone()),
        edit::Pick::Latency => (
            std::iter::once((None, text::LATENCY_TOTAL.to_string()))
                .chain(steps())
                .collect(),
            match &p.latency_source {
                LatencySource::Total => None,
                LatencySource::Step { step_id } => Some(step_id.clone()),
            },
        ),
    };
    let i = opts.iter().position(|(id, _)| *id == cur).unwrap_or(0);
    (opts, i)
}

fn cond_fields(op: ConditionOp) -> Vec<CondFocus> {
    let mut v = vec![CondFocus::Op];
    if op.needs_value() {
        v.push(CondFocus::Value);
    }
    if op.has_flags() {
        v.extend([CondFocus::IgnoreCase, CondFocus::Trim]);
    }
    v
}

fn clamp_move(cur: usize, d: isize, len: usize) -> usize {
    let last = len.saturating_sub(1) as isize;
    (cur as isize).saturating_add(d).clamp(0, last.max(0)) as usize
}

/// 편집 화면 동작의 줄 수(커서 가둠용).
fn rows_on(screen: &Screen, ui: &EditUi, p: &PanelConfig) -> usize {
    match screen {
        Screen::Settings => MENU_ITEMS,
        Screen::EditList => list_kind_at(ui.cursor).map_or(0, |k| list_len(p, k)),
        Screen::EnvVars => match &ui.env {
            Some(EnvLoad::Loaded(e)) => e.vars.len(),
            _ => 0,
        },
        Screen::ScenarioVars => match &ui.scen {
            Some(ScenLoad::Loaded { vars, .. }) => vars.len(),
            _ => 0,
        },
        Screen::Values => ui.values.as_ref().map_or(0, |v| v.list.rows.len()),
        _ => 0,
    }
}

/// 확정: 저장 표가 있으면 `Notice(저장 중…)`, 확인이 필요하면 확인 줄, 아니면 저장 요청.
fn commit(
    ui: &mut EditUi,
    cx: &mut EditCtx,
    bi: usize,
    pi: usize,
    change: Change,
    restore: Option<Overlay>,
    confirmed: bool,
) -> Option<EditReq> {
    if cx.ticket.is_some() {
        // 표 확인이 확인 줄보다 먼저 — 확인 뒤 거절되는 저장이 없게.
        ui.overlay = Some(Overlay::Notice(text::SAVING.to_string()));
        return None;
    }
    if !confirmed {
        let cfgs: Vec<BoardConfig> = cx.boards.iter().map(|b| b.config.clone()).collect();
        if let Some((t, y_only)) = confirm_for(&cfgs, bi, pi, &change, cx.names)
            && let Some(then) = pending_of(&change)
        {
            ui.overlay = Some(Overlay::Confirm {
                text: t,
                then,
                y_only,
            });
            return None;
        }
    }
    let b = &cx.boards[bi];
    let config = apply_change(&b.config, pi, &change);
    let (board_id, panel_id, name) = (b.id.clone(), ui.panel_id.clone(), b.name.clone());
    start_save(ui, cx, restore, |seq| EditReq::SaveBoard {
        seq,
        board_id,
        panel_id,
        panel_no: pi + 1,
        name,
        config,
    })
}

/// 저장 하나 시작: 표가 있으면 `Notice(저장 중…)`(None). 아니면 번호를 올려 표(편집 화면의 보드·칸)와
/// `Saving{restore}`를 세우고 `mk(seq)` 요청. 보드·환경·시나리오 저장이 함께 쓴다.
fn start_save(
    ui: &mut EditUi,
    cx: &mut EditCtx,
    restore: Option<Overlay>,
    mk: impl FnOnce(u64) -> EditReq,
) -> Option<EditReq> {
    if cx.ticket.is_some() {
        ui.overlay = Some(Overlay::Notice(text::SAVING.to_string()));
        return None;
    }
    *cx.seq += 1;
    let seq = *cx.seq;
    *cx.ticket = Some(SaveTicket {
        seq,
        board_id: ui.board_id.clone(),
        panel_id: ui.panel_id.clone(),
    });
    ui.overlay = Some(Overlay::Saving {
        restore: restore.map(Box::new),
    });
    Some(mk(seq))
}

/// 환경·시나리오 변수 입력줄 확정(13·14). 환경 = 받은 `vars` 복제에서 그 키만 바꿔 `SaveEnv`. 시나리오 = 그 한 줄
/// 교체(`splice_static_var`) — 안 되면 입력줄 오류 줄에 사유(저장 안 함), 되면 `SaveScenario{교체본, 받은 version}`.
/// 받은 값이 없으면(불러오는 중·실패) 아무것도 안 한다.
fn submit_var(ui: &mut EditUi, cx: &mut EditCtx, restore: Overlay, v: String) -> Option<EditReq> {
    let Overlay::Input { target, .. } = &restore else {
        return None;
    };
    match target {
        InputTarget::EnvVar(key) => {
            let Some(EnvLoad::Loaded(e)) = &ui.env else {
                return None;
            };
            let (id, name) = (e.id.clone(), e.name.clone());
            let mut vars = e.vars.clone();
            vars.insert(key.clone(), v);
            start_save(ui, cx, Some(restore), |seq| EditReq::SaveEnv {
                seq,
                id,
                name,
                vars,
            })
        }
        InputTarget::ScenarioVar(key) => {
            let Some(ScenLoad::Loaded {
                id, yaml, version, ..
            }) = &ui.scen
            else {
                return None;
            };
            match yaml_var::splice_static_var(yaml, key, &v) {
                Err(why) => {
                    ui.overlay = Some(with_error(restore, not_editable_text(why).to_string()));
                    None
                }
                Ok(yaml) => {
                    let (id, version) = (id.clone(), *version);
                    start_save(ui, cx, Some(restore), |seq| EditReq::SaveScenario {
                        seq,
                        id,
                        yaml,
                        version,
                    })
                }
            }
        }
        _ => None,
    }
}

fn not_editable_text(why: yaml_var::NotEditable) -> &'static str {
    match why {
        yaml_var::NotEditable::Generated => text::VAR_GENERATED,
        yaml_var::NotEditable::Shape => text::VAR_SHAPE,
    }
}

/// 환경·시나리오 변수 화면에서 `Enter`(spec §6.3·§6.4): 고른 줄의 값만 평문으로 입력줄에. 시나리오의 못 고치는 줄은
/// 사유 `Notice`, 값이 입력 규칙(받는 글자·2000자)을 못 지키면 `Notice(VALUE_UNEDITABLE)`. 같은 환경/시나리오를
/// 쓰는 칸이 2개 이상이면 공유 문구. 받은 값이 없으면 아무것도 안 한다.
fn activate_var(screen: &Screen, ui: &mut EditUi, cx: &EditCtx, p: &PanelConfig) {
    let cfgs: Vec<BoardConfig> = cx.boards.iter().map(|b| b.config.clone()).collect();
    let share_for = |(pn, bn): (usize, usize)| (pn >= 2).then(|| text::share_note(pn, bn));
    let i = ui.list_cursor;
    let (target, value, share) = match (screen, &ui.env, &ui.scen) {
        (Screen::EnvVars, Some(EnvLoad::Loaded(e)), _) => {
            let Some((k, v)) = e.vars.iter().nth(i) else {
                return;
            };
            let id = e.id.as_str();
            let share = share_for(edit::usage(&cfgs, |q| {
                q.environment_id.as_deref() == Some(id)
            }));
            (InputTarget::EnvVar(k.clone()), v.clone(), share)
        }
        (Screen::ScenarioVars, _, Some(ScenLoad::Loaded { vars, .. })) => {
            let Some(sv) = vars.get(i) else {
                return;
            };
            if let Err(why) = sv.editable {
                ui.overlay = Some(Overlay::Notice(not_editable_text(why).to_string()));
                return;
            }
            let sc = p.scenario_id.as_str();
            let share = share_for(edit::usage(&cfgs, |q| q.scenario_id == sc));
            (
                InputTarget::ScenarioVar(sv.key.clone()),
                sv.value.clone(),
                share,
            )
        }
        _ => return,
    };
    ui.overlay = Some(open_input(
        &value,
        InputMode::Text {
            max_chars: TEXT_MAX,
        },
        |input| Overlay::Input {
            target,
            input,
            error: None,
            share,
        },
    ));
}

/// 편집 동작 하나를 화면 상태에 적용(순수 — 서버 호출은 돌려준 요청으로). `Back`·`AskQuit`은 App이 먼저 처리한다
/// (`SubViews::back`·종료 확인창). 13·14의 조회 결과·저장 결과 반영은 `apply_done`.
pub fn edit_apply(screen: &Screen, ui: &mut EditUi, cx: &mut EditCtx, a: EditAction) -> EditOut {
    let mut out = EditOut::default();
    let Some((bi, pi)) = locate(cx.boards, ui) else {
        ui.overlay = None;
        return out;
    };
    let p = &cx.boards[bi].config.panels[pi];
    match a {
        // `CheckNow`는 호출 쪽 `run_edit`이 `start_check`로 처리한다(요청이 `App`의 대기 번호를 쓴다).
        EditAction::None | EditAction::Back | EditAction::AskQuit | EditAction::CheckNow => {}
        EditAction::PickCancel
        | EditAction::ConfirmNo
        | EditAction::CloseNotice
        | EditAction::CheckCancel => {
            ui.overlay = None;
        }
        EditAction::MoveCursor(d) => {
            let n = rows_on(screen, ui, p);
            match (screen, &mut ui.values) {
                (Screen::Settings, _) => ui.cursor = clamp_move(ui.cursor, d, n),
                // 값 목록은 자기 커서 — `list_cursor`는 저장 뒤 하위 목록 길이로 잘린다(§4.2).
                (Screen::Values, Some(v)) => v.cursor = clamp_move(v.cursor, d, n),
                (Screen::Values, None) => {}
                _ => ui.list_cursor = clamp_move(ui.list_cursor, d, n),
            }
        }
        EditAction::Jump(i) => {
            let last = rows_on(screen, ui, p).saturating_sub(1);
            match (screen, &mut ui.values) {
                (Screen::Settings, _) => ui.cursor = i.min(last),
                (Screen::Values, Some(v)) => v.cursor = i.min(last),
                (Screen::Values, None) => {}
                _ => ui.list_cursor = i.min(last),
            }
        }
        EditAction::DigitJump { no, .. } => {
            if matches!(screen, Screen::Settings) {
                ui.cursor = no.clamp(1, MENU_ITEMS) - 1;
            }
        }
        EditAction::Activate => match screen {
            Screen::Settings => activate_menu(ui, cx, p, &mut out),
            Screen::EditList => activate_list(ui, p),
            Screen::EnvVars | Screen::ScenarioVars => activate_var(screen, ui, cx, p),
            Screen::Values => activate_value(ui, p),
            _ => {}
        },
        EditAction::Add => {
            if matches!(screen, Screen::EditList)
                && list_kind_at(ui.cursor) == Some(edit::ListKind::Thresholds)
            {
                ui.overlay = Some(field_input(
                    InputTarget::ThresholdNew,
                    &edit::threshold_default_ms(p).to_string(),
                    InputMode::Digits { max: DIGITS_MAX },
                ));
            }
        }
        EditAction::Remove => {
            if matches!(screen, Screen::EditList)
                && let Some(k) = list_kind_at(ui.cursor)
                && ui.list_cursor < list_len(p, k)
            {
                let c = Change::Remove(k, ui.list_cursor);
                out.req = commit(ui, cx, bi, pi, c, None, false);
            }
        }
        EditAction::Swap => {
            if matches!(screen, Screen::EditList)
                && list_kind_at(ui.cursor) == Some(edit::ListKind::Display)
                && p.display_items.len() == 2
            {
                out.req = commit(ui, cx, bi, pi, Change::Swap, None, false);
            }
        }
        EditAction::ToggleReveal => {
            if matches!(screen, Screen::EnvVars) {
                ui.reveal = !ui.reveal;
            }
        }
        EditAction::Input(outcome, after) => {
            match &mut ui.overlay {
                Some(Overlay::Input { input, .. }) => *input = after,
                Some(Overlay::CondForm {
                    value,
                    focus: CondFocus::Value,
                    ..
                }) => *value = after,
                _ => return out,
            }
            match outcome {
                InputOutcome::AskQuit => out.ask_quit = true,
                InputOutcome::Cancel => ui.overlay = None,
                InputOutcome::Submit => {
                    if let Some(Overlay::Input {
                        target,
                        input,
                        share,
                        ..
                    }) = &ui.overlay
                    {
                        let v = input.text();
                        let change = match target {
                            InputTarget::Field(f) => Some(Change::Field(*f, v.clone())),
                            InputTarget::ThresholdNew => Some(Change::ThresholdAdd(parse_ms(&v))),
                            InputTarget::Threshold(i) => {
                                Some(Change::ThresholdSet(*i, parse_ms(&v)))
                            }
                            InputTarget::EnvVar(_) | InputTarget::ScenarioVar(_) => None,
                        };
                        let restore = Overlay::Input {
                            target: target.clone(),
                            input: input.clone(),
                            error: None,
                            share: share.clone(),
                        };
                        out.req = match change {
                            Some(c) => commit(ui, cx, bi, pi, c, Some(restore), false),
                            None => submit_var(ui, cx, restore, v),
                        };
                    }
                }
                InputOutcome::Edited | InputOutcome::Ignored => {}
            }
        }
        EditAction::PickMove(d) => match &mut ui.overlay {
            Some(Overlay::Pick {
                options, cursor, ..
            }) => *cursor = clamp_move(*cursor, d, options.len()),
            Some(Overlay::AddChoice { cursor, .. }) => *cursor = clamp_move(*cursor, d, 2),
            _ => {}
        },
        EditAction::PickChoose if matches!(ui.overlay, Some(Overlay::AddChoice { .. })) => {
            out.req = choose_add(ui, cx, bi, pi);
        }
        EditAction::PickChoose => {
            if let Some(Overlay::Pick {
                pick,
                options,
                cursor,
            }) = &ui.overlay
                && let Some((id, _)) = options.get(*cursor)
            {
                let change = match pick {
                    edit::Pick::Env => Some(Change::Env(id.clone())),
                    edit::Pick::Step => id.clone().map(Change::Step),
                    edit::Pick::Latency => Some(Change::Latency(id.clone())),
                };
                if let Some(c) = change {
                    out.req = commit(ui, cx, bi, pi, c, None, false);
                }
            }
        }
        EditAction::CondKey(k) => cond_key(ui, cx, bi, pi, k, &mut out),
        EditAction::ConfirmYes => {
            if let Some(Overlay::Confirm { then, .. }) = ui.overlay.take() {
                out.req = commit(ui, cx, bi, pi, change_of(then), None, true);
            }
        }
    }
    out
}

/// 값 목록의 `Enter`(tui-2b §2.3): 막힌 목록·빈 목록이면 무동작. `본문 전체` 줄은 바로 조건 칸(조건 10개면 이유만).
/// 그 밖은 선택 창 — 둘 다 막혔으면 두 이유를 안내 한 번으로, 아니면 커서를 고를 수 있는 첫 줄에.
fn activate_value(ui: &mut EditUi, p: &PanelConfig) {
    let Some(v) = &ui.values else {
        return;
    };
    if v.blocked.is_some() {
        return;
    }
    let Some(row) = v.list.rows.get(v.cursor) else {
        return;
    };
    let cond_block = pick::cond_block(p);
    if matches!(row.kind, pick::RowKind::BodyText) {
        ui.overlay = Some(match cond_block {
            Some(m) => Overlay::Notice(m.to_string()),
            None => new_cond_form(&v.step_id, row),
        });
        return;
    }
    let display_block =
        pick::display_item(&v.step_id, row).and_then(|d| pick::display_block(p, &d));
    ui.overlay = Some(match (cond_block, display_block) {
        (Some(c), Some(d)) => Overlay::Notice(format!("{c} · {d}")),
        _ => Overlay::AddChoice {
            cursor: usize::from(cond_block.is_some()),
            cond_block,
            display_block,
        },
    });
}

/// 값 목록에서 고른 줄로 새 조건 칸(§2.4) — 기본 규칙·값·시작 칸은 `pick::default_condition`.
fn new_cond_form(step_id: &str, row: &pick::ValueRow) -> Overlay {
    let d = pick::default_condition(step_id, row);
    let ops = edit::ops_for(d.cond.source);
    let op = ops.iter().position(|o| *o == d.cond.op).unwrap_or(0);
    Overlay::CondForm {
        target: CondTarget::New {
            step_id: d.cond.step_id,
            source: d.cond.source,
            path: d.cond.path,
            shown: row.shown(),
            hint: d.hint,
        },
        ops,
        op,
        value: LineInput::new(
            &d.cond.value,
            InputMode::Text {
                max_chars: TEXT_MAX,
            },
        ),
        ignore_case: d.cond.ignore_case,
        trim: d.cond.trim,
        focus: if d.focus_value {
            CondFocus::Value
        } else {
            CondFocus::Op
        },
        error: None,
    }
}

/// 선택 창의 `Enter`: 막힌 줄이면 무동작, 0 = 조건 칸, 1 = 표시 값 바로 저장(되살릴 창 없음 — 거절은 안내).
fn choose_add(ui: &mut EditUi, cx: &mut EditCtx, bi: usize, pi: usize) -> Option<EditReq> {
    let Some(Overlay::AddChoice {
        cursor,
        cond_block,
        display_block,
    }) = &ui.overlay
    else {
        return None;
    };
    let cursor = *cursor;
    if (cursor == 0 && cond_block.is_some()) || (cursor != 0 && display_block.is_some()) {
        return None;
    }
    let v = ui.values.as_ref()?;
    let row = v.list.rows.get(v.cursor)?;
    if cursor == 0 {
        ui.overlay = Some(new_cond_form(&v.step_id, row));
        return None;
    }
    let item = pick::display_item(&v.step_id, row)?;
    commit(ui, cx, bi, pi, Change::AddDisplay(item), None, false)
}

fn activate_menu(ui: &mut EditUi, cx: &EditCtx, p: &PanelConfig, out: &mut EditOut) {
    match edit::edit_kind(ui.cursor + 1, p, cx.names) {
        edit::EditKind::Input(f) => {
            let mode = if f == edit::Field::Title {
                InputMode::Text {
                    max_chars: TEXT_MAX,
                }
            } else {
                InputMode::Digits { max: DIGITS_MAX }
            };
            ui.overlay = Some(field_input(
                InputTarget::Field(f),
                &edit::field_value(p, f),
                mode,
            ));
        }
        edit::EditKind::Pick(pick) => {
            let (options, cursor) = pick_options(pick, p, cx.names);
            ui.overlay = Some(if options.is_empty() {
                Overlay::Notice(text::VALUE_UNEDITABLE.to_string())
            } else {
                Overlay::Pick {
                    pick,
                    options,
                    cursor,
                }
            });
        }
        edit::EditKind::List(_) => {
            ui.list_cursor = 0;
            out.screen = Some(Screen::EditList);
        }
        edit::EditKind::EnvVars => {
            if let Some(id) = &p.environment_id {
                ui.leave_env();
                ui.env = Some(EnvLoad::Loading { id: id.clone() });
                out.req = Some(EditReq::LoadEnv { id: id.clone() });
                out.screen = Some(Screen::EnvVars);
            }
        }
        edit::EditKind::ScenarioVars => {
            ui.leave_scen();
            ui.scen = Some(ScenLoad::Loading {
                id: p.scenario_id.clone(),
            });
            out.req = Some(EditReq::LoadScenario {
                id: p.scenario_id.clone(),
            });
            out.screen = Some(Screen::ScenarioVars);
        }
        edit::EditKind::ReadOnly(m) => ui.overlay = Some(Overlay::Notice(m.to_string())),
    }
}

fn activate_list(ui: &mut EditUi, p: &PanelConfig) {
    let i = ui.list_cursor;
    match list_kind_at(ui.cursor) {
        Some(edit::ListKind::Thresholds) => {
            if let Some(t) = p.thresholds.get(i) {
                ui.overlay = Some(field_input(
                    InputTarget::Threshold(i),
                    &t.ms.to_string(),
                    InputMode::Digits { max: DIGITS_MAX },
                ));
            }
        }
        Some(edit::ListKind::Conditions) => {
            if let Some(c) = p.conditions.get(i) {
                let ops = edit::ops_for(c.source);
                let op = ops.iter().position(|o| *o == c.op).unwrap_or(0);
                let (ignore_case, trim) = (c.ignore_case, c.trim);
                ui.overlay = Some(open_input(
                    &c.value,
                    InputMode::Text {
                        max_chars: TEXT_MAX,
                    },
                    |value| Overlay::CondForm {
                        target: CondTarget::Existing(i),
                        ops,
                        op,
                        value,
                        ignore_case,
                        trim,
                        focus: CondFocus::Op,
                        error: None,
                    },
                ));
            }
        }
        // 표시 값은 삭제·자리 바꾸기만.
        Some(edit::ListKind::Display) | None => {}
    }
}

fn cond_key(
    ui: &mut EditUi,
    cx: &mut EditCtx,
    bi: usize,
    pi: usize,
    k: KeyEvent,
    out: &mut EditOut,
) {
    let Some(Overlay::CondForm {
        target,
        ops,
        op,
        value,
        ignore_case,
        trim,
        focus,
        ..
    }) = &mut ui.overlay
    else {
        return;
    };
    let cur_op = ops.get(*op).copied().unwrap_or(ConditionOp::Exists);
    let fields = cond_fields(cur_op);
    let at = fields.iter().position(|f| f == focus).unwrap_or(0);
    match k.code {
        KeyCode::Tab => *focus = fields[(at + 1) % fields.len()],
        KeyCode::BackTab => *focus = fields[(at + fields.len() - 1) % fields.len()],
        KeyCode::Left | KeyCode::Right if *focus == CondFocus::Op && !ops.is_empty() => {
            let n = ops.len();
            *op = if k.code == KeyCode::Left {
                (*op + n - 1) % n
            } else {
                (*op + 1) % n
            };
        }
        KeyCode::Char(' ') if *focus == CondFocus::IgnoreCase => *ignore_case = !*ignore_case,
        KeyCode::Char(' ') if *focus == CondFocus::Trim => *trim = !*trim,
        KeyCode::Esc => ui.overlay = None,
        KeyCode::Enter => {
            // 값이 필요 없는 규칙이면 비워 보낸다(서버도 비운다).
            let value = if cur_op.needs_value() {
                value.text()
            } else {
                String::new()
            };
            let change = match target {
                CondTarget::Existing(index) => Change::Condition {
                    index: *index,
                    op: cur_op,
                    value,
                    ignore_case: *ignore_case,
                    trim: *trim,
                },
                CondTarget::New {
                    step_id,
                    source,
                    path,
                    ..
                } => Change::AddCondition(Condition {
                    step_id: step_id.clone(),
                    source: *source,
                    path: path.clone(),
                    op: cur_op,
                    value,
                    ignore_case: *ignore_case,
                    trim: *trim,
                }),
            };
            let restore = ui.overlay.clone().map(|o| match o {
                Overlay::CondForm {
                    target,
                    ops,
                    op,
                    value,
                    ignore_case,
                    trim,
                    focus,
                    ..
                } => Overlay::CondForm {
                    target,
                    ops,
                    op,
                    value,
                    ignore_case,
                    trim,
                    focus,
                    error: None,
                },
                o => o,
            });
            out.req = commit(ui, cx, bi, pi, change, restore, false);
        }
        _ => {}
    }
}

/// 5분 자동 복귀(spec §6.6): 화면 상태를 비우되 진행 중 저장(`Saving`)이 있으면 `edit`는 남긴다(입력·값은 `idle_drop`).
pub fn idle_return(views: &mut SubViews) {
    let keep = views.edit.take().and_then(|mut e| {
        let saving = matches!(e.overlay, Some(Overlay::Saving { .. }));
        idle_drop(&mut e);
        saving.then_some(e)
    });
    views.clear();
    views.edit = keep;
}

/// 편집 화면(메뉴·하위 목록·변수 화면)의 키 줄 조각. `list` = (하위 목록 종류, 실제 항목 수).
pub fn edit_keys(
    screen: &Screen,
    ui: &EditUi,
    list: Option<(edit::ListKind, usize)>,
    quit_confirm: bool,
) -> Vec<&'static str> {
    if quit_confirm {
        return vec![text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL];
    }
    match &ui.overlay {
        Some(Overlay::Input { .. }) => vec![text::KEYS_SAVE, text::KEYS_CANCEL, text::KEYS_CLEAR],
        Some(Overlay::Pick { .. }) => vec![text::KEYS_PICK, text::KEYS_SAVE, text::KEYS_CANCEL],
        Some(Overlay::CondForm { .. }) => crate::view::edit::cond_form_keys(),
        Some(Overlay::Confirm { .. } | Overlay::Saving { .. } | Overlay::Notice(_)) => vec![],
        Some(Overlay::Checking { .. }) => vec![text::KEYS_BACK],
        Some(Overlay::AddChoice { .. }) => {
            vec![text::KEYS_PICK, text::KEYS_CHOOSE, text::KEYS_CANCEL]
        }
        None => match screen {
            Screen::Values => match &ui.values {
                Some(v) if v.blocked.is_none() && !v.list.rows.is_empty() => {
                    vec![text::KEYS_PICK, text::KEYS_ADD_ENTER, text::KEYS_TO_BODY]
                }
                _ => vec![text::KEYS_TO_BODY],
            },
            Screen::Settings => vec![
                text::KEYS_PICK,
                text::KEYS_NUMBER,
                text::KEYS_CHECK_NOW,
                text::KEYS_EDIT,
                text::KEYS_TO_MONITOR,
            ],
            Screen::EditList => match list {
                Some((k, n)) => crate::view::edit::list_keys(view_list_kind(k), n),
                None => vec![text::KEYS_BACK],
            },
            Screen::EnvVars => crate::view::edit::vars_keys(true, ui.reveal),
            Screen::ScenarioVars => crate::view::edit::vars_keys(false, false),
            _ => vec![],
        },
    }
}

fn view_list_kind(k: edit::ListKind) -> crate::view::edit::ListKind {
    match k {
        edit::ListKind::Thresholds => crate::view::edit::ListKind::Thresholds,
        edit::ListKind::Conditions => crate::view::edit::ListKind::Conditions,
        edit::ListKind::Display => crate::view::edit::ListKind::Display,
    }
}
// ---- 편집 화면 그리기용 뷰 모델(원문을 넘긴다 — sanitize는 view가) ----

fn field_label(f: edit::Field) -> &'static str {
    match f {
        edit::Field::Title => text::SET_TITLE,
        edit::Field::Interval => text::SET_INTERVAL,
        edit::Field::Timeout => text::SET_TIMEOUT,
        edit::Field::BarCount => text::SET_BAR_COUNT,
        edit::Field::GraphMax => text::SET_GRAPH_MAX,
    }
}

fn list_label(k: edit::ListKind) -> &'static str {
    match k {
        edit::ListKind::Thresholds => text::SET_THRESHOLDS,
        edit::ListKind::Conditions => text::SET_CONDITIONS,
        edit::ListKind::Display => text::SET_DISPLAY,
    }
}

/// 목록 창 줄(Pick이 아니면 빈 목록) — `OverlayView::Pick`이 빌린다.
fn pick_labels(ui: &EditUi) -> Vec<String> {
    match &ui.overlay {
        Some(Overlay::Pick { options, .. }) => options.iter().map(|(_, l)| l.clone()).collect(),
        _ => vec![],
    }
}

/// 조건 칸 그리기 재료(소유) — 하위 목록(기존 조건)·값 목록(새 조건)이 함께 쓴다.
struct CondParts<'a> {
    labels: Vec<&'static str>,
    target: String,
    op: usize,
    value: Option<(String, usize)>,
    flags: Option<(bool, bool)>,
    focus: CondFocus,
    error: Option<&'a str>,
    received: Option<&'a str>,
    hint: Option<&'static str>,
}

impl CondParts<'_> {
    fn view(&self) -> CondFormView<'_> {
        CondFormView {
            target: &self.target,
            ops: &self.labels,
            op: self.op,
            value: self.value.clone(),
            flags: self.flags,
            focus: self.focus,
            error: self.error,
            received: self.received,
            hint: self.hint,
        }
    }
}

/// `CondForm` 창 → 그리기 재료. 기존 조건 = 대상 줄만(그 조건이 사라졌으면 None), 새 조건 = 대상
/// `"{대상} · {스텝 이름}"` + `받은 값`·안내 줄(tui-2b §3.2). `body_w` = 값 칸 폭 계산용 본문 폭.
fn cond_parts<'a>(
    o: &'a Overlay,
    p: &PanelConfig,
    names: &Names,
    body_w: u16,
) -> Option<CondParts<'a>> {
    let Overlay::CondForm {
        target,
        ops,
        op,
        value,
        ignore_case,
        trim,
        focus,
        error,
    } = o
    else {
        return None;
    };
    let (target, fallback, received, hint) = match target {
        CondTarget::Existing(i) => {
            let c = p.conditions.get(*i)?;
            (condition_target(c), c.op, None, None)
        }
        CondTarget::New {
            step_id,
            source,
            path,
            shown,
            hint,
        } => {
            let c = Condition {
                source: *source,
                path: path.clone(),
                ..Condition::default()
            };
            let step = names.step_name(&p.scenario_id, step_id).unwrap_or(step_id);
            (
                format!("{} · {step}", condition_target(&c)),
                ConditionOp::Eq,
                Some(shown.as_str()),
                hint.as_ref().map(pick::Hint::text),
            )
        }
    };
    let cur = ops.get(*op).copied().unwrap_or(fallback);
    let fw = cond_form_value_width(body_w);
    Some(CondParts {
        labels: ops.iter().map(|o| text::cond_op_label(*o)).collect(),
        target,
        op: *op,
        value: cur.needs_value().then(|| value.view(fw)),
        flags: cur.has_flags().then_some((*ignore_case, *trim)),
        focus: *focus,
        error: error.as_deref(),
        received,
        hint,
    })
}

/// overlay → 그리기 모델(조건 수정 칸은 따로 그린다 — None). `w` = 입력줄 가로 창 계산 폭.
/// `values` = 값 목록(선택 창 머리 = 고른 줄의 대상·받은 값 — 없으면 창도 없다).
fn overlay_view<'a>(
    o: &'a Overlay,
    picks: &'a [String],
    values: Option<&pick::ValuesState>,
    w: usize,
) -> Option<OverlayView<'a>> {
    Some(match o {
        Overlay::Input {
            target,
            input,
            error,
            share,
        } => {
            let (label, hint) = match target {
                InputTarget::Field(f) => (
                    field_label(*f),
                    edit::field_range(*f).map(|(lo, hi)| text::range_hint(lo, hi)),
                ),
                InputTarget::ThresholdNew | InputTarget::Threshold(_) => {
                    (text::SET_THRESHOLDS, Some(text::LATENCY_UNIT.to_string()))
                }
                InputTarget::EnvVar(k) | InputTarget::ScenarioVar(k) => (k.as_str(), None),
            };
            let (text, cursor_x) = input.view(w);
            OverlayView::Input {
                label,
                text,
                cursor_x,
                hint,
                error: error.as_deref(),
                share: share.as_deref(),
            }
        }
        Overlay::Pick { pick, cursor, .. } => OverlayView::Pick {
            title: match pick {
                edit::Pick::Env => text::SET_ENV,
                edit::Pick::Step => text::SET_STEP,
                edit::Pick::Latency => text::SET_LATENCY,
            },
            options: picks,
            cursor: *cursor,
        },
        Overlay::CondForm { .. } => return None,
        Overlay::Confirm { text, .. } => OverlayView::Confirm(text),
        Overlay::Saving { .. } => OverlayView::Saving,
        Overlay::Checking { .. } => OverlayView::Checking,
        Overlay::Notice(m) => OverlayView::Notice(m),
        Overlay::AddChoice {
            cursor,
            cond_block,
            display_block,
        } => {
            let t = values.and_then(|v| v.texts.get(v.cursor))?;
            OverlayView::Choice {
                head: format!("{}  =  {}", t.target(), t.shown()),
                options: [
                    (text::COND_ADD_CHOICE, *cond_block),
                    (text::DISPLAY_ADD_CHOICE, *display_block),
                ],
                cursor: *cursor,
            }
        }
    })
}

fn dim_row(t: &str) -> ListRow {
    ListRow {
        text: t.to_string(),
        color: None,
        dim: true,
    }
}

/// 하위 목록 줄(spec §6.1 8·11·12). 목록이 비면 빈 목록(호출 쪽이 안내 줄을 정한다).
pub fn list_rows(k: edit::ListKind, p: &PanelConfig, names: &Names) -> Vec<ListRow> {
    let sc = p.scenario_id.as_str();
    let row = |text: String, color: Option<String>| ListRow {
        text,
        color,
        dim: false,
    };
    match k {
        edit::ListKind::Thresholds => p
            .thresholds
            .iter()
            .map(|t| {
                row(
                    format!(
                        "{} {}",
                        crate::judge::format_stat_num(f64::from(t.ms)),
                        text::LATENCY_UNIT
                    ),
                    Some(t.color.clone()),
                )
            })
            .collect(),
        edit::ListKind::Conditions => p
            .conditions
            .iter()
            .map(|c| row(condition_summary(c, names.step_name(sc, &c.step_id)), None))
            .collect(),
        edit::ListKind::Display => p
            .display_items
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let rank = text::DISPLAY_RANK.get(i).copied().unwrap_or("");
                let step = names.step_name(sc, &d.step_id).unwrap_or(&d.step_id);
                row(format!("{rank} {} · {step}", display_target(d)), None)
            })
            .collect(),
    }
}

/// 환경 변수 화면 줄(키 순 — `BTreeMap`). `reveal`이 아니면 값 자리는 언제나 `env_display(_, false)`(고정 가림 문자) —
/// 원래 값은 줄 어디에도 들지 않는다(렌더러는 원문을 받지 않는다, Review Focus 5).
pub fn env_rows(e: &EnvironmentResponse, reveal: bool) -> Vec<VarRow> {
    e.vars
        .iter()
        .map(|(k, v)| VarRow {
            key: k.clone(),
            value: env_display(v, reveal),
            note: None,
        })
        .collect()
}

/// 시나리오 변수 화면 줄 — 가리지 않는다(설계). 못 고치는 줄은 사유(흐리게).
pub fn scen_rows(vars: &[yaml_var::StaticVar]) -> Vec<VarRow> {
    vars.iter()
        .map(|v| VarRow {
            key: v.key.clone(),
            value: v.value.clone(),
            note: v.editable.err().map(not_editable_text),
        })
        .collect()
}

/// 붙여넣기를 받을 overlay인가 — 입력줄(Input) 또는 조건 수정 칸의 값 칸 포커스(spec §6.7).
pub fn paste_target(ui: &EditUi) -> bool {
    matches!(
        ui.overlay,
        Some(Overlay::Input { .. })
            | Some(Overlay::CondForm {
                focus: CondFocus::Value,
                ..
            })
    )
}

/// 붙여넣기 — 입력줄이면 `LineInput::paste`(줄바꿈·제어 문자를 빼고 넣는다 — 끝의 줄바꿈이 저장되지 않게),
/// 아니면 버린다. 넣었으면 true.
pub fn paste_into(ui: &mut EditUi, s: &str) -> bool {
    match &mut ui.overlay {
        Some(Overlay::Input { input, .. }) => input.paste(s),
        Some(Overlay::CondForm {
            value,
            focus: CondFocus::Value,
            ..
        }) => value.paste(s),
        _ => return false,
    }
    true
}

/// 편집 메뉴 그린 줄 표(`render_edit_menu`가 돌려준 (화면 y, 항목 0부터))에서 y의 항목.
pub fn menu_item_at(table: &[(u16, usize)], y: u16) -> Option<usize> {
    table.iter().find(|(row, _)| *row == y).map(|(_, n)| *n)
}

/// 편집 메뉴 클릭(spec §6.1 — 메뉴 화면·overlay 없음일 때만 부른다): 왼쪽 누름이 항목 줄이면 그 항목으로
/// (`Jump`), 이미 고른 항목이면 `Activate`(= Enter). 그 밖 `None`.
pub fn menu_click(table: &[(u16, usize)], cursor: usize, m: MouseEvent) -> EditAction {
    if m.kind != MouseEventKind::Down(MouseButton::Left) {
        return EditAction::None;
    }
    match menu_item_at(table, m.row) {
        Some(n) if n == cursor => EditAction::Activate,
        Some(n) => EditAction::Jump(n),
        None => EditAction::None,
    }
}

/// 칸 대상 동작(테두리·오류 보기·칸 설정)은 칸이 실제로 그려진 모니터 화면에서만 — 보이지 않는
/// 변경을 저장하지 않고, 칸이 안 그려진 작은 화면에서 어느 칸인지 모르는 채 열리지 않게.
pub fn toggle_allowed(screen: &Screen, panels_drawn: bool) -> bool {
    matches!(screen, Screen::Monitor) && panels_drawn
}

/// 격자 `(cols, rows)`에서 한 칸 이동. 가장자리·비어 있는 칸 앞에서는 제자리.
pub fn move_sel(sel: usize, dir: Dir, grid: (usize, usize), n_panels: usize) -> usize {
    let cols = grid.0.max(1);
    let (r, c) = (sel / cols, sel % cols);
    let next = match dir {
        Dir::Left if c > 0 => sel - 1,
        Dir::Right if c + 1 < cols => sel + 1,
        Dir::Up if r > 0 => sel - cols,
        Dir::Down => sel + cols,
        _ => sel,
    };
    if next < n_panels { next } else { sel }
}

pub fn handle_mouse(screen: &Screen, m: MouseEvent, layout: &Layout) -> Action {
    if !matches!(screen, Screen::Monitor) {
        return Action::None;
    }
    match m.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            panel_at(layout, m.column, m.row).map_or(Action::None, Action::Select)
        }
        _ => Action::None,
    }
}

pub fn screen_after_start(r: &Result<(), StartError>) -> Screen {
    match r {
        Ok(()) => Screen::Monitor,
        Err(e) => Screen::Error(e.clone()),
    }
}

/// 시계 갱신용 최대 재그리기 간격.
const REDRAW_MAX: Duration = Duration::from_secs(1);

/// 폴러 태스크가 끝났다면(패닉 등) 마지막 결과가 영영 갱신되지 않으니 서버 끊김으로 본다.
pub fn effective_server_down(snapshot_down: bool, poller_finished: bool) -> bool {
    snapshot_down || poller_finished
}

struct Running {
    session: Session,
    boards: Vec<BoardResponse>,
    poller: JoinHandle<()>,
    /// 이 세션의 기록 조회 작업자
    fetcher: JoinHandle<()>,
    /// 이 세션의 편집 작업자(조회·저장)
    editor: JoinHandle<()>,
}

struct App<'a> {
    rt: &'a Runtime,
    file: PathBuf,
    log: LogLoc,
    screen: Screen,
    running: Option<Running>,
    idx: usize,
    selected: usize,
    board_tx: watch::Sender<String>,
    snap_tx: watch::Sender<PollSnapshot>,
    snap_rx: watch::Receiver<PollSnapshot>,
    poller_dead_logged: Cell<bool>,
    border: BorderStyle,
    prefs_path: Option<PathBuf>,
    panels_drawn: Cell<bool>,
    /// 새 화면 넷의 상태
    views: SubViews,
    /// 조회 결과 통로(작업자 → UI 루프)
    fetch_out: (mpsc::Sender<Fetched>, mpsc::Receiver<Fetched>),
    /// 세션마다 새 조회 작업자(세션이 없으면 None)
    fetch_req: Option<UnboundedSender<FetchReq>>,
    /// 마지막으로 잰 터미널 크기
    size: Rect,
    /// 마지막 키·마우스 입력 시각(5분 자동 복귀)
    last_input: Instant,
    /// 편집 결과 통로(작업자 → UI 루프)
    edit_out: (mpsc::Sender<EditDone>, mpsc::Receiver<EditDone>),
    /// 세션마다 새 편집 작업자(세션이 없으면 None)
    edit_req: Option<UnboundedSender<EditReq>>,
    /// 진행 중인 저장(보드 전환·5분 복귀 뒤에도 남는다)
    save_in_flight: Option<SaveTicket>,
    /// 마지막 저장 번호
    save_seq: u64,
    /// 마지막 지금 점검 대기 번호(칸 설정 `r`) — 세션을 다시 시작해도 비우지 않는다(줄지 않아야 늦게 온 옛 결과가 새 대기와 겹치지 않는다)
    check_seq: u64,
    /// 머리 줄 알림(모든 화면) — `Saved`는 `saved_at` 5초 뒤 지운다
    file_notice: Option<HeaderNotice>,
    saved_at: Option<Instant>,
    /// 모니터 `r`(지금 점검)의 머리 줄 알림과 받은 때 — 5초 동안 파일 알림보다 앞서 보이고, 파일 알림은 따로 보관한다.
    check_alert: Option<(HeaderNotice, Instant)>,
    /// 마지막으로 그린 편집 메뉴의 (화면 y, 항목) 표 — 메뉴 줄 클릭용(spec §6.1)
    menu_rows: RefCell<Vec<(u16, usize)>>,
}

/// `저장됨` 알림을 보이는 시간(spec §6.2-5).
const SAVED_NOTICE: Duration = Duration::from_secs(5);

/// 지금 점검 요청 결과 → 머리 줄 알림(성공은 받은 시각 `now_ms`, 409는 꺼짐, 그 밖은 실패).
pub fn check_notice(result: &CheckReply, now_ms: i64) -> HeaderNotice {
    match result {
        Ok(_) => HeaderNotice::CheckSent(now_ms),
        Err(Some(409)) => HeaderNotice::CheckOff,
        Err(_) => HeaderNotice::CheckFailed,
    }
}

/// 머리 줄 알림은 자리가 하나 — 지금 점검 알림(5초)이 파일 알림보다 앞선다.
pub fn shown_notice(
    check: Option<&HeaderNotice>,
    file: Option<&HeaderNotice>,
) -> Option<HeaderNotice> {
    check.or(file).cloned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// 기록의 `line` 줄(Http) 본문 입력. Http가 아니거나 trace에 그 스텝이 없으면 None.
fn body_input<'a>(
    panel_title: &'a str,
    rec: &'a CheckRecord,
    line: Option<&'a StepLine>,
) -> Option<BodyInput<'a>> {
    let Some(StepLine::Http {
        trace_idx,
        no,
        name,
        ..
    }) = line
    else {
        return None;
    };
    let step = rec.trace.as_ref()?.steps.get(*trace_idx)?;
    let (clipped_req, clipped_resp) = clip_flags(&rec.clipped, *trace_idx);
    Some(BodyInput {
        panel_title,
        at_ms: rec.at_ms,
        no: *no,
        name,
        step,
        clipped_req,
        clipped_resp,
        limit_kb: rec.limit_kb,
        reveal: false,
    })
}

/// 칸 설정 화면의 (제목, 항목 번호가 붙은 줄, 각주).
type SettingsView = (String, Vec<(String, Option<usize>)>, Option<String>);

impl App<'_> {
    async fn start_inner(
        &mut self,
    ) -> Result<(Session, Vec<BoardResponse>), Box<(StartError, Option<Session>)>> {
        let session = Session::start(&self.file, &crate::tempdb::runtime_dir())
            .await
            .map_err(|e| Box::new((e, None)))?;
        let mut boards = Vec::new();
        for b in &session.boards {
            match session.api.board(&b.id).await {
                Ok(r) => boards.push(r),
                Err(e) => {
                    let err = StartError {
                        stage: Stage::Import,
                        message: e.message,
                        rest_addr: None,
                    };
                    return Err(Box::new((err, Some(session))));
                }
            }
        }
        if boards.is_empty() {
            let err = StartError {
                stage: Stage::Import,
                message: text::NO_BOARDS.to_string(),
                rest_addr: None,
            };
            return Err(Box::new((err, Some(session))));
        }
        Ok((session, boards))
    }

    /// 세션을 (다시) 띄운다. 기존 세션이 있으면 먼저 내린다. 로그는 다시 초기화하지 않는다.
    fn start_session(&mut self) {
        self.stop_session();
        self.views.clear();
        // 옛 세션의 저장 결과·조회 결과(지금 점검 포함 — `pump`가 `views.clear()` 없이 가로챈다)·알림이 새 세션에 들지 않게
        // (보드 id는 가져오기 사이에 보존된다).
        self.file_notice = None;
        self.saved_at = None;
        self.check_alert = None;
        self.save_in_flight = None;
        while self.edit_out.1.try_recv().is_ok() {}
        while self.fetch_out.1.try_recv().is_ok() {}
        self.poller_dead_logged.set(false);
        self.idx = 0;
        self.selected = 0;
        let rt = self.rt;
        match rt.block_on(self.start_inner()) {
            Ok((mut session, boards)) => {
                let _guard = rt.enter();
                self.board_tx.send_replace(boards[0].id.clone());
                self.snap_tx.send_replace(PollSnapshot::default());
                let poller = spawn_poller(
                    session.api.clone(),
                    self.board_tx.subscribe(),
                    self.snap_tx.clone(),
                );
                let (fetch_req, fetcher) =
                    spawn_fetch_worker(rt.handle(), session.api.clone(), self.fetch_out.0.clone());
                self.fetch_req = Some(fetch_req);
                let file = FileState {
                    target: session.target.clone(),
                    start: session.start_fp,
                    expected: session.start_fp,
                    first_done: false,
                    state_dir: crate::logging::state_dir(),
                };
                let (edit_req, editor) = spawn_edit_worker(
                    rt.handle(),
                    session.api.clone(),
                    session.boards.iter().map(|b| b.id.clone()).collect(),
                    file,
                    session.start_bytes.take().unwrap_or_default(),
                    self.edit_out.0.clone(),
                );
                self.edit_req = Some(edit_req);
                self.running = Some(Running {
                    session,
                    boards,
                    poller,
                    fetcher,
                    editor,
                });
                self.screen = screen_after_start(&Ok(()));
            }
            Err(boxed) => {
                let (e, session) = *boxed;
                if let Some(s) = session {
                    rt.block_on(s.shutdown());
                }
                self.screen = screen_after_start(&Err(e));
            }
        }
    }

    fn stop_session(&mut self) {
        self.fetch_req = None;
        self.edit_req = None;
        if let Some(r) = self.running.take() {
            // 중단을 기다린 뒤 세션을 내린다 — 폴러·조회 작업자가 내려가는 컨트롤러·지워지는 DB에
            // 요청하는 일이 없게. 통로를 닫는 것만으론 작업자가 큐에 남은 요청을 다 처리한다.
            self.rt.block_on(async {
                r.poller.abort();
                r.fetcher.abort();
                r.editor.abort();
                let _ = r.poller.await;
                let _ = r.fetcher.await;
                // 파일 쓰기가 블로킹 풀에서 도는 중이면 그 쓰기는 끝까지 간다(abort가 끊지 못한다 — 원자 교체).
                let _ = r.editor.await;
            });
            self.rt.block_on(r.session.shutdown());
        }
    }

    fn n_panels(&self) -> usize {
        self.running
            .as_ref()
            .map_or(0, |r| r.boards[self.idx].config.panels.len())
    }

    fn board(&self) -> Option<&BoardResponse> {
        self.running.as_ref().map(|r| &r.boards[self.idx])
    }

    /// 지금 보드에서 선택된 칸(모니터 화면과 같은 가둠).
    fn selected_panel(&self) -> Option<&PanelConfig> {
        let panels = &self.board()?.config.panels;
        panels.get(self.selected.min(panels.len().saturating_sub(1)))
    }

    fn panel(&self, board_id: &str, panel_id: &str) -> Option<&PanelConfig> {
        let b = self.board().filter(|b| b.id == board_id)?;
        b.config.panels.iter().find(|p| p.id == panel_id)
    }

    /// 그 칸의 현재 막대 구간 결과(오래된 → 최신). 스냅샷이 다른 보드 것이면 빈 목록.
    fn panel_results(&self, board_id: &str, panel_id: &str) -> Vec<CheckResult> {
        let snap = self.snap_rx.borrow();
        snap.last
            .as_ref()
            .filter(|_| snap.board_id == board_id)
            .and_then(|s| s.panels.iter().find(|p| p.panel_id == panel_id))
            .map(|p| p.results.clone())
            .unwrap_or_default()
    }

    /// 자세히 화면의 스텝 줄(기록이 아직 없으면 빈 목록).
    fn record_lines(&self) -> Vec<StepLine> {
        let Some(st) = &self.views.record else {
            return vec![];
        };
        let RecordLoad::Loaded(rec) = &st.load else {
            return vec![];
        };
        let (Some(panel), Some(r)) = (self.panel(&st.board_id, &st.panel_id), &self.running) else {
            return vec![];
        };
        rec.trace
            .as_ref()
            .map(|t| {
                step_lines(
                    t,
                    &r.session.names,
                    &panel.scenario_id,
                    panel.step_id.as_deref(),
                )
            })
            .unwrap_or_default()
    }

    /// 편집 중인 보드·칸(편집 상태가 있으면 그 보드·칸 — 세션의 모든 보드 캐시에서, 없으면 선택 칸).
    fn edit_target(&self) -> Option<(&BoardResponse, &PanelConfig)> {
        let r = self.running.as_ref()?;
        match &self.views.edit {
            Some(e) => {
                let b = r.boards.iter().find(|b| b.id == e.board_id)?;
                let p = b.config.panels.iter().find(|p| p.id == e.panel_id)?;
                Some((b, p))
            }
            None => Some((self.board()?, self.selected_panel()?)),
        }
    }

    /// 칸 설정 화면의 (제목, 줄, 각주) — 편집 칸(없으면 선택 칸) 기준, 줄은 `width`에 맞춘다.
    fn settings_view(&self, width: usize) -> Option<SettingsView> {
        let r = self.running.as_ref()?;
        let (board, panel) = self.edit_target()?;
        let items = settings_items_edit(panel, &r.session.names, width);
        let lines = edit_menu_lines(&items, width);
        Some((panel.title.clone(), lines, group_note(&board.config, panel)))
    }

    /// 칸 설정 보기의 (줄 수, 보이는 줄 수) — 지금 크기 기준.
    fn settings_dims(&self) -> (usize, usize) {
        let body = sub_layout(self.size).body;
        self.settings_view(usize::from(body.width))
            .map_or((0, 0), |(_, lines, note)| {
                (lines.len(), settings_height(body, note.is_some()))
            })
    }

    fn send_fetch(&self, req: FetchReq) {
        if let Some(tx) = &self.fetch_req {
            let _ = tx.send(req);
        }
    }

    /// 조회 결과를 받아들이고, 보이는 목록 줄의 사유를 요청하고, 본문 줄을 만든다.
    /// 이벤트 루프가 그리기 전에 부른다. 화면이 바뀌었으면 true.
    fn pump(&mut self) -> bool {
        let mut changed = self.pump_edit();
        let mut record_arrived = false;
        while let Ok(msg) = self.fetch_out.1.try_recv() {
            if let Fetched::CheckNow { wait, result, .. } = msg {
                match wait {
                    // 모니터에서 보낸 것은 머리 줄 알림.
                    None => {
                        self.check_alert = Some((check_notice(&result, now_ms()), Instant::now()));
                        changed = true;
                    }
                    // 칸 설정에서 보낸 것은 대기 창이 번호로 가려 받는다(맞지 않으면 조용히 버린다 — 알림 없음).
                    Some(n) => {
                        if let Some(ui) = self.views.edit.as_mut() {
                            changed |= check_reply(ui, n, result);
                        }
                    }
                }
                continue;
            }
            let is_record = matches!(msg, Fetched::Record { .. });
            if self.views.accept(msg) {
                changed = true;
                record_arrived |= is_record;
            }
        }
        if self
            .check_alert
            .as_ref()
            .is_some_and(|(_, at)| at.elapsed() >= SAVED_NOTICE)
        {
            self.check_alert = None;
            changed = true;
        }
        if record_arrived {
            let lines = self.record_lines();
            if let Some(r) = self.views.record.as_mut()
                && matches!(r.load, RecordLoad::Loaded(_))
            {
                r.cursor = initial_step_cursor(&lines);
            }
        }
        changed |= self.pump_check_ready();
        let inner = match &self.screen {
            Screen::QuitConfirm(inner) => (**inner).clone(),
            s => s.clone(),
        };
        match inner {
            Screen::Errors => changed |= self.pump_errors(),
            Screen::Body => self.pump_body(),
            Screen::Settings => self.pump_settings(),
            _ => {}
        }
        changed
    }

    /// 칸 설정 대기 창이 `After(last)`인데 그 칸에 `last`보다 새 결과가 들어왔으면 그 회차의 자세히를 연다.
    /// **`self.screen` 자체**가 칸 설정 메뉴일 때만 — 종료 확인창이 떠 있으면 열지 않고 기다렸다가 취소해 메뉴로 돌아온
    /// 다음 갱신에서 연다(확인창이 저절로 사라지지 않게). 열었으면 true.
    fn pump_check_ready(&mut self) -> bool {
        if !check_open_allowed(&self.screen) {
            return false;
        }
        let Some(ui) = self.views.edit.as_ref() else {
            return false;
        };
        // 새 결과를 기다리는 대기 창이 있을 때만 결과 목록을 복제한다(이 함수는 매 갱신마다 불린다).
        if !matches!(
            ui.overlay,
            Some(Overlay::Checking {
                wait: CheckWait::After(_),
                ..
            })
        ) {
            return false;
        }
        let Some(clicked) = check_ready(ui, &self.panel_results(&ui.board_id, &ui.panel_id)) else {
            return false;
        };
        let Some((screen, req)) = self.views.open_record_from_settings(clicked) else {
            return false;
        };
        self.screen = screen;
        self.send_fetch(req);
        true
    }

    /// 편집 결과를 받아들이고 `저장됨`을 5초 뒤 지운다. 바뀌었으면 true. 작업자가 끝나 있으면(패닉) 남은 결과를
    /// 다 받은 뒤 기다리던 저장·조회를 푼다 — 끝났는지를 **먼저** 본다(끝나기 전에 보낸 결과는 이미 통로에 있다).
    fn pump_edit(&mut self) -> bool {
        let mut changed = false;
        let dead = self
            .running
            .as_ref()
            .is_some_and(|r| r.editor.is_finished());
        while let Ok(done) = self.edit_out.1.try_recv() {
            changed = true;
            let Some(r) = self.running.as_mut() else {
                continue;
            };
            if let Some(n) = apply_done(
                self.views.edit.as_mut(),
                &mut r.boards,
                &mut self.save_in_flight,
                done,
                now_ms(),
            ) {
                self.saved_at = matches!(n, HeaderNotice::Saved(_)).then(Instant::now);
                self.file_notice = Some(n);
            }
        }
        if dead && worker_gone(self.views.edit.as_mut(), &mut self.save_in_flight) {
            tracing::error!("edit worker stopped");
            changed = true;
        }
        if matches!(self.file_notice, Some(HeaderNotice::Saved(_)))
            && self.saved_at.is_none_or(|at| at.elapsed() >= SAVED_NOTICE)
        {
            self.file_notice = None;
            self.saved_at = None;
            changed = true;
        }
        changed
    }

    /// 편집 메뉴 스크롤: 고른 항목의 줄이 다 보이게(이미 보이면 그대로). 편집 상태가 없으면 1b 가둠.
    fn pump_settings(&mut self) {
        let body = sub_layout(self.size).body;
        let (w, bh) = (usize::from(body.width), usize::from(body.height));
        let Some((_, lines, note)) = self.settings_view(w) else {
            return;
        };
        let Some(ui) = self.views.edit.as_ref() else {
            let h = settings_height(body, note.is_some());
            self.views.scroll_settings(Action::None, lines.len(), h);
            return;
        };
        let picks = pick_labels(ui);
        let ov = ui
            .overlay
            .as_ref()
            .and_then(|o| overlay_view(o, &picks, ui.values.as_ref(), w));
        let oh = overlay_rows(ov.as_ref(), w, bh).len().min(bh);
        let h = if oh > 0 {
            bh.saturating_sub(1).saturating_sub(oh)
        } else {
            settings_height(body, note.is_some())
        };
        let cursor = ui.cursor;
        self.views.settings_scroll = ensure_visible(&lines, cursor, h, self.views.settings_scroll);
    }

    fn pump_errors(&mut self) -> bool {
        let Some((board_id, panel_id)) = self
            .views
            .errors
            .as_ref()
            .map(|e| (e.board_id.clone(), e.panel_id.clone()))
        else {
            return false;
        };
        let results = self.panel_results(&board_id, &panel_id);
        let height = errors_list_height(sub_layout(self.size).body);
        let Some(e) = self.views.errors.as_mut() else {
            return false;
        };
        let rows_at: Vec<i64> = error_results(&results, e.show_all)
            .iter()
            .map(|r| r.at_ms)
            .collect();
        e.pin_cursor(&rows_at);
        let alive: HashSet<i64> = results.iter().map(|r| r.at_ms).collect();
        e.cache.retain(&alive);
        let visible = visible_results(&results, e, height);
        let want = e.cache.wanted(&visible, results.last().map(|r| r.at_ms));
        if want.is_empty() {
            return false;
        }
        e.cache.mark_loading(&want);
        for at_ms in want {
            self.send_fetch(FetchReq::Reason {
                board_id: board_id.clone(),
                panel_id: panel_id.clone(),
                at_ms,
            });
        }
        true
    }

    fn pump_body(&mut self) {
        let lines = self.record_lines();
        let width = usize::from(sub_layout(self.size).body.width);
        let title = self
            .views
            .record
            .as_ref()
            .and_then(|st| self.panel(&st.board_id, &st.panel_id))
            .map(|p| p.title.clone())
            .unwrap_or_default();
        let SubViews { record, body, .. } = &mut self.views;
        let (Some(st), Some(body)) = (record.as_ref(), body.as_mut()) else {
            return;
        };
        let RecordLoad::Loaded(rec) = &st.load else {
            return;
        };
        if let Some(input) = body_input(&title, rec, lines.get(body.line_idx)) {
            body.ensure(&input, width);
        }
    }

    fn monitor_screen(&self) -> Option<MonitorScreen> {
        let r = self.running.as_ref()?;
        let board = &r.boards[self.idx];
        let mut snap = self.snap_rx.borrow().clone();
        let stalled = r.poller.is_finished();
        if stalled && !self.poller_dead_logged.replace(true) {
            tracing::error!("상태 폴러가 멈췄습니다 — 서버 응답 없음으로 표시합니다");
        }
        snap.server_down = effective_server_down(snap.server_down, stalled);
        let panels = build_panels(board, &snap);
        let server_time = snap
            .last
            .as_ref()
            .filter(|_| snap.board_id == board.id)
            .map(|s| s.now_ms);
        let selected = self.selected.min(panels.len().saturating_sub(1));
        Some(MonitorScreen {
            board_name: board.name.clone(),
            board_pos: (self.idx + 1, r.boards.len()),
            server_time,
            server_down: snap.server_down,
            panels,
            selected,
            border: self.border,
            notice: shown_notice(
                self.check_alert.as_ref().map(|(n, _)| n),
                self.file_notice.as_ref(),
            ),
        })
    }

    fn draw_screen(&self, f: &mut ratatui::Frame, screen: &Screen) {
        self.draw_with(f, screen, KeyBar::Monitor);
    }

    /// `bar` = 맨 아래 키 줄이 안내할 화면(도움말·종료 확인이 열려 있으면 그 화면의 키만).
    fn draw_with(&self, f: &mut ratatui::Frame, screen: &Screen, bar: KeyBar) {
        match screen {
            Screen::Starting => {
                f.render_widget(Paragraph::new(Line::from(text::STARTING)), f.area());
            }
            Screen::Monitor => {
                let drawn = self
                    .monitor_screen()
                    .is_some_and(|m| render_with_keys(f, &m, bar));
                self.panels_drawn.set(drawn);
            }
            Screen::Help => {
                let b = if bar == KeyBar::QuitConfirm {
                    bar
                } else {
                    KeyBar::Help
                };
                self.draw_with(f, &Screen::Monitor, b);
                let backups = self.running.as_ref().map(|r| &r.session.target);
                render_help(f, &self.file, backups, &self.log);
            }
            Screen::QuitConfirm(inner) => {
                self.draw_with(f, inner, KeyBar::QuitConfirm);
                render_quit_confirm(f);
            }
            Screen::Error(e) => render_error(f, e, &self.file, &self.log),
            Screen::Usage => render_usage(f),
            // 편집 화면 넷은 `draw_sub` → `draw_edit`.
            Screen::Errors
            | Screen::Record
            | Screen::Body
            | Screen::Settings
            | Screen::EditList
            | Screen::EnvVars
            | Screen::ScenarioVars
            | Screen::Values => {
                self.panels_drawn.set(false);
                self.draw_sub(f, screen, bar == KeyBar::QuitConfirm);
            }
        }
    }

    /// 새 화면 넷 — 맨 윗줄은 모니터와 같은 머리 줄(끊김 표시 포함).
    fn draw_sub(&self, f: &mut ratatui::Frame, screen: &Screen, quit_confirm: bool) {
        let Some(head) = self.monitor_screen().map(|m| m.header()) else {
            return;
        };
        let Some(r) = self.running.as_ref() else {
            return;
        };
        let mut ctx = KeyCtx {
            quit_confirm,
            show_all: self.views.errors.as_ref().is_some_and(|e| e.show_all),
            reveal: self.views.body.as_ref().is_some_and(|b| b.reveal),
            has_req_body: false,
            record_from_settings: self
                .views
                .record
                .as_ref()
                .is_some_and(|r| r.origin == RecordOrigin::Settings),
        };
        match screen {
            Screen::Errors => {
                let Some(st) = &self.views.errors else {
                    return;
                };
                let Some(panel) = self.panel(&st.board_id, &st.panel_id) else {
                    return;
                };
                let results = self.panel_results(&st.board_id, &st.panel_id);
                // 꺼진 보드 = `/status`의 enabled(그 보드 스냅샷이 아직 없으면 켜진 것으로 — 기존 문구).
                let enabled = {
                    let snap = self.snap_rx.borrow();
                    snap.last
                        .as_ref()
                        .filter(|_| snap.board_id == st.board_id)
                        .is_none_or(|s| s.enabled)
                };
                let input = ErrorsInput {
                    title: &panel.title,
                    results: &results,
                    thresholds: &panel.thresholds,
                    interval_seconds: panel.interval_seconds,
                    enabled,
                };
                let height = errors_list_height(sub_layout(f.area()).body);
                let v = errors_view(&input, st, height);
                render_errors(f, &head, &v, &sub_keys(screen, ctx));
            }
            Screen::Record => {
                let Some(st) = &self.views.record else {
                    return;
                };
                let Some(panel) = self.panel(&st.board_id, &st.panel_id) else {
                    return;
                };
                let v = record_view(panel, st, &r.session.names);
                render_record(f, &head, &v, &sub_keys(screen, ctx));
            }
            Screen::Body => {
                let Some(body) = &self.views.body else {
                    return;
                };
                let lines = self.record_lines();
                if let Some(StepLine::Http { trace_idx, .. }) = lines.get(body.line_idx)
                    && let Some(RecordState {
                        load: RecordLoad::Loaded(rec),
                        ..
                    }) = &self.views.record
                {
                    ctx.has_req_body = rec
                        .trace
                        .as_ref()
                        .and_then(|t| t.steps.get(*trace_idx))
                        .and_then(|s| s.request.as_ref())
                        .and_then(|q| q.body.as_deref())
                        .is_some_and(|b| !b.is_empty());
                }
                render_body(f, &head, body.lines(), body.scroll, &sub_keys(screen, ctx));
            }
            Screen::Settings | Screen::EditList | Screen::EnvVars | Screen::ScenarioVars => {
                self.draw_edit(f, screen, &head, quit_confirm)
            }
            Screen::Values => self.draw_values(f, screen, &head, quit_confirm),
            _ => {}
        }
    }

    /// 값 목록(tui-2b §3.1·§3.2): 줄 글자·대상 폭은 `values`에서 빌리고, 표지만 지금 칸 설정으로 보이는 줄에 계산한다.
    fn draw_values(&self, f: &mut ratatui::Frame, screen: &Screen, head: &HeaderView, quit: bool) {
        let (Some(r), Some(ui)) = (self.running.as_ref(), self.views.edit.as_ref()) else {
            return;
        };
        let Some(values) = ui.values.as_ref() else {
            return;
        };
        let Some((_, p)) = self.edit_target() else {
            return;
        };
        let names = &r.session.names;
        let body = sub_layout(f.area()).body;
        let w = usize::from(body.width);
        // 제목 = 요청·응답 화면 제목(`{칸 제목} · {시각} · {순번} {스텝 이름}`) — 뷰가 ` — 값 고르기`를 붙인다.
        let lines = self.record_lines();
        let at_ms = match &self.views.record {
            Some(RecordState {
                load: RecordLoad::Loaded(rec),
                ..
            }) => Some(rec.at_ms),
            _ => None,
        };
        let step = self.views.body.as_ref().and_then(|b| lines.get(b.line_idx));
        let title = match (at_ms, step) {
            (Some(at), Some(StepLine::Http { no, name, .. })) => {
                format!("{} · {} · {no} {name}", p.title, format_hms(at))
            }
            _ => p.title.clone(),
        };
        let marks = |i: usize| {
            values
                .list
                .rows
                .get(i)
                .map_or((0, false), |row| pick::marks(p, &values.step_id, row))
        };
        let cond = match &ui.overlay {
            Some(o @ Overlay::CondForm { .. }) => cond_parts(o, p, names, body.width),
            _ => None,
        };
        let form = cond.as_ref().map(CondParts::view);
        let picks = pick_labels(ui);
        let overlay = ui
            .overlay
            .as_ref()
            .and_then(|o| overlay_view(o, &picks, Some(values), w));
        let view = ValuesView {
            title: &title,
            notes: values.list.notes.iter().map(|n| n.text()).collect(),
            blocked: values.blocked.as_ref().map(|b| b.text()),
            rows: &values.texts,
            target_width: values.target_width,
            marks: &marks,
            cursor: values.cursor,
            overlay,
            form: form.as_ref(),
        };
        let keys = fit_keys(&edit_keys(screen, ui, None, quit), f.area().width);
        render_values(f, head, &view, &keys);
    }

    /// 편집 메뉴·하위 목록·변수 화면(편집 상태가 없으면 고른 항목 없는 메뉴).
    fn draw_edit(&self, f: &mut ratatui::Frame, screen: &Screen, head: &HeaderView, quit: bool) {
        self.menu_rows.borrow_mut().clear();
        let Some(r) = self.running.as_ref() else {
            return;
        };
        let key_w = f.area().width;
        let names = &r.session.names;
        let body = sub_layout(f.area()).body;
        let w = usize::from(body.width);
        let Some(ui) = self.views.edit.as_ref() else {
            // 닿지 않는 방어 경로(`OpenSettings`가 늘 `EditUi`를 만든다) — 고른 항목 없는 메뉴(`cursor: usize::MAX`).
            if let Some((title, lines, note)) = self.settings_view(w) {
                let view = EditMenuView {
                    title: &title,
                    lines: &lines,
                    cursor: usize::MAX,
                    scroll: self.views.settings_scroll,
                    note: note.as_deref(),
                    overlay: None,
                };
                let keys = sub_keys(
                    screen,
                    KeyCtx {
                        quit_confirm: quit,
                        show_all: false,
                        reveal: false,
                        has_req_body: false,
                        record_from_settings: false,
                    },
                );
                let _ = render_edit_menu(f, head, &view, &keys);
            }
            return;
        };
        let Some((_, p)) = self.edit_target() else {
            return;
        };
        let picks = pick_labels(ui);
        let overlay = ui
            .overlay
            .as_ref()
            .and_then(|o| overlay_view(o, &picks, ui.values.as_ref(), w));
        match screen {
            Screen::Settings => {
                let Some((title, lines, note)) = self.settings_view(w) else {
                    return;
                };
                let view = EditMenuView {
                    title: &title,
                    lines: &lines,
                    cursor: ui.cursor,
                    scroll: self.views.settings_scroll,
                    note: note.as_deref(),
                    overlay,
                };
                let keys = fit_keys(&edit_keys(screen, ui, None, quit), key_w);
                *self.menu_rows.borrow_mut() = render_edit_menu(f, head, &view, &keys);
            }
            Screen::EditList => {
                let Some(kind) = list_kind_at(ui.cursor) else {
                    return;
                };
                let rows = list_rows(kind, p, names);
                let n = rows.len();
                let rows = match (n, kind) {
                    (0, edit::ListKind::Conditions) => vec![dim_row(text::EDIT_NO_CONDITIONS)],
                    (0, edit::ListKind::Display) => vec![dim_row(text::EDIT_NO_DISPLAY)],
                    _ => rows,
                };
                let title = format!("{} · {}", list_label(kind), p.title);
                let keys = fit_keys(&edit_keys(screen, ui, Some((kind, n)), quit), key_w);
                let view = ListView {
                    title: &title,
                    rows,
                    cursor: ui.list_cursor,
                    overlay,
                };
                let cond = match &ui.overlay {
                    // 새 조건(`New`)은 값 목록 화면(`draw_values`)이 그린다 — 하위 목록에는 기존 조건만.
                    Some(
                        o @ Overlay::CondForm {
                            target: CondTarget::Existing(_),
                            ..
                        },
                    ) => cond_parts(o, p, names, body.width),
                    _ => None,
                };
                let form = cond.as_ref().map(CondParts::view);
                render_list_with_form(f, head, &view, &keys, form.as_ref());
            }
            Screen::EnvVars => {
                let id = p.environment_id.as_deref().unwrap_or_default();
                let cfgs: Vec<BoardConfig> = r.boards.iter().map(|b| b.config.clone()).collect();
                let (pn, bn) = edit::usage(&cfgs, |q| q.environment_id.as_deref() == Some(id));
                let (rows, loading, failed) = match &ui.env {
                    Some(EnvLoad::Loaded(e)) => (env_rows(e, ui.reveal), false, None),
                    Some(EnvLoad::Failed(m)) => (vec![], false, Some(m.as_str())),
                    _ => (vec![], true, None),
                };
                let view = VarsView {
                    title: format!(
                        "{} · {}",
                        text::SET_ENV_VARS,
                        names.env_name(id).unwrap_or(id)
                    ),
                    usage: text::usage_note(pn, bn),
                    rows,
                    cursor: ui.list_cursor,
                    loading,
                    failed,
                    overlay,
                };
                render_vars(
                    f,
                    head,
                    &view,
                    &fit_keys(&edit_keys(screen, ui, None, quit), key_w),
                );
            }
            Screen::ScenarioVars => {
                let sc = p.scenario_id.as_str();
                let cfgs: Vec<BoardConfig> = r.boards.iter().map(|b| b.config.clone()).collect();
                let (pn, bn) = edit::usage(&cfgs, |q| q.scenario_id == sc);
                let (rows, loading, failed) = match &ui.scen {
                    Some(ScenLoad::Loaded { vars, .. }) => (scen_rows(vars), false, None),
                    Some(ScenLoad::Failed(m)) => (vec![], false, Some(m.as_str())),
                    _ => (vec![], true, None),
                };
                let view = VarsView {
                    title: format!(
                        "{} · {}",
                        text::SET_SCEN_VARS,
                        names.scenario_name(sc).unwrap_or(sc)
                    ),
                    usage: text::usage_note_scenario(pn, bn),
                    rows,
                    cursor: ui.list_cursor,
                    loading,
                    failed,
                    overlay,
                };
                render_vars(
                    f,
                    head,
                    &view,
                    &fit_keys(&edit_keys(screen, ui, None, quit), key_w),
                );
            }
            _ => {}
        }
    }

    fn current_layout(&self, size: Rect) -> Layout {
        layout(size, self.n_panels()).unwrap_or(Layout { panels: vec![] })
    }

    /// 종료해야 하면 `true`.
    fn apply(&mut self, a: Action) -> bool {
        match a {
            Action::None => {}
            Action::Move(d) => {
                let n = self.n_panels();
                self.selected = move_sel(self.selected, d, grid_for(n), n);
            }
            Action::Select(i) => self.selected = i,
            Action::NextBoard | Action::PrevBoard => {
                if let Some(r) = &self.running {
                    let n = r.boards.len();
                    self.idx = if a == Action::NextBoard {
                        (self.idx + 1) % n
                    } else {
                        (self.idx + n - 1) % n
                    };
                    self.selected = 0;
                    self.board_tx.send_replace(r.boards[self.idx].id.clone());
                    self.views.clear();
                }
            }
            Action::ToggleBorder => {
                if toggle_allowed(&self.screen, self.panels_drawn.get()) {
                    self.border = self.border.toggled();
                    if let Some(p) = &self.prefs_path
                        && let Err(e) = prefs::save(
                            p,
                            &Prefs {
                                border: self.border,
                            },
                        )
                    {
                        tracing::warn!("설정 파일 저장 실패({}): {e}", p.display());
                    }
                }
            }
            Action::OpenHelp => self.screen = Screen::Help,
            Action::Back => {
                if let Screen::QuitConfirm(inner) = &self.screen {
                    self.screen = (**inner).clone();
                } else if let Some(s) = self.views.back(&self.screen) {
                    self.screen = s;
                }
            }
            Action::AskQuit => {
                self.screen = Screen::QuitConfirm(Box::new(self.screen.clone()));
            }
            Action::Quit => return true,
            Action::Retry => {
                self.screen = Screen::Starting;
                return false;
            }
            Action::OpenErrors => {
                if toggle_allowed(&self.screen, self.panels_drawn.get())
                    && let (Some(board), Some(panel)) = (self.board(), self.selected_panel())
                {
                    let (board_id, panel_id) = (board.id.clone(), panel.id.clone());
                    let rows_at: Vec<i64> =
                        error_results(&self.panel_results(&board_id, &panel_id), false)
                            .iter()
                            .map(|r| r.at_ms)
                            .collect();
                    self.screen = self.views.open_errors(&board_id, &panel_id, &rows_at);
                }
            }
            Action::CheckNow => {
                if toggle_allowed(&self.screen, self.panels_drawn.get())
                    && let (Some(board), Some(panel)) = (self.board(), self.selected_panel())
                {
                    let (board_id, panel_id) = (board.id.clone(), panel.id.clone());
                    self.send_fetch(FetchReq::CheckNow {
                        board_id,
                        panel_id,
                        wait: None,
                    });
                }
            }
            Action::OpenSettings => {
                if toggle_allowed(&self.screen, self.panels_drawn.get())
                    && let (Some(board), Some(panel)) = (self.board(), self.selected_panel())
                {
                    let (board_id, panel_id) = (board.id.clone(), panel.id.clone());
                    // 저장 중이면: 그 칸이면 `저장 중…`(결과가 오면 닫힌다), 다른 칸이면 안내 한 번.
                    let overlay =
                        overlay_for_ticket(self.save_in_flight.as_ref(), &board_id, &panel_id);
                    self.screen = self.views.open_settings();
                    self.views.edit = Some(EditUi {
                        board_id,
                        panel_id,
                        overlay,
                        ..EditUi::default()
                    });
                }
            }
            Action::Activate => self.activate(),
            Action::AddValue => {
                self.open_values_here();
            }
            Action::ToggleAll => {
                if matches!(self.screen, Screen::Errors)
                    && let Some((b, p)) = self
                        .views
                        .errors
                        .as_ref()
                        .map(|e| (e.board_id.clone(), e.panel_id.clone()))
                {
                    let results = self.panel_results(&b, &p);
                    if let Some(e) = self.views.errors.as_mut() {
                        e.show_all = !e.show_all;
                        let rows_at: Vec<i64> = error_results(&results, e.show_all)
                            .iter()
                            .map(|r| r.at_ms)
                            .collect();
                        e.pin_cursor(&rows_at);
                    }
                }
            }
            Action::ToggleReveal => {
                if matches!(self.screen, Screen::Body)
                    && let Some(b) = self.views.body.as_mut()
                {
                    b.reveal = !b.reveal;
                }
            }
            Action::PrevStep | Action::NextStep => {
                if matches!(self.screen, Screen::Body) {
                    let lines = self.record_lines();
                    let dir = if a == Action::PrevStep { -1 } else { 1 };
                    self.views.step_body(&lines, dir);
                }
            }
            Action::Up
            | Action::Down
            | Action::PageUp
            | Action::PageDown
            | Action::Home
            | Action::End => self.scroll(a),
        }
        false
    }

    /// 편집 화면(메뉴·하위 목록·변수 화면)이고 편집 상태가 있는가 — 그러면 키는 `edit_key`가 먼저.
    fn on_edit_screen(&self) -> bool {
        is_edit_screen(&self.screen) && self.views.edit.is_some()
    }

    /// 편집 화면의 키. 종료해야 하면 `true`.
    fn edit_key_event(&mut self, k: KeyEvent) -> bool {
        let Some(ui) = self.views.edit.as_ref() else {
            return false;
        };
        let a = edit_key(&self.screen, ui, k, Instant::now());
        self.run_edit(a)
    }

    /// 편집 메뉴의 마우스(spec §6.1 — 메뉴 화면·overlay 없음일 때만, 그 밖은 무시).
    fn edit_mouse(&mut self, m: MouseEvent) -> bool {
        let Some(ui) = self.views.edit.as_ref() else {
            return false;
        };
        if !matches!(self.screen, Screen::Settings) || ui.overlay.is_some() {
            return false;
        }
        let a = menu_click(&self.menu_rows.borrow(), ui.cursor, m);
        if a == EditAction::None {
            return false;
        }
        self.run_edit(a)
    }

    /// 편집 동작 하나를 적용하고 요청을 작업자에게. 종료해야 하면 `true`.
    fn run_edit(&mut self, a: EditAction) -> bool {
        if let Some(ui) = self.views.edit.as_mut() {
            ui.track_digit(&a);
        }
        match a {
            EditAction::Back => self.apply(Action::Back),
            EditAction::AskQuit => self.apply(Action::AskQuit),
            // 세션(조회 작업자)이 없으면 요청이 갈 곳이 없으니 대기 창을 띄우지 않는다. 작업자가 죽어 결과가
            // 안 오는 경우에도 대기 창은 `Esc`로 닫힌다.
            EditAction::CheckNow => {
                if self.fetch_req.is_some()
                    && let Some(ui) = self.views.edit.as_mut()
                {
                    let req = start_check(ui, &mut self.check_seq);
                    self.send_fetch(req);
                }
                false
            }
            a => {
                let (Some(r), Some(ui)) = (self.running.as_ref(), self.views.edit.as_mut()) else {
                    return false;
                };
                let mut cx = EditCtx {
                    boards: &r.boards,
                    names: &r.session.names,
                    ticket: &mut self.save_in_flight,
                    seq: &mut self.save_seq,
                };
                let out = edit_apply(&self.screen, ui, &mut cx, a);
                if let Some(req) = out.req {
                    let sent = self
                        .edit_req
                        .as_ref()
                        .is_some_and(|tx| tx.send(req).is_ok());
                    if !sent {
                        // 작업자가 없다(패닉 등) — 결과가 영영 안 오니 `저장 중…`에 갇히지 않게(리뷰 B2).
                        tracing::error!("edit worker unavailable");
                        worker_gone(self.views.edit.as_mut(), &mut self.save_in_flight);
                    }
                }
                if out.ask_quit {
                    self.screen = Screen::QuitConfirm(Box::new(self.screen.clone()));
                } else if let Some(s) = out.screen {
                    self.screen = s;
                }
                false
            }
        }
    }

    /// 요청·응답의 `a` — 값 목록을 열었으면 true. 판단은 `value_target`·`enter_values`(순수), 여기는 잇기만.
    fn open_values_here(&mut self) -> bool {
        let lines = self.record_lines();
        let Some(trace_idx) = self.views.value_target(&self.screen, &lines) else {
            return false;
        };
        let state = {
            let (Some(r), Some(st)) = (self.running.as_ref(), self.views.record.as_ref()) else {
                return false;
            };
            let RecordLoad::Loaded(rec) = &st.load else {
                return false;
            };
            let (Some(panel), Some(trace)) =
                (self.panel(&st.board_id, &st.panel_id), rec.trace.as_ref())
            else {
                return false;
            };
            pick::open_values(
                panel,
                trace,
                trace_idx,
                clip_flags(&rec.clipped, trace_idx).1,
                rec.limit_kb,
                &r.session.names,
            )
        };
        match self.views.enter_values(state, self.save_in_flight.as_ref()) {
            Some(s) => {
                self.screen = s;
                true
            }
            None => false,
        }
    }

    /// `Enter` — 목록 → 자세히(정상 회차도), 자세히 → 본문.
    fn activate(&mut self) {
        match self.screen {
            Screen::Errors => {
                let Some(e) = &self.views.errors else {
                    return;
                };
                let results = self.panel_results(&e.board_id, &e.panel_id);
                let list = error_results(&results, e.show_all);
                let rows_at: Vec<i64> = list.iter().map(|r| r.at_ms).collect();
                let Some(clicked) = (!list.is_empty())
                    .then(|| list[crate::inspect::cursor_index(&rows_at, e.cursor_at)].clone())
                else {
                    return;
                };
                // open_record는 본문 상태를 비운다 — 다른 회차를 열면 가림·캐시가 새로 시작한다.
                if let Some((s, req)) = self.views.open_record(clicked) {
                    self.screen = s;
                    self.send_fetch(req);
                }
            }
            Screen::Record => {
                let lines = self.record_lines();
                if let Some(s) = self.views.open_body(&lines) {
                    self.screen = s;
                }
            }
            _ => {}
        }
    }

    /// 새 화면의 위·아래·쪽·처음·끝.
    fn scroll(&mut self, a: Action) {
        let body = sub_layout(self.size).body;
        match self.screen {
            Screen::Errors => {
                let Some((b, p)) = self
                    .views
                    .errors
                    .as_ref()
                    .map(|e| (e.board_id.clone(), e.panel_id.clone()))
                else {
                    return;
                };
                let results = self.panel_results(&b, &p);
                let page = errors_list_height(body).max(1) as isize;
                let delta = match a {
                    Action::Up => -1,
                    Action::Down => 1,
                    Action::PageUp => -page,
                    Action::PageDown => page,
                    Action::Home => isize::MIN,
                    _ => isize::MAX,
                };
                if let Some(e) = self.views.errors.as_mut() {
                    let rows_at: Vec<i64> = error_results(&results, e.show_all)
                        .iter()
                        .map(|r| r.at_ms)
                        .collect();
                    e.cursor_at = move_cursor(&rows_at, e.cursor_at, delta);
                }
            }
            Screen::Record => {
                let len = self.record_lines().len();
                if let Some(r) = self.views.record.as_mut() {
                    let last = len.saturating_sub(1) as isize;
                    let cur = r.cursor as isize;
                    let next = match a {
                        Action::Up => cur - 1,
                        Action::Down => cur + 1,
                        Action::PageUp => cur - 10,
                        Action::PageDown => cur + 10,
                        Action::Home => 0,
                        _ => last,
                    };
                    r.cursor = next.clamp(0, last) as usize;
                }
            }
            Screen::Body => {
                let h = body_height(self.size);
                if let Some(b) = self.views.body.as_mut() {
                    let page = h.max(1) as isize;
                    match a {
                        Action::Up => b.scroll_by(-1, h),
                        Action::Down => b.scroll_by(1, h),
                        Action::PageUp => b.scroll_by(-page, h),
                        Action::PageDown => b.scroll_by(page, h),
                        Action::Home => b.scroll = 0,
                        _ => b.scroll_to_end(h),
                    }
                }
            }
            Screen::Settings => {
                let (n, h) = self.settings_dims();
                self.views.scroll_settings(a, n, h);
            }
            _ => {}
        }
    }
}

/// 세션을 내리는 동안(수 초 걸릴 수 있다) 마지막 화면이 얼어붙어 보이지 않게 한 줄을 그린다.
pub fn draw_closing<B: Backend>(term: &mut Terminal<B>) {
    let _ = term.draw(|f| f.render_widget(Paragraph::new(Line::from(text::CLOSING)), f.area()));
}

fn event_loop(
    app: &mut App,
    term: &mut Terminal<CrosstermBackend<io::Stdout>>,
    quit_signal: &AtomicBool,
) -> io::Result<()> {
    let mut first = matches!(app.screen, Screen::Starting);
    let mut dirty = true;
    let mut last_draw = Instant::now();
    loop {
        // 종료 신호(창 닫기·로그아웃) — 확인 없이 정상 종료 경로로.
        if quit_signal.load(Ordering::SeqCst) {
            draw_closing(term);
            return Ok(());
        }
        let s = term.size()?;
        app.size = Rect::new(0, 0, s.width, s.height);
        if idle_expired(&app.screen, app.last_input, Instant::now()) {
            app.screen = Screen::Monitor;
            idle_return(&mut app.views);
            dirty = true;
        }
        if app.pump() {
            dirty = true;
        }
        // 바뀐 것이 있을 때(입력·새 스냅샷·크기 변경)와 시계용으로 1초에 한 번만 그린다.
        if dirty || app.snap_rx.has_changed().unwrap_or(false) || last_draw.elapsed() >= REDRAW_MAX
        {
            app.snap_rx.borrow_and_update();
            term.draw(|f| app.draw_screen(f, &app.screen))?;
            dirty = false;
            last_draw = Instant::now();
        }
        if first || matches!(app.screen, Screen::Starting) {
            first = false;
            app.start_session();
            // 시작하는 동안 눌린 키가 뒤늦게 실행되지 않게 버린다.
            while event::poll(Duration::ZERO)? {
                event::read()?;
            }
            dirty = true;
            continue;
        }
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let n_boards = app.running.as_ref().map_or(0, |r| r.boards.len());
        let ev = event::read()?;
        if is_user_input(&ev) {
            app.last_input = Instant::now();
        }
        let action = match ev {
            Event::Key(k) if k.kind == KeyEventKind::Press && app.on_edit_screen() => {
                dirty = true;
                if app.edit_key_event(k) {
                    draw_closing(term);
                    return Ok(());
                }
                Action::None
            }
            Event::Key(k) if k.kind == KeyEventKind::Press => handle_key(&app.screen, k, n_boards),
            // 브래킷 붙여넣기: 편집 화면의 입력줄일 때만(아니면 버림 — spec §6.7).
            Event::Paste(p) => {
                if app.on_edit_screen()
                    && let Some(ui) = app.views.edit.as_mut()
                    && paste_into(ui, &p)
                {
                    dirty = true;
                }
                Action::None
            }
            Event::Mouse(m) if app.on_edit_screen() => {
                if app.edit_mouse(m) {
                    draw_closing(term);
                    return Ok(());
                }
                if m.kind != MouseEventKind::Moved {
                    dirty = true;
                }
                Action::None
            }
            Event::Mouse(m) => {
                let size = term.size()?;
                let lay = app.current_layout(Rect::new(0, 0, size.width, size.height));
                handle_mouse(&app.screen, m, &lay)
            }
            Event::Resize(..) => {
                dirty = true;
                Action::None
            }
            _ => Action::None,
        };
        if action != Action::None {
            dirty = true;
        }
        if app.apply(action) {
            draw_closing(term);
            return Ok(());
        }
    }
}

/// 풀스크린 앱을 돌리고 종료 코드를 돌려준다. `file`이 `None`이면 사용법 화면.
pub fn run(rt: &Runtime, file: Option<&Path>, log: LogLoc) -> i32 {
    let guard = match TerminalGuard::enter() {
        Ok(g) => g,
        Err(e) => {
            if file.is_none() {
                println!("{}", text::USAGE);
                return 2;
            }
            eprintln!("터미널을 열 수 없습니다: {e}");
            return 1;
        }
    };
    let backend = CrosstermBackend::new(io::stdout());
    let mut term = match Terminal::new(backend) {
        Ok(t) => t,
        Err(e) => {
            drop(guard);
            eprintln!("터미널을 열 수 없습니다: {e}");
            return 1;
        }
    };
    let (board_tx, _) = watch::channel(String::new());
    let (snap_tx, snap_rx) = watch::channel(PollSnapshot::default());
    let prefs_path = prefs::prefs_path();
    let border = match &prefs_path {
        Some(p) => match prefs::load(p) {
            Loaded::Ok(pr) => pr.border,
            Loaded::Missing => BorderStyle::default(),
            Loaded::Invalid(m) => {
                tracing::warn!("설정 파일을 쓸 수 없어 기본값으로 시작합니다: {m}");
                BorderStyle::default()
            }
        },
        None => {
            tracing::info!(
                "설정 파일 위치를 알 수 없어(XDG_CONFIG_HOME·HOME 없음) 테두리 선택을 이번 실행에만 둡니다"
            );
            BorderStyle::default()
        }
    };
    let mut app = App {
        rt,
        file: file.map(Path::to_path_buf).unwrap_or_default(),
        log,
        screen: if file.is_some() {
            Screen::Starting
        } else {
            Screen::Usage
        },
        running: None,
        idx: 0,
        selected: 0,
        board_tx,
        snap_tx,
        snap_rx,
        poller_dead_logged: Cell::new(false),
        border,
        prefs_path,
        panels_drawn: Cell::new(false),
        views: SubViews::default(),
        fetch_out: mpsc::channel(),
        fetch_req: None,
        size: Rect::default(),
        last_input: Instant::now(),
        edit_out: mpsc::channel(),
        edit_req: None,
        save_in_flight: None,
        save_seq: 0,
        check_seq: 0,
        file_notice: None,
        saved_at: None,
        check_alert: None,
        menu_rows: RefCell::new(Vec::new()),
    };
    let quit_signal = crate::shutdown::install(rt);
    let result = event_loop(&mut app, &mut term, &quit_signal);
    let code = match (&app.screen, &result) {
        (_, Err(_)) => 1,
        (Screen::Usage, _) => 2,
        (Screen::Error(_), _) => 1,
        (Screen::QuitConfirm(inner), _) => match **inner {
            Screen::Error(_) => 1,
            _ => 0,
        },
        _ => 0,
    };
    // 폴러 중지 → 세션 종료 → (guard drop) 터미널 복구. 어느 단계가 실패해도 복구는 한다.
    app.stop_session();
    drop(term);
    drop(guard);
    if let Err(e) = result {
        tracing::error!("UI 루프 오류: {e}");
        let _ = writeln!(
            io::stderr(),
            "{} {}",
            text::PANIC_EXIT,
            text::log_line(&app.log)
        );
    }
    code
}
