//! 모니터 화면 — 머리 줄·칸 격자·키 안내 줄과 클릭 대조용 칸 사각형.

use chrono::{Local, TimeZone};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

use super::axis::{axis_line, axis_uses_seconds};
use super::bigfont::{self, Tier};
use super::graph;
use super::model::{BigValue, PanelView, Row, panel_rows_s, parse_hex};
use super::tier::{self, TierInput, UNIT_W};
use super::{fit, key_bar, text_width};
use crate::judge::ReasonParts;
use crate::judge::{PanelState, format_hm, format_hms, grid_for};
use crate::text;

pub const MIN_PANEL_W: u16 = 24;
pub const MIN_PANEL_H: u16 = 6;

pub(crate) const C_TEXT: &str = "#f2f5f8";
pub(crate) const C_MUTED: &str = "#9aa7b4";
pub(crate) const C_SOFT: &str = "#cbd5e1";
pub(crate) const C_AXIS: &str = "#7b8794";
pub(crate) const C_OK: &str = "#22c55e";
pub(crate) const C_FAIL: &str = "#ef4444";
pub(crate) const C_GRAY: &str = "#94a3b8";
pub(crate) const C_SLOW: &str = "#f59e0b";
pub(crate) const C_GRAY_BORDER: &str = "#64748b";
pub(crate) const C_BLOCKED_BORDER: &str = "#475569";
pub(crate) const C_BRIGHT: &str = "#e2e8f0";

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

/// 칸 테두리(1a — 선택 칸은 굵은 선). 제목은 호출자가 붙인다.
fn panel_block(v: &PanelView, selected: bool) -> Block<'static> {
    let bc = border_color(v);
    let (border_type, style) = if selected {
        (
            BorderType::Thick,
            Style::default().fg(bc).add_modifier(Modifier::BOLD),
        )
    } else {
        (BorderType::Plain, Style::default().fg(bc))
    };
    Block::default()
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(style)
}

fn title_color(v: &PanelView) -> Color {
    if matches!(v.state, PanelState::Blocked | PanelState::Skipped) {
        color(C_SOFT)
    } else {
        color(C_TEXT)
    }
}

/// 사유 작은 줄 — 폭 `w`에 오른쪽 정렬.
fn reason_small_line(v: &PanelView, small: &str, w: usize) -> Line<'static> {
    let t = fit(small, w);
    let pad = w - text_width(&t);
    Line::from(vec![
        Span::raw(" ".repeat(pad)),
        Span::styled(t, Style::default().fg(small_color(v))),
    ])
}

/// 연속 실패 줄 — 통째로 안 들어가면 `N회 연속`만(꼬리를 단어 중간에서 자르지 않는다).
fn consecutive_line(v: &PanelView, w: usize) -> Line<'static> {
    let full = v.consecutive.as_deref().unwrap_or_default();
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

/// 평균·최대 줄 — 값이 없으면 빈 줄로 자리를 지킨다.
fn stats_line(v: &PanelView, w: usize) -> Line<'static> {
    Line::from(Span::styled(
        text::stats_for_width(v.stats.as_deref().unwrap_or_default(), w),
        Style::default().fg(color(C_MUTED)),
    ))
}

/// 시각 줄(`y`) — 눈금은 보이는 막대 범위(`bars_range`)에, 숫자 열이 있으면 `right`에서 끝나는
/// 그 열 아래에 `(ms)`.
fn render_axis_row(
    f: &mut Frame,
    y: u16,
    v: &PanelView,
    bars_range: Rect,
    right: u16,
    label_w: u16,
) {
    let n = usize::from(bars_range.width);
    let bars = &v.bars[v.bars.len() - n..];
    let times: Vec<Option<i64>> = bars.iter().map(|b| b.at_ms).collect();
    let secs = axis_uses_seconds(n, v.interval_seconds);
    let label: &dyn Fn(i64) -> String = if secs { &format_hms } else { &format_hm };
    put(
        f,
        Rect::new(bars_range.x, y, bars_range.width, 1),
        Line::from(Span::styled(
            axis_line(&times, label),
            Style::default().fg(color(C_AXIS)),
        )),
    );
    if label_w > 0 {
        put(
            f,
            Rect::new(right - label_w, y, label_w, 1),
            Line::from(Span::styled(
                format!("{:>w$}", text::AXIS_UNIT, w = usize::from(label_w)),
                Style::default().fg(color(C_AXIS)),
            )),
        );
    }
}

