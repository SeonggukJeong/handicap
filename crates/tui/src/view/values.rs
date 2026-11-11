//! 값 목록 화면 그리기(tui-2b spec §3.1·§3.2) — 뷰 모델만 받아 그린다.
//! 머리 줄·무입력 안내·키 줄(`render_frame`) 안에: 제목 줄(오른쪽 `{커서}/{전체}`) → 안내 줄 → 표 머리 → 값 줄 →
//! 맨 아래 선택 창(`OverlayView::Choice`) 또는 조건 칸. 창·칸 높이만큼 목록 영역이 줄어든다.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::edit::{CondFormView, cond_form_lines, render_form_at_bottom};
use super::inspect::render_frame;
use super::monitor::{C_BG, C_MUTED, C_SLOW, C_TEXT, HeaderView};
use super::settings::{OverlayView, color, overlay_rows, put};
use super::{fit, text_width, wrap_width};
use crate::inspect::sanitize;
use crate::pick;
use crate::text;

pub struct ValuesView<'a> {
    /// `{칸 제목} · {시각} · {순번} {스텝 이름}` — 그릴 때 ` — 값 고르기`를 붙인다.
    pub title: &'a str,
    /// 표 머리 위 안내 줄들(높이가 모자라면 먼저 빠진다).
    pub notes: Vec<String>,
    /// 값을 못 고르는 이유 — 있으면 표 머리·줄 없이 이 문구만(줄바꿈).
    pub blocked: Option<String>,
    /// 줄 글자 — 호출 쪽이 `sanitize`를 마친 글자를 넘긴다(`pick::ValuesState::new`). 여기서 다시 `sanitize`하지 않는다.
    pub rows: &'a [pick::RowText],
    /// 모든 줄의 대상 표시 폭 중 최대(`ValuesState::target_width`).
    pub target_width: usize,
    /// 줄 번호 → (그 줄을 대상으로 한 조건 수, 화면 표시 값 있음). **화면에 보이는 줄에만** 부른다.
    pub marks: &'a dyn Fn(usize) -> (usize, bool),
    pub cursor: usize,
    pub overlay: Option<OverlayView<'a>>,
    pub form: Option<&'a CondFormView<'a>>,
}

/// 오른쪽 표지 글자: `""`·`조건`·`조건 2`·`표시`·`조건 · 표시`·`조건 2 · 표시`.
pub fn mark_text(cond_marks: usize, display_mark: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    match cond_marks {
        0 => {}
        1 => parts.push(text::MARK_COND.to_string()),
        n => parts.push(format!("{} {n}", text::MARK_COND)),
    }
    if display_mark {
        parts.push(text::MARK_DISPLAY.to_string());
    }
    parts.join(" · ")
}

/// 넘치면 **앞**을 `…`로 줄인다(끝의 키 이름이 보이게). 넓은 글자는 반쪽으로 자르지 않는다.
pub fn fit_head(s: &str, w: usize) -> String {
    if text_width(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let mut tail: Vec<char> = Vec::new();
    let mut used = 0;
    for c in s.chars().rev() {
        let cw = text_width(c.encode_utf8(&mut [0; 4]));
        if used + cw > w - 1 {
            break;
        }
        used += cw;
        tail.push(c);
    }
    // 잘린 경계 바로 뒤의 폭 0 글자(결합 문자 등)는 `…` 위에 얹히니 버린다.
    while tail
        .last()
        .is_some_and(|c| text_width(c.encode_utf8(&mut [0; 4])) == 0)
    {
        tail.pop();
    }
    tail.push('…');
    tail.iter().rev().collect()
}

fn pad_to(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(text_width(s))))
}

/// 표지가 그 줄에 들어갈 최소 받은 값 칸.
const MIN_VALUE: usize = 4;

fn row_line(
    r: &pick::RowText,
    marks: (usize, bool),
    selected: bool,
    tw: usize,
    w: usize,
) -> Line<'static> {
    let sel = Style::default().fg(color(C_BG)).bg(color(C_TEXT));
    let text_style = Style::default().fg(color(C_TEXT));
    let muted = Style::default().fg(color(C_MUTED));
    let prefix = if selected { "▶ " } else { "  " };
    let target = pad_to(&fit_head(r.target(), tw), tw);
    let shown = r.shown();
    let mark = mark_text(marks.0, marks.1);
    let left_w = 2 + tw + 2;
    let mw = text_width(&mark);
    let show_mark = !mark.is_empty() && left_w + MIN_VALUE + 2 + mw <= w;
    let (value, mut tail) = if show_mark {
        let vw = w.saturating_sub(left_w + 2 + mw);
        (pad_to(&fit(shown, vw), vw), Some(format!("  {mark}")))
    } else {
        (fit(shown, w.saturating_sub(left_w)), None)
    };
    let mut left = format!("{prefix}{target}  {value}");
    if text_width(&left) + tail.as_ref().map_or(0, |t| text_width(t)) > w {
        // 폭이 아주 좁다 — 표지를 버리고 줄 통째로 줄인다.
        left = fit(&left, w);
        tail = None;
    }
    finish(left, tail, selected, w, sel, text_style, muted)
}

