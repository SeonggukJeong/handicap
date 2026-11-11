//! 입력줄 편집기(`input.rs`) — 정규화 없이 글자를 그대로 받는다(spec §6.7).

use handicap_tui::input::{InputMode, InputOutcome, LineInput, accept_char};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::text::Span;

fn k(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}
fn ctrl(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
}
fn w(s: &str) -> usize {
    Span::raw(s.to_string()).width()
}
fn text_mode() -> InputMode {
    InputMode::Text { max_chars: 2000 }
}

#[test]
fn letters_are_literal_not_commands() {
    let mut li = LineInput::new("", text_mode());
    for c in ['q', 'j', '?', 'ㅂ', 'Q'] {
        assert_eq!(li.key(k(KeyCode::Char(c))), InputOutcome::Edited);
    }
    assert_eq!(li.text(), "qj?ㅂQ");
    let shifted = KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT);
    assert_eq!(li.key(shifted), InputOutcome::Edited);
    assert_eq!(li.text(), "qj?ㅂQA");
}

#[test]
fn digits_mode_accepts_only_digits_and_cap() {
    let mut li = LineInput::new("", InputMode::Digits { max: 6 });
    assert_eq!(li.key(k(KeyCode::Char('a'))), InputOutcome::Ignored);
    assert_eq!(li.key(k(KeyCode::Char('-'))), InputOutcome::Ignored);
    for _ in 0..6 {
        assert_eq!(li.key(k(KeyCode::Char('7'))), InputOutcome::Edited);
    }
    assert_eq!(li.key(k(KeyCode::Char('7'))), InputOutcome::Ignored);
    assert_eq!(li.text(), "777777");
}

#[test]
fn text_cap_counts_chars_not_bytes() {
    let mut li = LineInput::new("", InputMode::Text { max_chars: 3 });
    for c in ['가', '나', '다', '라'] {
        li.key(k(KeyCode::Char(c)));
    }
    assert_eq!(li.text(), "가나다");
}

#[test]
fn new_filters_initial_value() {
    let li = LineInput::new("a\u{202E}b\n1", InputMode::Digits { max: 6 });
    assert_eq!(li.text(), "1");
    let li = LineInput::new("abcdef", InputMode::Text { max_chars: 3 });
    assert_eq!(li.text(), "abc");
}

#[test]
fn ctrl_keys() {
    let mut li = LineInput::new("abc", text_mode());
    assert_eq!(li.key(ctrl('b')), InputOutcome::Ignored);
    assert_eq!(li.key(ctrl('c')), InputOutcome::AskQuit);
    assert_eq!(li.text(), "abc");
    assert_eq!(li.key(ctrl('u')), InputOutcome::Edited);
    assert_eq!(li.text(), "");
}

#[test]
fn alt_char_is_ignored() {
    let mut li = LineInput::new("", text_mode());
    let alt = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT);
    assert_eq!(li.key(alt), InputOutcome::Ignored);
    assert_eq!(li.text(), "");
}

#[test]
fn release_and_repeat_ignored() {
    let mut li = LineInput::new("", text_mode());
    let mut rel = k(KeyCode::Char('a'));
    rel.kind = KeyEventKind::Release;
    assert_eq!(li.key(rel), InputOutcome::Ignored);
    rel.kind = KeyEventKind::Repeat;
    assert_eq!(li.key(rel), InputOutcome::Ignored);
    assert_eq!(li.text(), "");
}

#[test]
fn enter_esc_and_editing_keys() {
    let mut li = LineInput::new("abc", text_mode());
    assert_eq!(li.key(k(KeyCode::Left)), InputOutcome::Edited);
    li.key(k(KeyCode::Char('X')));
    assert_eq!(li.text(), "abXc");
    li.key(k(KeyCode::Backspace));
    assert_eq!(li.text(), "abc");
    li.key(k(KeyCode::Home));
    li.key(k(KeyCode::Delete));
    assert_eq!(li.text(), "bc");
    li.key(k(KeyCode::End));
    li.key(k(KeyCode::Char('z')));
    assert_eq!(li.text(), "bcz");
    assert_eq!(li.key(k(KeyCode::Enter)), InputOutcome::Submit);
    assert_eq!(li.key(k(KeyCode::Esc)), InputOutcome::Cancel);
    // 경계: 맨 앞 Backspace·맨 끝 Delete·Right는 패닉 없이 무변화.
    let mut e = LineInput::new("", text_mode());
    e.key(k(KeyCode::Backspace));
    e.key(k(KeyCode::Delete));
    e.key(k(KeyCode::Right));
    assert_eq!(e.text(), "");
}

#[test]
fn rejected_chars() {
    for c in [
        '\u{2028}', '\u{2029}', '\u{202E}', '\u{85}', '\u{61C}', '\n', '\u{1b}',
    ] {
        assert!(!accept_char(c), "{c:?}");
    }
    assert!(accept_char('a') && accept_char('한') && accept_char(' '));
    let mut li = LineInput::new("", text_mode());
    assert_eq!(li.key(k(KeyCode::Char('\u{202E}'))), InputOutcome::Ignored);
    assert_eq!(li.key(k(KeyCode::Char('\u{85}'))), InputOutcome::Ignored);
    assert_eq!(li.text(), "");
}

#[test]
fn paste_strips_newlines_and_controls() {
    let mut li = LineInput::new("", text_mode());
    li.paste("a\r\nb\n");
    assert_eq!(li.text(), "ab");
    li.paste("\u{202E}x\u{1b}y\t");
    assert_eq!(li.text(), "abxy");
    // 커서 위치에 넣는다.
    li.key(k(KeyCode::Home));
    li.paste("Z");
    assert_eq!(li.text(), "Zabxy");
    let mut d = LineInput::new("", InputMode::Digits { max: 3 });
    d.paste("1a2b3c4");
    assert_eq!(d.text(), "123");
}

#[test]
fn view_keeps_cursor_visible_with_wide_chars() {
    let mut li = LineInput::new("가나다라마바사아자차", text_mode());
    let (s, x) = li.view(5);
    assert!(w(&s) <= 5 && x < 5, "{s:?} {x}");
    li.key(k(KeyCode::Home));
    let (s, x) = li.view(5);
    assert!(s.starts_with('가'));
    assert_eq!(x, 0);
}

#[test]
fn view_tiny_widths_do_not_panic() {
    let li = LineInput::new("가a나", text_mode());
    assert_eq!(li.view(0), (String::new(), 0));
    let (s, x) = li.view(1);
    assert!(w(&s) <= 1 && x == 0);
}

#[test]
fn view_sweep() {
    let text = "ab가나cd다e라마f";
    let n = text.chars().count();
    for width in 0..=12usize {
        for pos in 0..=n {
            let mut li = LineInput::new(text, text_mode());
            li.key(k(KeyCode::Home));
            for _ in 0..pos {
                li.key(k(KeyCode::Right));
            }
            let (s, x) = li.view(width);
            assert!(w(&s) <= width, "w={width} pos={pos} {s:?}");
            if width == 0 {
                assert_eq!(x, 0);
            } else {
                assert!(x < width, "w={width} pos={pos} x={x}");
            }
        }
    }
}
