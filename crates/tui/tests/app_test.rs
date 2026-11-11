//! 앱 루프의 순수 부분(키·마우스·이동·화면 전이·패닉 판정)과 패닉 훅 서브프로세스.

use std::thread;

use std::time::{Duration, Instant};

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_tui::app::{
    Action, CondFocus, Dir, EditAction, EditUi, EnvLoad, FetchReq, Fetched, IDLE_RETURN,
    InputTarget, KeyCtx, Overlay, Pending, ScenLoad, Screen, SubViews, digit_jump, edit_key,
    effective_server_down, handle_key, handle_mouse, idle_drop, idle_expired, is_user_input,
    move_sel, screen_after_start, sub_keys, toggle_allowed,
};
use handicap_tui::edit::{Field, ListKind, Pick};
use handicap_tui::input::{InputMode, InputOutcome, LineInput};
use handicap_tui::inspect::{Reason, RecordLoad, StepLine, cursor_index};
use handicap_tui::session::{Stage, StartError};
use handicap_tui::terminal::{PanicAction, panic_action, panic_line};
use handicap_tui::view::monitor::Layout;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;

/// 전역 신호 처리기를 나눠 쓰는 두 테스트를 차례로 돌린다(§B45 (2)·§B46 (2) — 완화만, 효과 실증 불가).
static SIGNAL_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn key(c: KeyCode) -> KeyEvent {
    KeyEvent::new(c, KeyModifiers::NONE)
}

fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
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
    let _serial = SIGNAL_TESTS.lock().unwrap_or_else(|e| e.into_inner());
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
    let _serial = SIGNAL_TESTS.lock().unwrap_or_else(|e| e.into_inner());
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

// ---------- 1b: 오류 보기·칸 설정 화면 전환 (Task 7) ----------

const SUBS: [Screen; 4] = [
    Screen::Errors,
    Screen::Record,
    Screen::Body,
    Screen::Settings,
];

fn ch(c: char) -> KeyEvent {
    key(KeyCode::Char(c))
}

#[test]
fn monitor_e_and_enter_open_views() {
    for c in ['e', 'ㄷ', 'E'] {
        assert_eq!(
            handle_key(&Screen::Monitor, ch(c), 1),
            Action::OpenErrors,
            "{c}"
        );
    }
    assert_eq!(
        handle_key(&Screen::Monitor, key(KeyCode::Enter), 1),
        Action::OpenSettings
    );
    for s in [Screen::Help, Screen::Error(err()), Screen::Usage] {
        for k in [ch('e'), key(KeyCode::Enter)] {
            let a = handle_key(&s, k, 1);
            assert!(
                a != Action::OpenErrors && a != Action::OpenSettings,
                "{s:?} {a:?}"
            );
        }
    }
}

#[test]
fn sub_screen_keys() {
    let e = Screen::Errors;
    let nav = [
        (key(KeyCode::Up), Action::Up),
        (ch('k'), Action::Up),
        (key(KeyCode::Down), Action::Down),
        (ch('j'), Action::Down),
        (key(KeyCode::PageUp), Action::PageUp),
        (key(KeyCode::PageDown), Action::PageDown),
        (key(KeyCode::Home), Action::Home),
        (key(KeyCode::End), Action::End),
        (key(KeyCode::Esc), Action::Back),
        (ch('q'), Action::AskQuit),
    ];
    for s in &SUBS {
        for (k, want) in nav {
            assert_eq!(handle_key(s, k, 2), want, "{s:?} {k:?}");
        }
        for k in [key(KeyCode::Tab), ch('b'), ch('?')] {
            assert_eq!(handle_key(s, k, 2), Action::None, "{s:?} {k:?}");
        }
    }
    for c in ['a', 'ㅁ'] {
        assert_eq!(handle_key(&e, ch(c), 1), Action::ToggleAll, "{c}");
    }
    assert_eq!(handle_key(&e, key(KeyCode::Enter), 1), Action::Activate);
    assert_eq!(handle_key(&e, key(KeyCode::Left), 1), Action::None);

    let r = Screen::Record;
    assert_eq!(handle_key(&r, ch('a'), 1), Action::None);
    assert_eq!(handle_key(&r, key(KeyCode::Enter), 1), Action::Activate);
    assert_eq!(handle_key(&r, key(KeyCode::Left), 1), Action::None);
    assert_eq!(handle_key(&r, key(KeyCode::Right), 1), Action::None);
    assert_eq!(handle_key(&r, ch('v'), 1), Action::None);

    let b = Screen::Body;
    for c in ['v', 'ㅍ'] {
        assert_eq!(handle_key(&b, ch(c), 1), Action::ToggleReveal, "{c}");
    }
    assert_eq!(handle_key(&b, key(KeyCode::Left), 1), Action::PrevStep);
    assert_eq!(handle_key(&b, ch('h'), 1), Action::PrevStep);
    assert_eq!(handle_key(&b, key(KeyCode::Right), 1), Action::NextStep);
    assert_eq!(handle_key(&b, ch('l'), 1), Action::NextStep);
    assert_eq!(handle_key(&b, key(KeyCode::Enter), 1), Action::None);
    assert_eq!(handle_key(&b, ch('a'), 1), Action::None);

    let st = Screen::Settings;
    assert_eq!(handle_key(&st, key(KeyCode::Enter), 1), Action::None);
    assert_eq!(handle_key(&st, ch('1'), 1), Action::None);
    assert_eq!(handle_key(&st, key(KeyCode::Esc), 1), Action::Back);
    assert_eq!(handle_key(&st, ch('e'), 1), Action::None);
}

