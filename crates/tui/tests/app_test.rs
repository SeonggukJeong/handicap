//! 앱 루프의 순수 부분(키·마우스·이동·화면 전이·패닉 판정)과 패닉 훅 서브프로세스.

use std::thread;

use std::time::{Duration, Instant};

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_tui::app::{
    Action, CheckThen, CheckWait, CondFocus, CondTarget, Dir, EditAction, EditUi, EnvLoad,
    FetchReq, Fetched, IDLE_RETURN, InputTarget, KeyCtx, Overlay, Pending, ScenLoad, Screen,
    SubViews, digit_jump, edit_key, effective_server_down, handle_key, handle_mouse, idle_drop,
    idle_expired, is_edit_screen, is_user_input, move_sel, screen_after_start, start_check,
    sub_keys, toggle_allowed,
};
use handicap_tui::app::{check_open_allowed, check_ready, check_reply};
use handicap_tui::edit::{Field, ListKind, Pick};
use handicap_tui::input::{InputMode, InputOutcome, LineInput};
use handicap_tui::inspect::{Reason, RecordLoad, RecordOrigin, StepLine, cursor_index};
use handicap_tui::session::{Stage, StartError};
use handicap_tui::terminal::{PanicAction, panic_action, panic_line};
use handicap_tui::view::monitor::Layout;
use handicap_tui::wire::CheckRecord;
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
    assert_eq!(handle_key(&b, ch('a'), 1), Action::AddValue);

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
        record_from_settings: false,
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
        [
            "↑↓ PgUp PgDn 스크롤",
            "←→ 이전·다음 스텝",
            "a 조건·표시 추가",
            "Esc 자세히로"
        ]
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
            "a 조건·표시 추가",
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
        ["↑↓ 고르기", "1–14 번호", "Enter 수정", "Esc 모니터로"]
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
    // 붙여넣기도 입력이다(5분 타이머를 미룬다).
    assert!(is_user_input(&Event::Paste("x".into())));
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
        // 돌려받은 입력줄이 그 글자 그대로 끝난다(정규화된 키가 들어가면 `ㅂ`→`q`, `Q`→`q`로 바뀐다).
        let EditAction::Input(out, li) = ek(&Screen::Settings, &ui, key(KeyCode::Char(c))) else {
            panic!("{c}: Input이 아님");
        };
        assert_eq!(out, InputOutcome::Edited, "{c}");
        assert_eq!(li.text(), c.to_string(), "{c}");
    }
    let outcome = |k| match ek(&Screen::Settings, &ui, k) {
        EditAction::Input(o, _) => o,
        other => panic!("Input이 아님: {other:?}"),
    };
    assert_eq!(outcome(ctrl('c')), InputOutcome::AskQuit);
    assert_eq!(outcome(key(KeyCode::Enter)), InputOutcome::Submit);
    assert_eq!(outcome(key(KeyCode::Esc)), InputOutcome::Cancel);
    // edit_key는 원래 버퍼를 바꾸지 않는다(복제본에 적용한 결과를 돌려준다).
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

    // edit_key: 0 단독은 무동작, 1 뒤 0은 10으로
    let mut ui = EditUi::default();
    assert_eq!(
        edit_key(&Screen::Settings, &ui, key(KeyCode::Char('0')), t0),
        EditAction::None
    );
    assert_eq!(
        edit_key(&Screen::Settings, &ui, key(KeyCode::Char('3')), t0),
        EditAction::DigitJump {
            no: 3,
            pending: None
        }
    );
    ui.digit = Some((1, t0));
    assert_eq!(
        edit_key(
            &Screen::Settings,
            &ui,
            key(KeyCode::Char('0')),
            t0 + Duration::from_millis(300)
        ),
        EditAction::DigitJump {
            no: 10,
            pending: None
        }
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
fn digit_pending_is_cleared_by_any_other_key() {
    let t0 = Instant::now();
    let s = Screen::Settings;
    let mut ui = EditUi::default();
    // 1 → ↓ → 2(1초 안) = 2번(12 아님)
    let a = edit_key(&s, &ui, key(KeyCode::Char('1')), t0);
    assert_eq!(
        a,
        EditAction::DigitJump {
            no: 1,
            pending: Some((1, t0))
        }
    );
    ui.track_digit(&a);
    assert_eq!(ui.digit, Some((1, t0)));
    let a = edit_key(&s, &ui, key(KeyCode::Down), t0 + Duration::from_millis(100));
    assert_eq!(a, EditAction::MoveCursor(1));
    ui.track_digit(&a);
    assert_eq!(ui.digit, None);
    let a = edit_key(
        &s,
        &ui,
        key(KeyCode::Char('2')),
        t0 + Duration::from_millis(200),
    );
    assert_eq!(
        a,
        EditAction::DigitJump {
            no: 2,
            pending: None
        }
    );
    // 1 → 1(1초 안) = 11
    let mut ui = EditUi::default();
    let a = edit_key(&s, &ui, key(KeyCode::Char('1')), t0);
    ui.track_digit(&a);
    let a = edit_key(
        &s,
        &ui,
        key(KeyCode::Char('1')),
        t0 + Duration::from_millis(300),
    );
    assert_eq!(
        a,
        EditAction::DigitJump {
            no: 11,
            pending: None
        }
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
        target: CondTarget::Existing(0),
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
    for k in [
        key(KeyCode::Char('q')),
        key(KeyCode::Char(' ')),
        key(KeyCode::Left),
    ] {
        assert!(matches!(
            ek(&s, &ui, k),
            EditAction::Input(InputOutcome::Edited, _)
        ));
    }
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
    assert!(matches!(
        ek(&s, &ui, ctrl('c')),
        EditAction::Input(InputOutcome::AskQuit, _)
    ));
    // Ctrl 여부와 무관하게 폼 키(Ctrl+Enter가 입력줄 Submit으로 새지 않는다).
    let ctrl_enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL);
    assert_eq!(ek(&s, &ui, ctrl_enter), EditAction::CondKey(ctrl_enter));
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
    // y_only가 아니면 y는 예가 아니다(Enter만 예).
    assert_eq!(
        ek(&s, &step, key(KeyCode::Char('y'))),
        EditAction::ConfirmNo
    );
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
    assert_eq!(ek(&s, &pick, key(KeyCode::Esc)), EditAction::PickCancel);
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
    // Ctrl+Q도 종료 확인(기존 handle_key와 같다) — 메뉴·목록 창·저장 중 모두.
    assert_eq!(ek(&s, &saving, ctrl('q')), EditAction::AskQuit);
    assert_eq!(ek(&s, &pick, ctrl('q')), EditAction::AskQuit);
    assert_eq!(ek(&s, &EditUi::default(), ctrl('q')), EditAction::AskQuit);
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
    let mut ui = EditUi {
        overlay: Some(Overlay::Saving {
            restore: Some(Box::new(input_overlay("v"))),
        }),
        reveal: true,
        env: Some(EnvLoad::Loading { id: "e".into() }),
        scen: Some(ScenLoad::Failed("x".into())),
        digit: Some((1, Instant::now())),
        ..EditUi::default()
    };
    idle_drop(&mut ui);
    assert!(matches!(ui.overlay, Some(Overlay::Saving { .. })));
    assert!(!ui.reveal && ui.env.is_none() && ui.scen.is_none() && ui.digit.is_none());
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
fn back_from_settings_clears_edit_state() {
    let mut v = SubViews {
        edit: Some(EditUi {
            cursor: 5,
            digit: Some((1, Instant::now())),
            reveal: true,
            ..EditUi::default()
        }),
        ..SubViews::default()
    };
    assert_eq!(v.back(&Screen::Settings), Some(Screen::Monitor));
    assert!(v.edit.is_none());
    // 도움말은 편집 상태를 건드리지 않는다.
    v.edit = Some(EditUi::default());
    assert_eq!(v.back(&Screen::Help), Some(Screen::Monitor));
    assert!(v.edit.is_some());
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
    // Overlay 자체의 Debug도 종류 이름만.
    for o in [
        ui.overlay.clone().unwrap(),
        Overlay::Notice("SERVER-MSG-12".into()),
        Overlay::Confirm {
            text: "SERVER-MSG-12".into(),
            then: Pending::SetStep("STEP-ID-9".into()),
            y_only: true,
        },
    ] {
        let d = format!("{o:?}");
        for leak in [
            "TYPED-SECRET-77",
            "'T'",
            "API_KEY_NAME",
            "SERVER-MSG-12",
            "STEP-ID-9",
        ] {
            assert!(!d.contains(leak), "{leak} leaked: {d}");
        }
    }
}

// ---- tui-2a-1 Task 10: 저장 결과 반영·확인 판정·저장 표(순수) ----

mod save {
    use super::*;
    use handicap_controller::monitor::config::{
        BoardConfig, Condition, ConditionOp, DisplayItem, PanelConfig,
    };
    use handicap_tui::app::{
        Change, EditCtx, EditDone, EditReq, FileErr, SaveTicket, SavedValue, SavedWhat, apply_done,
        confirm_for, edit_apply,
    };
    use handicap_tui::filesave::{WriteError, WriteStage};
    use handicap_tui::names::Names;
    use handicap_tui::view::monitor::HeaderNotice;
    use handicap_tui::wire::BoardResponse;

    const BUNDLE: &str = include_str!("fixtures/bundle_template.json");
    const ENV: &str = "01J0000000000000000000EN01";
    const SC: &str = "01J0000000000000000000SC01";
    const ST: &str = "01J0000000000000000000ST01";

    fn names() -> Names {
        Names::from_bundle(BUNDLE.as_bytes())
    }

    fn panel(id: &str) -> PanelConfig {
        PanelConfig {
            id: id.into(),
            title: format!("칸-{id}"),
            scenario_id: SC.into(),
            environment_id: Some(ENV.into()),
            ..PanelConfig::default()
        }
    }

    fn board(id: &str, panels: Vec<PanelConfig>) -> BoardResponse {
        BoardResponse {
            id: id.into(),
            name: format!("보드-{id}"),
            config: BoardConfig {
                panels,
                ..BoardConfig::default()
            },
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn boards() -> Vec<BoardResponse> {
        vec![
            board("B1", vec![panel("P1"), panel("P2")]),
            board("B2", vec![panel("Q1")]),
        ]
    }

    fn ticket(seq: u64, b: &str, p: &str) -> Option<SaveTicket> {
        Some(SaveTicket {
            seq,
            board_id: b.into(),
            panel_id: p.into(),
        })
    }

    fn ui(b: &str, p: &str, overlay: Option<Overlay>) -> EditUi {
        EditUi {
            board_id: b.into(),
            panel_id: p.into(),
            overlay,
            ..EditUi::default()
        }
    }

    fn digits(v: &str) -> LineInput {
        LineInput::new(v, InputMode::Digits { max: 6 })
    }

    fn timeout_input(v: &str, error: Option<&str>) -> Overlay {
        Overlay::Input {
            target: InputTarget::Field(Field::Timeout),
            input: digits(v),
            error: error.map(str::to_string),
            share: None,
        }
    }

    fn saving(restore: Option<Overlay>) -> Overlay {
        Overlay::Saving {
            restore: restore.map(Box::new),
        }
    }

    fn saved_board(seq: u64, b: BoardResponse, file: Option<Result<(), FileErr>>) -> EditDone {
        EditDone::Saved {
            seq,
            req: SavedWhat::Board {
                board_id: b.id.clone(),
            },
            server: Ok(SavedValue::Board(b)),
            file,
        }
    }

    fn rejected(seq: u64, b: &str, m: &str) -> EditDone {
        EditDone::Saved {
            seq,
            req: SavedWhat::Board { board_id: b.into() },
            server: Err(m.into()),
            file: None,
        }
    }

    fn changed_b1() -> BoardResponse {
        let mut b = boards().remove(0);
        b.config.panels[0].timeout_seconds = 9;
        b.updated_at = 2;
        b
    }

    #[test]
    fn apply_done_rejection_keeps_cache_and_restores() {
        let mut bs = boards();
        let before: Vec<_> = bs.iter().map(|b| b.config.clone()).collect();
        let mut t = ticket(3, "B1", "P1");
        let mut u = ui("B1", "P1", Some(saving(Some(timeout_input("45", None)))));
        let n = apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            rejected(3, "B1", "제한 시간은 1~30초여야 합니다"),
            0,
        );
        assert_eq!(n, None);
        assert_eq!(t, None);
        let after: Vec<_> = bs.iter().map(|b| b.config.clone()).collect();
        assert_eq!(after, before);
        assert_eq!(
            u.overlay,
            Some(timeout_input("45", Some("제한 시간은 1~30초여야 합니다")))
        );
    }

    #[test]
    fn apply_done_pick_rejection_is_notice() {
        let mut bs = boards();
        let mut t = ticket(1, "B1", "P1");
        let mut u = ui("B1", "P1", Some(saving(None)));
        apply_done(Some(&mut u), &mut bs, &mut t, rejected(1, "B1", "거절"), 0);
        assert_eq!(u.overlay, Some(Overlay::Notice("거절".into())));
        assert_eq!(t, None);
    }

    #[test]
    fn apply_done_ok_replaces_board_and_notice() {
        // 성공 + 파일 Ok → Saved(now), 캐시 교체, overlay 닫힘.
        let mut bs = boards();
        let mut t = ticket(5, "B1", "P1");
        let mut u = ui("B1", "P1", Some(saving(Some(timeout_input("9", None)))));
        let n = apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(5, changed_b1(), Some(Ok(()))),
            1234,
        );
        assert_eq!(n, Some(HeaderNotice::Saved(1234)));
        assert_eq!(bs[0].config.panels[0].timeout_seconds, 9);
        assert_eq!(bs[0].updated_at, 2);
        assert_eq!(bs[1].config, boards()[1].config);
        assert_eq!(u.overlay, None);
        assert_eq!(t, None);
        // 내보내기·다른 쓰기 실패 → FileFailed.
        for e in [
            FileErr::Export("x".into()),
            FileErr::Write(WriteError {
                stage: WriteStage::Persist,
                kind: None,
            }),
        ] {
            let mut t = ticket(6, "B1", "P1");
            let n = apply_done(
                None,
                &mut bs,
                &mut t,
                saved_board(6, changed_b1(), Some(Err(e))),
                0,
            );
            assert_eq!(n, Some(HeaderNotice::FileFailed));
        }
        // 밖에서 바뀜 → ChangedOutside.
        let mut t = ticket(7, "B1", "P1");
        let n = apply_done(
            None,
            &mut bs,
            &mut t,
            saved_board(
                7,
                changed_b1(),
                Some(Err(FileErr::Write(WriteError {
                    stage: WriteStage::ChangedOutside,
                    kind: None,
                }))),
            ),
            0,
        );
        assert_eq!(n, Some(HeaderNotice::ChangedOutside));
        // 표와 다른 seq는 버린다(캐시·알림·표 불변).
        let mut bs = boards();
        let mut t = ticket(8, "B1", "P1");
        let n = apply_done(
            None,
            &mut bs,
            &mut t,
            saved_board(7, changed_b1(), Some(Ok(()))),
            0,
        );
        assert_eq!(n, None);
        assert_eq!(bs[0].config.panels[0].timeout_seconds, 5);
        assert_eq!(t, ticket(8, "B1", "P1"));
    }

    #[test]
    fn apply_done_stale_panel_no_overlay() {
        // 표 = B1/P1, 지금 화면 = B1/P2(입력줄 열림) → 캐시는 바뀌고 overlay 불변.
        let mut bs = boards();
        let mut t = ticket(2, "B1", "P1");
        let open = timeout_input("3", None);
        let mut u = ui("B1", "P2", Some(open.clone()));
        let n = apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(2, changed_b1(), Some(Ok(()))),
            9,
        );
        assert_eq!(n, Some(HeaderNotice::Saved(9)));
        assert_eq!(bs[0].config.panels[0].timeout_seconds, 9);
        assert_eq!(u.overlay, Some(open.clone()));
        // 거절도 다른 칸 화면엔 Notice를 띄우지 않는다.
        let mut t = ticket(3, "B1", "P1");
        apply_done(Some(&mut u), &mut bs, &mut t, rejected(3, "B1", "거절"), 0);
        assert_eq!(u.overlay, Some(open));
        assert_eq!(t, None);
    }

    #[test]
    fn apply_done_closes_saving_notice_on_any_panel() {
        // `저장 중…` 안내(표가 있을 때 저장·다른 칸 열기)는 "지금 저장 중"이라는 뜻뿐 — 그 저장이 끝나면
        // 표의 칸과 화면 칸이 달라도 닫는다. 표와 다른 seq는 안 닫고, 다른 안내는 그대로.
        let saving_notice = || Some(Overlay::Notice(handicap_tui::text::SAVING.to_string()));
        let mut bs = boards();
        let mut u = ui("B1", "P2", saving_notice());
        let mut t = ticket(2, "B1", "P1");
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(1, changed_b1(), None),
            0,
        );
        assert_eq!(u.overlay, saving_notice());
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(2, changed_b1(), Some(Ok(()))),
            0,
        );
        assert_eq!(u.overlay, None);
        // 같은 칸 + 거절도 닫힌다.
        let mut u = ui("B1", "P1", saving_notice());
        let mut t = ticket(3, "B1", "P1");
        apply_done(Some(&mut u), &mut bs, &mut t, rejected(3, "B1", "거절"), 0);
        assert_eq!(u.overlay, None);
        // 다른 안내는 그대로.
        let other = Some(Overlay::Notice("다른 안내".into()));
        let mut u = ui("B1", "P2", other.clone());
        let mut t = ticket(4, "B1", "P1");
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(4, changed_b1(), None),
            0,
        );
        assert_eq!(u.overlay, other);
    }

    #[test]
    fn apply_done_after_idle_keeps_notice() {
        let mut bs = boards();
        let mut t = ticket(4, "B1", "P1");
        let n = apply_done(
            None,
            &mut bs,
            &mut t,
            saved_board(4, changed_b1(), Some(Ok(()))),
            77,
        );
        assert_eq!(n, Some(HeaderNotice::Saved(77)));
        assert_eq!(bs[0].config.panels[0].timeout_seconds, 9);
        assert_eq!(t, None);
        // 5분 복귀 뒤 남은 Saving(edit 유지)도 닫힌다.
        let mut t = ticket(5, "B1", "P1");
        let mut u = ui("B1", "P1", Some(saving(None)));
        idle_drop(&mut u);
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            saved_board(5, changed_b1(), Some(Ok(()))),
            0,
        );
        assert_eq!(u.overlay, None);
    }

    #[test]
    fn ticket_blocks_second_save() {
        let bs = boards();
        let nm = names();
        let submit = || {
            let li = digits("9");
            EditAction::Input(InputOutcome::Submit, li)
        };
        // 표 없음 → 저장 요청 + 표 + Saving(restore = 입력줄).
        let mut t = None;
        let mut seq = 0;
        let mut u = ui("B1", "P1", Some(timeout_input("9", None)));
        let out = {
            let mut cx = EditCtx {
                boards: &bs,
                names: &nm,
                ticket: &mut t,
                seq: &mut seq,
            };
            edit_apply(&Screen::Settings, &mut u, &mut cx, submit())
        };
        let Some(EditReq::SaveBoard {
            seq: s1,
            board_id,
            panel_id,
            panel_no,
            config,
            ..
        }) = out.req
        else {
            panic!("no save request");
        };
        assert_eq!(
            (board_id.as_str(), panel_id.as_str(), panel_no),
            ("B1", "P1", 1)
        );
        assert_eq!(config.panels[0].timeout_seconds, 9);
        assert_eq!(config.panels[1], bs[0].config.panels[1]);
        assert_eq!(t, ticket(s1, "B1", "P1"));
        assert_eq!(u.overlay, Some(saving(Some(timeout_input("9", None)))));
        // 표가 있는 동안 다른 칸에서 확정 → 요청 없음·Notice(저장 중)·표 그대로.
        let mut u2 = ui("B1", "P2", Some(timeout_input("7", None)));
        let out2 = {
            let mut cx = EditCtx {
                boards: &bs,
                names: &nm,
                ticket: &mut t,
                seq: &mut seq,
            };
            edit_apply(&Screen::Settings, &mut u2, &mut cx, submit())
        };
        assert!(out2.req.is_none());
        assert_eq!(u2.overlay, Some(Overlay::Notice("저장 중…".into())));
        assert_eq!(t, ticket(s1, "B1", "P1"));
    }

    #[test]
    fn confirm_for_table() {
        let nm = names();
        let mut grouped = panel("G1");
        grouped.group_id = Some("g".into());
        grouped.step_id = Some(ST.into());
        grouped.conditions = vec![Condition {
            step_id: ST.into(),
            op: ConditionOp::Exists,
            ..Condition::default()
        }];
        grouped.display_items = vec![DisplayItem::default(), DisplayItem::default()];
        let mut alone = panel("A1");
        alone.environment_id = Some("E-ONLY".into());
        let cfgs = vec![
            BoardConfig {
                panels: vec![grouped, alone, panel("P3")],
                ..BoardConfig::default()
            },
            BoardConfig {
                panels: vec![panel("Q1")],
                ..BoardConfig::default()
            },
        ];
        // 단계 확인(조건 1·표시 2) — 다른 스텝으로 바꿀 때만.
        assert_eq!(
            confirm_for(&cfgs, 0, 0, &Change::Step("OTHER".into()), &nm),
            Some((
                "조건 1개·표시 값 2개도 이 스텝으로 바뀝니다 — Enter 계속 · Esc 취소".into(),
                false
            ))
        );
        assert_eq!(
            confirm_for(&cfgs, 0, 0, &Change::Step(ST.into()), &nm),
            None
        );
        assert_eq!(
            confirm_for(&cfgs, 0, 2, &Change::Step("OTHER".into()), &nm),
            None
        );
        // 환경 빠짐: 자기만 쓰던 환경을 떠나면(이름이 없으면 id).
        assert_eq!(
            confirm_for(&cfgs, 0, 1, &Change::Env(Some(ENV.into())), &nm),
            Some((
                "\"E-ONLY\" 환경은 다른 칸이 안 써서 파일에서 빠집니다 — Enter 계속 · Esc 취소"
                    .into(),
                false
            ))
        );
        // 다른 칸도 쓰는 환경을 떠나면 확인 없음.
        assert_eq!(confirm_for(&cfgs, 0, 2, &Change::Env(None), &nm), None);
        // 마지막 사용 칸이 떠나면 이름으로.
        let only = vec![BoardConfig {
            panels: vec![panel("Z1")],
            ..BoardConfig::default()
        }];
        assert_eq!(
            confirm_for(&only, 0, 0, &Change::Env(None), &nm),
            Some((
                "\"대상\" 환경은 다른 칸이 안 써서 파일에서 빠집니다 — Enter 계속 · Esc 취소"
                    .into(),
                false
            ))
        );
        // 삭제 = y_only, 번호는 1부터.
        assert_eq!(
            confirm_for(&cfgs, 0, 0, &Change::Remove(ListKind::Conditions, 0), &nm),
            Some(("1번을 지울까요? y 지우기 · 다른 키 취소".into(), true))
        );
        // 확인 없음.
        for c in [
            Change::Field(Field::Timeout, "9".into()),
            Change::Latency(None),
            Change::ThresholdAdd(1000),
            Change::ThresholdSet(0, 900),
            Change::Swap,
        ] {
            assert_eq!(confirm_for(&cfgs, 0, 0, &c, &nm), None, "{c:?}");
        }
    }

    fn run(
        screen: &Screen,
        u: &mut EditUi,
        bs: &[BoardResponse],
        t: &mut Option<SaveTicket>,
        a: EditAction,
    ) -> handicap_tui::app::EditOut {
        let nm = names();
        let mut seq = 10;
        let mut cx = EditCtx {
            boards: bs,
            names: &nm,
            ticket: t,
            seq: &mut seq,
        };
        edit_apply(screen, u, &mut cx, a)
    }

    #[test]
    fn menu_activate_opens_by_kind() {
        let bs = boards();
        let mut t = None;
        // 6 → 지금 값으로 채운 숫자 입력줄.
        let mut u = ui("B1", "P1", None);
        u.cursor = 5;
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(u.overlay, Some(timeout_input("5", None)));
        // 2 → 읽기 전용 안내.
        let mut u = ui("B1", "P1", None);
        u.cursor = 1;
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(
            u.overlay,
            Some(Overlay::Notice("시나리오는 GUI에서 바꿉니다".into()))
        );
        // 3 → 환경 목록(환경 없음 + 번들 순서), 커서 = 지금 값.
        let mut u = ui("B1", "P1", None);
        u.cursor = 2;
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        match &u.overlay {
            Some(Overlay::Pick {
                pick: Pick::Env,
                options,
                cursor,
            }) => {
                assert_eq!(options[0], (None, "환경 없음".to_string()));
                assert_eq!(options[1], (Some(ENV.to_string()), "대상".to_string()));
                assert_eq!(*cursor, 1);
            }
            o => panic!("{o:?}"),
        }
        // 8 → 하위 목록 화면.
        let mut u = ui("B1", "P1", None);
        u.cursor = 7;
        let out = run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(out.screen, Some(Screen::EditList));
        // 13 → 환경 변수 화면(불러오는 중) + 조회 요청.
        let mut u = ui("B1", "P1", None);
        u.cursor = 12;
        let out = run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(out.screen, Some(Screen::EnvVars));
        assert!(matches!(out.req, Some(EditReq::LoadEnv { ref id }) if id == ENV));
        assert!(matches!(u.env, Some(EnvLoad::Loading { ref id }) if id == ENV));
        // 숫자 이동.
        let mut u = ui("B1", "P1", None);
        run(
            &Screen::Settings,
            &mut u,
            &bs,
            &mut t,
            EditAction::DigitJump {
                no: 12,
                pending: None,
            },
        );
        assert_eq!(u.cursor, 11);
        run(
            &Screen::Settings,
            &mut u,
            &bs,
            &mut t,
            EditAction::Jump(usize::MAX),
        );
        assert_eq!(u.cursor, 13);
        run(
            &Screen::Settings,
            &mut u,
            &bs,
            &mut t,
            EditAction::MoveCursor(-20),
        );
        assert_eq!(u.cursor, 0);
    }

    #[test]
    fn unacceptable_initial_value_is_notice() {
        // 제목에 받지 않는 글자(U+2028)가 있으면 입력줄을 열지 않는다(몰래 잘라 저장하지 않게).
        let mut bs = boards();
        bs[0].config.panels[0].title = "a\u{2028}b".into();
        let mut t = None;
        let mut u = ui("B1", "P1", None);
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(
            u.overlay,
            Some(Overlay::Notice(
                "이 값은 TUI에서 못 고칩니다 — GUI에서".into()
            ))
        );
    }

    #[test]
    fn input_replaces_buffer_and_cancel_closes() {
        let bs = boards();
        let mut t = None;
        let mut u = ui("B1", "P1", Some(timeout_input("5", None)));
        run(
            &Screen::Settings,
            &mut u,
            &bs,
            &mut t,
            EditAction::Input(InputOutcome::Edited, digits("57")),
        );
        assert_eq!(u.overlay, Some(timeout_input("57", None)));
        run(
            &Screen::Settings,
            &mut u,
            &bs,
            &mut t,
            EditAction::Input(InputOutcome::Cancel, digits("57")),
        );
        assert_eq!(u.overlay, None);
        assert_eq!(t, None);
    }

    #[test]
    fn list_remove_asks_then_saves() {
        let mut bs = boards();
        bs[0].config.panels[0].thresholds = vec![
            handicap_controller::monitor::config::Threshold {
                ms: 800,
                color: "#f59e0b".into(),
            },
            handicap_controller::monitor::config::Threshold {
                ms: 1500,
                color: "#ef4444".into(),
            },
        ];
        let mut t = None;
        let mut u = ui("B1", "P1", None);
        u.cursor = 7;
        u.list_cursor = 1;
        run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Remove);
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Confirm { text, y_only: true, .. }) if text == "2번을 지울까요? y 지우기 · 다른 키 취소"
        ));
        let out = run(
            &Screen::EditList,
            &mut u,
            &bs,
            &mut t,
            EditAction::ConfirmYes,
        );
        match out.req {
            Some(EditReq::SaveBoard { config, .. }) => {
                assert_eq!(config.panels[0].thresholds.len(), 1);
                assert_eq!(config.panels[0].thresholds[0].ms, 800);
            }
            r => panic!("{r:?}"),
        }
        assert_eq!(u.overlay, Some(saving(None)));
    }

    #[test]
    fn empty_pick_is_notice() {
        // 볼 스텝 후보가 0개(시나리오를 모름) → 빈 목록 창 대신 안내.
        let mut bs = boards();
        let p = &mut bs[0].config.panels[0];
        p.group_id = Some("g".into());
        p.scenario_id = "UNKNOWN".into();
        let mut t = None;
        let mut u = ui("B1", "P1", None);
        u.cursor = 3;
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Activate);
        assert!(matches!(u.overlay, Some(Overlay::Notice(_))));
    }

    #[test]
    fn idle_return_keeps_pending_save() {
        use handicap_tui::app::idle_return;
        let mut v = SubViews::default();
        v.open_errors("B1", "P1", &[]);
        v.edit = Some(ui("B1", "P1", Some(saving(None))));
        idle_return(&mut v);
        assert!(v.errors.is_none());
        assert_eq!(v.edit.as_ref().unwrap().overlay, Some(saving(None)));
        // 입력 중(저장 없음) → 편집 상태까지 버린다(입력값 버림 — Q3).
        let mut v = SubViews {
            edit: Some(ui("B1", "P1", Some(timeout_input("45", None)))),
            ..SubViews::default()
        };
        idle_return(&mut v);
        assert!(v.edit.is_none());
    }

    #[test]
    fn edit_keys_per_mode() {
        use handicap_tui::app::edit_keys;
        let menu = ui("B1", "P1", None);
        assert_eq!(
            edit_keys(&Screen::Settings, &menu, None, false),
            [
                "↑↓ 고르기",
                "1–14 번호",
                "r 지금 점검",
                "Enter 수정",
                "Esc 모니터로"
            ]
        );
        assert_eq!(
            edit_keys(&Screen::Settings, &menu, None, true),
            ["y 종료", "다른 키 취소"]
        );
        let input = ui("B1", "P1", Some(timeout_input("5", None)));
        assert_eq!(
            edit_keys(&Screen::Settings, &input, None, false),
            ["Enter 저장", "Esc 취소", "Ctrl+U 지우기"]
        );
        let pick = ui(
            "B1",
            "P1",
            Some(Overlay::Pick {
                pick: Pick::Env,
                options: vec![(None, "환경 없음".into())],
                cursor: 0,
            }),
        );
        assert_eq!(
            edit_keys(&Screen::Settings, &pick, None, false),
            ["↑↓ 고르기", "Enter 저장", "Esc 취소"]
        );
        for o in [
            Overlay::Confirm {
                text: "x".into(),
                then: Pending::SetEnv(None),
                y_only: false,
            },
            saving(None),
            Overlay::Notice("x".into()),
        ] {
            assert!(edit_keys(&Screen::Settings, &ui("B1", "P1", Some(o)), None, false).is_empty());
        }
        assert_eq!(
            edit_keys(
                &Screen::EditList,
                &menu,
                Some((ListKind::Thresholds, 2)),
                false
            ),
            ["↑↓ 고르기", "Enter 수정", "a 추가", "d 삭제", "Esc 뒤로"]
        );
        let form = ui(
            "B1",
            "P1",
            Some(Overlay::CondForm {
                target: CondTarget::Existing(0),
                ops: vec![ConditionOp::Eq],
                op: 0,
                value: text_input("a"),
                ignore_case: false,
                trim: false,
                focus: CondFocus::Op,
                error: None,
            }),
        );
        let k = edit_keys(
            &Screen::EditList,
            &form,
            Some((ListKind::Conditions, 1)),
            false,
        );
        assert!(!k.contains(&"d 삭제"), "{k:?}");
        assert!(k.contains(&"Enter 저장"));
        assert_eq!(
            edit_keys(&Screen::EnvVars, &menu, None, false),
            ["↑↓ 고르기", "Enter 수정", "v 값 보기", "Esc 뒤로"]
        );
    }

    #[test]
    fn cond_form_edits_and_saves() {
        let mut bs = boards();
        bs[0].config.panels[0].conditions = vec![Condition {
            step_id: ST.into(),
            source: handicap_controller::monitor::config::ConditionSource::Status,
            op: ConditionOp::Eq,
            value: "200".into(),
            ..Condition::default()
        }];
        let mut t = None;
        let mut u = ui("B1", "P1", None);
        u.cursor = 10;
        run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Activate);
        let Some(Overlay::CondForm { ops, op, .. }) = &u.overlay else {
            panic!("{:?}", u.overlay);
        };
        assert_eq!(ops[*op], ConditionOp::Eq);
        let k = |c| EditAction::CondKey(KeyEvent::new(c, KeyModifiers::NONE));
        // Tab → 값 칸, 값 교체, Enter → 저장 요청.
        run(&Screen::EditList, &mut u, &bs, &mut t, k(KeyCode::Tab));
        assert!(matches!(
            &u.overlay,
            Some(Overlay::CondForm {
                focus: CondFocus::Value,
                ..
            })
        ));
        run(
            &Screen::EditList,
            &mut u,
            &bs,
            &mut t,
            EditAction::Input(InputOutcome::Edited, text_input("201")),
        );
        let out = run(&Screen::EditList, &mut u, &bs, &mut t, k(KeyCode::Enter));
        match out.req {
            Some(EditReq::SaveBoard { config, .. }) => {
                assert_eq!(config.panels[0].conditions[0].value, "201");
                assert_eq!(config.panels[0].conditions[0].op, ConditionOp::Eq);
            }
            r => panic!("{r:?}"),
        }
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Saving { restore: Some(_) })
        ));
    }

    // ---- tui-2a-1 Task 11: 환경/시나리오 변수 연결·붙여넣기·마우스·리뷰 반영 ----

    use handicap_tui::app::{
        env_rows, menu_click, menu_item_at, paste_into, paste_target, scen_rows, worker_gone,
    };
    use handicap_tui::wire::{EnvironmentResponse, ScenarioResponse};

    const VARS_YAML: &str = "version: 1\nname: s\nvariables:\n  # 주문 번호\n  order_id: \"A-1\"\n  gid: {gen: uuid}\n  multi: |\n    x\nsteps:\n  - { id: \"01J00000000000000000000A01\", name: a, type: http, request: { method: GET, url: \"/a\" }, assert: [] }\n";

    fn env_resp(vars: &[(&str, &str)]) -> EnvironmentResponse {
        let m: serde_json::Map<String, serde_json::Value> = vars
            .iter()
            .map(|(k, v)| ((*k).to_string(), serde_json::Value::from(*v)))
            .collect();
        serde_json::from_value(serde_json::json!({
            "id": ENV, "name": "대상", "vars": m, "created_at": 1, "updated_at": 2
        }))
        .unwrap()
    }

    fn scen_resp(yaml: &str, version: i64) -> ScenarioResponse {
        serde_json::from_value(serde_json::json!({
            "id": SC, "name": "s", "yaml": yaml, "version": version,
            "created_at": 1, "updated_at": 2
        }))
        .unwrap()
    }

    fn scen_loaded(yaml: &str, version: i64) -> ScenLoad {
        ScenLoad::Loaded {
            id: SC.into(),
            yaml: yaml.into(),
            version,
            vars: handicap_tui::yaml_var::static_vars(yaml),
        }
    }

    fn env_ui(vars: &[(&str, &str)]) -> EditUi {
        let mut u = ui("B1", "P1", None);
        u.cursor = 12;
        u.env = Some(EnvLoad::Loaded(env_resp(vars)));
        u
    }

    fn scen_ui(yaml: &str) -> EditUi {
        let mut u = ui("B1", "P1", None);
        u.cursor = 13;
        u.scen = Some(scen_loaded(yaml, 4));
        u
    }

    fn only_board() -> Vec<BoardResponse> {
        vec![board("B1", vec![panel("P1")])]
    }

    fn submit(v: &str) -> EditAction {
        EditAction::Input(InputOutcome::Submit, text_input(v))
    }

    fn env_done(id: &str, result: Result<EnvironmentResponse, String>) -> EditDone {
        EditDone::Env {
            id: id.into(),
            result,
        }
    }

    #[test]
    fn late_load_for_other_id_dropped() {
        let mut bs = boards();
        let mut t = None;
        // 지금 E2를 기다리는데 E1 결과 → 버림.
        let mut u = ui("B1", "P1", None);
        u.env = Some(EnvLoad::Loading { id: "E2".into() });
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            env_done("E1", Ok(env_resp(&[("K", "v")]))),
            0,
        );
        assert!(matches!(&u.env, Some(EnvLoad::Loading { id }) if id == "E2"));
        // 같은 id면 받는다(키 순 줄).
        let mut u = ui("B1", "P1", None);
        u.env = Some(EnvLoad::Loading { id: ENV.into() });
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            env_done(ENV, Ok(env_resp(&[("Z", "1"), ("A", "2")]))),
            0,
        );
        match &u.env {
            Some(EnvLoad::Loaded(e)) => {
                assert_eq!(e.vars.keys().collect::<Vec<_>>(), ["A", "Z"]);
            }
            _ => panic!("not loaded"),
        }
        // 실패도 그 id일 때만.
        let mut u = ui("B1", "P1", None);
        u.env = Some(EnvLoad::Loading { id: ENV.into() });
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            env_done(ENV, Err("없음".into())),
            0,
        );
        assert!(matches!(&u.env, Some(EnvLoad::Failed(m)) if m == "없음"));
        // 화면을 나갔으면(None) 버린다 — 값이 다시 메모리에 들지 않는다.
        let mut u = ui("B1", "P1", None);
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            env_done(ENV, Ok(env_resp(&[("K", "v")]))),
            0,
        );
        assert!(u.env.is_none());
        // 이미 Loaded면 늦은 조회 결과로 덮지 않는다.
        let mut u = env_ui(&[("K", "mine")]);
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            env_done(ENV, Ok(env_resp(&[("K", "late")]))),
            0,
        );
        assert!(matches!(&u.env, Some(EnvLoad::Loaded(e)) if e.vars["K"] == "mine"));
        // 시나리오도 같은 규칙.
        let mut u = ui("B1", "P1", None);
        u.scen = Some(ScenLoad::Loading { id: "S2".into() });
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Scenario {
                id: SC.into(),
                result: Ok(scen_resp(VARS_YAML, 1)),
            },
            0,
        );
        assert!(matches!(&u.scen, Some(ScenLoad::Loading { id }) if id == "S2"));
        let mut u = ui("B1", "P1", None);
        u.scen = Some(ScenLoad::Loading { id: SC.into() });
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Scenario {
                id: SC.into(),
                result: Ok(scen_resp(VARS_YAML, 7)),
            },
            0,
        );
        match &u.scen {
            Some(ScenLoad::Loaded {
                id, version, vars, ..
            }) => {
                assert_eq!(id, SC);
                assert_eq!(*version, 7);
                let keys: Vec<&str> = vars.iter().map(|v| v.key.as_str()).collect();
                assert_eq!(keys, ["gid", "multi", "order_id"]);
            }
            _ => panic!("not loaded"),
        }
        let mut u = ui("B1", "P1", None);
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Scenario {
                id: SC.into(),
                result: Ok(scen_resp(VARS_YAML, 7)),
            },
            0,
        );
        assert!(u.scen.is_none());
        // 편집 상태가 아예 없어도 패닉 없이 버린다.
        apply_done(
            None,
            &mut bs,
            &mut t,
            env_done(ENV, Ok(env_resp(&[("K", "v")]))),
            0,
        );
    }

    #[test]
    fn env_rows_masked_unless_reveal() {
        let e = env_resp(&[("TOKEN", "SECRET-TOKEN-1"), ("BASE", "http://x")]);
        let rows = env_rows(&e, false);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].key, "BASE");
        for r in &rows {
            assert_eq!(r.value, handicap_tui::view::edit::env_display("", false));
            assert!(!format!("{r:?}").contains("SECRET-TOKEN-1"), "{r:?}");
            assert!(!format!("{r:?}").contains("http://x"), "{r:?}");
            assert_eq!(r.note, None);
        }
        let rows = env_rows(&e, true);
        assert_eq!(rows[1].value, "SECRET-TOKEN-1");
        // 시나리오 변수는 가리지 않는다 — 못 고치는 줄엔 사유.
        let rows = scen_rows(&handicap_tui::yaml_var::static_vars(VARS_YAML));
        let by = |k: &str| rows.iter().find(|r| r.key == k).unwrap().clone();
        assert_eq!(by("order_id").value, "A-1");
        assert_eq!(by("order_id").note, None);
        assert_eq!(by("gid").note, Some("생성 변수 — GUI에서"));
        assert_eq!(
            by("multi").note,
            Some("이 값의 모양은 TUI에서 못 고칩니다 — GUI에서")
        );
    }

    #[test]
    fn env_activate_opens_value_only_and_submit_saves() {
        let bs = only_board();
        let mut t = None;
        let mut u = env_ui(&[("A", "a-val"), ("TOKEN", "old")]);
        u.list_cursor = 1;
        run(&Screen::EnvVars, &mut u, &bs, &mut t, EditAction::Activate);
        match &u.overlay {
            Some(Overlay::Input {
                target: InputTarget::EnvVar(k),
                input,
                share,
                error,
            }) => {
                assert_eq!(k, "TOKEN");
                assert_eq!(input.text(), "old");
                assert_eq!(*share, None, "칸 1개면 공유 문구 없음");
                assert_eq!(*error, None);
            }
            o => panic!("{o:?}"),
        }
        let out = run(&Screen::EnvVars, &mut u, &bs, &mut t, submit("new"));
        match out.req {
            Some(EditReq::SaveEnv { id, name, vars, .. }) => {
                assert_eq!(id, ENV);
                assert_eq!(name, "대상");
                assert_eq!(vars["TOKEN"], "new");
                assert_eq!(vars["A"], "a-val", "다른 키는 그대로");
                assert_eq!(vars.len(), 2);
            }
            r => panic!("{r:?}"),
        }
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Saving { restore: Some(_) })
        ));
        assert!(t.is_some());
        // 저장 성공(화면 그대로) → env는 응답으로 갱신.
        let mut bs = bs;
        let seq = t.as_ref().unwrap().seq;
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Saved {
                seq,
                req: SavedWhat::Env { id: ENV.into() },
                server: Ok(SavedValue::Env(env_resp(&[
                    ("A", "a-val"),
                    ("TOKEN", "new"),
                ]))),
                file: Some(Ok(())),
            },
            0,
        );
        assert_eq!(u.overlay, None);
        assert!(matches!(&u.env, Some(EnvLoad::Loaded(e)) if e.vars["TOKEN"] == "new"));
    }

    #[test]
    fn env_share_note_and_uneditable_value() {
        let bs = boards();
        let mut t = None;
        let mut u = env_ui(&[("TOKEN", "old")]);
        run(&Screen::EnvVars, &mut u, &bs, &mut t, EditAction::Activate);
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Input { share: Some(s), .. })
                if s == "이 값을 쓰는 칸 3개(보드 2개)가 함께 바뀝니다"
        ));
        // 입력 규칙(제어 문자)을 못 지키는 값은 입력줄 대신 안내.
        let mut u = env_ui(&[("TOKEN", "a\tb")]);
        run(&Screen::EnvVars, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(
            u.overlay,
            Some(Overlay::Notice(
                "이 값은 TUI에서 못 고칩니다 — GUI에서".into()
            ))
        );
        // 2000자 넘는 값도.
        let long = "x".repeat(2001);
        let mut u = env_ui(&[("TOKEN", &long)]);
        run(&Screen::EnvVars, &mut u, &bs, &mut t, EditAction::Activate);
        assert!(matches!(u.overlay, Some(Overlay::Notice(_))));
        // 불러오는 중이면 아무것도 안 연다.
        let mut u = ui("B1", "P1", None);
        u.env = Some(EnvLoad::Loading { id: ENV.into() });
        run(&Screen::EnvVars, &mut u, &bs, &mut t, EditAction::Activate);
        assert_eq!(u.overlay, None);
    }

    #[test]
    fn scenario_share_note_when_shared() {
        let bs = boards(); // 이 시나리오를 쓰는 칸 3개(보드 2개)
        let mut t = None;
        let mut u = scen_ui(VARS_YAML);
        u.list_cursor = 2; // order_id
        run(
            &Screen::ScenarioVars,
            &mut u,
            &bs,
            &mut t,
            EditAction::Activate,
        );
        match &u.overlay {
            Some(Overlay::Input {
                target: InputTarget::ScenarioVar(k),
                input,
                share,
                ..
            }) => {
                assert_eq!(k, "order_id");
                assert_eq!(input.text(), "A-1");
                assert_eq!(
                    share.as_deref(),
                    Some("이 값을 쓰는 칸 3개(보드 2개)가 함께 바뀝니다")
                );
            }
            o => panic!("{o:?}"),
        }
        // 칸 하나뿐이면 문구 없음.
        let one = only_board();
        let mut u = scen_ui(VARS_YAML);
        u.list_cursor = 2;
        run(
            &Screen::ScenarioVars,
            &mut u,
            &one,
            &mut t,
            EditAction::Activate,
        );
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Input { share: None, .. })
        ));
    }

    #[test]
    fn scenario_activate_not_editable_is_notice() {
        let bs = boards();
        let mut t = None;
        for (i, want) in [
            (0, "생성 변수 — GUI에서"),
            (1, "이 값의 모양은 TUI에서 못 고칩니다 — GUI에서"),
        ] {
            let mut u = scen_ui(VARS_YAML);
            u.list_cursor = i;
            run(
                &Screen::ScenarioVars,
                &mut u,
                &bs,
                &mut t,
                EditAction::Activate,
            );
            assert_eq!(u.overlay, Some(Overlay::Notice(want.into())), "{i}");
        }
    }

    #[test]
    fn scenario_submit_splices_or_shows_reason() {
        let bs = only_board();
        let mut t = None;
        let mut u = scen_ui(VARS_YAML);
        u.list_cursor = 2;
        run(
            &Screen::ScenarioVars,
            &mut u,
            &bs,
            &mut t,
            EditAction::Activate,
        );
        let out = run(&Screen::ScenarioVars, &mut u, &bs, &mut t, submit("B-2"));
        let spliced =
            handicap_tui::yaml_var::splice_static_var(VARS_YAML, "order_id", "B-2").unwrap();
        match out.req {
            Some(EditReq::SaveScenario {
                id, yaml, version, ..
            }) => {
                assert_eq!(id, SC);
                assert_eq!(yaml, spliced);
                assert_eq!(version, 4);
            }
            r => panic!("{r:?}"),
        }
        // 성공 → 응답의 yaml·version으로 갱신(줄도 새로).
        let mut bs = bs;
        let seq = t.as_ref().unwrap().seq;
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Saved {
                seq,
                req: SavedWhat::Scenario { id: SC.into() },
                server: Ok(SavedValue::Scenario(scen_resp(&spliced, 5))),
                file: Some(Ok(())),
            },
            0,
        );
        match &u.scen {
            Some(ScenLoad::Loaded {
                yaml,
                version,
                vars,
                ..
            }) => {
                assert_eq!(*yaml, spliced);
                assert_eq!(*version, 5);
                assert_eq!(
                    vars.iter().find(|v| v.key == "order_id").unwrap().value,
                    "B-2"
                );
            }
            _ => panic!("not loaded"),
        }
        // 교체가 안 되면(키가 YAML에서 사라짐 — 낡은 줄) 저장하지 않고 입력줄 오류 줄에 사유.
        let mut u = scen_ui(VARS_YAML);
        u.overlay = Some(Overlay::Input {
            target: InputTarget::ScenarioVar("nope".into()),
            input: text_input("x"),
            error: None,
            share: None,
        });
        let mut t = None;
        let out = run(&Screen::ScenarioVars, &mut u, &bs, &mut t, submit("x"));
        assert!(out.req.is_none());
        assert!(t.is_none());
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Input { error: Some(e), .. })
                if e == "이 값의 모양은 TUI에서 못 고칩니다 — GUI에서"
        ));
    }

    #[test]
    fn scenario_multiline_plain_opens_input_then_shows_reason() {
        // 목록의 `editable`은 ⑦ 검증을 안 돈다 — 줄 이어짐 값은 입력줄이 열리고, 확정 때 저장 없이 사유.
        let y = "version: 1\nname: s\nvariables:\n  order_id: A-1\n    B-2\nsteps:\n  - { id: \"01J00000000000000000000A01\", name: a, type: http, request: { method: GET, url: \"/a\" }, assert: [] }\n";
        let bs = only_board();
        let mut t = None;
        let mut u = scen_ui(y);
        u.list_cursor = 0;
        run(
            &Screen::ScenarioVars,
            &mut u,
            &bs,
            &mut t,
            EditAction::Activate,
        );
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Input { error: None, .. })
        ));
        let out = run(&Screen::ScenarioVars, &mut u, &bs, &mut t, submit("Z"));
        assert!(out.req.is_none());
        assert!(t.is_none());
        assert!(matches!(
            &u.overlay,
            Some(Overlay::Input { error: Some(e), .. })
                if e == "이 값의 모양은 TUI에서 못 고칩니다 — GUI에서"
        ));
    }

    #[test]
    fn vars_save_after_leaving_screen_only_notice() {
        // 저장 중에 5분 복귀(편집 상태는 남지만 env·scen은 비움) → 성공이 와도 다시 채우지 않는다.
        let mut bs = only_board();
        let mut t = ticket(8, "B1", "P1");
        let mut u = env_ui(&[("TOKEN", "old")]);
        u.overlay = Some(saving(None));
        idle_drop(&mut u);
        let n = apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Saved {
                seq: 8,
                req: SavedWhat::Env { id: ENV.into() },
                server: Ok(SavedValue::Env(env_resp(&[("TOKEN", "new")]))),
                file: Some(Ok(())),
            },
            33,
        );
        assert_eq!(n, Some(HeaderNotice::Saved(33)));
        assert!(u.env.is_none(), "값이 메모리에 다시 들면 안 된다");
        assert_eq!(u.overlay, None);
        let mut t = ticket(9, "B1", "P1");
        let mut u = scen_ui(VARS_YAML);
        u.overlay = Some(saving(None));
        idle_drop(&mut u);
        apply_done(
            Some(&mut u),
            &mut bs,
            &mut t,
            EditDone::Saved {
                seq: 9,
                req: SavedWhat::Scenario { id: SC.into() },
                server: Ok(SavedValue::Scenario(scen_resp(VARS_YAML, 5))),
                file: Some(Ok(())),
            },
            0,
        );
        assert!(u.scen.is_none());
        // 편집 상태 자체가 없을 때도(None) 알림만.
        let mut t = ticket(10, "B1", "P1");
        let n = apply_done(
            None,
            &mut bs,
            &mut t,
            EditDone::Saved {
                seq: 10,
                req: SavedWhat::Env { id: ENV.into() },
                server: Ok(SavedValue::Env(env_resp(&[("TOKEN", "new")]))),
                file: Some(Ok(())),
            },
            1,
        );
        assert_eq!(n, Some(HeaderNotice::Saved(1)));
    }

    /// 리뷰 B1: 5분 복귀는 `Saving.restore` 안의 입력값(환경 토큰 평문일 수 있다)도 버린다.
    #[test]
    fn idle_then_rejection_does_not_restore_typed_value() {
        let mut bs = only_board();
        let mut t = ticket(5, "B1", "P1");
        let typed = Overlay::Input {
            target: InputTarget::EnvVar("TOKEN".into()),
            input: text_input("TYPED-TOKEN-88"),
            error: None,
            share: None,
        };
        let mut v = SubViews {
            edit: Some(env_ui(&[("TOKEN", "old")])),
            ..SubViews::default()
        };
        v.edit.as_mut().unwrap().overlay = Some(saving(Some(typed)));
        handicap_tui::app::idle_return(&mut v);
        let u = v.edit.as_mut().expect("저장 중이면 편집 상태는 남는다");
        assert_eq!(u.overlay, Some(saving(None)));
        apply_done(Some(u), &mut bs, &mut t, rejected(5, "B1", "거절"), 0);
        assert!(
            !matches!(u.overlay, Some(Overlay::Input { .. })),
            "{:?}",
            u.overlay
        );
        let dump = format!(
            "{:?}",
            u.overlay.clone().map(|o| match o {
                Overlay::Notice(m) => m,
                o => format!("{o:?}"),
            })
        );
        assert!(!dump.contains("TYPED-TOKEN-88"), "{dump}");
        assert!(u.env.is_none());
    }

    /// 리뷰 B2: 작업자가 없거나 죽으면 `저장 중…`에서 빠져나온다.
    #[test]
    fn worker_gone_releases_saving() {
        let mut t = ticket(2, "B1", "P1");
        let mut u = ui("B1", "P1", Some(saving(Some(timeout_input("9", None)))));
        u.env = Some(EnvLoad::Loading { id: ENV.into() });
        u.scen = Some(ScenLoad::Loading { id: SC.into() });
        assert!(worker_gone(Some(&mut u), &mut t));
        assert_eq!(t, None);
        assert_eq!(
            u.overlay,
            Some(Overlay::Notice(
                "저장하지 못했습니다 — TUI를 다시 시작하세요".into()
            ))
        );
        assert!(matches!(&u.env, Some(EnvLoad::Failed(_))));
        assert!(matches!(&u.scen, Some(ScenLoad::Failed(_))));
        // 할 일이 없으면 false(화면 불변).
        let mut t = None;
        let mut u = ui("B1", "P1", Some(timeout_input("9", None)));
        assert!(!worker_gone(Some(&mut u), &mut t));
        assert_eq!(u.overlay, Some(timeout_input("9", None)));
        // 다른 칸 화면이면 표만 푼다.
        let mut t = ticket(2, "B1", "P1");
        let mut u = ui("B1", "P2", Some(timeout_input("9", None)));
        assert!(worker_gone(Some(&mut u), &mut t));
        assert_eq!(t, None);
        assert_eq!(u.overlay, Some(timeout_input("9", None)));
        let mut t = ticket(2, "B1", "P1");
        assert!(worker_gone(None, &mut t));
        assert_eq!(t, None);
    }

    #[test]
    fn paste_only_into_input() {
        // 입력줄 → 붙여넣기(줄바꿈·제어 문자는 빠지고 저장되지 않는다).
        let mut u = ui("B1", "P1", Some(timeout_input("1", None)));
        assert!(paste_target(&u));
        assert!(paste_into(&mut u, "23\n"));
        assert_eq!(u.overlay, Some(timeout_input("123", None)));
        // 조건 수정 칸은 값 칸에 포커스일 때만.
        let form = |focus| Overlay::CondForm {
            target: CondTarget::Existing(0),
            ops: vec![ConditionOp::Eq],
            op: 0,
            value: text_input("a"),
            ignore_case: false,
            trim: false,
            focus,
            error: None,
        };
        let mut u = ui("B1", "P1", Some(form(CondFocus::Value)));
        assert!(paste_target(&u));
        assert!(paste_into(&mut u, "b\r\nc"));
        assert!(
            matches!(&u.overlay, Some(Overlay::CondForm { value, .. }) if value.text() == "abc")
        );
        for o in [
            form(CondFocus::Op),
            form(CondFocus::IgnoreCase),
            Overlay::Pick {
                pick: Pick::Env,
                options: vec![(None, "환경 없음".into())],
                cursor: 0,
            },
            Overlay::Notice("n".into()),
            saving(Some(timeout_input("1", None))),
            Overlay::Confirm {
                text: "t".into(),
                then: Pending::SetEnv(None),
                y_only: false,
            },
        ] {
            let mut u = ui("B1", "P1", Some(o.clone()));
            assert!(!paste_target(&u), "{o:?}");
            assert!(!paste_into(&mut u, "x"));
            assert_eq!(u.overlay, Some(o));
        }
        let mut u = ui("B1", "P1", None);
        assert!(!paste_target(&u));
        assert!(!paste_into(&mut u, "x"));
        assert_eq!(u.overlay, None);
    }

    #[test]
    fn mouse_click_maps_to_item() {
        let table = [(5u16, 0usize), (6, 1), (7, 1)];
        assert_eq!(menu_item_at(&table, 7), Some(1));
        assert_eq!(menu_item_at(&table, 5), Some(0));
        assert_eq!(menu_item_at(&table, 4), None);
        assert_eq!(menu_item_at(&table, 8), None);
        let click = |y| mouse(MouseEventKind::Down(MouseButton::Left), 3, y);
        // 다른 항목 → 그 항목으로, 고른 항목(여러 줄 어디든) → Enter.
        assert_eq!(menu_click(&table, 0, click(7)), EditAction::Jump(1));
        assert_eq!(menu_click(&table, 1, click(6)), EditAction::Activate);
        assert_eq!(menu_click(&table, 1, click(7)), EditAction::Activate);
        assert_eq!(menu_click(&table, 1, click(9)), EditAction::None);
        for kind in [
            MouseEventKind::Down(MouseButton::Right),
            MouseEventKind::Up(MouseButton::Left),
            MouseEventKind::Moved,
            MouseEventKind::ScrollDown,
        ] {
            assert_eq!(menu_click(&table, 0, mouse(kind, 3, 7)), EditAction::None);
        }
        // Jump는 메뉴 커서를 그 항목으로.
        let bs = boards();
        let mut t = None;
        let mut u = ui("B1", "P1", None);
        run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Jump(1));
        assert_eq!(u.cursor, 1);
    }

    /// 리뷰 B3: 좁은 화면에서 빠지는 순서 — 표시 순서는 그대로, `Enter 저장`이 마지막까지.
    #[test]
    fn edit_key_bar_keeps_save_longest() {
        use handicap_tui::view::edit::fit_keys;
        let input = ["Enter 저장", "Esc 취소", "Ctrl+U 지우기"];
        assert_eq!(fit_keys(&input, 80), input);
        let w = |segs: &[&str]| {
            let s = segs.join("  ");
            ratatui::text::Span::raw(s).width() as u16 + 1
        };
        assert_eq!(fit_keys(&input, w(&input) - 1), ["Enter 저장", "Esc 취소"]);
        assert_eq!(
            fit_keys(&input, w(&["Enter 저장", "Esc 취소"]) - 1),
            ["Enter 저장"]
        );
        assert_eq!(fit_keys(&input, 5), ["Enter 저장"]);
        let pick = ["↑↓ 고르기", "Enter 저장", "Esc 취소"];
        assert_eq!(fit_keys(&pick, w(&pick) - 1), ["Enter 저장", "Esc 취소"]);
        assert_eq!(fit_keys(&pick, 12), ["Enter 저장"]);
        let form = ["Tab 다음 칸", "Space 켜기·끄기", "Enter 저장", "Esc 취소"];
        assert_eq!(
            fit_keys(&form, w(&form) - 1),
            ["Space 켜기·끄기", "Enter 저장", "Esc 취소"]
        );
        assert_eq!(
            fit_keys(&form, w(&["Enter 저장", "Esc 취소"])),
            ["Enter 저장", "Esc 취소"]
        );
        assert_eq!(fit_keys(&form, 12), ["Enter 저장"]);
        // 저장·취소가 없는 줄은 기존 규칙(앞 조각부터).
        let menu = ["↑↓ 고르기", "1–14 번호", "Enter 수정", "Esc 모니터로"];
        assert_eq!(
            fit_keys(&menu, w(&menu) - 1),
            ["1–14 번호", "Enter 수정", "Esc 모니터로"]
        );
    }

    // ---------- tui-2b Task 4: 값 목록 편집 상태·선택 창·새 조건 칸·저장 ----------

    mod values {
        use super::*;
        use handicap_controller::monitor::config::{ConditionSource, DisplaySource};
        use handicap_tui::app::edit_keys;
        use handicap_tui::pick::{
            Blocked, Hint, PickValue, RowKind, ValueList, ValueRow, ValuesState, marks,
        };
        use handicap_tui::text;

        fn body_str(path: &str, v: &str) -> ValueRow {
            ValueRow {
                kind: RowKind::Body { path: path.into() },
                value: PickValue::Str(v.into()),
            }
        }

        fn body_text_row() -> ValueRow {
            ValueRow {
                kind: RowKind::BodyText,
                value: PickValue::BodyText,
            }
        }

        fn state(rows: Vec<ValueRow>) -> ValuesState {
            ValuesState::new(
                ST.into(),
                ValueList {
                    rows,
                    notes: vec![],
                },
                None,
            )
        }

        /// 보드 B1·칸 P1의 `EditUi` + 값 목록(`pick::ValuesState::new`로).
        fn values_ui(rows: Vec<ValueRow>) -> EditUi {
            let mut u = ui("B1", "P1", None);
            u.values = Some(state(rows));
            u
        }

        fn cond(i: usize) -> Condition {
            Condition {
                step_id: ST.into(),
                source: ConditionSource::Status,
                op: ConditionOp::Eq,
                value: format!("{}", 200 + i),
                ..Condition::default()
            }
        }

        fn ten_conds(bs: &mut [BoardResponse]) {
            bs[0].config.panels[0].conditions = (0..10).map(cond).collect();
        }

        fn two_displays(bs: &mut [BoardResponse]) {
            bs[0].config.panels[0].display_items = vec![
                DisplayItem {
                    step_id: ST.into(),
                    source: DisplaySource::Status,
                    path: String::new(),
                },
                DisplayItem {
                    step_id: ST.into(),
                    source: DisplaySource::Header,
                    path: "x-a".into(),
                },
            ];
        }

        fn choice(cursor: usize, c: Option<&'static str>, d: Option<&'static str>) -> Overlay {
            Overlay::AddChoice {
                cursor,
                cond_block: c,
                display_block: d,
            }
        }

        fn ck(c: KeyCode) -> EditAction {
            EditAction::CondKey(KeyEvent::new(c, KeyModifiers::NONE))
        }

        fn eight_rows() -> Vec<ValueRow> {
            (0..8)
                .map(|i| body_str(&format!("$.k{i}"), &format!("v{i}")))
                .collect()
        }

        #[test]
        fn values_keys() {
            let s = Screen::Values;
            let u = values_ui(eight_rows());
            for (k, want) in [
                (key(KeyCode::Down), EditAction::MoveCursor(1)),
                (ch('j'), EditAction::MoveCursor(1)),
                (key(KeyCode::Up), EditAction::MoveCursor(-1)),
                (ch('k'), EditAction::MoveCursor(-1)),
                (key(KeyCode::PageDown), EditAction::MoveCursor(10)),
                (key(KeyCode::PageUp), EditAction::MoveCursor(-10)),
                (key(KeyCode::Home), EditAction::Jump(0)),
                (key(KeyCode::End), EditAction::Jump(usize::MAX)),
                (key(KeyCode::Enter), EditAction::Activate),
                (key(KeyCode::Esc), EditAction::Back),
                (ch('q'), EditAction::AskQuit),
                (ctrl('c'), EditAction::AskQuit),
                (ctrl('b'), EditAction::None),
                (ch('1'), EditAction::None),
                (ch('r'), EditAction::None),
                (ch('a'), EditAction::None),
                (ch('d'), EditAction::None),
                (ch('s'), EditAction::None),
                (ch('v'), EditAction::None),
            ] {
                assert_eq!(ek(&s, &u, k), want, "{k:?}");
            }
        }

        #[test]
        fn values_cursor_is_separate() {
            let bs = boards();
            let mut t = None;
            let mut u = values_ui(eight_rows());
            u.cursor = 10;
            u.list_cursor = 3;
            let s = Screen::Values;
            run(&s, &mut u, &bs, &mut t, EditAction::MoveCursor(1));
            assert_eq!(u.values.as_ref().unwrap().cursor, 1);
            run(&s, &mut u, &bs, &mut t, EditAction::MoveCursor(10));
            assert_eq!(u.values.as_ref().unwrap().cursor, 7, "끝에서 가둠");
            run(&s, &mut u, &bs, &mut t, EditAction::Jump(0));
            assert_eq!(u.values.as_ref().unwrap().cursor, 0);
            run(&s, &mut u, &bs, &mut t, EditAction::Jump(usize::MAX));
            assert_eq!(u.values.as_ref().unwrap().cursor, 7);
            run(&s, &mut u, &bs, &mut t, EditAction::MoveCursor(-20));
            assert_eq!(u.values.as_ref().unwrap().cursor, 0, "처음에서 가둠");
            assert_eq!((u.cursor, u.list_cursor), (10, 3), "메뉴·목록 커서 불변");
        }

        #[test]
        fn activate_opens_choice() {
            let s = Screen::Values;
            let row = || vec![body_str("$.status", "OK")];
            // 보통 줄 → 선택 창(둘 다 열림, 커서 0).
            let bs = boards();
            let mut t = None;
            let mut u = values_ui(row());
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, Some(choice(0, None, None)));
            // 조건 10개 → 커서 1, 조건 줄 막힘.
            let mut bs10 = boards();
            ten_conds(&mut bs10);
            let mut u = values_ui(row());
            run(&s, &mut u, &bs10, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, Some(choice(1, Some(text::COND_MAX), None)));
            // 표시 값 2개 → 커서 0, 표시 줄 막힘.
            let mut bs2 = boards();
            two_displays(&mut bs2);
            let mut u = values_ui(row());
            run(&s, &mut u, &bs2, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, Some(choice(0, None, Some(text::DISPLAY_MAX))));
            // 둘 다 막힘 → 안내 한 번에 두 이유.
            let mut both = boards();
            ten_conds(&mut both);
            two_displays(&mut both);
            let mut u = values_ui(row());
            let out = run(&s, &mut u, &both, &mut t, EditAction::Activate);
            assert!(out.req.is_none());
            assert_eq!(
                u.overlay,
                Some(Overlay::Notice(format!(
                    "{} · {}",
                    text::COND_MAX,
                    text::DISPLAY_MAX
                )))
            );
            // `본문 전체` 줄 → 바로 조건 칸(글자 포함, 값 칸에서 시작).
            let mut u = values_ui(vec![body_text_row()]);
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            let Some(Overlay::CondForm {
                target,
                ops,
                op,
                focus,
                value,
                ..
            }) = &u.overlay
            else {
                panic!("{:?}", u.overlay);
            };
            assert!(
                matches!(
                    target,
                    CondTarget::New {
                        source: ConditionSource::BodyText,
                        ..
                    }
                ),
                "{target:?}"
            );
            assert_eq!(ops[*op], ConditionOp::Contains);
            assert_eq!(*focus, CondFocus::Value);
            assert_eq!(value.text(), "");
            // `본문 전체` + 조건 10개 → 이유 안내만.
            let mut u = values_ui(vec![body_text_row()]);
            run(&s, &mut u, &bs10, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, Some(Overlay::Notice(text::COND_MAX.into())));
            // 막힌 상태(줄이 있어도) → 창 없음 — 줄 1개라야 `blocked` 가드에 이빨이 있다.
            let mut u = ui("B1", "P1", None);
            u.values = Some(ValuesState::new(
                ST.into(),
                ValueList {
                    rows: row(),
                    notes: vec![],
                },
                Some(Blocked::NoResponse),
            ));
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, None);
            // 줄 0개 → 창 없음.
            let mut u = values_ui(vec![]);
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            assert_eq!(u.overlay, None);
            assert_eq!(t, None, "요청 없음");
        }

        #[test]
        fn choice_keys_and_blocked_rows() {
            let s = Screen::Values;
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(0, None, None));
            assert_eq!(ek(&s, &u, key(KeyCode::Down)), EditAction::PickMove(1));
            assert_eq!(ek(&s, &u, ch('j')), EditAction::PickMove(1));
            assert_eq!(ek(&s, &u, key(KeyCode::Up)), EditAction::PickMove(-1));
            assert_eq!(ek(&s, &u, key(KeyCode::Enter)), EditAction::PickChoose);
            assert_eq!(ek(&s, &u, key(KeyCode::Esc)), EditAction::PickCancel);
            assert_eq!(ek(&s, &u, ch('q')), EditAction::AskQuit);
            assert_eq!(ek(&s, &u, ctrl('b')), EditAction::None);
            // 커서는 0/1에 가둔다.
            let bs = boards();
            let mut t = None;
            for _ in 0..3 {
                run(&s, &mut u, &bs, &mut t, EditAction::PickMove(1));
            }
            assert_eq!(u.overlay, Some(choice(1, None, None)));
            run(&s, &mut u, &bs, &mut t, EditAction::PickMove(-5));
            assert_eq!(u.overlay, Some(choice(0, None, None)));
            run(&s, &mut u, &bs, &mut t, EditAction::PickCancel);
            assert_eq!(u.overlay, None);
            // 막힌 줄에서 Enter → 창 그대로·요청 없음.
            let mut bs10 = boards();
            ten_conds(&mut bs10);
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(0, Some(text::COND_MAX), None));
            let out = run(&s, &mut u, &bs10, &mut t, EditAction::PickChoose);
            assert!(out.req.is_none());
            assert_eq!(u.overlay, Some(choice(0, Some(text::COND_MAX), None)));
            let mut bs2 = boards();
            two_displays(&mut bs2);
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(1, None, Some(text::DISPLAY_MAX)));
            let out = run(&s, &mut u, &bs2, &mut t, EditAction::PickChoose);
            assert!(out.req.is_none());
            assert_eq!(u.overlay, Some(choice(1, None, Some(text::DISPLAY_MAX))));
            assert_eq!(t, None);
        }

        /// 줄 하나로 값 목록 → Enter → `조건으로 추가` → 조건 칸.
        fn open_form(row: ValueRow, bs: &[BoardResponse]) -> EditUi {
            let mut t = None;
            let mut u = values_ui(vec![row]);
            run(&Screen::Values, &mut u, bs, &mut t, EditAction::Activate);
            run(&Screen::Values, &mut u, bs, &mut t, EditAction::PickChoose);
            u
        }

        #[test]
        fn choose_condition_opens_prefilled_form() {
            let bs = boards();
            let u = open_form(body_str("$.status", "OK"), &bs);
            let Some(Overlay::CondForm {
                target,
                ops,
                op,
                value,
                focus,
                error,
                ..
            }) = &u.overlay
            else {
                panic!("{:?}", u.overlay);
            };
            assert_eq!(
                *target,
                CondTarget::New {
                    step_id: ST.into(),
                    source: ConditionSource::Body,
                    path: "$.status".into(),
                    shown: "\"OK\"".into(),
                    hint: None,
                }
            );
            assert_eq!(ops[*op], ConditionOp::Eq);
            assert_eq!(value.text(), "OK");
            assert_eq!(*focus, CondFocus::Op);
            assert_eq!(*error, None);
            // 41자 → 값 있음 + 매번 바뀌는 값 안내.
            let long = "x".repeat(41);
            let u = open_form(body_str("$.token", &long), &bs);
            let Some(Overlay::CondForm {
                target, ops, op, ..
            }) = &u.overlay
            else {
                panic!("{:?}", u.overlay);
            };
            assert_eq!(ops[*op], ConditionOp::NotEmpty);
            assert!(
                matches!(
                    target,
                    CondTarget::New {
                        hint: Some(Hint::Volatile),
                        ..
                    }
                ),
                "{target:?}"
            );
            // 인증 헤더 → 가린 값 안내.
            let u = open_form(
                ValueRow {
                    kind: RowKind::Header {
                        name: "authorization".into(),
                    },
                    value: PickValue::Header("••••".into()),
                },
                &bs,
            );
            let Some(Overlay::CondForm {
                target,
                ops,
                op,
                value,
                ..
            }) = &u.overlay
            else {
                panic!("{:?}", u.overlay);
            };
            assert_eq!(ops[*op], ConditionOp::NotEmpty);
            assert_eq!(value.text(), "", "가린 값이 비교값으로 들어가지 않는다");
            assert!(
                matches!(
                    target,
                    CondTarget::New {
                        source: ConditionSource::Header,
                        hint: Some(Hint::Masked),
                        ..
                    }
                ),
                "{target:?}"
            );
        }

        #[test]
        fn save_new_condition_request() {
            let mut bs = boards();
            bs[0].config.panels[0].conditions = vec![cond(0)];
            let mut u = open_form(body_str("$.status", "OK"), &bs);
            let form = u.overlay.clone().unwrap();
            let mut t = None;
            let out = run(&Screen::Values, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard {
                panel_id, config, ..
            }) = out.req
            else {
                panic!("no save request");
            };
            assert_eq!(panel_id, u.panel_id);
            assert_eq!(panel_id, "P1");
            let cs = &config.panels[0].conditions;
            assert_eq!(cs.len(), 2);
            assert_eq!(cs[0], cond(0), "기존 조건 그대로");
            assert_eq!(
                cs[1],
                Condition {
                    step_id: ST.into(),
                    source: ConditionSource::Body,
                    path: "$.status".into(),
                    op: ConditionOp::Eq,
                    value: "OK".into(),
                    ignore_case: false,
                    trim: false,
                }
            );
            assert_eq!(config.panels[1], bs[0].config.panels[1]);
            assert_eq!(u.overlay, Some(saving(Some(form))));
            // 규칙을 `키 있음`으로 바꾸고 저장 → 값 빈 글자.
            let mut u = open_form(body_str("$.status", "OK"), &bs);
            run(&Screen::Values, &mut u, &bs, &mut t, ck(KeyCode::Right));
            run(&Screen::Values, &mut u, &bs, &mut t, ck(KeyCode::Right));
            let Some(Overlay::CondForm { ops, op, .. }) = &u.overlay else {
                panic!("{:?}", u.overlay);
            };
            assert_eq!(ops[*op], ConditionOp::Exists);
            let mut t = None;
            let out = run(&Screen::Values, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard { config, .. }) = out.req else {
                panic!("no save request");
            };
            let c = config.panels[0].conditions.last().unwrap();
            assert_eq!((c.op, c.value.as_str()), (ConditionOp::Exists, ""));
            // 스텝 칸 → step_id = 칸의 스텝.
            let mut bs = boards();
            bs[0].config.panels[0].step_id = Some("STEP-OWN".into());
            let mut u = open_form(body_str("$.status", "OK"), &bs);
            let mut t = None;
            let out = run(&Screen::Values, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard { config, .. }) = out.req else {
                panic!("no save request");
            };
            assert_eq!(config.panels[0].conditions[0].step_id, "STEP-OWN");
        }

        #[test]
        fn save_new_display_request() {
            let bs = boards();
            let mut t = None;
            let mut u = values_ui(vec![body_str("$.status", "OK")]);
            run(&Screen::Values, &mut u, &bs, &mut t, EditAction::Activate);
            run(
                &Screen::Values,
                &mut u,
                &bs,
                &mut t,
                EditAction::PickMove(1),
            );
            let out = run(&Screen::Values, &mut u, &bs, &mut t, EditAction::PickChoose);
            let Some(EditReq::SaveBoard {
                panel_id, config, ..
            }) = out.req
            else {
                panic!("no save request");
            };
            assert_eq!(panel_id, "P1");
            assert_eq!(
                config.panels[0].display_items,
                vec![DisplayItem {
                    step_id: ST.into(),
                    source: DisplaySource::Body,
                    path: "$.status".into(),
                }]
            );
            assert!(config.panels[0].conditions.is_empty());
            assert_eq!(u.overlay, Some(saving(None)));
        }

        #[test]
        fn save_results() {
            let bs0 = boards();
            let mut bs = bs0.clone();
            let mut t = None;
            let s = Screen::Values;
            let mut u = values_ui(eight_rows());
            u.cursor = 10; // 메뉴 11번(성공 조건) — `apply_done`이 `list_cursor`를 그 목록 길이로 자른다.
            u.list_cursor = 0;
            run(&s, &mut u, &bs, &mut t, EditAction::Jump(5));
            assert_eq!(u.values.as_ref().unwrap().cursor, 5);
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            run(&s, &mut u, &bs, &mut t, EditAction::PickChoose);
            let form = u.overlay.clone().unwrap();
            let out = run(&s, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard { seq, config, .. }) = out.req else {
                panic!("no save request");
            };
            assert_eq!(
                config.panels[0].conditions[0].path, "$.k5",
                "고른 줄의 조건"
            );
            // 서버 성공 → 창 닫힘·값 목록 그대로·커서 그대로·표지 1.
            let mut saved = bs0[0].clone();
            saved.config = config.clone();
            let n = apply_done(
                Some(&mut u),
                &mut bs,
                &mut t,
                saved_board(seq, saved, Some(Ok(()))),
                7,
            );
            assert_eq!(n, Some(HeaderNotice::Saved(7)));
            assert_eq!(u.overlay, None);
            let v = u.values.as_ref().expect("값 목록 그대로");
            assert_eq!(v.list.rows.len(), 8);
            assert_eq!(v.cursor, 5, "저장 뒤 값 목록 커서가 튀지 않는다");
            assert_eq!(u.list_cursor, 0);
            let p = &bs[0].config.panels[0];
            assert_eq!(marks(p, &v.step_id, &v.list.rows[5]), (1, false));
            assert_eq!(marks(p, &v.step_id, &v.list.rows[0]), (0, false));
            // 그 뒤 Enter도 같은 줄(5)을 고른다.
            run(&s, &mut u, &bs, &mut t, EditAction::Activate);
            run(&s, &mut u, &bs, &mut t, EditAction::PickChoose);
            assert!(
                matches!(&u.overlay, Some(Overlay::CondForm { target: CondTarget::New { path, .. }, .. }) if path == "$.k5"),
                "{:?}",
                u.overlay
            );
            // 서버 거절(조건) → 조건 칸이 오류 줄을 달고 되살아나며 대상은 New 그대로.
            let mut bs = bs0.clone();
            let mut t = None;
            let mut u = values_ui(eight_rows());
            u.overlay = Some(form.clone());
            let out = run(&s, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let seq = match out.req {
                Some(EditReq::SaveBoard { seq, .. }) => seq,
                r => panic!("{r:?}"),
            };
            apply_done(
                Some(&mut u),
                &mut bs,
                &mut t,
                rejected(seq, "B1", "거절-사유"),
                0,
            );
            let Some(Overlay::CondForm { target, error, .. }) = &u.overlay else {
                panic!("{:?}", u.overlay);
            };
            assert_eq!(error.as_deref(), Some("거절-사유"));
            let Overlay::CondForm { target: want, .. } = &form else {
                unreachable!()
            };
            assert_eq!(target, want, "거절 뒤에도 대상·받은 값 그대로");
            assert!(matches!(target, CondTarget::New { .. }));
            // 서버 거절(표시) → 안내.
            let mut t = None;
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(1, None, None));
            let out = run(&s, &mut u, &bs, &mut t, EditAction::PickChoose);
            let seq = match out.req {
                Some(EditReq::SaveBoard { seq, .. }) => seq,
                r => panic!("{r:?}"),
            };
            apply_done(
                Some(&mut u),
                &mut bs,
                &mut t,
                rejected(seq, "B1", "표시-거절"),
                0,
            );
            assert_eq!(u.overlay, Some(Overlay::Notice("표시-거절".into())));
            assert!(u.values.is_some());
        }

        #[test]
        fn saving_in_flight() {
            let bs = boards();
            let s = Screen::Values;
            let busy = || ticket(1, "B1", "P2");
            // 화면에 추가.
            let mut t = busy();
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(1, None, None));
            let out = run(&s, &mut u, &bs, &mut t, EditAction::PickChoose);
            assert!(out.req.is_none());
            assert_eq!(u.overlay, Some(Overlay::Notice(text::SAVING.into())));
            assert_eq!(t, busy());
            // 조건 칸 저장.
            let mut u = open_form(body_str("$.status", "OK"), &bs);
            let out = run(&s, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            assert!(out.req.is_none());
            assert_eq!(u.overlay, Some(Overlay::Notice(text::SAVING.into())));
            assert_eq!(t, busy());
        }

        #[test]
        fn esc_ignored_while_saving() {
            let s = Screen::Values;
            let mut u = values_ui(eight_rows());
            u.overlay = Some(saving(None));
            for k in [key(KeyCode::Esc), key(KeyCode::Enter), key(KeyCode::Down)] {
                assert_eq!(ek(&s, &u, k), EditAction::None, "{k:?}");
            }
            assert_eq!(ek(&s, &u, ch('q')), EditAction::AskQuit);
        }

        #[test]
        fn back_from_values() {
            let lines = vec![http_line(0)];
            // 오류 보기 경로 → 값 목록을 나가면 `EditUi` 없음.
            let mut v = SubViews::default();
            v.open_errors("B1", "P1", &[7]);
            v.open_record(result(7)).unwrap();
            assert_eq!(v.open_body(&lines), Some(Screen::Body));
            v.body.as_mut().unwrap().scroll = 3;
            v.edit = Some(values_ui(eight_rows()));
            assert_eq!(v.back(&Screen::Values), Some(Screen::Body));
            assert!(v.edit.is_none(), "오류 보기 경로는 EditUi를 남기지 않는다");
            assert_eq!(v.body.as_ref().unwrap().scroll, 3, "요청·응답 상태 그대로");
            assert!(v.record.is_some());
            // 칸 설정 경로 → `values`만 비우고 메뉴 커서는 둔다.
            let mut v = SubViews::default();
            let mut e = ui("B1", "P1", None);
            e.cursor = 6;
            v.edit = Some(e);
            v.open_record_from_settings(result(11), false).unwrap();
            assert_eq!(v.open_body(&lines), Some(Screen::Body));
            v.edit.as_mut().unwrap().values = Some(state(eight_rows()));
            assert_eq!(v.back(&Screen::Values), Some(Screen::Body));
            let e = v.edit.as_ref().expect("칸 설정 경로는 EditUi를 남긴다");
            assert!(e.values.is_none());
            assert_eq!(e.cursor, 6);
            assert!(v.body.is_some() && v.record.is_some());
        }

        #[test]
        fn idle_drops_values() {
            let mut u = values_ui(eight_rows());
            u.overlay = Some(choice(0, None, None));
            idle_drop(&mut u);
            assert!(u.values.is_none());
            assert!(u.overlay.is_none());
            // 저장 중이면 `Saving`은 남고 되살릴 조건 칸·값 목록은 버린다.
            let bs = boards();
            let form = open_form(body_str("$.status", "OK"), &bs).overlay.unwrap();
            let mut u = values_ui(eight_rows());
            u.overlay = Some(saving(Some(form)));
            idle_drop(&mut u);
            assert_eq!(u.overlay, Some(saving(None)));
            assert!(u.values.is_none());
            let t0 = Instant::now();
            assert!(!idle_expired(
                &Screen::Values,
                t0,
                t0 + IDLE_RETURN - Duration::from_secs(1)
            ));
            assert!(idle_expired(&Screen::Values, t0, t0 + IDLE_RETURN));
            assert!(idle_expired(
                &Screen::QuitConfirm(Box::new(Screen::Values)),
                t0,
                t0 + IDLE_RETURN
            ));
        }

        #[test]
        fn existing_condition_edit_unchanged() {
            let mut bs = boards();
            bs[0].config.panels[0].conditions = vec![cond(0), cond(1)];
            let mut t = None;
            let mut u = ui("B1", "P1", None);
            u.cursor = 10;
            u.list_cursor = 1;
            run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Activate);
            assert!(
                matches!(
                    &u.overlay,
                    Some(Overlay::CondForm {
                        target: CondTarget::Existing(1),
                        ..
                    })
                ),
                "{:?}",
                u.overlay
            );
            run(&Screen::EditList, &mut u, &bs, &mut t, ck(KeyCode::Tab));
            run(
                &Screen::EditList,
                &mut u,
                &bs,
                &mut t,
                EditAction::Input(InputOutcome::Edited, text_input("404")),
            );
            let out = run(&Screen::EditList, &mut u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard { seq, config, .. }) = out.req else {
                panic!("no save request");
            };
            let cs = &config.panels[0].conditions;
            assert_eq!(cs.len(), 2, "추가가 아니라 수정");
            assert_eq!(cs[0], cond(0));
            assert_eq!(cs[1].value, "404");
            // 거절 → 같은 줄(Existing(1))의 조건 칸이 되살아난다.
            apply_done(Some(&mut u), &mut bs, &mut t, rejected(seq, "B1", "x"), 0);
            assert!(
                matches!(
                    &u.overlay,
                    Some(Overlay::CondForm {
                        target: CondTarget::Existing(1),
                        error: Some(_),
                        ..
                    })
                ),
                "{:?}",
                u.overlay
            );
        }

        #[test]
        fn keys_bar_on_values() {
            let mut u = values_ui(eight_rows());
            assert_eq!(
                edit_keys(&Screen::Values, &u, None, false),
                [text::KEYS_PICK, text::KEYS_ADD_ENTER, text::KEYS_TO_BODY]
            );
            assert_eq!(text::KEYS_ADD_ENTER, "Enter 추가");
            assert_eq!(text::KEYS_TO_BODY, "Esc 요청·응답으로");
            assert_eq!(text::KEYS_CHOOSE, "Enter 선택");
            u.overlay = Some(choice(0, None, None));
            assert_eq!(
                edit_keys(&Screen::Values, &u, None, false),
                [text::KEYS_PICK, text::KEYS_CHOOSE, text::KEYS_CANCEL]
            );
            let u = values_ui(vec![]);
            assert_eq!(
                edit_keys(&Screen::Values, &u, None, false),
                [text::KEYS_TO_BODY]
            );
            let mut u = ui("B1", "P1", None);
            u.values = Some(ValuesState::new(
                ST.into(),
                ValueList {
                    rows: vec![body_str("$.a", "b")],
                    notes: vec![],
                },
                Some(Blocked::NoResponse),
            ));
            assert_eq!(
                edit_keys(&Screen::Values, &u, None, false),
                [text::KEYS_TO_BODY]
            );
        }

        #[test]
        fn debug_hides_values() {
            let form = Overlay::CondForm {
                target: CondTarget::New {
                    step_id: "STEPSECRET".into(),
                    source: ConditionSource::Body,
                    path: "$.secretpath".into(),
                    shown: "SECRETVALUE".into(),
                    hint: None,
                },
                ops: vec![ConditionOp::Eq],
                op: 0,
                value: text_input("TYPEDVALUE"),
                ignore_case: false,
                trim: false,
                focus: CondFocus::Op,
                error: None,
            };
            let mut u = values_ui(vec![body_str("$.secretpath", "SECRETVALUE")]);
            u.overlay = Some(form.clone());
            let target = CondTarget::New {
                step_id: "STEPSECRET".into(),
                source: ConditionSource::Body,
                path: "$.secretpath".into(),
                shown: "SECRETVALUE".into(),
                hint: Some(Hint::Masked),
            };
            let change = Change::AddCondition(Condition {
                step_id: "STEPSECRET".into(),
                source: ConditionSource::Body,
                path: "$.secretpath".into(),
                op: ConditionOp::Eq,
                value: "SECRETVALUE".into(),
                ..Condition::default()
            });
            let display = Change::AddDisplay(DisplayItem {
                step_id: "STEPSECRET".into(),
                source: DisplaySource::Body,
                path: "$.secretpath".into(),
            });
            let ds = [
                format!("{form:?}"),
                format!("{u:?}"),
                format!("{target:?}"),
                format!("{change:?}"),
                format!("{display:?}"),
                format!("{:?}", saving(Some(form.clone()))),
                format!("{:?}", choice(0, Some(text::COND_MAX), None)),
            ];
            for d in &ds {
                for leak in ["SECRETVALUE", "secretpath", "STEPSECRET", "TYPEDVALUE"] {
                    assert!(!d.contains(leak), "{leak} leaked: {d}");
                }
            }
            assert_eq!(ds[3], "AddCondition");
            assert_eq!(ds[4], "AddDisplay");
            assert!(ds[1].contains("values"), "{}", ds[1]);
        }

        // ---------- tui-2b Task 5: 요청·응답의 `a` → 값 목록 ----------

        /// 오류 보기 경로: 목록(보드 `b`·칸 `p`) → 자세히 → 요청·응답.
        fn errors_views(b: &str, p: &str) -> SubViews {
            let mut v = SubViews::default();
            v.open_errors(b, p, &[7]);
            v.open_record(result(7)).unwrap();
            assert_eq!(v.open_body(&[http_line(0)]), Some(Screen::Body));
            v
        }

        /// 칸 설정 경로: 칸 설정(`edit` = B1·P1, 메뉴 커서 10) → `r` 자세히 → 요청·응답.
        fn settings_views() -> SubViews {
            let mut v = SubViews::default();
            let mut e = ui("B1", "P1", None);
            e.cursor = 10;
            e.list_cursor = 2;
            v.edit = Some(e);
            v.open_record_from_settings(result(11), false).unwrap();
            assert_eq!(v.open_body(&[http_line(0)]), Some(Screen::Body));
            v
        }

        #[test]
        fn enter_values_creates_edit_for_record_panel() {
            let mut v = errors_views("B1", "P2");
            assert!(v.edit.is_none());
            assert_eq!(
                v.enter_values(state(eight_rows()), None),
                Some(Screen::Values)
            );
            let e = v.edit.as_ref().expect("EditUi를 만든다");
            assert_eq!((e.board_id.as_str(), e.panel_id.as_str()), ("B1", "P2"));
            assert!(e.values.is_some());
            assert_eq!(e.overlay, None);
        }

        #[test]
        fn enter_values_replaces_other_panels_edit() {
            // 5분 복귀 뒤 저장이 끝나 남은 칸 P1의 `EditUi` + 칸 P2의 기록에서 `a`.
            let mut v = errors_views("B1", "P2");
            let mut left = ui("B1", "P1", None);
            left.cursor = 7;
            v.edit = Some(left);
            assert_eq!(
                v.enter_values(state(vec![body_str("$.status", "OK")]), None),
                Some(Screen::Values)
            );
            let u = v.edit.as_mut().unwrap();
            assert_eq!((u.board_id.as_str(), u.panel_id.as_str()), ("B1", "P2"));
            assert_eq!(u.cursor, 0, "남은 EditUi를 쓰지 않는다");
            // 조건으로 저장 → 요청의 칸 = P2, 바뀐 칸도 P2.
            let bs = boards();
            let mut t = None;
            let s = Screen::Values;
            run(&s, u, &bs, &mut t, EditAction::Activate);
            run(&s, u, &bs, &mut t, EditAction::PickChoose);
            let out = run(&s, u, &bs, &mut t, ck(KeyCode::Enter));
            let Some(EditReq::SaveBoard {
                panel_id, config, ..
            }) = out.req
            else {
                panic!("no save request");
            };
            assert_eq!(panel_id, "P2");
            assert_eq!(config.panels[1].conditions.len(), 1);
            assert_eq!(config.panels[1].conditions[0].path, "$.status");
            assert!(config.panels[0].conditions.is_empty(), "칸 P1 불변");
        }

        #[test]
        fn enter_values_replaces_other_boards_edit_with_same_panel_id() {
            // 남은 EditUi = 다른 보드 B2의 같은 칸 id P2, 기록 = B1/P2.
            let mut v = errors_views("B1", "P2");
            let mut left = ui("B2", "P2", None);
            left.cursor = 7;
            v.edit = Some(left);
            assert_eq!(
                v.enter_values(state(vec![body_str("$.status", "OK")]), None),
                Some(Screen::Values)
            );
            let u = v.edit.as_ref().unwrap();
            assert_eq!((u.board_id.as_str(), u.panel_id.as_str()), ("B1", "P2"));
            assert_eq!(u.cursor, 0, "다른 보드의 EditUi를 쓰지 않는다");
        }

        #[test]
        fn enter_values_keeps_same_panel_edit() {
            let mut v = settings_views();
            assert_eq!(
                v.enter_values(state(eight_rows()), None),
                Some(Screen::Values)
            );
            let e = v.edit.as_ref().unwrap();
            assert_eq!((e.cursor, e.list_cursor), (10, 2), "같은 EditUi");
            assert!(e.values.is_some());
        }

        #[test]
        fn enter_values_with_save_in_flight() {
            let t = SaveTicket {
                seq: 1,
                board_id: "B1".into(),
                panel_id: "P1".into(),
            };
            let mut v = errors_views("B1", "P1");
            v.enter_values(state(eight_rows()), Some(&t));
            assert_eq!(v.edit.as_ref().unwrap().overlay, Some(saving(None)));
            let mut v = errors_views("B1", "P2");
            v.enter_values(state(eight_rows()), Some(&t));
            assert_eq!(
                v.edit.as_ref().unwrap().overlay,
                Some(Overlay::Notice(text::SAVING.to_string()))
            );
            // 기록이 없으면 아무것도 안 한다.
            let mut v = SubViews::default();
            assert_eq!(v.enter_values(state(eight_rows()), Some(&t)), None);
            assert!(v.edit.is_none());
        }

        #[test]
        fn esc_chain_errors_path() {
            let mut v = errors_views("B1", "P1");
            assert_eq!(
                v.enter_values(state(eight_rows()), None),
                Some(Screen::Values)
            );
            assert_eq!(v.back(&Screen::Values), Some(Screen::Body));
            assert!(v.edit.is_none(), "값 목록을 나오면 EditUi 없음");
            assert_eq!(v.back(&Screen::Body), Some(Screen::Record));
            assert_eq!(v.back(&Screen::Record), Some(Screen::Errors));
            assert_eq!(v.back(&Screen::Errors), Some(Screen::Monitor));
            assert!(v.edit.is_none());
        }

        #[test]
        fn esc_chain_settings_path() {
            let mut v = settings_views();
            assert_eq!(
                v.enter_values(state(eight_rows()), None),
                Some(Screen::Values)
            );
            assert_eq!(v.back(&Screen::Values), Some(Screen::Body));
            assert_eq!(v.back(&Screen::Body), Some(Screen::Record));
            assert_eq!(v.back(&Screen::Record), Some(Screen::Settings));
            let e = v.edit.as_ref().expect("칸 설정 경로는 EditUi를 남긴다");
            assert!(e.values.is_none());
            assert_eq!(e.cursor, 10);
        }

        #[test]
        fn back_from_values_ignored_while_saving() {
            for mut v in [errors_views("B1", "P1"), settings_views()] {
                v.enter_values(state(eight_rows()), None).unwrap();
                v.edit.as_mut().unwrap().overlay = Some(saving(None));
                assert_eq!(v.back(&Screen::Values), None);
                let e = v.edit.as_ref().expect("저장 중 EditUi를 버리지 않는다");
                assert!(e.values.is_some(), "값 목록 그대로");
                assert_eq!(e.overlay, Some(saving(None)));
                assert!(v.body.is_some());
            }
        }

        // ---------- tui-2b Task 7: 하위 목록 11·12의 `a` ----------

        /// 메뉴 커서 `cursor`(0부터 — 7 = 8번 기준선, 10 = 11번 조건, 11 = 12번 표시)에서 연 하위 목록의 `EditUi`.
        fn list_ui(cursor: usize) -> EditUi {
            let mut u = ui("B1", "P1", None);
            u.cursor = cursor;
            u
        }

        #[test]
        fn list_a_blocked() {
            let mut t = None;
            // 11번·조건 10개 → 이유 안내만, 점검 없음.
            let mut bs = boards();
            ten_conds(&mut bs);
            let mut u = list_ui(10);
            let out = run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Add);
            assert_eq!(u.overlay, Some(Overlay::Notice(text::COND_MAX.to_string())));
            assert_eq!(out.check, None);
            assert!(out.req.is_none());
            // 12번·표시 값 2개 → 이유 안내만.
            let mut bs = boards();
            two_displays(&mut bs);
            let mut u = list_ui(11);
            let out = run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Add);
            assert_eq!(
                u.overlay,
                Some(Overlay::Notice(text::DISPLAY_MAX.to_string()))
            );
            assert_eq!(out.check, None);
            // 11번·9개 / 12번·1개 / 빈 목록 → 점검 의도(창은 `run_edit`의 `start_check`가 띄운다).
            let mut nine = boards();
            nine[0].config.panels[0].conditions = (0..9).map(cond).collect();
            let mut one = boards();
            two_displays(&mut one);
            one[0].config.panels[0].display_items.pop();
            for (cursor, bs) in [
                (10, &nine),
                (11, &one),
                (10, &boards()),
                (11, &boards()),
                // 표시 값 2개여도 11번(조건)은 막히지 않는다 — 막힘은 그 목록의 것.
                (10, &{
                    let mut b = boards();
                    two_displays(&mut b);
                    b
                }),
            ] {
                let mut u = list_ui(cursor);
                let out = run(&Screen::EditList, &mut u, bs, &mut t, EditAction::Add);
                assert_eq!(out.check, Some(CheckThen::Values), "{cursor}");
                assert_eq!(u.overlay, None, "{cursor}");
                assert!(out.req.is_none() && out.screen.is_none(), "{cursor}");
            }
            // 8번(기준선) → 지금처럼 새 기준선 입력줄, 점검 없음.
            let bs = boards();
            let mut u = list_ui(7);
            let out = run(&Screen::EditList, &mut u, &bs, &mut t, EditAction::Add);
            assert!(
                matches!(
                    u.overlay,
                    Some(Overlay::Input {
                        target: InputTarget::ThresholdNew,
                        ..
                    })
                ),
                "{:?}",
                u.overlay
            );
            assert_eq!(out.check, None);
            // 하위 목록이 아닌 화면의 `Add`는 무동작.
            let mut u = list_ui(10);
            let out = run(&Screen::Settings, &mut u, &bs, &mut t, EditAction::Add);
            assert_eq!(out.check, None);
            assert_eq!(u.overlay, None);
        }

        #[test]
        fn idle_and_cancel() {
            let values = Overlay::Checking {
                seq: 1,
                wait: CheckWait::Sent,
                then: CheckThen::Values,
            };
            // 하위 목록의 대기 창: Esc = 닫기.
            let u = ui("B1", "P1", Some(values.clone()));
            assert_eq!(
                ek(&Screen::EditList, &u, key(KeyCode::Esc)),
                EditAction::CheckCancel
            );
            assert_eq!(ek(&Screen::EditList, &u, ch('a')), EditAction::None);
            let bs = boards();
            let mut t = None;
            let mut u = list_ui(10);
            u.overlay = Some(values.clone());
            run(
                &Screen::EditList,
                &mut u,
                &bs,
                &mut t,
                EditAction::CheckCancel,
            );
            assert_eq!(u.overlay, None);
            // 5분 복귀가 값 목록 의도의 대기 창도 버린다.
            for w in [CheckWait::Sent, CheckWait::After(Some(3))] {
                let mut u = ui_with(Overlay::Checking {
                    seq: 2,
                    wait: w,
                    then: CheckThen::Values,
                });
                idle_drop(&mut u);
                assert!(u.overlay.is_none());
            }
        }
    }
}

