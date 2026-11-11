//! 칸 설정 편집 메뉴 그리기(목업 §1–§3) — 줄은 `panel_settings::edit_menu_lines`가 만든다.
//! 뷰 모델만 받아 그린다: 고른 항목(`▶`·흰 바탕), 아래쪽 입력줄·확인·저장 중·안내, 항목 아래 목록 창.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use super::inspect::render_frame;
use super::model::parse_hex;
use super::monitor::{C_BG, C_FAIL, C_MUTED, C_SLOW, C_TEXT, HeaderView};
use super::{fit, text_width, wrap_width};
use crate::inspect::sanitize;
use crate::text;

pub(crate) fn color(hex: &str) -> Color {
    parse_hex(hex).unwrap_or(Color::Reset)
}

pub(crate) fn put(f: &mut Frame, area: Rect, line: Line) {
    f.render_widget(Paragraph::new(line), area);
}

/// 입력 칸 바탕(목업 `.inp`).
const INPUT_BG: Color = Color::Rgb(0x26, 0x31, 0x3d);
/// 입력 칸 최소 폭 — 이보다 좁아지면 힌트 → 라벨 순으로 줄인다.
const MIN_TEXT: usize = 4;
/// 목록 창이 항목 줄 들여쓰기에서 시작하는 열.
const PICK_X: usize = 4;

/// 각주가 실제로 그려지는가 — 목록 줄을 최소 1줄 남길 수 있을 때만(body 높이 ≥ 3).
fn note_shown(body_h: u16, has_note: bool) -> bool {
    has_note && body_h >= 3
}

/// `body`(= `sub_layout(..).body`)에서 제목 줄 1 + (각주가 있으면) 각주 줄 1을 뺀 줄 수.
pub fn settings_height(body: Rect, has_note: bool) -> usize {
    let note = u16::from(note_shown(body.height, has_note));
    usize::from(body.height.saturating_sub(1).saturating_sub(note))
}

pub struct EditMenuView<'a> {
    pub title: &'a str,
    /// `panel_settings::edit_menu_lines`(항목 번호는 0부터, 구분 줄은 None)
    pub lines: &'a [(String, Option<usize>)],
    /// 고른 항목 번호(0부터). 범위 밖이면 고른 항목 없음.
    pub cursor: usize,
    pub scroll: usize,
    pub note: Option<&'a str>,
    pub overlay: Option<OverlayView<'a>>,
}

