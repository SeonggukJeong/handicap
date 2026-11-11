//! 앱 루프 — 메인 스레드의 동기 UI 루프(`event::poll`)가 tokio 런타임을 `block_on`으로 부린다.
//! 키·마우스 해석과 격자 이동은 순수 함수로 분리했다.

use std::cell::Cell;
use std::collections::HashSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
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
use handicap_controller::monitor::config::PanelConfig;

use crate::api::Api;
use crate::inspect::{
    BodyInput, BodyState, ErrorsInput, ErrorsState, Reason, RecordLoad, RecordState, StepLine,
    clip_flags, error_results, errors_view, initial_step_cursor, load_of, move_cursor,
    neighbor_http, reason_of, record_view, step_lines, visible_results,
};
use crate::judge::grid_for;
use crate::logging::LogLoc;
use crate::panel_settings::{group_note, settings_items, settings_lines};
use crate::poll::{PollSnapshot, spawn_poller};
use crate::prefs::{self, BorderStyle, Loaded, Prefs};
use crate::session::{Session, Stage, StartError};
use crate::terminal::TerminalGuard;
use crate::text;
use crate::view::error::{render_error, render_usage};
use crate::view::inspect::{
    body_height, errors_list_height, render_body, render_errors, render_record, sub_layout,
};
use crate::view::model::build_panels;
use crate::view::monitor::{KeyBar, Layout, MonitorScreen, layout, panel_at, render_with_keys};
use crate::view::overlay::{render_help, render_quit_confirm};
use crate::view::settings::{render_settings, settings_height};
use crate::wire::{BoardResponse, CheckRecord};

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
    /// 칸 설정 보기(§5.4)
    Settings,
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
    OpenSettings,
    Activate,
    ToggleAll,
    ToggleReveal,
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
                KeyCode::Enter => Action::OpenSettings,
                _ => Action::None,
            }
        }
        Screen::Errors | Screen::Record | Screen::Body | Screen::Settings => {
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

/// 새 화면 넷(오류 목록·자세히·본문·칸 설정).
fn is_sub(screen: &Screen) -> bool {
    matches!(
        screen,
        Screen::Errors | Screen::Record | Screen::Body | Screen::Settings
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
        Screen::Record => vec![text::KEYS_PICK_STEP, text::KEYS_BODY, text::KEYS_TO_LIST],
        Screen::Body => {
            let mut keys = vec![text::KEYS_SCROLL, text::KEYS_STEP_NAV];
            if c.has_req_body {
                keys.push(if c.reveal {
                    text::KEYS_HIDE
                } else {
                    text::KEYS_REVEAL
                });
            }
            keys.push(text::KEYS_TO_DETAIL);
            keys
        }
        Screen::Settings => vec![text::KEYS_SCROLL_SHORT, text::KEYS_TO_MONITOR],
        _ => vec![],
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
}

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
}

/// 기록 조회 작업자 — 요청을 **하나씩 차례로** 처리한다(동시에 기록 둘을 메모리에 들지 않는다 —
/// 한 기록이 최대 1 MiB 본문 × 스텝 수). `Reason` 요청은 응답에서 reason·detail만 남기고 기록을 버린다.
/// 돌려받은 Sender를 버리면 작업자가 끝난다. 결과 수신자가 사라져도 끝난다.
/// 로그를 남기지 않는다(URL·본문·사유가 로그로 새지 않게).
pub fn spawn_fetch_worker(
    handle: &Handle,
    api: Api,
    out: mpsc::Sender<Fetched>,
) -> UnboundedSender<FetchReq> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<FetchReq>();
    handle.spawn(async move {
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
            };
            if out.send(msg).is_err() {
                return;
            }
        }
    });
    tx
}