// ---------- tui-check-now Task 4: 모니터 `r` · 머리 줄 알림 ----------

#[test]
fn monitor_r_checks_now() {
    for c in ['r', 'R', 'ㄱ'] {
        assert_eq!(
            handle_key(&Screen::Monitor, ch(c), 1),
            Action::CheckNow,
            "{c}"
        );
    }
    assert_eq!(handle_key(&Screen::Monitor, ctrl('r'), 1), Action::None);
}

#[test]
fn r_elsewhere_keeps_old_meaning() {
    // 시작 오류 화면의 다시 시도는 그대로.
    assert_eq!(handle_key(&Screen::Error(err()), ch('r'), 1), Action::Retry);
    // 오류 보기·자세히·요청·응답·도움말에서는 무동작.
    for s in [Screen::Errors, Screen::Record, Screen::Body, Screen::Help] {
        for c in ['r', 'R', 'ㄱ'] {
            assert_eq!(handle_key(&s, ch(c), 1), Action::None, "{s:?} {c}");
        }
    }
}

#[test]
fn check_notice_maps_reply() {
    use handicap_tui::app::check_notice;
    use handicap_tui::view::monitor::HeaderNotice;
    assert_eq!(check_notice(&Ok(Some(1)), 99), HeaderNotice::CheckSent(99));
    assert_eq!(check_notice(&Ok(None), 99), HeaderNotice::CheckSent(99));
    assert_eq!(check_notice(&Err(Some(409)), 99), HeaderNotice::CheckOff);
    assert_eq!(check_notice(&Err(Some(404)), 99), HeaderNotice::CheckFailed);
    assert_eq!(check_notice(&Err(None), 99), HeaderNotice::CheckFailed);
}