pub enum OverlayView<'a> {
    /// `text`·`cursor_x` = `LineInput::view`가 돌려준 가로 창과 그 안의 커서 열.
    Input {
        label: &'a str,
        text: String,
        cursor_x: usize,
        hint: Option<String>,
        error: Option<&'a str>,
        share: Option<&'a str>,
    },
    Pick {
        title: &'a str,
        options: &'a [String],
        cursor: usize,
    },
    /// 값 목록에서 고른 뒤의 창(조건으로 추가 / 화면에 추가) — 머리 줄 + 두 줄, 아래 붙는 줄 방식.
    /// `head`는 `{대상}  =  {받은 값}`(원격 글자), 옵션의 둘째 값은 막힌 이유(있으면 ` — {이유}`, 흐리게).
    Choice {
        head: String,
        options: [(&'a str, Option<&'a str>); 2],
        cursor: usize,
    },
    Confirm(&'a str),
    Saving,
    /// 지금 점검 결과 대기(`점검 결과를 기다리는 중…`)
    Checking,
    Notice(&'a str),
}

pub(crate) fn col_w(c: char) -> usize {
    text_width(c.encode_utf8(&mut [0; 4]))
}

/// `t`의 `cursor_x`열이 `w`칸 창 안에 들어오게 앞을 잘라 낸 (창 글자, 창 안 커서 열).
pub(crate) fn window(t: &str, cursor_x: usize, w: usize) -> (String, usize) {
    if w == 0 {
        return (String::new(), 0);
    }
    let cursor_x = cursor_x.min(text_width(t));
    let off = if cursor_x >= w { cursor_x + 1 - w } else { 0 };
    let mut skipped = 0;
    let mut chars = t.chars().peekable();
    while skipped < off {
        match chars.next() {
            Some(c) => skipped += col_w(c),
            None => break,
        }
    }
    let (mut out, mut used) = (String::new(), 0);
    for c in chars {
        let cw = col_w(c);
        if used + cw > w {
            break;
        }
        out.push(c);
        used += cw;
    }
    (out, cursor_x.saturating_sub(skipped))
}

/// ` {라벨}  [입력 칸]  {힌트}` — 좁으면 힌트 → 라벨 순으로 줄이고 입력 칸은 커서가 보이게 가로로 민다.
fn input_line(
    label: &str,
    text_in: &str,
    cursor_x: usize,
    hint: Option<&str>,
    w: usize,
) -> Line<'static> {
    let mut label = sanitize(label);
    let mut hint = hint.map(sanitize).filter(|h| !h.is_empty());
    let fixed = |label: &str, hint: &Option<String>| {
        1 + text_width(label) + 2 + hint.as_ref().map_or(0, |h| text_width(h) + 2)
    };
    if w.saturating_sub(fixed(&label, &hint)) < MIN_TEXT {
        hint = None;
    }
    if w.saturating_sub(fixed(&label, &hint)) < MIN_TEXT {
        label = fit(&label, w.saturating_sub(1 + 2 + MIN_TEXT));
    }
    let tw = w.saturating_sub(fixed(&label, &hint));
    let base = Style::default().fg(color(C_TEXT));
    let field = base.bg(INPUT_BG);
    let cursor_style = Style::default().fg(color(C_BG)).bg(color(C_TEXT));
    let mut spans = vec![
        Span::raw(" "),
        Span::styled(label, base.add_modifier(Modifier::BOLD)),
        Span::raw("  "),
    ];
    if tw > 0 {
        let (shown, cx) = window(&sanitize(text_in), cursor_x, tw);
        let (mut pre, mut cur, mut post) = (String::new(), String::new(), String::new());
        let mut col = 0;
        for c in shown.chars() {
            if cur.is_empty() && col >= cx {
                cur.push(c);
            } else if cur.is_empty() {
                pre.push(c);
            } else {
                post.push(c);
            }
            col += col_w(c);
        }
        if cur.is_empty() {
            cur.push(' ');
        }
        let used = text_width(&pre) + text_width(&cur) + text_width(&post);
        spans.push(Span::styled(pre, field));
        spans.push(Span::styled(cur, cursor_style));
        spans.push(Span::styled(post, field));
        spans.push(Span::styled(" ".repeat(tw.saturating_sub(used)), field));
    }
    if let Some(h) = hint {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(h, Style::default().fg(color(C_MUTED))));
    }
    Line::from(spans)
}

/// 목록 창 한 줄 — 고른 줄은 `▶ ` + 흰 바탕.
fn pick_line(opt: &str, selected: bool, w: usize) -> Line<'static> {
    let mark = if selected { "▶ " } else { "  " };
    let s = fit(&format!("{mark}{}", sanitize(opt)), w);
    let pad = " ".repeat(w.saturating_sub(text_width(&s)));
    let style = if selected {
        Style::default().fg(color(C_BG)).bg(color(C_TEXT))
    } else {
        Style::default().fg(color(C_TEXT))
    };
    Line::from(Span::styled(format!("{s}{pad}"), style))
}

