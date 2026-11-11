//! 입력줄 편집기 — 순수(spec §6.7). 글자는 정규화 없이 그대로 받는다(`q`·`j`·`?`·한글 모두 글자).

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::inspect::is_bidi_control;
use crate::view::text_width;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Text { max_chars: usize },
    Digits { max: usize },
}

#[derive(Clone, PartialEq, Eq)]
pub struct LineInput {
    buf: Vec<char>,
    /// 글자 위치(0..=buf.len()).
    cursor: usize,
    mode: InputMode,
}

/// 입력한 값이 로그로 새지 않게 글자 수·커서·모드만 찍는다.
impl std::fmt::Debug for LineInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LineInput")
            .field("chars", &self.buf.len())
            .field("cursor", &self.cursor)
            .field("mode", &self.mode)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputOutcome {
    Edited,
    Submit,
    Cancel,
    AskQuit,
    Ignored,
}

/// 받지 않는 글자: `char::is_control`, U+0085, U+2028/2029(YAML 줄바꿈으로 읽힘), bidi 제어(`inspect::sanitize`와 같은 술어).
pub fn accept_char(c: char) -> bool {
    !(c.is_control() || c == '\u{85}' || c == '\u{2028}' || c == '\u{2029}' || is_bidi_control(c))
}

impl LineInput {
    pub fn new(initial: &str, mode: InputMode) -> LineInput {
        let mut li = LineInput {
            buf: Vec::new(),
            cursor: 0,
            mode,
        };
        for c in initial.chars() {
            li.insert(c);
        }
        li
    }

    pub fn text(&self) -> String {
        self.buf.iter().collect()
    }

    fn cap(&self) -> usize {
        match self.mode {
            InputMode::Text { max_chars } => max_chars,
            InputMode::Digits { max } => max,
        }
    }

    fn allows(&self, c: char) -> bool {
        match self.mode {
            InputMode::Text { .. } => accept_char(c),
            InputMode::Digits { .. } => c.is_ascii_digit(),
        }
    }

    /// 받으면 true.
    fn insert(&mut self, c: char) -> bool {
        if !self.allows(c) || self.buf.len() >= self.cap() {
            return false;
        }
        self.buf.insert(self.cursor, c);
        self.cursor += 1;
        true
    }

    /// 원시 KeyEvent(정규화 전). Press만 받는다(Release/Repeat = Ignored, `app.rs` 이벤트 루프와 같은 규칙).
    /// Alt+글자는 Ignored(터미널 메타 조합 — 글자로 넣지 않는다).
    pub fn key(&mut self, k: KeyEvent) -> InputOutcome {
        if k.kind != KeyEventKind::Press {
            return InputOutcome::Ignored;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        match k.code {
            KeyCode::Char(c) if ctrl => match c.to_ascii_lowercase() {
                'u' => {
                    self.buf.clear();
                    self.cursor = 0;
                    InputOutcome::Edited
                }
                'c' => InputOutcome::AskQuit,
                _ => InputOutcome::Ignored,
            },
            KeyCode::Char(_) if alt => InputOutcome::Ignored,
            KeyCode::Char(c) => {
                if self.insert(c) {
                    InputOutcome::Edited
                } else {
                    InputOutcome::Ignored
                }
            }
            KeyCode::Enter => InputOutcome::Submit,
            KeyCode::Esc => InputOutcome::Cancel,
            KeyCode::Left => {
                self.cursor = self.cursor.saturating_sub(1);
                InputOutcome::Edited
            }
            KeyCode::Right => {
                self.cursor = (self.cursor + 1).min(self.buf.len());
                InputOutcome::Edited
            }
            KeyCode::Home => {
                self.cursor = 0;
                InputOutcome::Edited
            }
            KeyCode::End => {
                self.cursor = self.buf.len();
                InputOutcome::Edited
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    self.buf.remove(self.cursor);
                }
                InputOutcome::Edited
            }
            KeyCode::Delete => {
                if self.cursor < self.buf.len() {
                    self.buf.remove(self.cursor);
                }
                InputOutcome::Edited
            }
            _ => InputOutcome::Ignored,
        }
    }

    /// 붙여넣기: 받지 않는 글자(`\r`·`\n`·제어 포함)는 버리고 커서 위치에 넣는다. `Submit`은 일으키지 않는다.
    pub fn paste(&mut self, s: &str) {
        for c in s.chars() {
            self.insert(c);
        }
    }

    /// 폭 `w` 칸에 보일 (글자열, 커서의 화면 x). 규칙: 커서 앞 글자 폭이 `w`보다 작으면 처음부터 보이고,
    /// 아니면 창이 커서에서 끝난다(커서 앞 글자 폭 ≤ `w-1`이 되는 가장 앞 글자부터). 넓은 글자는 쪼개지 않고,
    /// 칸에 안 들어가는 뒤쪽 글자는 버린다.
    pub fn view(&self, w: usize) -> (String, usize) {
        if w == 0 {
            return (String::new(), 0);
        }
        let cw = |c: char| text_width(c.encode_utf8(&mut [0; 4]));
        let before: usize = self.buf[..self.cursor].iter().map(|&c| cw(c)).sum();
        let mut start = 0;
        if before >= w {
            let mut used = before;
            while used > w - 1 && start < self.cursor {
                used = used.saturating_sub(cw(self.buf[start]));
                start += 1;
            }
        }
        let mut out = String::new();
        let mut used = 0;
        let mut cursor_x = 0;
        for (i, &c) in self.buf.iter().enumerate().skip(start) {
            if i == self.cursor {
                cursor_x = used;
            }
            let c_w = cw(c);
            if used + c_w > w {
                break;
            }
            out.push(c);
            used += c_w;
        }
        if self.cursor >= self.buf.len() {
            cursor_x = used.min(w - 1);
        }
        (out, cursor_x)
    }
}
