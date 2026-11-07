//! 모니터 화면 — 머리 줄·칸 격자·키 안내 줄과 클릭 대조용 칸 사각형.

use chrono::{Local, TimeZone};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

use super::axis::{axis_line, axis_uses_seconds};
use super::model::{BigValue, PanelView, Row, panel_rows, parse_hex};
use super::{fit, text_width};
use crate::judge::ReasonParts;
use crate::judge::{PanelState, format_hm, format_hms, grid_for};
use crate::text;

pub const MIN_PANEL_W: u16 = 24;
pub const MIN_PANEL_H: u16 = 6;

const C_TEXT: &str = "#f2f5f8";
const C_MUTED: &str = "#9aa7b4";
const C_SOFT: &str = "#cbd5e1";
const C_AXIS: &str = "#7b8794";
const C_OK: &str = "#22c55e";
const C_FAIL: &str = "#ef4444";
const C_GRAY: &str = "#94a3b8";
const C_SLOW: &str = "#f59e0b";

fn color(hex: &str) -> Color {
    parse_hex(hex).unwrap_or(Color::Reset)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub panels: Vec<Rect>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TooSmall {
    pub have: (u16, u16),
    pub need: (u16, u16),
}

#[derive(Debug, Clone)]
pub struct MonitorScreen {
    pub board_name: String,
    /// (현재 순번 1부터, 전체)
    pub board_pos: (usize, usize),
    pub server_time: Option<i64>,
    pub server_down: bool,
    pub panels: Vec<PanelView>,
    pub selected: usize,
}

/// 머리 줄 1행·키 안내 줄 1행을 뺀 영역을 `grid_for` 격자로 나눈다. 칸 최소 24×6.
pub fn layout(area: Rect, n: usize) -> Result<Layout, TooSmall> {
    let (cols, rows) = grid_for(n);
    let grid = Rect::new(
        area.x,
        area.y.saturating_add(1),
        area.width,
        area.height.saturating_sub(2),
    );
    let edge = |origin: u16, total: u16, count: usize, i: usize| -> u16 {
        origin + (u32::from(total) * i as u32 / count as u32) as u16
    };
    let mut rects = Vec::with_capacity(n);
    let mut small = false;
    for idx in 0..cols * rows {
        let (r, c) = (idx / cols, idx % cols);
        let (x0, x1) = (
            edge(grid.x, grid.width, cols, c),
            edge(grid.x, grid.width, cols, c + 1),
        );
        let (y0, y1) = (
            edge(grid.y, grid.height, rows, r),
            edge(grid.y, grid.height, rows, r + 1),
        );
        if x1 - x0 < MIN_PANEL_W || y1 - y0 < MIN_PANEL_H {
            small = true;
        }
        if idx < n {
            rects.push(Rect::new(x0, y0, x1 - x0, y1 - y0));
        }
    }
    if small {
        return Err(TooSmall {
            have: (area.width, area.height),
            need: (MIN_PANEL_W * cols as u16, MIN_PANEL_H * rows as u16 + 2),
        });
    }
    Ok(Layout { panels: rects })
}

/// 클릭 좌표가 든 칸(테두리 포함)의 인덱스.
pub fn panel_at(layout: &Layout, x: u16, y: u16) -> Option<usize> {
    layout
        .panels
        .iter()
        .position(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

fn state_color(v: &PanelView) -> Color {
    match v.state {
        PanelState::Ok => color(C_OK),
        PanelState::Slow => v.bars.last().map_or(color(C_SLOW), |b| b.color),
        PanelState::Fail => color(C_FAIL),
        _ => color(C_GRAY),
    }
}

fn big_color(v: &PanelView) -> Color {
    if v.state == PanelState::Ok {
        color(C_TEXT)
    } else {
        state_color(v)
    }
}

fn big_text(v: &PanelView) -> String {
    match &v.big {
        BigValue::Text(t) => t.clone(),
        BigValue::Reason(ReasonParts::Split { fixed, .. }) => fixed.clone(),
        BigValue::Reason(ReasonParts::Detail { big, .. }) => big.clone(),
        BigValue::Reason(ReasonParts::NotContained { needle, .. }) => text::not_contained(needle),
    }
}

fn reason_small(v: &PanelView) -> Option<&str> {
    match &v.big {
        BigValue::Reason(ReasonParts::Split { step, .. }) => step.as_deref(),
        BigValue::Reason(ReasonParts::Detail { small, .. })
        | BigValue::Reason(ReasonParts::NotContained { small, .. }) => Some(small),
        BigValue::Text(_) => None,
    }
}

fn put(f: &mut Frame, area: Rect, line: Line) {
    f.render_widget(Paragraph::new(line), area);
}

fn render_panel(f: &mut Frame, rect: Rect, v: &PanelView, selected: bool) {
    let sc = state_color(v);
    let (border_type, style) = if selected {
        (
            BorderType::Thick,
            Style::default().fg(sc).add_modifier(Modifier::BOLD),
        )
    } else {
        (BorderType::Plain, Style::default().fg(sc))
    };
    let title = format!(
        " {} ",
        fit(&v.title, usize::from(rect.width).saturating_sub(4))
    );
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(style)
        .title(Span::styled(title, Style::default().fg(color(C_TEXT))));
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    if inner.width == 0 {
        return;
    }
    let w = usize::from(inner.width);
    let small = reason_small(v);
    let rows = panel_rows(
        inner.height,
        small.is_some(),
        v.consecutive.is_some(),
        v.stats.is_some(),
        v.display.len(),
    );
    let visible = v.bars.len().min(w);
    let bars = &v.bars[v.bars.len() - visible..];
    for (i, row) in rows.into_iter().enumerate() {
        let area = Rect::new(inner.x, inner.y + i as u16, inner.width, 1);
        let line = match row {
            Row::Status => {
                let label = fit(v.label, w);
                let lw = text_width(&label);
                let big = if w > lw + 1 {
                    fit(&big_text(v), w - lw - 1)
                } else {
                    String::new()
                };
                let pad = w - lw - text_width(&big);
                Line::from(vec![
                    Span::styled(label, Style::default().fg(sc).add_modifier(Modifier::BOLD)),
                    Span::raw(" ".repeat(pad)),
                    Span::styled(
                        big,
                        Style::default()
                            .fg(big_color(v))
                            .add_modifier(Modifier::BOLD),
                    ),
                ])
            }
            Row::ReasonSmall => {
                let t = fit(small.unwrap_or_default(), w);
                let pad = w - text_width(&t);
                Line::from(vec![
                    Span::raw(" ".repeat(pad)),
                    Span::styled(t, Style::default().fg(big_color(v))),
                ])
            }
            Row::Consecutive => Line::from(Span::styled(
                fit(v.consecutive.as_deref().unwrap_or_default(), w),
                Style::default().fg(color(C_FAIL)),
            )),
            Row::Bars => Line::from(
                bars.iter()
                    .map(|b| Span::styled(b.glyph.to_string(), Style::default().fg(b.color)))
                    .collect::<Vec<_>>(),
            ),
            Row::Axis => {
                let times: Vec<Option<i64>> = bars.iter().map(|b| b.at_ms).collect();
                let secs = axis_uses_seconds(visible, v.interval_seconds);
                let label: &dyn Fn(i64) -> String = if secs { &format_hms } else { &format_hm };
                Line::from(Span::styled(
                    axis_line(&times, label),
                    Style::default().fg(color(C_AXIS)),
                ))
            }
            Row::Stats => Line::from(Span::styled(
                fit(v.stats.as_deref().unwrap_or_default(), w),
                Style::default().fg(color(C_MUTED)),
            )),
            Row::Display(k) => Line::from(Span::styled(
                fit(v.display.get(k).map_or("", String::as_str), w),
                Style::default().fg(color(if k == 0 { C_TEXT } else { C_SOFT })),
            )),
        };
        put(f, area, line);
    }
}

fn clock(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

fn render_header(f: &mut Frame, area: Rect, s: &MonitorScreen) {
    let mut left = format!(" {} · {}", text::MONITOR_TITLE, s.board_name);
    if s.board_pos.1 > 1 {
        left.push(' ');
        left.push_str(&text::board_pos(s.board_pos.0, s.board_pos.1));
    }
    let status = if s.server_down {
        text::SERVER_DOWN
    } else {
        text::MONITOR_RUNNING
    };
    let right = match s.server_time {
        Some(ms) => format!("{}  {} ", clock(ms), status),
        None => format!("{status} "),
    };
    let w = usize::from(area.width);
    let rw = text_width(&right).min(w);
    let left = fit(&left, w.saturating_sub(rw + 1));
    let pad = w.saturating_sub(text_width(&left) + rw);
    let status_color = if s.server_down { C_FAIL } else { C_MUTED };
    put(
        f,
        area,
        Line::from(vec![
            Span::styled(
                left,
                Style::default()
                    .fg(color(C_TEXT))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" ".repeat(pad)),
            Span::styled(fit(&right, rw), Style::default().fg(color(status_color))),
        ]),
    );
}

pub fn render(f: &mut Frame, s: &MonitorScreen) {
    let area = f.area();
    let lay = match layout(area, s.panels.len()) {
        Ok(l) => l,
        Err(e) => {
            let msg = text::too_small(e.have, e.need);
            f.render_widget(
                Paragraph::new(msg).wrap(ratatui::widgets::Wrap { trim: false }),
                area,
            );
            return;
        }
    };
    render_header(f, Rect::new(area.x, area.y, area.width, 1), s);
    for (i, (rect, v)) in lay.panels.iter().zip(&s.panels).enumerate() {
        render_panel(f, *rect, v, i == s.selected);
    }
    let keys = if s.board_pos.1 > 1 {
        text::KEYS_MONITOR
    } else {
        text::KEYS_MONITOR_SINGLE
    };
    put(
        f,
        Rect::new(
            area.x,
            area.y + area.height.saturating_sub(1),
            area.width,
            1,
        ),
        Line::from(Span::styled(
            format!(" {keys}"),
            Style::default().fg(color(C_MUTED)),
        )),
    );
}