#[test]
fn shown_notice_prefers_check_over_file() {
    use handicap_tui::app::shown_notice;
    use handicap_tui::view::monitor::HeaderNotice;
    let check = HeaderNotice::CheckSent(5);
    let file = HeaderNotice::FileFailed;
    assert_eq!(shown_notice(Some(&check), Some(&file)), Some(check.clone()));
    assert_eq!(shown_notice(None, Some(&file)), Some(file));
    assert_eq!(shown_notice(None, None), None);
}

// ---------- tui-check-now Task 5: 칸 설정의 r → 대기 창 → 자세히 ----------

fn checking(seq: u64, wait: CheckWait) -> Overlay {
    Overlay::Checking {
        seq,
        wait,
        then: CheckThen::Record,
    }
}

fn board_ui(o: Option<Overlay>) -> EditUi {
    EditUi {
        board_id: "B1".into(),
        panel_id: "P1".into(),
        overlay: o,
        ..EditUi::default()
    }
}

#[test]
fn check_keys_menu_and_waiting_window() {
    let menu = EditUi::default();
    for c in ['r', 'R', 'ㄱ'] {
        assert_eq!(
            ek(&Screen::Settings, &menu, ch(c)),
            EditAction::CheckNow,
            "{c}"
        );
    }
    // Ctrl+R은 무동작(Ctrl+문자 규칙).
    assert_eq!(ek(&Screen::Settings, &menu, ctrl('r')), EditAction::None);
    // 하위 목록·변수 화면의 r은 무동작.
    for s in [Screen::EditList, Screen::EnvVars, Screen::ScenarioVars] {
        assert_eq!(ek(&s, &menu, ch('r')), EditAction::None, "{s:?}");
    }
    // 입력줄의 r은 글자.
    let input = ui_with(input_overlay(""));
    let EditAction::Input(_, li) = ek(&Screen::Settings, &input, ch('r')) else {
        panic!("입력줄 r이 글자가 아님");
    };
    assert_eq!(li.text(), "r");
    // 대기 창: Esc = 닫기, q·Ctrl+C = 종료 확인, 그 밖 = 무동작.
    let wait = ui_with(checking(1, CheckWait::Sent));
    let s = Screen::Settings;
    assert_eq!(ek(&s, &wait, key(KeyCode::Esc)), EditAction::CheckCancel);
    assert_eq!(ek(&s, &wait, ch('q')), EditAction::AskQuit);
    assert_eq!(ek(&s, &wait, ctrl('c')), EditAction::AskQuit);
    for k in [ch('r'), key(KeyCode::Enter), ch('1'), ctrl('r')] {
        assert_eq!(ek(&s, &wait, k), EditAction::None, "{k:?}");
    }
    let after = ui_with(checking(1, CheckWait::After(Some(3))));
    assert_eq!(ek(&s, &after, key(KeyCode::Esc)), EditAction::CheckCancel);
    assert_eq!(ek(&s, &after, ch('r')), EditAction::None);
}

