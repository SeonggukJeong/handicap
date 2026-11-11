//! 팝업 — 도움말·종료 확인.

use std::path::Path;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use super::{centered, key_bar, text_width, wrap_width};
use crate::logging::LogLoc;
use crate::text;

pub fn render_help(f: &mut Frame, file: &Path, log: &LogLoc) {
    let key_col = text::HELP_KEYS
        .iter()
        .map(|(k, _)| text_width(k))
        .max()
        .unwrap_or(0)
        + 2;
    let key_rows: Vec<String> = text::HELP_KEYS
        .iter()
        .map(|(k, d)| format!("{k}{}{d}", " ".repeat(key_col - text_width(k))))
        .collect();
    let area = f.area();
    let width = area.width.min(78);
    let inner_w = usize::from(width.saturating_sub(2)).max(1);
    // 경로는 줄바꿈 뒤의 행 수로 센다(공백 없는 긴 경로가 상자 밖으로 밀리지 않게 직접 자른다).
    let mut fixed: Vec<String> =
        wrap_width(&format!("{}: {}", text::HELP_FILE, file.display()), inner_w);
    fixed.extend(wrap_width(&text::log_line(log), inner_w));
    fixed.extend(wrap_width(text::HELP_IDLE, inner_w));
    fixed.push(text::HELP_COPY.to_string());
    let want = (key_rows.len() + fixed.len()) as u16 + 3;
    // 테두리 2 + 키 안내 줄 1. 모자라면 키 줄 → 복사 안내 → 무입력 안내 순으로 뺀다(경로가 진단에 가장 중요).
    let rect = centered(area, width, want.min(area.height));
    let cap = usize::from(rect.height.saturating_sub(3));
    let keys_shown = cap.saturating_sub(fixed.len()).min(key_rows.len());
    fixed.truncate(cap);
    let lines: Vec<Line> = key_rows
        .into_iter()
        .take(keys_shown)
        .chain(fixed)
        .map(Line::from)
        .collect();
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
    f.render_widget(Paragraph::new(lines), body);
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