/// 선택 칸 머리 줄 제목 앞 `▶ ` 자리(Task 5가 그린다).
const SELECT_MARK_W: usize = 2;

/// L·M 머리 줄 — 왼쪽 제목(굵게) · 오른쪽 상태 문구(굵게, 상태 색). 사이 1칸 이상, 모자라면 제목만 줄인다.
/// 상태 문구 + 1이 폭보다 넓으면 제목을 빼고 상태 문구만 줄여 쓴다.
fn header_line(v: &PanelView, w: usize, selected: bool) -> Line<'static> {
    let label_style = Style::default()
        .fg(state_color(v))
        .add_modifier(Modifier::BOLD);
    let lw = text_width(v.label);
    if lw + 1 > w {
        let label = text::label_for_width(v.label, w);
        let pad = w - text_width(&label);
        return Line::from(vec![
            Span::raw(" ".repeat(pad)),
            Span::styled(label, label_style),
        ]);
    }
    let reserve = if selected { SELECT_MARK_W } else { 0 };
    let title = fit(&v.title, (w - lw - 1).saturating_sub(reserve));
    let pad = w - lw - text_width(&title);
    Line::from(vec![
        Span::styled(
            title,
            Style::default()
                .fg(title_color(v))
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" ".repeat(pad)),
        Span::styled(v.label, label_style),
    ])
}

/// L·M 큰 값 블록(`area` = 사용 폭 × 블록 줄 수). 큰 글꼴로 그릴 수 없거나 허용 폭을 넘는 값은
/// 블록 가운데 줄에 일반 굵은 글자로 오른쪽 정렬(블록 위치는 그대로).
fn render_big_lm(f: &mut Frame, area: Rect, v: &PanelView, tier: Tier, ref_w: u16) {
    let style = Style::default()
        .fg(big_color(v))
        .add_modifier(Modifier::BOLD);
    let latency = match (&v.big, v.state) {
        (BigValue::Text(t), PanelState::Ok | PanelState::Slow) => t
            .strip_suffix(text::LATENCY_UNIT)
            .and_then(|s| s.strip_suffix(' ')),
        _ => None,
    };
    // 실패류 허용 폭: 표시 항목이 설정된 칸은 기준 폭(왼쪽 자리를 지킨다), 아니면 사용 폭 전체.
    let fail_allowed = if v.n_display_items > 0 {
        ref_w
    } else {
        area.width
    };
    let glyph: Option<(&str, u16, bool)> = match (&v.big, latency) {
        (_, Some(num)) => Some((num, ref_w.saturating_sub(UNIT_W), true)),
        (BigValue::Reason(ReasonParts::Split { fixed, .. }), None) => {
            Some((fixed, fail_allowed, false))
        }
        (BigValue::Reason(ReasonParts::Detail { big, .. }), None) => {
            Some((big, fail_allowed, false))
        }
        _ => None,
    };
    if area.height == 0 {
        return;
    }
    // 블록 줄 수보다 글꼴 줄이 많으면(단계 규칙상 없지만) 칸 밖에 쓰지 않게 일반 글자로.
    let big_rows = glyph
        .filter(|&(s, allowed, _)| {
            bigfont::supported(s) && bigfont::width(s, tier) <= usize::from(allowed)
        })
        .map(|(s, _, unit)| (bigfont::rows(s, tier), unit))
        .filter(|(rows, _)| rows.len() <= usize::from(area.height));
    if let Some((rows, unit)) = big_rows {
        let right = area.x + area.width - if unit { UNIT_W } else { 0 };
        let buf = f.buffer_mut();
        for (i, row) in rows.iter().enumerate() {
            let rw = row.chars().count() as u16;
            buf.set_string(right - rw, area.y + i as u16, row, style);
        }
        if unit {
            let uw = text_width(text::LATENCY_UNIT) as u16;
            buf.set_string(
                area.x + area.width - uw,
                area.y + area.height - 1,
                text::LATENCY_UNIT,
                style,
            );
        }
        return;
    }
    let allowed = if latency.is_some() {
        ref_w
    } else {
        fail_allowed
    };
    let t = big_fit(v, usize::from(allowed));
    let pad = usize::from(area.width).saturating_sub(text_width(&t));
    put(
        f,
        Rect::new(area.x, area.y + area.height / 2, area.width, 1),
        Line::from(vec![Span::raw(" ".repeat(pad)), Span::styled(t, style)]),
    );
}