/// 새 화면 상태 묶음 + 화면 전환(순수). App은 이 메서드만 부른다.
#[derive(Debug, Default)]
pub struct SubViews {
    pub errors: Option<ErrorsState>,
    pub record: Option<RecordState>,
    pub body: Option<BodyState>,
    pub settings_scroll: usize,
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
        let req = FetchReq::Record {
            board_id: e.board_id.clone(),
            panel_id: e.panel_id.clone(),
            at_ms: clicked.at_ms,
        };
        self.record = Some(RecordState {
            board_id: e.board_id.clone(),
            panel_id: e.panel_id.clone(),
            at_ms: clicked.at_ms,
            clicked,
            load: RecordLoad::Loading,
            cursor: 0,
        });
        self.body = None;
        Some((Screen::Record, req))
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
            Screen::Body => {
                self.body = None;
                Some(Screen::Record)
            }
            Screen::Record => {
                self.record = None;
                self.body = None;
                Some(Screen::Errors)
            }
            Screen::Errors => {
                self.clear_inspect();
                Some(Screen::Monitor)
            }
            Screen::Settings | Screen::Help => Some(Screen::Monitor),
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
        }
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
        self.poller_dead_logged.set(false);
        self.idx = 0;
        self.selected = 0;
        let rt = self.rt;
        match rt.block_on(self.start_inner()) {
            Ok((session, boards)) => {
                let _guard = rt.enter();
                self.board_tx.send_replace(boards[0].id.clone());
                self.snap_tx.send_replace(PollSnapshot::default());
                let poller = spawn_poller(
                    session.api.clone(),
                    self.board_tx.subscribe(),
                    self.snap_tx.clone(),
                );
                self.fetch_req = Some(spawn_fetch_worker(
                    rt.handle(),
                    session.api.clone(),
                    self.fetch_out.0.clone(),
                ));
                self.running = Some(Running {
                    session,
                    boards,
                    poller,
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
        // 요청 통로를 닫으면 작업자는 처리 중인 요청 하나를 마치고 끝난다.
        self.fetch_req = None;
        if let Some(r) = self.running.take() {
            // 중단을 기다린 뒤 세션을 내린다 — 폴러가 지워지는 DB를 읽는 일이 없게.
            self.rt.block_on(async {
                r.poller.abort();
                let _ = r.poller.await;
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

    /// 칸 설정 보기의 (제목, 줄, 각주) — 선택 칸 기준, 줄은 `width`에 맞춘다.
    fn settings_view(&self, width: usize) -> Option<(String, Vec<String>, Option<String>)> {
        let r = self.running.as_ref()?;
        let board = self.board()?;
        let panel = self.selected_panel()?;
        let lines = settings_lines(&settings_items(panel, &r.session.names), width);
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
        let mut changed = false;
        let mut record_arrived = false;
        while let Ok(msg) = self.fetch_out.1.try_recv() {
            let is_record = matches!(msg, Fetched::Record { .. });
            if self.views.accept(msg) {
                changed = true;
                record_arrived |= is_record;
            }
        }
        if record_arrived {
            let lines = self.record_lines();
            if let Some(r) = self.views.record.as_mut()
                && matches!(r.load, RecordLoad::Loaded(_))
            {
                r.cursor = initial_step_cursor(&lines);
            }
        }
        let inner = match &self.screen {
            Screen::QuitConfirm(inner) => (**inner).clone(),
            s => s.clone(),
        };
        match inner {
            Screen::Errors => changed |= self.pump_errors(),
            Screen::Body => self.pump_body(),
            Screen::Settings => {
                let (n, h) = self.settings_dims();
                self.views.scroll_settings(Action::None, n, h);
            }
            _ => {}
        }
        changed
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
                render_help(f, &self.file, &self.log);
            }
            Screen::QuitConfirm(inner) => {
                self.draw_with(f, inner, KeyBar::QuitConfirm);
                render_quit_confirm(f);
            }
            Screen::Error(e) => render_error(f, e, &self.file, &self.log),
            Screen::Usage => render_usage(f),
            Screen::Errors | Screen::Record | Screen::Body | Screen::Settings => {
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
                let input = ErrorsInput {
                    title: &panel.title,
                    results: &results,
                    thresholds: &panel.thresholds,
                    interval_seconds: panel.interval_seconds,
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
            Screen::Settings => {
                let width = usize::from(sub_layout(f.area()).body.width);
                let Some((title, lines, note)) = self.settings_view(width) else {
                    return;
                };
                render_settings(
                    f,
                    &head,
                    &title,
                    &lines,
                    note.as_deref(),
                    self.views.settings_scroll,
                    &sub_keys(screen, ctx),
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
            Action::OpenSettings => {
                if toggle_allowed(&self.screen, self.panels_drawn.get())
                    && self.selected_panel().is_some()
                {
                    self.screen = self.views.open_settings();
                }
            }
            Action::Activate => self.activate(),
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
            app.views.clear();
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
        if matches!(ev, Event::Key(_) | Event::Mouse(_)) {
            app.last_input = Instant::now();
        }
        let action = match ev {
            Event::Key(k) if k.kind == KeyEventKind::Press => handle_key(&app.screen, k, n_boards),
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
