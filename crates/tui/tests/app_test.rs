//! 앱 루프의 순수 부분(키·마우스·이동·화면 전이·패닉 판정)과 패닉 훅 서브프로세스.

use std::thread;

use handicap_tui::app::{
    Action, Dir, Screen, effective_server_down, handle_key, handle_mouse, move_sel,
    screen_after_start,
};
use handicap_tui::session::{Stage, StartError};
use handicap_tui::terminal::{PanicAction, panic_action, panic_line};
use handicap_tui::view::monitor::Layout;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn err() -> StartError {
    StartError {
        stage: Stage::Import,
        message: "x".into(),
        rest_addr: None,
    }
}

#[test]
fn move_sel_stops_at_edges() {
    assert_eq!(move_sel(2, Dir::Right, (3, 3), 9), 2);
    assert_eq!(move_sel(0, Dir::Left, (3, 3), 9), 0);
    assert_eq!(move_sel(0, Dir::Up, (3, 3), 9), 0);
    assert_eq!(move_sel(8, Dir::Down, (3, 3), 9), 8);
    assert_eq!(move_sel(4, Dir::Right, (3, 3), 9), 5);
    assert_eq!(move_sel(4, Dir::Down, (3, 3), 9), 7);
}

#[test]
fn move_sel_partial_grid() {
    // 5칸 3×2: 윗줄 0 1 2, 아랫줄 3 4
    assert_eq!(move_sel(2, Dir::Down, (3, 2), 5), 2);
    assert_eq!(move_sel(1, Dir::Down, (3, 2), 5), 4);
    assert_eq!(move_sel(4, Dir::Right, (3, 2), 5), 4);
}

#[test]
fn q_asks_then_y_quits() {
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Char('q')), 1),
        Action::AskQuit
    );
    let confirm = Screen::QuitConfirm(Box::new(Screen::Monitor));
    assert_eq!(
        handle_key(&confirm, key(KeyCode::Char('y')), 1),
        Action::Quit
    );
    assert_eq!(
        handle_key(&confirm, key(KeyCode::Char('n')), 1),
        Action::Back
    );
}

#[test]
fn ctrl_c_asks() {
    let k = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert_eq!(handle_key(&Screen::Monitor, k, 1), Action::AskQuit);
}

#[test]
fn tab_ignored_single_board() {
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Tab), 1),
        Action::None
    );
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Tab), 2),
        Action::NextBoard
    );
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::BackTab), 2),
        Action::PrevBoard
    );
}

#[test]
fn error_screen_r_retries() {
    let s = Screen::Error(err());
    assert_eq!(handle_key(&s, key(KeyCode::Char('r')), 0), Action::Retry);
    assert_eq!(handle_key(&s, key(KeyCode::Char('q')), 0), Action::Quit);
}

#[test]
fn usage_q_quits_without_confirm() {
    assert_eq!(
        handle_key(&Screen::Usage, key(KeyCode::Char('q')), 0),
        Action::Quit
    );
}

#[test]
fn screen_after_start_maps_err_to_error() {
    assert_eq!(screen_after_start(&Ok(())), Screen::Monitor);
    assert_eq!(screen_after_start(&Err(err())), Screen::Error(err()));
}

#[test]
fn keys_move_help_back() {
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Char('l')), 1),
        Action::Move(Dir::Right)
    );
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Up), 1),
        Action::Move(Dir::Up)
    );
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Char('?')), 1),
        Action::OpenHelp
    );
    assert_eq!(
        handle_key(&Screen::Help, key(KeyCode::Esc), 1),
        Action::Back
    );
    assert_eq!(
        handle_key(&Screen::Starting, key(KeyCode::Char('j')), 1),
        Action::None
    );
}

fn layout2() -> Layout {
    Layout {
        panels: vec![Rect::new(0, 1, 30, 10), Rect::new(30, 1, 30, 10)],
    }
}

fn mouse(kind: MouseEventKind, x: u16, y: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column: x,
        row: y,
        modifiers: KeyModifiers::NONE,
    }
}

#[test]
fn mouse_left_click_selects() {
    let m = mouse(MouseEventKind::Down(MouseButton::Left), 40, 5);
    assert_eq!(
        handle_mouse(&Screen::Monitor, m, &layout2()),
        Action::Select(1)
    );
}

#[test]
fn mouse_other_events_ignored() {
    let l = layout2();
    for kind in [
        MouseEventKind::Moved,
        MouseEventKind::Down(MouseButton::Right),
        MouseEventKind::Up(MouseButton::Left),
    ] {
        assert_eq!(
            handle_mouse(&Screen::Monitor, mouse(kind, 40, 5), &l),
            Action::None
        );
    }
    // 팝업이 떠 있으면 클릭 무시
    let m = mouse(MouseEventKind::Down(MouseButton::Left), 40, 5);
    assert_eq!(handle_mouse(&Screen::Help, m, &l), Action::None);
}