#[test]
fn ctrl_letters_ignored_on_monitor_and_sub_screens_only() {
    assert_eq!(handle_key(&Screen::Monitor, ctrl('b'), 1), Action::None);
    assert_eq!(handle_key(&Screen::Monitor, ctrl('e'), 1), Action::None);
    assert_eq!(handle_key(&Screen::Errors, ctrl('a'), 1), Action::None);
    assert_eq!(handle_key(&Screen::Body, ctrl('v'), 1), Action::None);
    for s in [Screen::Monitor, Screen::Errors] {
        assert_eq!(handle_key(&s, ctrl('c'), 1), Action::AskQuit, "{s:?}");
        assert_eq!(handle_key(&s, ctrl('q'), 1), Action::AskQuit, "{s:?}");
    }
    let confirm = Screen::QuitConfirm(Box::new(Screen::Errors));
    assert_eq!(handle_key(&confirm, ctrl('y'), 1), Action::Back);
    assert_eq!(handle_key(&confirm, ctrl('c'), 1), Action::Back);
    assert_eq!(handle_key(&confirm, ch('y'), 1), Action::Quit);
    assert_eq!(
        handle_key(&Screen::Error(err()), ctrl('c'), 1),
        Action::Quit
    );
    assert_eq!(handle_key(&Screen::Help, ctrl('c'), 1), Action::AskQuit);
}

fn ctx() -> KeyCtx {
    KeyCtx {
        quit_confirm: false,
        show_all: false,
        reveal: false,
        has_req_body: false,
    }
}

#[test]
fn sub_keys_per_screen() {
    assert_eq!(
        sub_keys(&Screen::Errors, ctx()),
        ["↑↓ 고르기", "a 전체 회차", "Enter 자세히", "Esc 모니터로"]
    );
    let all = KeyCtx {
        show_all: true,
        ..ctx()
    };
    assert_eq!(
        sub_keys(&Screen::Errors, all),
        ["↑↓ 고르기", "a 실패만", "Enter 자세히", "Esc 모니터로"]
    );
    assert_eq!(
        sub_keys(&Screen::Record, ctx()),
        ["↑↓ 스텝 고르기", "Enter 요청·응답 보기", "Esc 목록으로"]
    );
    assert_eq!(
        sub_keys(&Screen::Body, ctx()),
        ["↑↓ PgUp PgDn 스크롤", "←→ 이전·다음 스텝", "Esc 자세히로"]
    );
    let body = KeyCtx {
        has_req_body: true,
        ..ctx()
    };
    assert_eq!(
        sub_keys(&Screen::Body, body),
        [
            "↑↓ PgUp PgDn 스크롤",
            "←→ 이전·다음 스텝",
            "v 요청 본문 보기",
            "Esc 자세히로"
        ]
    );
    let shown = KeyCtx {
        reveal: true,
        ..body
    };
    assert!(sub_keys(&Screen::Body, shown).contains(&"v 가리기"));
    assert_eq!(
        sub_keys(&Screen::Settings, ctx()),
        ["↑↓ 스크롤", "Esc 모니터로"]
    );
    let q = KeyCtx {
        quit_confirm: true,
        ..ctx()
    };
    for s in &SUBS {
        assert_eq!(sub_keys(s, q), ["y 종료", "다른 키 취소"], "{s:?}");
        assert!(!sub_keys(s, ctx()).contains(&"q 종료"), "{s:?}");
    }
}