#[test]
fn start_check_numbers_and_request() {
    let mut ui = board_ui(None);
    let mut seq = 0u64;
    let req = start_check(&mut ui, &mut seq, CheckThen::Record);
    assert_eq!(seq, 1);
    assert_eq!(ui.overlay, Some(checking(1, CheckWait::Sent)));
    assert_eq!(
        req,
        FetchReq::CheckNow {
            board_id: "B1".into(),
            panel_id: "P1".into(),
            wait: Some(1)
        }
    );
    let req = start_check(&mut ui, &mut seq, CheckThen::Record);
    assert_eq!(seq, 2);
    assert_eq!(ui.overlay, Some(checking(2, CheckWait::Sent)));
    assert_eq!(
        req,
        FetchReq::CheckNow {
            board_id: "B1".into(),
            panel_id: "P1".into(),
            wait: Some(2)
        }
    );
}

#[test]
fn check_reply_applies_only_to_matching_wait() {
    // 맞는 번호 + 성공 → After.
    let mut ui = board_ui(Some(checking(3, CheckWait::Sent)));
    assert!(check_reply(&mut ui, 3, Ok(Some(5))));
    assert_eq!(ui.overlay, Some(checking(3, CheckWait::After(Some(5)))));
    let mut ui = board_ui(Some(checking(3, CheckWait::Sent)));
    assert!(check_reply(&mut ui, 3, Ok(None)));
    assert_eq!(ui.overlay, Some(checking(3, CheckWait::After(None))));
    // 409 → 꺼짐 안내, 그 밖 → 실패 안내.
    let mut ui = board_ui(Some(checking(3, CheckWait::Sent)));
    assert!(check_reply(&mut ui, 3, Err(Some(409))));
    assert_eq!(
        ui.overlay,
        Some(Overlay::Notice(handicap_tui::text::CHECK_OFF.to_string()))
    );
    for e in [None, Some(404), Some(500)] {
        let mut ui = board_ui(Some(checking(3, CheckWait::Sent)));
        assert!(check_reply(&mut ui, 3, Err(e)));
        assert_eq!(
            ui.overlay,
            Some(Overlay::Notice(
                handicap_tui::text::CHECK_NOW_FAILED.to_string()
            )),
            "{e:?}"
        );
    }
    // 받지 않는 경우: 번호가 다름·창 없음·이미 After·Saving → false, 창 불변.
    for o in [
        Some(checking(4, CheckWait::Sent)),
        None,
        Some(checking(3, CheckWait::After(Some(1)))),
        Some(Overlay::Saving { restore: None }),
        Some(Overlay::Notice("n".into())),
    ] {
        let mut ui = board_ui(o.clone());
        assert!(!check_reply(&mut ui, 3, Ok(Some(9))), "{o:?}");
        assert_eq!(ui.overlay, o);
        assert!(!check_reply(&mut ui, 3, Err(Some(409))), "{o:?}");
        assert_eq!(ui.overlay, o);
    }
}

