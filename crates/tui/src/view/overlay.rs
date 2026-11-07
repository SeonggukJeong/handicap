//! 팝업 — 도움말·종료 확인.

use std::path::Path;

use ratatui::Frame;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};

use super::{centered, text_width};
use crate::logging::LogLoc;
use crate::text;

pub(crate) fn log_text(log: &LogLoc) -> String {
    match log {
        LogLoc::Path(p) => p.display().to_string(),
        LogLoc::Unavailable(cause) => text::log_unavailable(cause),
    }
}

pub fn render_help(f: &mut Frame, file: &Path, log: &LogLoc) {
    let mut lines: Vec<Line> = text::HELP_KEYS
        .iter()
        .map(|(k, d)| Line::from(format!("{k:<18}{d}")))
        .collect();
    lines.push(Line::from(""));
    lines.push(Line::from(format!(
        "{}: {}",
        text::HELP_FILE,
        file.display()
    )));
    lines.push(Line::from(format!("{}: {}", text::HELP_LOG, log_text(log))));
    lines.push(Line::from(text::HELP_COPY));
    lines.push(Line::from(""));
    lines.push(Line::styled(
        text::KEYS_HELP,
        Style::default().add_modifier(Modifier::DIM),
    ));
    let area = f.area();
    let rect = centered(
        area,
        area.width.min(78),
        (lines.len() as u16 + 4).min(area.height),
    );
    f.render_widget(Clear, rect);
    f.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" {} ", text::HELP_TITLE)),
        ),
        rect,
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