#[test]
fn idle_input_ignores_bare_mouse_moves() {
    use ratatui::crossterm::event::Event;
    let mouse = |kind| {
        Event::Mouse(MouseEvent {
            kind,
            column: 1,
            row: 1,
            modifiers: KeyModifiers::NONE,
        })
    };
    assert!(is_user_input(&Event::Key(KeyEvent::new(
        KeyCode::Char('e'),
        KeyModifiers::NONE
    ))));
    assert!(is_user_input(&mouse(MouseEventKind::Down(
        MouseButton::Left
    ))));
    assert!(is_user_input(&mouse(MouseEventKind::ScrollDown)));
    assert!(!is_user_input(&mouse(MouseEventKind::Moved)));
    assert!(!is_user_input(&Event::Resize(80, 24)));
    assert!(!is_user_input(&Event::FocusGained));
}

#[test]
fn idle_expired_rules() {
    assert_eq!(IDLE_RETURN, Duration::from_secs(300));
    let t0 = Instant::now();
    for s in &SUBS {
        assert!(!idle_expired(s, t0, t0 + Duration::from_secs(299)), "{s:?}");
        assert!(idle_expired(s, t0, t0 + Duration::from_secs(300)), "{s:?}");
    }
    let wrapped = Screen::QuitConfirm(Box::new(Screen::Errors));
    assert!(idle_expired(&wrapped, t0, t0 + Duration::from_secs(300)));
    let hour = t0 + Duration::from_secs(3600);
    for s in [
        Screen::QuitConfirm(Box::new(Screen::Monitor)),
        Screen::Help,
        Screen::Monitor,
        Screen::Starting,
        Screen::Usage,
        Screen::Error(err()),
    ] {
        assert!(!idle_expired(&s, t0, hour), "{s:?}");
    }
    // 시계 역전 — last_input이 now보다 뒤.
    assert!(!idle_expired(&Screen::Errors, hour, t0));
}

#[test]
fn open_errors_pins_cursor_to_first_row() {
    let mut v = SubViews::default();
    assert_eq!(v.open_errors("B", "P", &[30, 20, 10]), Screen::Errors);
    let e = v.errors.as_ref().unwrap();
    assert_eq!((e.board_id.as_str(), e.panel_id.as_str()), ("B", "P"));
    assert_eq!(e.cursor_at, Some(30));
    assert_eq!(cursor_index(&[40, 30, 20, 10], e.cursor_at), 1);

    let mut v = SubViews::default();
    v.open_errors("B", "P", &[]);
    let e = v.errors.as_mut().unwrap();
    assert_eq!(e.cursor_at, None);
    e.pin_cursor(&[10]);
    assert_eq!(e.cursor_at, Some(10));
    assert_eq!(cursor_index(&[20, 10], e.cursor_at), 1);

    // show_all을 끄며 커서 줄(정상 회차 25)이 빠지면 그보다 오래된 첫 실패 줄로 다시 고정.
    e.show_all = true;
    e.cursor_at = Some(25);
    e.show_all = false;
    e.pin_cursor(&[30, 20, 10]);
    assert_eq!(e.cursor_at, Some(20));
    e.pin_cursor(&[]);
    assert_eq!(e.cursor_at, None);
}

fn result(at: i64) -> CheckResult {
    CheckResult {
        at_ms: at,
        verdict: Verdict::Fail,
        latency_ms: Some(5),
        reason: None,
        detail: None,
        display: vec![],
    }
}

fn http_line(trace_idx: usize) -> StepLine {
    StepLine::Http {
        trace_idx,
        no: trace_idx + 1,
        loop_index: None,
        name: format!("s{trace_idx}"),
        method: None,
        url: None,
        status: None,
        latency_ms: None,
        error: None,
        timed_out: false,
        focus: false,
    }
}

fn lines3() -> Vec<StepLine> {
    vec![
        http_line(0),
        StepLine::If {
            branch: "then".into(),
        },
        http_line(2),
    ]
}