/// L·M 단계 칸(spec §4.2): 좌우 여백 1, 머리 줄 → 큰 값 블록(표시 값 왼쪽) → 사유 작은 줄 →
/// 연속 실패 줄 → 막대 영역 → 시각 줄 → 평균·최대 줄.
fn render_panel_lm(f: &mut Frame, rect: Rect, v: &PanelView, selected: bool, tier: Tier) {
    let block = panel_block(v, selected);
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    if inner.width < 3 || inner.height == 0 {
        return;
    }
    let x0 = inner.x + 1;
    let usable = inner.width - 2;
    let w = usize::from(usable);
    let bottom = inner.y + inner.height;
    let row = |y: u16| Rect::new(x0, y, usable, 1);
    let mut y = inner.y;
    put(f, row(y), header_line(v, w, selected));
    y += 1;
    let block_h = if tier == Tier::L { 5 } else { 3 };
    let ref_w = tier::reference_width(v.timeout_seconds, tier);
    let block_h = block_h.min(bottom - y);
    render_big_lm(
        f,
        Rect::new(x0, y, usable, block_h),
        v,
        tier,
        ref_w.min(usable),
    );
    // 화면 표시 값 — 왼쪽 자리 폭은 기준 폭으로 재서 응답 시간이 바뀌어도 고정된다.
    let left = usize::from(usable.saturating_sub(ref_w.saturating_add(1)));
    for (k, val) in v
        .display
        .iter()
        .take(2.min(usize::from(block_h)))
        .enumerate()
    {
        let style = if k == 0 {
            Style::default()
                .fg(color(C_TEXT))
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(color(C_SOFT))
        };
        put(
            f,
            Rect::new(x0, y + k as u16, left as u16, 1),
            Line::from(Span::styled(fit(val, left), style)),
        );
    }
    y += block_h;
    if let Some(small) = reason_small(v)
        && y < bottom
    {
        put(f, row(y), reason_small_line(v, small, w));
        y += 1;
    }
    if v.consecutive.is_some() && y < bottom {
        put(f, row(y), consecutive_line(v, w));
        y += 1;
    }
    let tail = 1 + u16::from(v.show_stats);
    let bar_h = bottom.saturating_sub(y).saturating_sub(tail);
    let label_w = graph::label_width(&v.thresholds, usable, true);
    let range = graph::render_graph(f, Rect::new(x0, y, usable, bar_h), v, true, label_w, None);
    y += bar_h;
    if y < bottom {
        render_axis_row(f, y, v, range, x0 + usable, label_w);
        y += 1;
    }
    if v.show_stats && y < bottom {
        put(f, row(y), stats_line(v, w));
    }
}

