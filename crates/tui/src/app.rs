//! 앱 루프 — 메인 스레드의 동기 UI 루프(`event::poll`)가 tokio 런타임을 `block_on`으로 부린다.
//! 키·마우스 해석과 격자 이동은 순수 함수로 분리했다.

use std::cell::Cell;
use std::io;
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

use crate::judge::grid_for;
use crate::logging::LogLoc;
use crate::poll::{PollSnapshot, spawn_poller};
use crate::session::{Session, Stage, StartError};
use crate::terminal::TerminalGuard;
use crate::text;
use crate::view::error::{render_error, render_usage};
use crate::view::model::build_panels;
use crate::view::monitor::{Layout, MonitorScreen, layout, panel_at, render};
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
                KeyCode::Char('?') => Action::OpenHelp,
                _ => Action::None,
            }
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
        })
    }

    fn draw_screen(&self, f: &mut ratatui::Frame, screen: &Screen) {
        match screen {
            Screen::Starting => {
                f.render_widget(Paragraph::new(Line::from(text::STARTING)), f.area());
            }
            Screen::Monitor => {
                if let Some(m) = self.monitor_screen() {
                    render(f, &m);
                }
            }
            Screen::Help => {
                self.draw_screen(f, &Screen::Monitor);
                render_help(f, &self.file, &self.log);
            }
            Screen::QuitConfirm(inner) => {
                self.draw_screen(f, inner);
                render_quit_confirm(f);
            }
            Screen::Error(e) => render_error(f, e, &self.file, &self.log),
            Screen::Usage => render_usage(f),
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
        eprintln!("{} {}", text::PANIC_EXIT, text::log_line(&app.log));
    }
    code
}