#[test]
fn sub_views_transitions() {
    let mut v = SubViews::default();
    assert!(v.open_record(result(7)).is_none(), "errors 없이");
    v.open_errors("B", "P", &[7]);
    assert_eq!(
        v.open_record(result(7)),
        Some((
            Screen::Record,
            FetchReq::Record {
                board_id: "B".into(),
                panel_id: "P".into(),
                at_ms: 7
            }
        ))
    );
    {
        let r = v.record.as_ref().unwrap();
        assert_eq!(
            (r.board_id.as_str(), r.panel_id.as_str(), r.at_ms),
            ("B", "P", 7)
        );
        assert_eq!(r.clicked.at_ms, 7);
        assert!(matches!(r.load, RecordLoad::Loading));
        assert_eq!(r.cursor, 0);
    }
    let lines = lines3();
    v.record.as_mut().unwrap().cursor = 1;
    assert_eq!(v.open_body(&lines), None, "If 줄");
    assert!(v.body.is_none());
    v.record.as_mut().unwrap().cursor = 0;
    assert_eq!(v.open_body(&lines), Some(Screen::Body));
    assert_eq!(v.body.as_ref().unwrap().line_idx, 0);

    // 옆 스텝으로 — BodyState를 새로 만든다(가림·스크롤·캐시 초기화).
    {
        let b = v.body.as_mut().unwrap();
        b.reveal = true;
        b.scroll = 9;
    }
    assert!(v.step_body(&lines, 1));
    {
        let b = v.body.as_ref().unwrap();
        assert_eq!((b.line_idx, b.reveal, b.scroll), (2, false, 0));
        assert!(b.lines().is_empty(), "이전 스텝의 줄이 남지 않는다");
    }
    assert_eq!(v.record.as_ref().unwrap().cursor, 2);
    v.body.as_mut().unwrap().scroll = 4;
    assert!(!v.step_body(&lines, 1), "끝");
    assert_eq!(v.body.as_ref().unwrap().scroll, 4, "body 불변");
    assert!(v.step_body(&lines, -1));
    assert_eq!(v.body.as_ref().unwrap().line_idx, 0);
    assert_eq!(v.record.as_ref().unwrap().cursor, 0);

    v.body.as_mut().unwrap().reveal = true;
    assert_eq!(v.back(&Screen::Body), Some(Screen::Record));
    assert!(v.body.is_none());
    assert_eq!(v.open_body(&lines), Some(Screen::Body));
    assert!(!v.body.as_ref().unwrap().reveal, "다시 열면 가림");
    v.back(&Screen::Body);

    assert_eq!(v.back(&Screen::Record), Some(Screen::Errors));
    assert!(v.record.is_none());
    assert_eq!(v.back(&Screen::Errors), Some(Screen::Monitor));
    assert!(v.errors.is_none());
    assert_eq!(v.open_settings(), Screen::Settings);
    v.settings_scroll = 3;
    assert_eq!(v.open_settings(), Screen::Settings);
    assert_eq!(v.settings_scroll, 0);
    assert_eq!(v.back(&Screen::Settings), Some(Screen::Monitor));
    assert_eq!(v.back(&Screen::Help), Some(Screen::Monitor));
    assert_eq!(v.back(&Screen::Monitor), None);
    assert_eq!(v.back(&Screen::Starting), None);
    assert!(v.open_record(result(7)).is_none());
}

#[test]
fn idle_return_clears_views() {
    let mut v = SubViews::default();
    v.open_errors("B", "P", &[7]);
    v.open_record(result(7)).unwrap();
    v.open_body(&lines3()).unwrap();
    v.body.as_mut().unwrap().reveal = true;
    v.settings_scroll = 7;
    v.clear();
    assert!(v.errors.is_none() && v.record.is_none() && v.body.is_none());
    assert_eq!(v.settings_scroll, 0);
}

#[test]
fn fetched_for_other_panel_is_dropped() {
    let reason = |b: &str, p: &str, at: i64, r: Reason| Fetched::Reason {
        board_id: b.into(),
        panel_id: p.into(),
        at_ms: at,
        reason: r,
    };
    let record = |b: &str, p: &str, at: i64| Fetched::Record {
        board_id: b.into(),
        panel_id: p.into(),
        at_ms: at,
        load: RecordLoad::Gone,
    };
    let mut v = SubViews::default();
    assert!(
        !v.accept(reason("B", "P1", 5, Reason::Gone)),
        "화면을 이미 나감"
    );
    v.open_errors("B", "P1", &[7, 5]);
    let cached = |v: &SubViews| {
        v.errors
            .as_ref()
            .unwrap()
            .cache
            .reason_for(&result(5), false)
    };
    assert!(!v.accept(reason("B", "P2", 5, Reason::Gone)));
    assert!(!v.accept(reason("X", "P1", 5, Reason::Gone)));
    assert_eq!(cached(&v), Reason::Loading);
    assert!(v.accept(reason("B", "P1", 5, Reason::Gone)));
    assert_eq!(cached(&v), Reason::Gone);

    assert!(!v.accept(record("B", "P1", 7)), "기록 화면 없음");
    v.open_record(result(7)).unwrap();
    assert!(!v.accept(record("B", "P1", 8)));
    // 묶음의 다른 칸 — 같은 at_ms.
    assert!(!v.accept(record("B", "P2", 7)));
    assert!(!v.accept(record("X", "P1", 7)));
    assert!(matches!(
        v.record.as_ref().unwrap().load,
        RecordLoad::Loading
    ));
    assert!(v.accept(record("B", "P1", 7)));
    assert!(matches!(v.record.as_ref().unwrap().load, RecordLoad::Gone));
}