#[test]
fn check_ready_needs_a_newer_result() {
    let ui = board_ui(Some(checking(1, CheckWait::After(Some(10)))));
    assert_eq!(check_ready(&ui, &[result(5), result(10)]), None);
    let got = check_ready(&ui, &[result(5), result(10), result(11)]).unwrap();
    assert_eq!(got.at_ms, 11);
    assert_eq!(check_ready(&ui, &[]), None);
    let none = board_ui(Some(checking(1, CheckWait::After(None))));
    assert_eq!(check_ready(&none, &[]), None);
    assert_eq!(check_ready(&none, &[result(3)]).unwrap().at_ms, 3);
    let sent = board_ui(Some(checking(1, CheckWait::Sent)));
    assert_eq!(check_ready(&sent, &[result(3)]), None);
    assert_eq!(check_ready(&board_ui(None), &[result(3)]), None);
}

#[test]
fn check_open_allowed_only_on_plain_settings() {
    let r = CheckThen::Record;
    assert!(check_open_allowed(&Screen::Settings, r));
    assert!(!check_open_allowed(
        &Screen::QuitConfirm(Box::new(Screen::Settings)),
        r
    ));
    assert!(!check_open_allowed(&Screen::EditList, r));
    assert!(!check_open_allowed(&Screen::Monitor, r));
}

