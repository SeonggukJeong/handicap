//! 모니터 화면 — 머리 줄·칸 격자·키 안내 줄과 클릭 대조용 칸 사각형.

use chrono::{Local, TimeZone};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

use super::axis::{axis_line, axis_uses_seconds};
use super::model::{BigValue, PanelView, Row, panel_rows, parse_hex};
use super::{fit, key_bar, text_width};
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
const C_GRAY_BORDER: &str = "#64748b";
const C_BLOCKED_BORDER: &str = "#475569";
const C_BRIGHT: &str = "#e2e8f0";

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

/// GUI `borderColorOf`.
fn border_color(v: &PanelView) -> Color {
    match v.state {
        PanelState::Blocked => color(C_BLOCKED_BORDER),
        PanelState::Ok | PanelState::Slow | PanelState::Fail => state_color(v),
        _ => color(C_GRAY_BORDER),
    }
}

/// GUI `bigColor`.
fn big_color(v: &PanelView) -> Color {
    match v.state {
        PanelState::Ok => color(C_TEXT),
        PanelState::Skipped => color(C_BRIGHT),
        _ => state_color(v),
    }
}

/// GUI `smallColor`.
fn small_color(v: &PanelView) -> Color {
    if v.state == PanelState::Blocked {
        color(C_GRAY_BORDER)
    } else {
        big_color(v)
    }
}

/// 큰 값을 `avail`칸에 맞춘다. 포함 안 됨은 따옴표·꼬리를 지키고 찾는 글자만 줄인다(뜻이 뒤집히지 않게).
fn big_fit(v: &PanelView, avail: usize) -> String {
    match &v.big {
        BigValue::Text(t) => fit(t, avail),
        BigValue::Reason(ReasonParts::Split { fixed, .. }) => fit(fixed, avail),
        BigValue::Reason(ReasonParts::Detail { big, .. }) => fit(big, avail),
        BigValue::Reason(ReasonParts::NotContained { needle, .. }) => {
            let overhead = 1 + text_width(text::NOT_CONTAINED_TAIL);
            if avail > overhead {
                format!(
                    "\"{}{}",
                    fit(needle, avail - overhead),
                    text::NOT_CONTAINED_TAIL
                )
            } else {
                String::new()
            }
        }
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
    let bc = border_color(v);
    let (border_type, style) = if selected {
        (
            BorderType::Thick,
            Style::default().fg(bc).add_modifier(Modifier::BOLD),
        )
    } else {
        (BorderType::Plain, Style::default().fg(bc))
    };
    let title_color = if matches!(v.state, PanelState::Blocked | PanelState::Skipped) {
        color(C_SOFT)
    } else {
        color(C_TEXT)
    };
    let title = format!(
        " {} ",
        fit(&v.title, usize::from(rect.width).saturating_sub(4))
    );
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(style)
        .title(Span::styled(title, Style::default().fg(title_color)));
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
                    big_fit(v, w - lw - 1)
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
                    Span::styled(t, Style::default().fg(small_color(v))),
                ])
            }
            Row::Consecutive => {
                let full = v.consecutive.as_deref().unwrap_or_default();
                // 통째로 안 들어가면 `N회 연속`만(꼬리를 단어 중간에서 자르지 않는다).
                let shown = if text_width(full) <= w {
                    full
                } else {
                    text::consecutive_short(full)
                };
                Line::from(Span::styled(
                    fit(shown, w),
                    Style::default().fg(color(C_FAIL)),
                ))
            }
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

fn clock(ms: i64, with_date: bool) -> String {
    let fmt = if with_date {
        "%Y-%m-%d %H:%M:%S"
    } else {
        "%H:%M:%S"
    };
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format(fmt).to_string())
        .unwrap_or_default()
}

/// 머리 줄. 점검 상태는 절대 자르지 않고, 좁으면 날짜 → `Handicap 모니터 · ` → 시계 순으로 뺀다.
/// 보드 이름은 마지막에야 `…`로 줄이고 `(i/n)`은 통째로 남긴다.
fn render_header(f: &mut Frame, area: Rect, s: &MonitorScreen) {
    let w = usize::from(area.width);
    let status = if s.server_down {
        text::SERVER_DOWN
    } else {
        text::MONITOR_RUNNING
    };
    let pos = if s.board_pos.1 > 1 {
        format!(" {}", text::board_pos(s.board_pos.0, s.board_pos.1))
    } else {
        String::new()
    };
    // (접두 표시, 시계 형식)
    let steps: [(bool, Option<bool>); 4] = [
        (true, Some(true)),
        (true, Some(false)),
        (false, Some(false)),
        (false, None),
    ];
    let mut chosen = None;
    for (i, (prefix, date)) in steps.iter().enumerate() {
        let right = match (s.server_time, date) {
            (Some(ms), Some(d)) => format!("{}  {} ", clock(ms, *d), status),
            _ => format!("{status} "),
        };
        let head = if *prefix {
            format!(" {} · ", text::MONITOR_TITLE)
        } else {
            " ".to_string()
        };
        let fixed = text_width(&head) + text_width(&pos) + text_width(&right) + 1;
        let name_w = text_width(&s.board_name);
        let last = i == steps.len() - 1;
        if fixed + name_w <= w || last {
            let room = w.saturating_sub(fixed);
            let name = if room >= 2 || fixed + name_w <= w {
                fit(&s.board_name, room)
            } else {
                String::new()
            };
            chosen = Some((head, name, right));
            break;
        }
    }
    let (head, name, right) = chosen.unwrap_or_default();
    let (head, name, pos) = if text_width(&right) >= w {
        // 상태만으로도 넘치면 `…`로 줄인다.
        (String::new(), String::new(), String::new())
    } else {
        (head, name, pos)
    };
    let left = if text_width(&head) + text_width(&name) + text_width(&pos) + text_width(&right) > w
    {
        String::new()
    } else {
        format!("{head}{name}{pos}")
    };
    let right = fit(&right, w);
    let pad = w.saturating_sub(text_width(&left) + text_width(&right));
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
            Span::styled(right, Style::default().fg(color(status_color))),
        ]),
    );
}

fn render_key_bar(f: &mut Frame, area: Rect, segments: &[&str]) {
    if area.height == 0 {
        return;
    }
    put(
        f,
        Rect::new(area.x, area.y + area.height - 1, area.width, 1),
        Line::from(Span::styled(
            key_bar(segments, area.width),
            Style::default().fg(color(C_MUTED)),
        )),
    );
}

pub fn render(f: &mut Frame, s: &MonitorScreen) {
    let area = f.area();
    let lay = match layout(area, s.panels.len()) {
        Ok(l) => l,
        Err(e) => {
            let body = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1));
            f.render_widget(
                Paragraph::new(text::too_small(e.have, e.need))
                    .wrap(ratatui::widgets::Wrap { trim: false }),
                body,
            );
            render_key_bar(f, area, &[text::KEYS_QUIT]);
            return;
        }
    };
    render_header(f, Rect::new(area.x, area.y, area.width, 1), s);
    for (i, (rect, v)) in lay.panels.iter().zip(&s.panels).enumerate() {
        render_panel(f, *rect, v, i == s.selected);
    }
    let mut keys = vec![text::KEYS_MOVE];
    if s.board_pos.1 > 1 {
        keys.push(text::KEYS_NEXT_BOARD);
    }
    keys.extend([text::KEYS_HELP_OPEN, text::KEYS_QUIT]);
    render_key_bar(f, area, &keys);
}
