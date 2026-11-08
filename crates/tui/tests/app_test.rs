//! 앱 루프의 순수 부분(키·마우스·이동·화면 전이·패닉 판정)과 패닉 훅 서브프로세스.

use std::thread;

use handicap_tui::app::{
    Action, Dir, Screen, effective_server_down, handle_key, handle_mouse, move_sel,
    screen_after_start, toggle_allowed,
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
#[test]
fn closing_frame_shows_shutting_down_text() {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    let mut term = Terminal::new(TestBackend::new(40, 5)).unwrap();
    handicap_tui::app::draw_closing(&mut term);
    let text: String = term
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();
    // 넓은 글자 뒤엔 빈 칸이 끼므로 공백을 지우고 본다.
    let squeezed: String = text.split_whitespace().collect();
    assert!(squeezed.contains("종료중…"), "{text}");
}

#[test]
fn panic_in_check_main_thread_prints_one_stderr_line_and_logs() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_handicap-tui"))
        .env("HANDICAP_TUI_PANIC_SELFTEST", "check-main")
        .env("HOME", tmp.path())
        .env("XDG_STATE_HOME", &state)
        .env("XDG_RUNTIME_DIR", tmp.path())
        .env_remove("RUST_LOG")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(101));
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(err.lines().count(), 1, "stderr={err}");
    assert!(err.contains("핸디캡 모니터 오류로 종료합니다."), "{err}");
    assert!(err.contains("tui-check.log"), "{err}");
    let log = std::fs::read_to_string(state.join("handicap/tui-check.log")).unwrap();
    assert!(log.contains("selftest-check-main-marker"), "log={log}");
}

#[cfg(unix)]
#[test]
fn termination_signals_set_quit_flag() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let rt = tokio::runtime::Runtime::new().unwrap();
    // 진짜 `install`은 5초 뒤 `process::exit(1)`하는 감시견을 건다 — 테스트 바이너리 전체가 죽지 않게
    // 사실상 영원한 유예와 빈 동작을 주입한다.
    let flag = handicap_tui::shutdown::install_with(&rt, Duration::from_secs(3600), || {});
    assert!(!flag.load(Ordering::SeqCst));
    // SAFETY: 핸들러가 설치된 뒤 자기 프로세스에 SIGTERM을 보낸다(기본 동작=종료는 대체됐다).
    unsafe { libc::raise(libc::SIGTERM) };
    let t = Instant::now();
    while !flag.load(Ordering::SeqCst) {
        assert!(t.elapsed() < Duration::from_secs(3), "flag never set");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 종료 신호 뒤 메인 루프가 정상 종료하지 못하면(예: 터미널 읽기에서 막힘) 감시견이 강제 정리를 부른다.
#[cfg(unix)]
#[test]
fn watchdog_fires_when_main_does_not_exit() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    let rt = tokio::runtime::Runtime::new().unwrap();
    let fired = Arc::new(AtomicBool::new(false));
    let f = fired.clone();
    let _flag = handicap_tui::shutdown::install_with(&rt, Duration::from_millis(200), move || {
        f.store(true, Ordering::SeqCst)
    });
    // SAFETY: 핸들러가 설치된 뒤 자기 프로세스에 SIGHUP을 보낸다(기본 동작=종료는 대체됐다).
    unsafe { libc::raise(libc::SIGHUP) };
    let t = Instant::now();
    while !fired.load(Ordering::SeqCst) {
        assert!(t.elapsed() < Duration::from_secs(3), "watchdog never fired");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn b_and_hangul_toggle_border_on_monitor_only() {
    for c in ['b', 'ㅠ', 'B'] {
        assert_eq!(
            handle_key(&Screen::Monitor, key(KeyCode::Char(c)), 1),
            Action::ToggleBorder,
            "{c}"
        );
    }
    let others = [
        Screen::Help,
        Screen::QuitConfirm(Box::new(Screen::Monitor)),
        Screen::Error(err()),
        Screen::Usage,
    ];
    for s in &others {
        assert_ne!(
            handle_key(s, key(KeyCode::Char('b')), 1),
            Action::ToggleBorder,
            "{s:?}"
        );
    }
}

#[test]
fn toggle_allowed_only_when_panels_drawn() {
    assert!(toggle_allowed(&Screen::Monitor, true));
    assert!(!toggle_allowed(&Screen::Monitor, false));
    assert!(!toggle_allowed(&Screen::Help, true));
}