#[test]
fn record_from_settings_opens_and_goes_back_to_settings() {
    let mut v = SubViews::default();
    assert!(
        v.open_record_from_settings(result(11), false).is_none(),
        "edit 없이"
    );
    let mut ui = board_ui(Some(checking(2, CheckWait::After(Some(5)))));
    ui.cursor = 6;
    v.edit = Some(ui);
    assert_eq!(
        v.open_record_from_settings(result(11), false),
        Some((
            Screen::Record,
            FetchReq::Record {
                board_id: "B1".into(),
                panel_id: "P1".into(),
                at_ms: 11
            }
        ))
    );
    assert!(v.errors.is_none(), "errors를 만들지 않는다");
    {
        let e = v.edit.as_ref().unwrap();
        assert!(e.overlay.is_none());
        assert_eq!(e.cursor, 6);
        let r = v.record.as_ref().unwrap();
        assert_eq!(
            (r.board_id.as_str(), r.panel_id.as_str(), r.at_ms),
            ("B1", "P1", 11)
        );
        assert_eq!(r.origin, RecordOrigin::Settings);
        assert!(matches!(r.load, RecordLoad::Loading));
        assert_eq!(r.cursor, 0);
        assert!(v.body.is_none());
    }
    // 요청·응답 왕복: Record → Body → Record → Settings.
    let lines = vec![http_line(0)];
    assert_eq!(v.open_body(&lines), Some(Screen::Body));
    assert_eq!(v.back(&Screen::Body), Some(Screen::Record));
    assert_eq!(v.back(&Screen::Record), Some(Screen::Settings));
    assert!(v.record.is_none() && v.body.is_none());
    assert!(v.errors.is_none(), "errors가 없는 채 목록으로 가지 않는다");
    assert_eq!(v.edit.as_ref().unwrap().cursor, 6, "메뉴 커서 유지");
    // 그 뒤 메뉴 → 모니터.
    assert_eq!(v.back(&Screen::Settings), Some(Screen::Monitor));
    assert!(v.edit.is_none());
}

