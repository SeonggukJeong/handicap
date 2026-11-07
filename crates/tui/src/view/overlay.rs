//! 팝업 — 도움말·종료 확인.

use std::path::Path;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};

use super::{centered, key_bar, text_width};
use crate::logging::LogLoc;
use crate::text;

pub fn render_help(f: &mut Frame, file: &Path, log: &LogLoc) {
    let key_col = text::HELP_KEYS
        .iter()
        .map(|(k, _)| text_width(k))
        .max()
        .unwrap_or(0)
        + 2;
    let mut lines: Vec<Line> = text::HELP_KEYS
        .iter()
        .map(|(k, d)| Line::from(format!("{k}{}{d}", " ".repeat(key_col - text_width(k)))))
        .collect();
    lines.push(Line::from(format!(
        "{}: {}",
        text::HELP_FILE,
        file.display()
    )));
    lines.push(Line::from(text::log_line(log)));
    lines.push(Line::from(text::HELP_COPY));
    let area = f.area();
    // 테두리 2 + 키 안내 줄 1. 모자라면 본문만 잘린다.
    let rect = centered(
        area,
        area.width.min(78),
        (lines.len() as u16 + 3).min(area.height),
    );
    f.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" {} ", text::HELP_TITLE));
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    if inner.height == 0 {
        return;
    }
    let body = Rect::new(inner.x, inner.y, inner.width, inner.height - 1);
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
    f.render_widget(
        Paragraph::new(Line::styled(
            key_bar(&[text::KEYS_HELP], inner.width),
            Style::default().add_modifier(Modifier::DIM),
        )),
        Rect::new(inner.x, inner.y + inner.height - 1, inner.width, 1),
    );
}

pub fn render_quit_confirm(f: &mut Frame) {
    let w = text_width(text::QUIT_CONFIRM) as u16 + 6;
    let rect = centered(f.area(), w, 5);
    f.render_widget(Clear, rect);
    f.render_widget(
        Paragraph::new(vec![Line::from(""), Line::from(text::QUIT_CONFIRM)])
            .centered()
            .block(Block::default().borders(Borders::ALL)),
        rect,
    );
}