#[test]
fn panic_action_ui_thread_restores() {
    let id = thread::current().id();
    assert_eq!(panic_action(id, id), PanicAction::RestoreAndPrint);
}

#[test]
fn panic_action_other_thread_logs_only() {
    let ui = thread::current().id();
    let other = thread::spawn(|| thread::current().id()).join().unwrap();
    assert_eq!(panic_action(other, ui), PanicAction::LogOnly);
}

#[test]
fn panic_hook_non_ui_thread_keeps_terminal() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_handicap-tui"))
        .env("HANDICAP_TUI_PANIC_SELFTEST", "1")
        .env("HOME", tmp.path())
        .env("XDG_STATE_HOME", &state)
        .env("XDG_RUNTIME_DIR", tmp.path())
        .env_remove("RUST_LOG")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "stderr={:?}", out.stderr);
    assert!(
        out.stderr.is_empty(),
        "stderr={:?}",
        String::from_utf8_lossy(&out.stderr)
    );
    let log = std::fs::read_to_string(state.join("handicap/tui.log")).unwrap();
    assert!(log.contains("selftest-panic-marker"), "log={log}");
}

#[test]
fn quit_confirm_only_y_quits_ctrl_c_cancels() {
    let confirm = Screen::QuitConfirm(Box::new(Screen::Monitor));
    let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert_eq!(handle_key(&confirm, ctrl_c, 1), Action::Back);
    assert_eq!(handle_key(&confirm, key(KeyCode::Esc), 1), Action::Back);
    assert_eq!(
        handle_key(&confirm, key(KeyCode::Char('q')), 1),
        Action::Back
    );
}

#[test]
fn key_aliases_uppercase_and_korean() {
    let ch = |c: char| key(KeyCode::Char(c));
    let m = Screen::Monitor;
    assert_eq!(handle_key(&m, ch('Q'), 1), Action::AskQuit);
    assert_eq!(handle_key(&m, ch('ㅂ'), 1), Action::AskQuit);
    assert_eq!(handle_key(&m, ch('H'), 1), Action::Move(Dir::Left));
    assert_eq!(handle_key(&m, ch('ㅗ'), 1), Action::Move(Dir::Left));
    assert_eq!(handle_key(&m, ch('ㅓ'), 1), Action::Move(Dir::Down));
    assert_eq!(handle_key(&m, ch('ㅏ'), 1), Action::Move(Dir::Up));
    assert_eq!(handle_key(&m, ch('ㅣ'), 1), Action::Move(Dir::Right));
    let confirm = Screen::QuitConfirm(Box::new(Screen::Monitor));
    assert_eq!(handle_key(&confirm, ch('ㅛ'), 1), Action::Quit);
    assert_eq!(handle_key(&confirm, ch('Y'), 1), Action::Quit);
    let e = Screen::Error(err());
    assert_eq!(handle_key(&e, ch('ㄱ'), 0), Action::Retry);
    assert_eq!(handle_key(&e, ch('R'), 0), Action::Retry);
    assert_eq!(handle_key(&e, ch('ㅂ'), 0), Action::Quit);
    // Ctrl+C는 y의 별칭이 아니다.
    let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert_ne!(handle_key(&confirm, ctrl_c, 1), Action::Quit);
}

#[test]
fn stalled_poller_counts_as_server_down() {
    assert!(effective_server_down(false, true));
    assert!(effective_server_down(true, false));
    assert!(!effective_server_down(false, false));
}

#[test]
fn panic_line_includes_cause_only_when_log_unavailable() {
    use handicap_tui::logging::LogLoc;
    let with_log = panic_line(&LogLoc::Path("/tmp/tui.log".into()), "boom at x.rs:1");
    assert!(with_log.contains("로그: /tmp/tui.log"), "{with_log}");
    assert!(!with_log.contains("boom"), "{with_log}");
    let no_log = panic_line(&LogLoc::Unavailable("권한 없음".into()), "boom at x.rs:1");
    assert!(no_log.contains("로그 없음: 권한 없음"), "{no_log}");
    assert!(no_log.contains("boom at x.rs:1"), "{no_log}");
    let empty = panic_line(&LogLoc::Unavailable(String::new()), "boom");
    assert!(!empty.contains("로그 없음: "), "{empty}");
    assert!(empty.contains("boom"), "{empty}");
}