#[test]
fn record_from_errors_still_goes_back_to_errors() {
    let mut v = SubViews::default();
    v.open_errors("B", "P", &[7]);
    v.open_record(result(7)).unwrap();
    assert_eq!(v.record.as_ref().unwrap().origin, RecordOrigin::Errors);
    assert_eq!(v.back(&Screen::Record), Some(Screen::Errors));
    assert!(v.errors.is_some());
}

#[test]
fn sub_keys_record_follows_origin() {
    let from = KeyCtx {
        record_from_settings: true,
        ..ctx()
    };
    assert_eq!(
        sub_keys(&Screen::Record, from).last(),
        Some(&"Esc 칸 설정으로")
    );
    assert_eq!(
        sub_keys(&Screen::Record, ctx()).last(),
        Some(&"Esc 목록으로")
    );
    // 편집 상태 없는 방어 경로에는 r 안내가 없다.
    assert!(!sub_keys(&Screen::Settings, ctx()).contains(&"r 지금 점검"));
}

#[test]
fn edit_keys_check_now_and_waiting() {
    use handicap_tui::app::edit_keys;
    let menu = EditUi::default();
    assert_eq!(
        edit_keys(&Screen::Settings, &menu, None, false),
        [
            "↑↓ 고르기",
            "1–14 번호",
            "r 지금 점검",
            "Enter 수정",
            "Esc 모니터로"
        ]
    );
    for w in [CheckWait::Sent, CheckWait::After(Some(1))] {
        assert_eq!(
            edit_keys(&Screen::Settings, &ui_with(checking(1, w)), None, false),
            ["Esc 뒤로"]
        );
    }
}