fn finish(
    left: String,
    tail: Option<String>,
    selected: bool,
    w: usize,
    sel: Style,
    text_style: Style,
    muted: Style,
) -> Line<'static> {
    let used = text_width(&left) + tail.as_ref().map_or(0, |t| text_width(t));
    if selected {
        let pad = " ".repeat(w.saturating_sub(used));
        let t = tail.unwrap_or_default();
        return Line::from(Span::styled(format!("{left}{t}{pad}"), sel));
    }
    let mut spans = vec![Span::styled(left, text_style)];
    if let Some(t) = tail {
        spans.push(Span::styled(t, muted));
    }
    Line::from(spans)
}

/// 값 목록 화면. 선택 창(`overlay`)이나 조건 칸(`form`)이 있으면 body 맨 아래를 그만큼 쓴다.
pub fn render_values(f: &mut Frame, head: &HeaderView, v: &ValuesView, keys: &[&str]) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let bh = usize::from(body.height);
    let row = |i: usize| Rect::new(body.x, body.y.saturating_add(i as u16), body.width, 1);
    let muted = Style::default().fg(color(C_MUTED));
    let text_style = Style::default().fg(color(C_TEXT));

    // 맨 아래 자리 — 조건 칸이 있으면 칸, 아니면 선택 창 줄들.
    let (ov_rows, form_h) = match v.form {
        Some(fv) => (Vec::new(), usize::from(cond_form_lines(fv)).min(bh)),
        None => (overlay_rows(v.overlay.as_ref(), w, bh), 0),
    };
    let ov_n = ov_rows.len().min(bh);
    let reserve = ov_n.max(form_h);
    let area_h = bh - reserve;

    if area_h > 0 {
        let n = v.rows.len();
        let cursor = v.cursor.min(n.saturating_sub(1));
        // 제목 줄.
        let t = format!("{}{}", sanitize(v.title), text::PICK_TITLE_SUFFIX);
        let bold = text_style.add_modifier(Modifier::BOLD);
        let right = (n > 0 && v.blocked.is_none()).then(|| format!("{}/{n}", cursor + 1));
        let title_line = match right {
            Some(r) if text_width(&t) + 2 + text_width(&r) <= w => Line::from(vec![
                Span::styled(t.clone(), bold),
                Span::raw(" ".repeat(w - text_width(&t) - text_width(&r))),
                Span::styled(r, muted),
            ]),
            _ => Line::from(Span::styled(fit(&t, w), bold)),
        };
        put(f, row(0), title_line);

        let rest = area_h - 1;
        if let Some(b) = &v.blocked {
            let st = Style::default().fg(color(C_SLOW));
            for (i, l) in wrap_width(&sanitize(b), w)
                .into_iter()
                .take(rest)
                .enumerate()
            {
                put(f, row(1 + i), Line::from(Span::styled(l, st)));
            }
        } else {
            // 줄이 1줄도 안 남으면 안내 줄 → 표 머리 순으로 뺀다.
            let mut head_n = usize::from(rest > 0);
            let mut notes_n = v.notes.len().min(rest - head_n);
            if n > 0 {
                while notes_n + head_n >= rest && notes_n > 0 {
                    notes_n -= 1;
                }
                if notes_n + head_n >= rest {
                    head_n = 0;
                }
            }
            let mut y = 1;
            for note in v.notes.iter().take(notes_n) {
                put(
                    f,
                    row(y),
                    Line::from(Span::styled(fit(&sanitize(note), w), muted)),
                );
                y += 1;
            }
            let tw = v.target_width.min(w / 2).min(w.saturating_sub(2));
            if head_n > 0 {
                let line = fit(
                    &format!(
                        "  {}  {}",
                        pad_to(text::PICK_COL_TARGET, tw),
                        text::PICK_COL_VALUE
                    ),
                    w,
                );
                put(f, row(y), Line::from(Span::styled(line, muted)));
                y += 1;
            }
            let lh = rest.saturating_sub(notes_n + head_n);
            let start = (cursor + 1).saturating_sub(lh).min(n);
            for (i, r) in v.rows[start..].iter().take(lh).enumerate() {
                let idx = start + i;
                put(
                    f,
                    row(y + i),
                    row_line(r, (v.marks)(idx), idx == cursor, tw, w),
                );
            }
        }
    }

    // 맨 아래: 선택 창 줄들(모자라면 앞 줄부터 뺀다) 또는 조건 칸.
    if let Some(fv) = v.form {
        render_form_at_bottom(f, body, form_h as u16, fv);
    } else {
        let skip = ov_rows.len() - ov_n;
        for (i, l) in ov_rows.into_iter().skip(skip).enumerate() {
            put(f, row(bh - ov_n + i), l);
        }
    }
}
