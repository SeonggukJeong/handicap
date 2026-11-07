//! 시작 실패·사용법 화면.

use std::path::Path;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Wrap};

use super::key_bar;
use crate::check_mode::stage_label;
use crate::logging::LogLoc;
use crate::session::StartError;
use crate::text;

/// 맨 아래 한 줄에 키 안내를 그리고 그 위 영역을 돌려준다.
pub(crate) fn split_key_bar(f: &mut Frame, segments: &[&str]) -> Rect {
    let area = f.area();
    if area.height == 0 {
        return area;
    }
    f.render_widget(
        Paragraph::new(Line::styled(
            key_bar(segments, area.width),
            Style::default().add_modifier(Modifier::DIM),
        )),
        Rect::new(area.x, area.y + area.height - 1, area.width, 1),
    );
    Rect::new(area.x, area.y, area.width, area.height - 1)
}

pub fn render_error(f: &mut Frame, e: &StartError, file: &Path, log: &LogLoc) {
    let body = split_key_bar(f, &[text::KEYS_RETRY, text::KEYS_QUIT]);
    let lines = vec![
        Line::styled(
            format!("{} {}", stage_label(e.stage), text::ERROR_SUFFIX),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
        Line::from(""),
        Line::from(e.message.clone()),
        Line::from(""),
        Line::from(format!("{}: {}", text::FILE_LABEL, file.display())),
        Line::from(text::log_line(log)),
    ];
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
}

pub fn render_usage(f: &mut Frame) {
    let lines = vec![
        Line::styled(text::USAGE, Style::default().add_modifier(Modifier::BOLD)),
        Line::from(""),
        Line::from(text::USAGE_MANUAL),
    ];
    let body = split_key_bar(f, &[text::KEYS_QUIT]);
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), body);
}
