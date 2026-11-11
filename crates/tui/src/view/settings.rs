//! 칸 설정 보기 그리기(목업 §4) — 줄은 `panel_settings::settings_lines`가 만든다.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::inspect::render_frame;
use super::model::parse_hex;
use super::monitor::{C_MUTED, C_TEXT, HeaderView};
use super::{fit, text_width};
use crate::inspect::sanitize;
use crate::text;

fn color(hex: &str) -> Color {
    parse_hex(hex).unwrap_or(Color::Reset)
}

fn put(f: &mut Frame, area: Rect, line: Line) {
    f.render_widget(Paragraph::new(line), area);
}

/// 각주가 실제로 그려지는가 — 목록 줄을 최소 1줄 남길 수 있을 때만(body 높이 ≥ 3).
fn note_shown(body_h: u16, has_note: bool) -> bool {
    has_note && body_h >= 3
}

/// `body`(= `sub_layout(..).body`)에서 제목 줄 1 + (각주가 있으면) 각주 줄 1을 뺀 줄 수.
pub fn settings_height(body: Rect, has_note: bool) -> usize {
    let note = u16::from(note_shown(body.height, has_note));
    usize::from(body.height.saturating_sub(1).saturating_sub(note))
}

/// 칸 설정 보기: body 1행 = `칸 설정 · {칸 제목}` + 오른쪽 `보기 전용 — …`(폭이 모자라면 통째 생략),
/// 그 아래 `lines[scroll..]`, body 맨 아래 줄 = 각주(C_MUTED). `scroll`은 호출자가 가둔다.
pub fn render_settings(
    f: &mut Frame,
    head: &HeaderView,
    title: &str,
    lines: &[String],
    note: Option<&str>,
    scroll: usize,
    keys: &[&str],
) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let row = |i: u16| Rect::new(body.x, body.y.saturating_add(i), body.width, 1);
    let muted = Style::default().fg(color(C_MUTED));
    let text_style = Style::default().fg(color(C_TEXT));

    let t = format!("{} · {}", text::SETTINGS_TITLE, sanitize(title));
    let bold = text_style.add_modifier(Modifier::BOLD);
    let (tw, rw) = (text_width(&t), text_width(text::SETTINGS_READONLY));
    let title_line = if tw + 1 + rw <= w {
        Line::from(vec![
            Span::styled(t, bold),
            Span::raw(" ".repeat(w - tw - rw)),
            Span::styled(text::SETTINGS_READONLY, muted),
        ])
    } else {
        Line::from(Span::styled(fit(&t, w), bold))
    };
    put(f, row(0), title_line);

    let h = settings_height(body, note.is_some());
    let start = scroll.min(lines.len());
    for (i, l) in lines[start..].iter().take(h).enumerate() {
        put(
            f,
            row(1 + i as u16),
            Line::from(Span::styled(fit(l, w), text_style)),
        );
    }
    if let Some(n) = note.filter(|_| note_shown(body.height, true)) {
        put(
            f,
            row(body.height - 1),
            Line::from(Span::styled(fit(&sanitize(n), w), muted)),
        );
    }
}
