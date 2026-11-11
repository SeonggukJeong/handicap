//! 앱 루프 — 메인 스레드의 동기 UI 루프(`event::poll`)가 tokio 런타임을 `block_on`으로 부린다.
//! 키·마우스 해석과 격자 이동은 순수 함수로 분리했다.

use std::cell::Cell;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
use tokio::runtime::Runtime;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use handicap_controller::monitor::check::CheckResult;

use crate::inspect::{
    BodyState, ErrorsState, Reason, RecordLoad, RecordState, StepLine, neighbor_http,
};
use crate::judge::grid_for;
use crate::logging::LogLoc;
use crate::poll::{PollSnapshot, spawn_poller};
use crate::prefs::{self, BorderStyle, Loaded, Prefs};
use crate::session::{Session, Stage, StartError};
use crate::terminal::TerminalGuard;
use crate::text;
use crate::view::error::{render_error, render_usage};
use crate::view::model::build_panels;
use crate::view::monitor::{KeyBar, Layout, MonitorScreen, layout, panel_at, render_with_keys};
use crate::view::overlay::{render_help, render_quit_confirm};
use crate::wire::BoardResponse;

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

/// 기록 조회 요청(작업자는 Task 8).
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

/// 테두리 전환은 칸이 실제로 그려진 모니터 화면에서만(보이지 않는 변경을 저장하지 않게).
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
            // Task 8이 채운다.
            Screen::Errors | Screen::Record | Screen::Body | Screen::Settings => {}
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
                } else if matches!(self.screen, Screen::Help) {
                    self.screen = Screen::Monitor;
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
            // Task 8이 연결한다.
            Action::OpenErrors
            | Action::OpenSettings
            | Action::Activate
            | Action::ToggleAll
            | Action::ToggleReveal
            | Action::PrevStep
            | Action::NextStep
            | Action::Up
            | Action::Down
            | Action::PageUp
            | Action::PageDown
            | Action::Home
            | Action::End => {}
        }
        false
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
        let action = match event::read()? {
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