#[test]
fn settings_scroll_is_capped_to_last_page() {
    // 줄 12개·보이는 줄 5개 → 상한 7. 끝까지 내려도 빈 화면이 되지 않는다.
    let mut v = SubViews::default();
    v.open_settings();
    for _ in 0..20 {
        v.scroll_settings(Action::Down, 12, 5);
    }
    assert_eq!(v.settings_scroll, 7);
    v.scroll_settings(Action::PageDown, 12, 5);
    assert_eq!(v.settings_scroll, 7);
    v.scroll_settings(Action::PageUp, 12, 5);
    assert_eq!(v.settings_scroll, 2);
    v.scroll_settings(Action::Up, 12, 5);
    v.scroll_settings(Action::Up, 12, 5);
    v.scroll_settings(Action::Up, 12, 5);
    assert_eq!(v.settings_scroll, 0);
    v.scroll_settings(Action::End, 12, 5);
    assert_eq!(v.settings_scroll, 7);
    // 화면이 커지면(보이는 줄 10) 다음 가둠에서 상한 2로.
    v.scroll_settings(Action::None, 12, 10);
    assert_eq!(v.settings_scroll, 2);
    v.scroll_settings(Action::Home, 12, 10);
    assert_eq!(v.settings_scroll, 0);
    // 다 보이면 0에 머문다.
    v.scroll_settings(Action::PageDown, 3, 10);
    assert_eq!(v.settings_scroll, 0);
}

// ---- tui-2a-1 Task 7: 편집 화면 상태·키 ----

fn text_input(initial: &str) -> LineInput {
    LineInput::new(initial, InputMode::Text { max_chars: 2000 })
}

fn ui_with(o: Overlay) -> EditUi {
    EditUi {
        overlay: Some(o),
        ..EditUi::default()
    }
}

fn input_overlay(initial: &str) -> Overlay {
    Overlay::Input {
        target: InputTarget::Field(Field::Title),
        input: text_input(initial),
        error: None,
        share: None,
    }
}

fn ek(screen: &Screen, ui: &EditUi, k: KeyEvent) -> EditAction {
    edit_key(screen, ui, k, Instant::now())
}

#[test]
fn input_mode_keys_are_literal() {
    let ui = ui_with(input_overlay(""));
    for c in ['q', 'ㅂ', 'j', '?', 'Q'] {
        assert_eq!(
            ek(&Screen::Settings, &ui, key(KeyCode::Char(c))),
            EditAction::Input(InputOutcome::Edited),
            "{c}"
        );
    }
    assert_eq!(
        ek(&Screen::Settings, &ui, ctrl('c')),
        EditAction::Input(InputOutcome::AskQuit)
    );
    assert_eq!(
        ek(&Screen::Settings, &ui, key(KeyCode::Enter)),
        EditAction::Input(InputOutcome::Submit)
    );
    assert_eq!(
        ek(&Screen::Settings, &ui, key(KeyCode::Esc)),
        EditAction::Input(InputOutcome::Cancel)
    );
    // edit_key는 버퍼를 바꾸지 않는다(호출 쪽이 키를 한 번 적용).
    let Some(Overlay::Input { input, .. }) = &ui.overlay else {
        unreachable!()
    };
    assert_eq!(input.text(), "");
    // overlay가 없는 메뉴에서는 화면 규칙.
    let none = EditUi::default();
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Char('q'))),
        EditAction::AskQuit
    );
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Char('ㅂ'))),
        EditAction::AskQuit
    );
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Char('j'))),
        EditAction::MoveCursor(1)
    );
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Char('?'))),
        EditAction::None
    );
    assert_eq!(ek(&Screen::Settings, &none, ctrl('c')), EditAction::AskQuit);
    assert_eq!(ek(&Screen::Settings, &none, ctrl('b')), EditAction::None);
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Esc)),
        EditAction::Back
    );
    assert_eq!(
        ek(&Screen::Settings, &none, key(KeyCode::Enter)),
        EditAction::Activate
    );
}