/// 고른 항목 아래(없으면 위, 그래도 없으면 body 전체)에 테두리 목록 창을 그린다. 그린 사각형을 돌려준다.
pub(crate) fn render_pick(
    f: &mut Frame,
    body: Rect,
    sel_rows: Option<(u16, u16)>,
    title: &str,
    options: &[String],
    cursor: usize,
) -> Rect {
    let w = usize::from(body.width);
    let opts: Vec<String> = options.iter().map(|o| sanitize(o)).collect();
    let title = sanitize(title);
    let x_off = if w > PICK_X + 6 { PICK_X } else { 0 };
    let content = opts.iter().map(|o| text_width(o)).max().unwrap_or(0) + 2;
    let box_w = (content + 2)
        .max(text_width(&title) + 4)
        .min(w.saturating_sub(x_off))
        .max(1);
    let need = u16::try_from(opts.len() + 2).unwrap_or(u16::MAX);
    let body_bottom = body.y.saturating_add(body.height);
    let mk = |y: u16, h: u16| Rect::new(body.x + x_off as u16, y, box_w as u16, h);
    let rect = match sel_rows {
        Some((_, last)) if body_bottom.saturating_sub(last.saturating_add(1)) >= need => {
            mk(last + 1, need)
        }
        Some((first, _)) if first.saturating_sub(body.y.saturating_add(1)) >= need => {
            mk(first - need, need)
        }
        _ => body,
    };
    f.render_widget(Clear, rect);
    let bordered = rect.width >= 4 && rect.height >= 3;
    let inner = if bordered {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(color(C_MUTED)))
            .title(Span::styled(
                format!(
                    " {} ",
                    fit(&title, usize::from(rect.width).saturating_sub(4))
                ),
                Style::default().fg(color(C_TEXT)),
            ));
        let inner = block.inner(rect);
        f.render_widget(block, rect);
        inner
    } else {
        rect
    };
    let rows = usize::from(inner.height);
    if rows > 0 && inner.width > 0 {
        let start = cursor
            .saturating_add(1)
            .saturating_sub(rows)
            .min(opts.len());
        for (i, o) in opts[start..].iter().take(rows).enumerate() {
            put(
                f,
                Rect::new(inner.x, inner.y + i as u16, inner.width, 1),
                pick_line(o, start + i == cursor, usize::from(inner.width)),
            );
        }
    }
    rect
}

/// 한 줄을 `w`칸으로 — 앞에 공백 1칸, 원격 문자열은 `sanitize`.
pub(crate) fn overlay_text(t: &str, style: Style, w: usize) -> Line<'static> {
    Line::from(Span::styled(
        format!(" {}", fit(&sanitize(t), w.saturating_sub(1))),
        style,
    ))
}