/// S 단계 칸(1a 배치 기반, spec §4.3).
fn render_panel_s(f: &mut Frame, rect: Rect, v: &PanelView, selected: bool) {
    let sc = state_color(v);
    let title = format!(
        " {} ",
        fit(&v.title, usize::from(rect.width).saturating_sub(4))
    );
    let block =
        panel_block(v, selected).title(Span::styled(title, Style::default().fg(title_color(v))));
    let inner = block.inner(rect);
    f.render_widget(block, rect);
    if inner.width == 0 {
        return;
    }
    let w = usize::from(inner.width);
    let small = reason_small(v);
    let (rows, bar_h) = panel_rows_s(
        inner.height,
        small.is_some(),
        v.consecutive.is_some(),
        v.show_stats,
        v.n_display_items,
    );
    // 기준선·숫자 열은 최악 경우 막대 줄 수로 정해 상태가 바뀌어도 막대가 밀리지 않는다.
    let worst_bar_h = panel_rows_s(inner.height, true, true, v.show_stats, v.n_display_items).1;
    let draw_thresholds = worst_bar_h >= graph::MIN_THRESHOLD_ROWS;
    let label_w = graph::label_width(&v.thresholds, inner.width, draw_thresholds);
    let mut bars_range = Rect::new(inner.x, inner.y, 0, 0);
    let mut y = inner.y;
    for row in rows {
        let h = if row == Row::Bars { bar_h } else { 1 };
        let area = Rect::new(inner.x, y, inner.width, h);
        y += h;
        let line = match row {
            Row::Status => {
                let label = text::label_for_width(v.label, w);
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
            Row::ReasonSmall => reason_small_line(v, small.unwrap_or_default(), w),
            Row::Consecutive => consecutive_line(v, w),
            Row::Bars => {
                bars_range = graph::render_graph(f, area, v, draw_thresholds, label_w, None);
                continue;
            }
            Row::Axis => {
                render_axis_row(f, area.y, v, bars_range, inner.x + inner.width, label_w);
                continue;
            }
            Row::Stats => stats_line(v, w),
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

/// 맨 아래 키 줄이 안내할 화면 — 열려 있는 화면에서 쓸 수 있는 키만 보인다(spec §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBar {
    Monitor,
    Help,
    QuitConfirm,
}

pub fn render(f: &mut Frame, s: &MonitorScreen) {
    render_with_keys(f, s, KeyBar::Monitor);
}

pub fn render_with_keys(f: &mut Frame, s: &MonitorScreen, bar: KeyBar) {
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
            let keys: &[&str] = match bar {
                KeyBar::Monitor => &[text::KEYS_QUIT],
                KeyBar::Help => &[text::KEYS_HELP],
                KeyBar::QuitConfirm => &[text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL],
            };
            render_key_bar(f, area, keys);
            return;
        }
    };
    render_header(f, Rect::new(area.x, area.y, area.width, 1), s);
    // 크기 단계는 보드 전체에 하나, 설정과 칸 크기로만(spec §4.1).
    let inners: Vec<(u16, u16)> = lay
        .panels
        .iter()
        .map(|r| (r.width.saturating_sub(2), r.height.saturating_sub(2)))
        .collect();
    let inputs: Vec<TierInput> = s
        .panels
        .iter()
        .map(|v| TierInput {
            timeout_seconds: v.timeout_seconds,
            has_display_items: v.n_display_items > 0,
            show_stats: v.show_stats,
        })
        .collect();
    let tier = tier::board_tier(&inners, &inputs);
    for (i, (rect, v)) in lay.panels.iter().zip(&s.panels).enumerate() {
        if tier == Tier::S {
            render_panel_s(f, *rect, v, i == s.selected);
        } else {
            render_panel_lm(f, *rect, v, i == s.selected, tier);
        }
    }
    let keys = match bar {
        KeyBar::Monitor => {
            let mut keys = vec![text::KEYS_MOVE];
            if s.board_pos.1 > 1 {
                keys.push(text::KEYS_NEXT_BOARD);
            }
            keys.extend([text::KEYS_HELP_OPEN, text::KEYS_QUIT]);
            keys
        }
        KeyBar::Help => vec![text::KEYS_HELP],
        KeyBar::QuitConfirm => vec![text::KEYS_CONFIRM_YES, text::KEYS_CONFIRM_CANCEL],
    };
    render_key_bar(f, area, &keys);
}
