//! 시작 실패·사용법 화면.

use std::path::Path;

use ratatui::Frame;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Wrap};

use super::overlay::log_text;
use crate::check_mode::stage_label;
use crate::logging::LogLoc;
use crate::session::StartError;
use crate::text;

pub fn render_error(f: &mut Frame, e: &StartError, file: &Path, log: &LogLoc) {
    let lines = vec![
        Line::styled(
            format!("{} {}", stage_label(e.stage), text::ERROR_SUFFIX),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
        Line::from(""),
        Line::from(e.message.clone()),
        Line::from(""),
        Line::from(format!("{}: {}", text::FILE_LABEL, file.display())),
        Line::from(format!("{}: {}", text::HELP_LOG, log_text(log))),
        Line::from(""),
        Line::styled(
            text::KEYS_ERROR,
            Style::default().add_modifier(Modifier::DIM),
        ),
    ];
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), f.area());
}

pub fn render_usage(f: &mut Frame) {
    let lines = vec![
        Line::styled(text::USAGE, Style::default().add_modifier(Modifier::BOLD)),
        Line::from(""),
        Line::from(text::USAGE_MANUAL),
    ];
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), f.area());
}