#[test]
fn menu_digit_jump() {
    let t0 = Instant::now();
    assert_eq!(digit_jump(None, 3, t0), (3, None));
    let (n, pend) = digit_jump(None, 1, t0);
    assert_eq!(n, 1);
    assert_eq!(pend, Some((1, t0)));
    // 0.5초 뒤 2 → 12, 대기 지움
    assert_eq!(
        digit_jump(pend, 2, t0 + Duration::from_millis(500)),
        (12, None)
    );
    assert_eq!(
        digit_jump(pend, 0, t0 + Duration::from_millis(500)),
        (10, None)
    );
    assert_eq!(
        digit_jump(pend, 4, t0 + Duration::from_millis(500)),
        (14, None)
    );
    // 1.5초 뒤 2 → 2
    assert_eq!(
        digit_jump(pend, 2, t0 + Duration::from_millis(1500)),
        (2, None)
    );
    // 경계: 정확히 1초는 지난 것으로 본다(`<` 1초만 대기 안).
    assert_eq!(digit_jump(pend, 2, t0 + Duration::from_secs(1)), (2, None));
    assert_eq!(
        digit_jump(pend, 2, t0 + Duration::from_millis(999)),
        (12, None)
    );
    // 대기 중 7 → 7
    assert_eq!(
        digit_jump(pend, 7, t0 + Duration::from_millis(100)),
        (7, None)
    );
    // 대기 중 1 → 11(0–4 규칙), 대기 지움
    assert_eq!(
        digit_jump(pend, 1, t0 + Duration::from_millis(100)),
        (11, None)
    );
    // 대기가 지나간 뒤 1 → 1, 새 대기
    let later = t0 + Duration::from_secs(2);
    assert_eq!(digit_jump(pend, 1, later), (1, Some((1, later))));
    // 시계 역전(now < 표시 시각)도 패닉 없이 "대기 안"으로 본다.
    assert_eq!(
        digit_jump(Some((1, t0 + Duration::from_secs(5))), 2, t0),
        (12, None)
    );

    // edit_key: 0 단독은 무동작, 1 뒤 0은 Digit(0)
    let mut ui = EditUi::default();
    assert_eq!(
        edit_key(&Screen::Settings, &ui, key(KeyCode::Char('0')), t0),
        EditAction::None
    );
    assert_eq!(
        edit_key(&Screen::Settings, &ui, key(KeyCode::Char('3')), t0),
        EditAction::Digit(3)
    );
    ui.digit = Some((1, t0));
    assert_eq!(
        edit_key(
            &Screen::Settings,
            &ui,
            key(KeyCode::Char('0')),
            t0 + Duration::from_millis(300)
        ),
        EditAction::Digit(0)
    );
    assert_eq!(
        edit_key(
            &Screen::Settings,
            &ui,
            key(KeyCode::Char('0')),
            t0 + Duration::from_secs(2)
        ),
        EditAction::None
    );
    // 하위 화면에서 숫자는 무동작
    assert_eq!(
        ek(
            &Screen::EditList,
            &EditUi::default(),
            key(KeyCode::Char('3'))
        ),
        EditAction::None
    );
}

#[test]
fn list_screen_keys_normalize() {
    let ui = EditUi::default();
    let l = Screen::EditList;
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('ㅇ'))), EditAction::Remove);
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('d'))), EditAction::Remove);
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('ㄴ'))), EditAction::Swap);
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('ㅁ'))), EditAction::Add);
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('A'))), EditAction::Add);
    assert_eq!(
        ek(&l, &ui, key(KeyCode::Char('ㅓ'))),
        EditAction::MoveCursor(1)
    );
    assert_eq!(
        ek(&l, &ui, key(KeyCode::Char('ㅏ'))),
        EditAction::MoveCursor(-1)
    );
    assert_eq!(ek(&l, &ui, key(KeyCode::Enter)), EditAction::Activate);
    assert_eq!(ek(&l, &ui, key(KeyCode::Esc)), EditAction::Back);
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('ㅂ'))), EditAction::AskQuit);
    assert_eq!(
        ek(&Screen::EnvVars, &ui, key(KeyCode::Char('ㅍ'))),
        EditAction::ToggleReveal
    );
    assert_eq!(
        ek(&Screen::EnvVars, &ui, key(KeyCode::Char('v'))),
        EditAction::ToggleReveal
    );
    // 변수 화면엔 a/d/s가 없다
    assert_eq!(
        ek(&Screen::EnvVars, &ui, key(KeyCode::Char('d'))),
        EditAction::None
    );
    assert_eq!(
        ek(&Screen::ScenarioVars, &ui, key(KeyCode::Char('a'))),
        EditAction::None
    );
    assert_eq!(
        ek(&Screen::ScenarioVars, &ui, key(KeyCode::Char('v'))),
        EditAction::None
    );
    // 목록에는 v가 없다
    assert_eq!(ek(&l, &ui, key(KeyCode::Char('v'))), EditAction::None);
}

