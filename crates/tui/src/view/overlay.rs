//! 팝업 — 도움말·종료 확인.

use std::path::Path;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use super::{centered, key_bar, text_width, wrap_width};
use crate::filesave::FileTarget;
use crate::inspect::sanitize;
use crate::logging::LogLoc;
use crate::text;

/// 도움말. `backups` = 세션의 실제 대상(있으면 보드 파일 줄 아래에 백업 줄). 줄 순서: 키 줄 → 경고(노랑) →
/// 보드 파일 → 백업 → 로그 → 무입력 → 복사. 높이가 모자라면 새 두 줄부터(백업 → 경고), 그다음 키 줄 →
/// 복사 안내 → 무입력 안내 순으로 뺀다(경로가 진단에 가장 중요).
pub fn render_help(f: &mut Frame, file: &Path, backups: Option<&FileTarget>, log: &LogLoc) {
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
    let file_rows = wrap_width(&format!("{}: {}", text::HELP_FILE, file.display()), inner_w);
    let mut tail: Vec<String> = wrap_width(&text::log_line(log), inner_w);
    tail.extend(wrap_width(text::HELP_IDLE, inner_w));
    tail.push(text::HELP_COPY.to_string());
    let warn_rows = wrap_width(text::HELP_REPLACE_WARN, inner_w);
    // 실제 경로는 파일 시스템 유래 — 그리기 전에 sanitize. 한 줄에 들어가면 한 줄, 아니면 두 경로를 따로
    // 줄바꿈한다(한 줄로 자르면 `원본:` 쪽이 통째로 사라진다).
    let backup_rows: Vec<String> = backups
        .map(|t| {
            let bak = sanitize(&t.bak().display().to_string());
            let orig = sanitize(&t.orig_bak().display().to_string());
            let one = text::help_backups(&bak, &orig);
            if text_width(&one) <= inner_w {
                vec![one]
            } else {
                let mut rows = wrap_width(&text::help_backup(&bak), inner_w);
                rows.extend(wrap_width(&text::help_orig(&orig), inner_w));
                rows
            }
        })
        .unwrap_or_default();
    let base = key_rows.len() + file_rows.len() + tail.len();
    let room = usize::from(area.height.saturating_sub(3));
    // 백업 줄은 통째로 넣거나 통째로 뺀다.
    let show_backup = !backup_rows.is_empty() && base + warn_rows.len() + backup_rows.len() <= room;
    let show_warn = base + warn_rows.len() <= room;
    let n_warn = if show_warn { warn_rows.len() } else { 0 };
    let n_backup = if show_backup { backup_rows.len() } else { 0 };
    let want = (base + n_warn + n_backup) as u16 + 3;
    let rect = centered(area, width, want.min(area.height));
    let cap = usize::from(rect.height.saturating_sub(3));
    let mut fixed: Vec<String> = file_rows;
    if show_backup {
        fixed.extend(backup_rows);
    }
    fixed.extend(tail);
    let keys_shown = cap.saturating_sub(fixed.len() + n_warn).min(key_rows.len());
    fixed.truncate(cap.saturating_sub(n_warn));
    let warn = Style::default().fg(Color::Yellow);
    let lines: Vec<Line> = key_rows
        .into_iter()
        .take(keys_shown)
        .map(Line::from)
        .chain(
            warn_rows
                .into_iter()
                .take(n_warn)
                .map(|r| Line::styled(r, warn)),
        )
        .chain(fixed.into_iter().map(Line::from))
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