#[test]
fn idle_drop_discards_waiting_window() {
    let mut ui = ui_with(checking(1, CheckWait::Sent));
    idle_drop(&mut ui);
    assert!(ui.overlay.is_none());
    let mut ui = ui_with(checking(1, CheckWait::After(None)));
    idle_drop(&mut ui);
    assert!(ui.overlay.is_none());
}

// ---------- tui-2b Task 5: 요청·응답의 `a` ----------

#[test]
fn body_a_key() {
    for c in ['a', 'A', 'ㅁ'] {
        assert_eq!(handle_key(&Screen::Body, ch(c), 1), Action::AddValue, "{c}");
    }
    assert_eq!(handle_key(&Screen::Body, ctrl('a'), 1), Action::None);
    assert_eq!(handle_key(&Screen::Errors, ch('a'), 1), Action::ToggleAll);
    for s in [Screen::Record, Screen::Monitor, Screen::Errors] {
        assert_ne!(handle_key(&s, ch('a'), 1), Action::AddValue, "{s:?}");
    }
}

#[test]
fn body_keys_bar() {
    for has_req_body in [false, true] {
        let k = sub_keys(
            &Screen::Body,
            KeyCtx {
                has_req_body,
                ..ctx()
            },
        );
        assert_eq!(
            k[k.len() - 2..],
            [
                handicap_tui::text::KEYS_ADD_VALUE,
                handicap_tui::text::KEYS_TO_DETAIL
            ],
            "{has_req_body}"
        );
    }
    assert_eq!(handicap_tui::text::KEYS_ADD_VALUE, "a 조건·표시 추가");
}

fn loaded(trace_at: i64) -> RecordLoad {
    RecordLoad::Loaded(Box::new(CheckRecord {
        at_ms: trace_at,
        limit_kb: 64,
        result: result(trace_at),
        trace: None,
        clipped: vec![],
    }))
}

#[test]
fn value_target_rules() {
    // 줄 번호(1)와 trace 인덱스(4)가 다르다 — 돌려주는 것은 trace 인덱스.
    let lines = vec![
        StepLine::If {
            branch: "then".into(),
        },
        http_line(4),
    ];
    let mut v = SubViews::default();
    v.open_errors("B", "P", &[7]);
    v.open_record(result(7)).unwrap();
    v.record.as_mut().unwrap().cursor = 1;
    assert_eq!(v.value_target(&Screen::Body, &lines), None, "body 없음");
    assert_eq!(v.open_body(&lines), Some(Screen::Body));
    assert_eq!(v.value_target(&Screen::Body, &lines), None, "Loading");
    v.record.as_mut().unwrap().load = RecordLoad::Gone;
    assert_eq!(v.value_target(&Screen::Body, &lines), None, "Gone");
    v.record.as_mut().unwrap().load = loaded(7);
    assert_eq!(v.value_target(&Screen::Body, &lines), Some(4));
    for s in [
        Screen::QuitConfirm(Box::new(Screen::Body)),
        Screen::Record,
        Screen::Values,
        Screen::Errors,
    ] {
        assert_eq!(v.value_target(&s, &lines), None, "{s:?}");
    }
    v.body.as_mut().unwrap().line_idx = 0;
    assert_eq!(v.value_target(&Screen::Body, &lines), None, "If 줄");
    v.body = None;
    assert_eq!(v.value_target(&Screen::Body, &lines), None, "body 없음");
}

#[test]
fn edit_screens_include_values() {
    for s in [
        Screen::Settings,
        Screen::EditList,
        Screen::EnvVars,
        Screen::ScenarioVars,
        Screen::Values,
    ] {
        assert!(is_edit_screen(&s), "{s:?}");
    }
    for s in [
        Screen::Monitor,
        Screen::Errors,
        Screen::Record,
        Screen::Body,
        Screen::Help,
        Screen::QuitConfirm(Box::new(Screen::Values)),
    ] {
        assert!(!is_edit_screen(&s), "{s:?}");
    }
}

// ---------- tui-2b Task 7: 칸 설정 11·12의 `a` → 지금 점검 → 값 목록 ----------

#[test]
fn list_a_key() {
    let u = EditUi::default();
    for c in ['a', 'A', 'ㅁ'] {
        assert_eq!(ek(&Screen::EditList, &u, ch(c)), EditAction::Add, "{c}");
    }
    assert_eq!(ek(&Screen::EditList, &u, ctrl('a')), EditAction::None);
}

#[test]
fn start_check_carries_then() {
    let mut ui = board_ui(None);
    let mut seq = 4u64;
    let req = start_check(&mut ui, &mut seq, CheckThen::Values);
    assert_eq!(
        ui.overlay,
        Some(Overlay::Checking {
            seq: 5,
            wait: CheckWait::Sent,
            then: CheckThen::Values
        })
    );
    // 요청은 메뉴 `r`과 같다.
    assert_eq!(
        req,
        FetchReq::CheckNow {
            board_id: "B1".into(),
            panel_id: "P1".into(),
            wait: Some(5)
        }
    );
    start_check(&mut ui, &mut seq, CheckThen::Record);
    assert_eq!(ui.overlay, Some(checking(6, CheckWait::Sent)));
    // 응답이 와도 의도는 그대로 남는다.
    let mut ui = board_ui(None);
    start_check(&mut ui, &mut seq, CheckThen::Values);
    assert!(check_reply(&mut ui, 7, Ok(Some(1))));
    assert_eq!(
        ui.overlay,
        Some(Overlay::Checking {
            seq: 7,
            wait: CheckWait::After(Some(1)),
            then: CheckThen::Values
        })
    );
}

#[test]
fn check_open_allowed_by_intent() {
    use CheckThen::{Record, Values};
    assert!(check_open_allowed(&Screen::Settings, Record));
    assert!(!check_open_allowed(&Screen::EditList, Record));
    assert!(check_open_allowed(&Screen::EditList, Values));
    assert!(!check_open_allowed(&Screen::Settings, Values));
    assert!(!check_open_allowed(
        &Screen::QuitConfirm(Box::new(Screen::EditList)),
        Values
    ));
    assert!(!check_open_allowed(&Screen::Record, Values));
}

#[test]
fn open_record_from_settings_sets_flag() {
    for flag in [true, false] {
        let mut v = SubViews {
            edit: Some(board_ui(Some(checking(1, CheckWait::After(None))))),
            ..SubViews::default()
        };
        let (s, _) = v.open_record_from_settings(result(11), flag).unwrap();
        assert_eq!(s, Screen::Record);
        let r = v.record.as_ref().unwrap();
        assert_eq!(r.auto_values, flag);
        assert_eq!(r.origin, RecordOrigin::Settings);
        assert_eq!(v.back(&Screen::Record), Some(Screen::Settings), "{flag}");
    }
    // 오류 보기에서 연 자세히에는 표지가 없다.
    let mut v = SubViews::default();
    v.open_errors("B1", "P1", &[7]);
    v.open_record(result(7)).unwrap();
    assert!(!v.record.as_ref().unwrap().auto_values);
}

fn focus_line(trace_idx: usize) -> StepLine {
    let StepLine::Http {
        no,
        loop_index,
        name,
        method,
        url,
        status,
        latency_ms,
        error,
        timed_out,
        ..
    } = http_line(trace_idx)
    else {
        unreachable!()
    };
    StepLine::Http {
        trace_idx,
        no,
        loop_index,
        name,
        method,
        url,
        status,
        latency_ms,
        error,
        timed_out,
        focus: true,
    }
}

/// 칸 설정(B1·P1, 대기 창 `Values`) → 기록이 오면 값 목록으로 갈 자세히.
fn auto_views(flag: bool) -> SubViews {
    let mut e = board_ui(Some(Overlay::Checking {
        seq: 1,
        wait: CheckWait::After(None),
        then: CheckThen::Values,
    }));
    e.cursor = 10;
    let mut v = SubViews {
        edit: Some(e),
        ..SubViews::default()
    };
    v.open_record_from_settings(result(11), flag).unwrap();
    v
}

#[test]
fn take_auto_values_sequence() {
    // 스텝 칸: 둘째 줄이 `◀ 이 칸`(trace 3).
    let lines = vec![http_line(0), focus_line(3)];
    let mut v = auto_views(true);
    v.record.as_mut().unwrap().load = loaded(11);
    // ① 종료 확인창 — 열지 않고 표지 그대로(창을 닫지 않는다).
    let qc = Screen::QuitConfirm(Box::new(Screen::Record));
    assert_eq!(v.take_auto_values(&qc, &lines, true), None);
    assert!(v.record.as_ref().unwrap().auto_values, "표지 그대로");
    assert!(v.body.is_none());
    // ② 정확히 자세히 — 그 줄의 요청·응답, 표지 내려감.
    assert_eq!(
        v.take_auto_values(&Screen::Record, &lines, true),
        Some(Screen::Body)
    );
    let r = v.record.as_ref().unwrap();
    assert!(!r.auto_values, "표지 내려감");
    assert_eq!(r.cursor, 1);
    assert_eq!(v.body.as_ref().unwrap().line_idx, 1);
    // ③ 한 번만.
    assert_eq!(v.take_auto_values(&Screen::Record, &lines, true), None);
    // 이어서 값 목록을 열 수 있다(`open_values_here`의 판단).
    assert_eq!(v.value_target(&Screen::Body, &lines), Some(3));
    // 칸 설정 경로 그대로 — `Esc` 사슬의 끝은 칸 설정 메뉴.
    assert_eq!(v.back(&Screen::Body), Some(Screen::Record));
    assert_eq!(v.back(&Screen::Record), Some(Screen::Settings));
    assert_eq!(v.edit.as_ref().unwrap().cursor, 10);
}

#[test]
fn take_auto_values_rules() {
    let step = vec![http_line(0), focus_line(1)];
    // 기록을 기다리는 중 → None, 표지 그대로.
    let mut v = auto_views(true);
    assert_eq!(v.take_auto_values(&Screen::Record, &step, true), None);
    assert!(v.record.as_ref().unwrap().auto_values);
    // 없음·실패로 끝남 → None, 표지만 내린다.
    for load in [RecordLoad::Gone, RecordLoad::Failed("x".into())] {
        let mut v = auto_views(true);
        v.record.as_mut().unwrap().load = load;
        assert_eq!(v.take_auto_values(&Screen::Record, &step, true), None);
        assert!(!v.record.as_ref().unwrap().auto_values);
        assert!(v.body.is_none());
    }
    // 받았지만 대상 없음(흐름 전체 칸·HTTP 2줄) → 자세히에 머문다, 표지 내려감.
    let flow = vec![http_line(0), http_line(1)];
    let mut v = auto_views(true);
    v.record.as_mut().unwrap().load = loaded(11);
    assert_eq!(v.take_auto_values(&Screen::Record, &flow, false), None);
    assert!(!v.record.as_ref().unwrap().auto_values);
    assert!(v.body.is_none());
    // 흐름 전체 칸·HTTP 1줄(+If) → 그 줄.
    let one = vec![
        StepLine::If {
            branch: "then".into(),
        },
        http_line(4),
    ];
    let mut v = auto_views(true);
    v.record.as_mut().unwrap().load = loaded(11);
    assert_eq!(
        v.take_auto_values(&Screen::Record, &one, false),
        Some(Screen::Body)
    );
    assert_eq!(v.record.as_ref().unwrap().cursor, 1);
    // 표지 없음 → 상태 불변.
    let mut v = auto_views(false);
    v.record.as_mut().unwrap().load = loaded(11);
    v.record.as_mut().unwrap().cursor = 0;
    assert_eq!(v.take_auto_values(&Screen::Record, &step, true), None);
    assert_eq!(v.record.as_ref().unwrap().cursor, 0);
    assert!(v.body.is_none());
    // 기록 없음 → None.
    let mut v = SubViews::default();
    assert_eq!(v.take_auto_values(&Screen::Record, &step, true), None);
    // 화면이 자세히가 아님(요청·응답) → None, 표지 그대로.
    let mut v = auto_views(true);
    v.record.as_mut().unwrap().load = loaded(11);
    for s in [Screen::Body, Screen::Settings, Screen::EditList] {
        assert_eq!(v.take_auto_values(&s, &step, true), None, "{s:?}");
        assert!(v.record.as_ref().unwrap().auto_values, "{s:?}");
    }
    // 기다리다 `Esc`로 자세히를 떠나면 `record`째 사라져 열지 않는다.
    let mut v = auto_views(true);
    assert_eq!(v.back(&Screen::Record), Some(Screen::Settings));
    assert!(v.record.is_none());
    assert_eq!(v.take_auto_values(&Screen::Record, &step, true), None);
    assert!(v.body.is_none());
}

// ---- tui-2b-polish Task 3: 대체 화면 키 줄(spec §2.3-3) ----

#[test]
fn missing_keys_branches() {
    use handicap_tui::app::{edit_keys, missing_keys};
    use handicap_tui::text;
    let open = ui_with(input_overlay("x"));
    let closed = EditUi::default();
    // ① 종료 확인창 — ui 유무·화면 무관.
    for s in [Screen::Errors, Screen::Values] {
        for ui in [None, Some(&open), Some(&closed)] {
            assert_eq!(
                missing_keys(&s, ui, true),
                [text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL],
                "{s:?}"
            );
        }
    }
    let edit_screens = [
        Screen::Settings,
        Screen::EditList,
        Screen::EnvVars,
        Screen::ScenarioVars,
        Screen::Values,
    ];
    for s in &edit_screens {
        // ② 편집 화면 + 창 열림 → 그 창의 키 줄(`Esc 뒤로`가 아니다).
        let k = missing_keys(s, Some(&open), false);
        assert_eq!(k, edit_keys(s, &open, None, false), "{s:?}");
        assert_ne!(k, [text::KEYS_BACK], "{s:?}");
        // ③ 편집 화면 + 창 없음 → `Esc 뒤로`.
        assert_eq!(
            missing_keys(s, Some(&closed), false),
            [text::KEYS_BACK],
            "{s:?}"
        );
        // ⑤ ui 없음 → `Esc 뒤로`.
        assert_eq!(missing_keys(s, None, false), [text::KEYS_BACK], "{s:?}");
        // ⑥ 저장 중 창 → 빈 목록(지금 `edit_keys`와 같다).
        let saving = ui_with(Overlay::Saving { restore: None });
        assert!(missing_keys(s, Some(&saving), false).is_empty(), "{s:?}");
    }
    // ④ 편집 화면 아님 + 창 열림 → `Esc 뒤로`.
    for s in [Screen::Errors, Screen::Record, Screen::Body] {
        assert_eq!(
            missing_keys(&s, Some(&open), false),
            [text::KEYS_BACK],
            "{s:?}"
        );
        assert_eq!(missing_keys(&s, None, false), [text::KEYS_BACK], "{s:?}");
    }
}