#[test]
fn cond_form_keys() {
    let form = |focus| Overlay::CondForm {
        index: 0,
        ops: vec![],
        op: 0,
        value: text_input("x"),
        ignore_case: false,
        trim: false,
        focus,
        error: None,
    };
    let s = Screen::EditList;
    let ui = ui_with(form(CondFocus::Trim));
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Tab)),
        EditAction::CondKey(key(KeyCode::Tab))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Char(' '))),
        EditAction::CondKey(key(KeyCode::Char(' ')))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::BackTab)),
        EditAction::CondKey(key(KeyCode::BackTab))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Enter)),
        EditAction::CondKey(key(KeyCode::Enter))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Esc)),
        EditAction::CondKey(key(KeyCode::Esc))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Left)),
        EditAction::CondKey(key(KeyCode::Left))
    );
    assert_eq!(ek(&s, &ui, ctrl('c')), EditAction::AskQuit);
    // 값 칸 = 입력줄 규칙: 글자·Space는 글자, Tab·Enter·Esc는 폼으로.
    let ui = ui_with(form(CondFocus::Value));
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Char('q'))),
        EditAction::Input(InputOutcome::Edited)
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Char(' '))),
        EditAction::Input(InputOutcome::Edited)
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Left)),
        EditAction::Input(InputOutcome::Edited)
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Tab)),
        EditAction::CondKey(key(KeyCode::Tab))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Enter)),
        EditAction::CondKey(key(KeyCode::Enter))
    );
    assert_eq!(
        ek(&s, &ui, key(KeyCode::Esc)),
        EditAction::CondKey(key(KeyCode::Esc))
    );
    assert_eq!(
        ek(&s, &ui, ctrl('c')),
        EditAction::Input(InputOutcome::AskQuit)
    );
}

#[test]
fn confirm_y_only() {
    let confirm = |y_only| {
        ui_with(Overlay::Confirm {
            text: "t".into(),
            then: Pending::Remove(ListKind::Thresholds, 0),
            y_only,
        })
    };
    let s = Screen::EditList;
    let del = confirm(true);
    assert_eq!(
        ek(&s, &del, key(KeyCode::Char('y'))),
        EditAction::ConfirmYes
    );
    assert_eq!(
        ek(&s, &del, key(KeyCode::Char('ㅛ'))),
        EditAction::ConfirmYes
    );
    assert_eq!(ek(&s, &del, key(KeyCode::Enter)), EditAction::ConfirmNo);
    assert_eq!(ek(&s, &del, key(KeyCode::Char('n'))), EditAction::ConfirmNo);
    assert_eq!(ek(&s, &del, key(KeyCode::Esc)), EditAction::ConfirmNo);
    let step = confirm(false);
    assert_eq!(ek(&s, &step, key(KeyCode::Enter)), EditAction::ConfirmYes);
    assert_eq!(ek(&s, &step, key(KeyCode::Esc)), EditAction::ConfirmNo);
    assert_eq!(
        ek(&s, &step, key(KeyCode::Char('x'))),
        EditAction::ConfirmNo
    );
}

#[test]
fn notice_swallows_next_key() {
    let ui = ui_with(Overlay::Notice("안내".into()));
    for k in [
        key(KeyCode::Down),
        key(KeyCode::Char('q')),
        key(KeyCode::Enter),
        ctrl('b'),
    ] {
        assert_eq!(ek(&Screen::Settings, &ui, k), EditAction::CloseNotice);
    }
    assert_eq!(ui.cursor, 0);
}