/// 키 줄 위 overlay 줄들(Input = 공유·입력·오류, 나머지 1줄, Pick은 없음). 모자라면 공유 → 오류 순으로 뺀다.
/// 편집 메뉴·하위 목록·변수 화면이 같이 쓴다.
pub(crate) fn overlay_rows(
    overlay: Option<&OverlayView>,
    w: usize,
    bh: usize,
) -> Vec<Line<'static>> {
    let muted = Style::default().fg(color(C_MUTED));
    let text_style = Style::default().fg(color(C_TEXT));
    let mut ov_rows: Vec<Line<'static>> = Vec::new();
    match overlay {
        Some(OverlayView::Input {
            label,
            text: t,
            cursor_x,
            hint,
            error,
            share,
        }) => {
            let cap = if bh >= 2 { bh - 1 } else { bh };
            let share_line = share.map(|s| overlay_text(s, Style::default().fg(color(C_SLOW)), w));
            let err_line = error.map(|e| overlay_text(e, Style::default().fg(color(C_FAIL)), w));
            let n = 1 + usize::from(share_line.is_some()) + usize::from(err_line.is_some());
            let (share_line, err_line) = match n {
                n if n <= cap => (share_line, err_line),
                n if n == cap + 1 && share_line.is_some() => (None, err_line),
                _ => (None, None),
            };
            ov_rows.extend(share_line);
            ov_rows.push(input_line(label, t, *cursor_x, hint.as_deref(), w));
            ov_rows.extend(err_line);
        }
        Some(OverlayView::Choice {
            head,
            options,
            cursor,
        }) => {
            let sel = Style::default().fg(color(C_BG)).bg(color(C_TEXT));
            let cursor = &(*cursor).min(1);
            let mut opt_rows: Vec<Line<'static>> = options
                .iter()
                .enumerate()
                .map(|(i, (name, why))| {
                    let selected = i == *cursor;
                    let mark = if selected { "▶ " } else { "  " };
                    let reason = why
                        .map(|r| format!(" — {}", sanitize(r)))
                        .unwrap_or_default();
                    let s = fit(&format!("{mark}{}{reason}", sanitize(name)), w);
                    if selected {
                        let pad = " ".repeat(w.saturating_sub(text_width(&s)));
                        // 막힌 줄 위의 커서 — 선택 바탕은 두고 흐림을 같이 준다.
                        let st = if why.is_some() {
                            sel.add_modifier(Modifier::DIM)
                        } else {
                            sel
                        };
                        Line::from(Span::styled(format!("{s}{pad}"), st))
                    } else if why.is_some() {
                        Line::from(Span::styled(s, muted))
                    } else {
                        Line::from(Span::styled(s, text_style))
                    }
                })
                .collect();
            // 높이가 모자라면 머리 줄 → 안 고른 줄 순으로 뺀다(고른 줄이 마지막까지 남는다).
            if bh >= 5 {
                // 머리는 줄바꿈 — 제목 줄 + 고른 목록 줄 + 두 선택 줄을 남긴다(본문 높이 5 이상일 때 최소 1줄, 4 이하면
                // 머리 없음 — 높이 4에서 머리를 넣으면 목록이 0줄이 된다). 넘치면 마지막 머리 줄 끝을 `…`로.
                let cap = bh - 4;
                // 머리는 최대 64KB 값일 수 있다 — 보일 줄 수를 넉넉히 덮는 만큼만 잘라 줄바꿈한다(매 프레임 전체를 훑지 않게).
                let budget = (cap + 1).saturating_mul(w.max(1)).saturating_mul(4);
                let mut it = head.chars();
                let short: String = it.by_ref().take(budget).collect();
                let truncated = it.next().is_some();
                let wrapped = wrap_width(&sanitize(&short), w.saturating_sub(2));
                let cut = truncated || wrapped.len() > cap;
                let n = wrapped.len().min(cap);
                for (i, l) in wrapped.into_iter().take(n).enumerate() {
                    let l = if cut && i + 1 == n {
                        fit(&format!("{l}…"), w.saturating_sub(2))
                    } else {
                        l
                    };
                    ov_rows.push(Line::from(Span::styled(
                        fit(&format!("  {l}"), w),
                        text_style,
                    )));
                }
                ov_rows.extend(opt_rows);
            } else if bh >= 2 {
                ov_rows.extend(opt_rows);
            } else {
                let i = (*cursor).min(opt_rows.len().saturating_sub(1));
                if i < opt_rows.len() {
                    ov_rows.push(opt_rows.swap_remove(i));
                }
            }
        }
        Some(OverlayView::Confirm(t)) => {
            ov_rows.push(overlay_text(t, text_style.add_modifier(Modifier::BOLD), w))
        }
        Some(OverlayView::Saving) => ov_rows.push(overlay_text(text::SAVING, muted, w)),
        Some(OverlayView::Checking) => ov_rows.push(overlay_text(text::CHECK_WAITING, muted, w)),
        Some(OverlayView::Notice(t)) => {
            ov_rows.push(overlay_text(t, Style::default().fg(color(C_SLOW)), w));
        }
        _ => {}
    }
    ov_rows
}

