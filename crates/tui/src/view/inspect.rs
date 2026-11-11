//! 새 화면(오류 보기·칸 설정)이 같이 쓰는 틀(머리 줄·무입력 안내 줄·키 줄)과 오류 목록 그리기.
//! 배치 기준은 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §1.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::model::parse_hex;
use super::monitor::{
    C_FAIL, C_GRAY, C_MUTED, C_OK, C_SLOW, C_TEXT, HeaderView, render_header_view,
};
use super::{fit, key_bar, text_width};
use crate::inspect::{ErrorRow, ErrorsView, Reason, sanitize};
use crate::judge::{PanelState, format_hms, format_ms};
use crate::text;

fn color(hex: &str) -> Color {
    parse_hex(hex).unwrap_or(Color::Reset)
}

fn put(f: &mut Frame, area: Rect, line: Line) {
    f.render_widget(Paragraph::new(line), area);
}

/// 새 화면의 줄 배치.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubLayout {
    pub head: Option<Rect>,
    pub body: Rect,
    pub idle: Option<Rect>,
    pub keys: Option<Rect>,
}

/// 높이 ≥ 1이면 맨 아래 키 줄, ≥ 3이면 맨 위 머리 줄, 높이 ≥ 10 ∧ 폭 ≥ (안내 문구 폭 + 1)이면
/// 키 줄 바로 위에 무입력 안내 줄. 나머지가 body. 안내 줄은 줄이지 않고 통째로 생략한다.
pub fn sub_layout(area: Rect) -> SubLayout {
    let row = |y: u16| Rect::new(area.x, y, area.width, 1);
    let mut top = area.y;
    let mut bottom = area.y.saturating_add(area.height);
    let keys = (area.height >= 1).then(|| {
        bottom -= 1;
        row(bottom)
    });
    let head = (area.height >= 3).then(|| {
        top += 1;
        row(area.y)
    });
    let idle =
        (area.height >= 10 && usize::from(area.width) > text_width(text::IDLE_NOTICE)).then(|| {
            bottom -= 1;
            row(bottom)
        });
    SubLayout {
        head,
        body: Rect::new(area.x, top, area.width, bottom.saturating_sub(top)),
        idle,
        keys,
    }
}

/// 머리 줄·무입력 안내 줄(C_MUTED)·키 줄(C_MUTED)을 그리고 body를 돌려준다.
pub fn render_frame(f: &mut Frame, head: &HeaderView, keys: &[&str]) -> Rect {
    let l = sub_layout(f.area());
    if let Some(r) = l.head {
        render_header_view(f, r, head);
    }
    let muted = Style::default().fg(color(C_MUTED));
    if let Some(r) = l.idle {
        put(
            f,
            r,
            Line::from(Span::styled(format!(" {}", text::IDLE_NOTICE), muted)),
        );
    }
    if let Some(r) = l.keys {
        put(
            f,
            r,
            Line::from(Span::styled(key_bar(keys, r.width), muted)),
        );
    }
    l.body
}

/// body에서 제목 줄 1 + (body 높이 ≥ 4면) 열 이름 줄 1을 뺀 줄 수.
pub fn errors_list_height(area: Rect) -> usize {
    let cols = u16::from(area.height >= 4);
    usize::from(area.height.saturating_sub(1).saturating_sub(cols))
}

/// 커서 표시 `▶ ` 자리.
const MARK_W: usize = 2;
/// 열 사이 공백.
const GAP: usize = 3;
/// 사유 칸이 이보다 좁아지면 상태 열(그다음 시각 열)을 통째로 뺀다.
const REASON_MIN: usize = 4;

/// 이 화면에 나올 수 있는 상태 문구.
const ROW_STATES: [PanelState; 6] = [
    PanelState::Ok,
    PanelState::Slow,
    PanelState::Fail,
    PanelState::ConfigError,
    PanelState::Blocked,
    PanelState::Skipped,
];

/// 폭에 따라 보이는 열.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cols {
    time: bool,
    state: bool,
    state_w: usize,
    time_w: usize,
}

fn cols_for(w: usize) -> Cols {
    let state_w = ROW_STATES
        .iter()
        .map(|&s| text_width(text::state_label(s)))
        .max()
        .unwrap_or(0);
    let time_w = text_width(&format_hms(0));
    let with_time = MARK_W + time_w + GAP;
    let state = w >= with_time + state_w + GAP + REASON_MIN;
    let time = state || w >= with_time + REASON_MIN;
    Cols {
        time,
        state,
        state_w,
        time_w,
    }
}

fn pad_to(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(text_width(s))))
}