#[test]
fn pick_and_saving_keys() {
    let pick = ui_with(Overlay::Pick {
        pick: Pick::Env,
        options: vec![(None, "환경 없음".into())],
        cursor: 0,
    });
    let s = Screen::Settings;
    assert_eq!(ek(&s, &pick, key(KeyCode::Down)), EditAction::PickMove(1));
    assert_eq!(
        ek(&s, &pick, key(KeyCode::Char('ㅏ'))),
        EditAction::PickMove(-1)
    );
    assert_eq!(ek(&s, &pick, key(KeyCode::Enter)), EditAction::PickChoose);
    assert_eq!(ek(&s, &pick, key(KeyCode::Esc)), EditAction::Back);
    assert_eq!(ek(&s, &pick, key(KeyCode::Char('q'))), EditAction::AskQuit);
    assert_eq!(ek(&s, &pick, key(KeyCode::Char('d'))), EditAction::None);
    let saving = ui_with(Overlay::Saving { restore: None });
    assert_eq!(ek(&s, &saving, key(KeyCode::Esc)), EditAction::None);
    assert_eq!(ek(&s, &saving, key(KeyCode::Enter)), EditAction::None);
    assert_eq!(
        ek(&s, &saving, key(KeyCode::Char('q'))),
        EditAction::AskQuit
    );
    assert_eq!(ek(&s, &saving, ctrl('c')), EditAction::AskQuit);
}

#[test]
fn idle_drops_overlay_keeps_pending_save() {
    for o in [
        input_overlay("v"),
        Overlay::Pick {
            pick: Pick::Step,
            options: vec![],
            cursor: 0,
        },
        Overlay::Confirm {
            text: "t".into(),
            then: Pending::SetEnv(None),
            y_only: false,
        },
        Overlay::Notice("n".into()),
    ] {
        let mut ui = ui_with(o);
        idle_drop(&mut ui);
        assert!(ui.overlay.is_none());
    }
    let mut ui = ui_with(Overlay::Saving {
        restore: Some(Box::new(input_overlay("v"))),
    });
    idle_drop(&mut ui);
    assert!(matches!(ui.overlay, Some(Overlay::Saving { .. })));
}

#[test]
fn idle_applies_to_edit_screens() {
    let t0 = Instant::now();
    for s in [Screen::EnvVars, Screen::EditList, Screen::ScenarioVars] {
        assert!(
            !idle_expired(&s, t0, t0 + Duration::from_secs(299)),
            "{s:?}"
        );
        assert!(idle_expired(&s, t0, t0 + IDLE_RETURN), "{s:?}");
        let wrapped = Screen::QuitConfirm(Box::new(s));
        assert!(idle_expired(&wrapped, t0, t0 + IDLE_RETURN));
    }
}

#[test]
fn back_from_edit_screens_clears_secret_state() {
    let mut v = SubViews {
        edit: Some(EditUi {
            reveal: true,
            env: Some(EnvLoad::Loading { id: "e".into() }),
            scen: Some(ScenLoad::Failed("x".into())),
            list_cursor: 4,
            ..EditUi::default()
        }),
        ..SubViews::default()
    };
    assert_eq!(v.back(&Screen::EnvVars), Some(Screen::Settings));
    let e = v.edit.as_ref().unwrap();
    assert!(!e.reveal && e.env.is_none() && e.list_cursor == 0);
    assert!(
        e.scen.is_some(),
        "EnvVars를 나가도 시나리오 쪽은 건드리지 않는다"
    );
    assert_eq!(v.back(&Screen::ScenarioVars), Some(Screen::Settings));
    assert!(v.edit.as_ref().unwrap().scen.is_none());
    assert_eq!(v.back(&Screen::EditList), Some(Screen::Settings));
}

#[test]
fn edit_ui_debug_hides_values() {
    let ui = EditUi {
        overlay: Some(Overlay::Input {
            target: InputTarget::EnvVar("API_KEY_NAME".into()),
            input: text_input("TYPED-SECRET-77"),
            error: None,
            share: None,
        }),
        env: Some(EnvLoad::Loaded(
            serde_json::from_value(serde_json::json!({
                "id": "e1", "name": "ENVNAME", "vars": {"K": "ENV-SECRET-99"},
                "created_at": 1, "updated_at": 2
            }))
            .unwrap(),
        )),
        scen: Some(ScenLoad::Loaded {
            id: "s1".into(),
            yaml: "variables:\n  a: YAML-SECRET-55\n".into(),
            version: 1,
            vars: vec![],
        }),
        ..EditUi::default()
    };
    let d = format!("{ui:?}");
    for leak in [
        "TYPED-SECRET-77",
        "ENV-SECRET-99",
        "YAML-SECRET-55",
        "API_KEY_NAME",
    ] {
        assert!(!d.contains(leak), "{leak} leaked: {d}");
    }
    assert!(d.contains("<가림>"));
}