/// 편집 메뉴: body 1행 = `칸 설정 · {제목}` + 오른쪽 안내(폭이 모자라면 통째 생략), 그 아래 `lines[scroll..]`,
/// 맨 아래 = 각주(overlay가 있으면 생략) 또는 overlay. 고른 항목은 줄 전부 흰 바탕 + 첫 줄 `▶`.
/// 그린 줄 → 항목 번호 표 (화면 y, 항목 번호)를 돌려준다(목록 창이 덮은 줄은 뺀다).
pub fn render_edit_menu(
    f: &mut Frame,
    head: &HeaderView,
    v: &EditMenuView,
    keys: &[&str],
) -> Vec<(u16, usize)> {
    let body = render_frame(f, head, keys);
    let mut table = Vec::new();
    if body.height == 0 || body.width == 0 {
        return table;
    }
    let w = usize::from(body.width);
    let bh = usize::from(body.height);
    let row = |i: usize| Rect::new(body.x, body.y.saturating_add(i as u16), body.width, 1);
    let muted = Style::default().fg(color(C_MUTED));
    let text_style = Style::default().fg(color(C_TEXT));

    let ov_rows = overlay_rows(v.overlay.as_ref(), w, bh);
    let oh = ov_rows.len().min(bh);
    let has_pick = matches!(v.overlay, Some(OverlayView::Pick { .. }));
    let note = v.note.filter(|_| oh == 0 && note_shown(body.height, true));

    // 제목 줄(overlay가 body를 다 차지하면 생략).
    if bh > oh {
        let t = format!("{} · {}", text::SETTINGS_TITLE, sanitize(v.title));
        let bold = text_style.add_modifier(Modifier::BOLD);
        let (tw, rw) = (text_width(&t), text_width(text::SETTINGS_EDIT_NOTE));
        let title_line = if tw + 1 + rw <= w {
            Line::from(vec![
                Span::styled(t, bold),
                Span::raw(" ".repeat(w - tw - rw)),
                Span::styled(text::SETTINGS_EDIT_NOTE, muted),
            ])
        } else {
            Line::from(Span::styled(fit(&t, w), bold))
        };
        put(f, row(0), title_line);
    }

    // 목록.
    let list_h = bh
        .saturating_sub(1)
        .saturating_sub(oh)
        .saturating_sub(usize::from(note.is_some()));
    let start = v.scroll.min(v.lines.len());
    let first_of_cursor = v.lines.iter().position(|(_, n)| *n == Some(v.cursor));
    let sel_style = Style::default().fg(color(C_BG)).bg(color(C_TEXT));
    let mut sel_rows: Option<(u16, u16)> = None;
    for (i, (l, n)) in v.lines[start..].iter().take(list_h).enumerate() {
        let y = body.y.saturating_add(1 + i as u16);
        let area = row(1 + i);
        let selected = n.is_some() && *n == Some(v.cursor);
        if let Some(n) = n {
            table.push((y, *n));
        }
        if selected {
            sel_rows = Some(sel_rows.map_or((y, y), |(a, _)| (a, y)));
            let mut s = fit(l, w);
            if first_of_cursor == Some(start + i)
                && w >= 2
                && let Some(rest) = s.strip_prefix("  ")
            {
                s = format!("▶ {rest}");
            }
            let pad = " ".repeat(w.saturating_sub(text_width(&s)));
            put(
                f,
                area,
                Line::from(Span::styled(format!("{s}{pad}"), sel_style)),
            );
        } else {
            let style = if n.is_some() { text_style } else { muted };
            put(f, area, Line::from(Span::styled(fit(l, w), style)));
        }
    }
    if let Some(n) = note {
        put(
            f,
            row(bh - 1),
            Line::from(Span::styled(fit(&sanitize(n), w), muted)),
        );
    }

    // overlay.
    for (i, l) in ov_rows.into_iter().take(oh).enumerate() {
        put(f, row(bh - oh + i), l);
    }
    if has_pick
        && let Some(OverlayView::Pick {
            title,
            options,
            cursor,
        }) = &v.overlay
    {
        let r = render_pick(f, body, sel_rows, title, options, *cursor);
        table.retain(|(y, _)| *y < r.y || *y >= r.y.saturating_add(r.height));
    }
    table
}