fn state_style(s: PanelState) -> Style {
    let c = match s {
        PanelState::Fail => C_FAIL,
        PanelState::ConfigError | PanelState::Slow => C_SLOW,
        PanelState::Ok => C_OK,
        _ => C_GRAY,
    };
    Style::default().fg(color(c))
}

fn reason_text(r: &ErrorRow) -> String {
    if matches!(r.state, PanelState::Ok | PanelState::Slow) {
        return match r.latency_ms {
            Some(ms) => format_ms(ms as f64),
            None => text::NO_VALUE.to_string(),
        };
    }
    match &r.reason {
        Reason::Known {
            reason: Some(s), ..
        } => sanitize(s),
        Reason::Known { reason: None, .. } => text::NO_VALUE.to_string(),
        Reason::Loading => text::LOADING.to_string(),
        Reason::Gone => text::RECORD_GONE_SHORT.to_string(),
        Reason::Failed(m) => text::record_load_error(&sanitize(m)),
    }
}

/// 열 머리·목록 줄 공통: (시각 칸, 상태 칸) 다음 사유 칸 시작까지의 폭.
fn reason_x(c: &Cols) -> usize {
    let mut x = MARK_W;
    if c.time {
        x += c.time_w + GAP;
    }
    if c.state {
        x += c.state_w + GAP;
    }
    x
}

fn cols_line(c: &Cols, w: usize) -> Line<'static> {
    let (t, s, r) = text::ERRORS_COLS;
    let mut out = " ".repeat(MARK_W);
    if c.time {
        out.push_str(&pad_to(t, c.time_w + GAP));
    }
    if c.state {
        out.push_str(&pad_to(s, c.state_w + GAP));
    }
    out.push_str(r);
    Line::from(Span::styled(
        fit(&out, w),
        Style::default().fg(color(C_MUTED)),
    ))
}

fn row_line(r: &ErrorRow, cursor: bool, c: &Cols, w: usize) -> Line<'static> {
    let base = Style::default().fg(color(C_TEXT));
    let bold = |s: Style| {
        if cursor {
            s.add_modifier(Modifier::BOLD)
        } else {
            s
        }
    };
    let mut spans = vec![Span::styled(
        if cursor { "▶ " } else { "  " }.to_string(),
        bold(base),
    )];
    if c.time {
        spans.push(Span::styled(
            pad_to(&format_hms(r.at_ms), c.time_w + GAP),
            bold(base),
        ));
    }
    if c.state {
        spans.push(Span::styled(
            pad_to(text::state_label(r.state), c.state_w + GAP),
            bold(state_style(r.state)),
        ));
    }
    let room = w.saturating_sub(reason_x(c));
    spans.push(Span::styled(fit(&reason_text(r), room), bold(base)));
    Line::from(spans)
}

fn title_line(v: &ErrorsView, w: usize) -> Line<'static> {
    let title = format!("{} · {}", text::ERRORS_TITLE, sanitize(&v.title));
    let count = if v.show_all {
        text::errors_count_all(v.total)
    } else {
        text::errors_count(v.failures, v.total, &text::span_text(v.span_secs))
    };
    let title_style = Style::default()
        .fg(color(C_TEXT))
        .add_modifier(Modifier::BOLD);
    let (tw, cw) = (text_width(&title), text_width(&count));
    if tw + 1 + cw > w {
        // 개수는 통째로 뺀다.
        return Line::from(Span::styled(fit(&title, w), title_style));
    }
    Line::from(vec![
        Span::styled(title, title_style),
        Span::raw(" ".repeat(w - tw - cw)),
        Span::styled(count, Style::default().fg(color(C_MUTED))),
    ])
}

/// 오류 목록(목업 §1): 제목·개수 줄 → 열 이름 줄(body 높이 ≥ 4) → 목록 줄. 키 줄은 `keys`.
pub fn render_errors(f: &mut Frame, head: &HeaderView, v: &ErrorsView, keys: &[&str]) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let row = |i: u16| Rect::new(body.x, body.y + i, body.width, 1);
    put(f, row(0), title_line(v, w));
    let list_h = errors_list_height(body);
    let mut y = 1u16;
    if v.rows.is_empty() {
        if body.height >= 2 {
            let msg = if v.show_all {
                text::ERRORS_EMPTY_ALL
            } else {
                text::ERRORS_EMPTY
            };
            put(
                f,
                row(1),
                Line::from(Span::styled(
                    fit(msg, w),
                    Style::default().fg(color(C_MUTED)),
                )),
            );
        }
        return;
    }
    let c = cols_for(w);
    if body.height >= 4 {
        put(f, row(y), cols_line(&c, w));
        y += 1;
    }
    for (i, r) in v.rows.iter().take(list_h).enumerate() {
        put(f, row(y), row_line(r, v.cursor == Some(i), &c, w));
        y += 1;
    }
}
