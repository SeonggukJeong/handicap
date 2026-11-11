//! 하위 목록(기준선·성공 조건·화면에 표시)·조건 수정 칸·환경/시나리오 변수 화면 그리기(목업 §4·§5).
//! 뷰 모델만 받아 그린다. 입력줄·확인·저장 중·목록 창은 `settings`의 overlay 그리기를 그대로 쓴다.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Clear;

use super::inspect::{render_frame, sub_layout};
use super::model::parse_hex;
use super::monitor::{C_BG, C_FAIL, C_MUTED, C_TEXT, HeaderView};
use super::settings::{OverlayView, col_w, color, overlay_rows, put, render_pick, window};
use super::{fit, text_width};
use crate::app::CondFocus;
use crate::inspect::sanitize;
use crate::text;

/// 가린 환경 값 표시.
const MASK: &str = "••••••••";

/// 환경 값 표시: `reveal`이 아니면 값과 상관없이 항상 가림 문자(빈 값·긴 값도 같게 — 길이가 새지 않는다).
pub fn env_display(value: &str, reveal: bool) -> String {
    if reveal {
        value.to_string()
    } else {
        MASK.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Thresholds,
    Conditions,
    Display,
}

/// 하위 목록 키 줄 조각 — `rows`는 실제 항목 수(안내 줄 제외).
pub fn list_keys(kind: ListKind, rows: usize) -> Vec<&'static str> {
    let mut k = vec![text::KEYS_PICK];
    if rows > 0 && kind != ListKind::Display {
        k.push(text::KEYS_EDIT);
    }
    if kind == ListKind::Thresholds {
        k.push(text::KEYS_ADD);
    }
    if kind == ListKind::Display && rows >= 2 {
        k.push(text::KEYS_SWAP);
    }
    if rows > 0 {
        k.push(text::KEYS_DELETE);
    }
    k.push(text::KEYS_BACK);
    k
}

/// 변수 화면 키 줄 조각 — 환경만 `v`(드러낸 상태면 `v 가리기`).
pub fn vars_keys(env: bool, reveal: bool) -> Vec<&'static str> {
    let mut k = vec![text::KEYS_PICK, text::KEYS_EDIT];
    if env {
        k.push(if reveal {
            text::KEYS_HIDE
        } else {
            text::KEYS_SHOW_VALUE
        });
    }
    k.push(text::KEYS_BACK);
    k
}

/// 조건 수정 칸 키 줄 조각(spec §6.7 — 삭제는 목록 화면의 `d`, 이 칸에는 없다).
pub fn cond_form_keys() -> Vec<&'static str> {
    vec![
        text::KEYS_NEXT_FIELD,
        text::KEYS_TOGGLE,
        text::KEYS_SAVE,
        text::KEYS_CANCEL,
    ]
}

/// 편집 화면 키 줄을 폭에 맞춘다 — **표시 순서는 그대로**, 빠지는 순서만 따로: `Enter 저장`·`Esc 취소`가 아닌 조각을
/// 앞에서부터, 그다음 `Esc 취소`, `Enter 저장`은 마지막까지(crates/tui/CLAUDE.md "덜 중요한 것부터" — `key_bar`는
/// 앞 조각부터 빼므로 저장 키가 앞에 있는 줄에서 먼저 사라졌다). 저장·취소가 없는 줄은 `key_bar`와 같은 결과.
/// 한 조각만 남아도 넘치면 그대로 두고 `key_bar`가 말줄임한다.
pub fn fit_keys(keys: &[&'static str], width: u16) -> Vec<&'static str> {
    let avail = usize::from(width).saturating_sub(1);
    let mut k: Vec<&'static str> = keys.to_vec();
    while k.len() > 1 && text_width(&k.join("  ")) > avail {
        let rank = |s: &str| match s {
            s if s == text::KEYS_SAVE => 2,
            s if s == text::KEYS_CANCEL => 1,
            _ => 0,
        };
        let low = k.iter().map(|s| rank(s)).min().unwrap_or(0);
        if let Some(i) = k.iter().position(|s| rank(s) == low) {
            k.remove(i);
        }
    }
    k
}

fn digits(mut n: usize) -> usize {
    let mut d = 1;
    while n >= 10 {
        n /= 10;
        d += 1;
    }
    d
}

fn pad_to(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(text_width(s))))
}

/// 제목 줄(굵게) + 오른쪽 보조 문구(폭이 모자라면 통째 생략).
fn title_line(title: &str, right: Option<&str>, w: usize) -> Line<'static> {
    let bold = Style::default()
        .fg(color(C_TEXT))
        .add_modifier(Modifier::BOLD);
    let muted = Style::default().fg(color(C_MUTED));
    let t = format!(" {}", sanitize(title));
    if let Some(r) = right {
        let r = sanitize(r);
        let (tw, rw) = (text_width(&t), text_width(&r));
        if !r.is_empty() && tw + 2 + rw < w {
            return Line::from(vec![
                Span::styled(t, bold),
                Span::raw(" ".repeat(w - tw - rw - 1)),
                Span::styled(r, muted),
                Span::raw(" "),
            ]);
        }
    }
    Line::from(Span::styled(fit(&t, w), bold))
}

/// 고른 줄 스타일(흰 바탕).
fn sel_style() -> Style {
    Style::default().fg(color(C_BG)).bg(color(C_TEXT))
}

/// body 높이에서 overlay 줄·제목·빈 줄을 뺀 목록 줄 수와 목록 첫 줄 오프셋.
fn list_geometry(bh: usize, oh: usize) -> (usize, usize) {
    let blank = usize::from(bh.saturating_sub(oh) >= 5);
    let top = 1 + blank;
    (top, bh.saturating_sub(oh).saturating_sub(top))
}

/// 커서가 늘 보이게 하는 첫 줄.
fn first_visible(cursor: usize, len: usize, h: usize) -> usize {
    let c = cursor.min(len.saturating_sub(1));
    c.saturating_add(1).saturating_sub(h).min(len)
}

pub struct ListView<'a> {
    /// 예: `응답속도 기준선 · 주문 조회` (원격 문자열 포함 가능 — 그릴 때 `sanitize`)
    pub title: &'a str,
    /// 줄이 없으면 `없음`. 안내 문구(`EDIT_NO_*`)는 호출자가 `dim` 줄 하나로 넘긴다 — `dim` 줄은 번호·`▶` 없이 흐리게.
    pub rows: Vec<ListRow>,
    pub cursor: usize,
    pub overlay: Option<OverlayView<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListRow {
    pub text: String,
    /// 기준선 `#rrggbb` — 있으면 글자 앞 `■`을 그 색으로(잘못된 문자열은 기본색).
    pub color: Option<String>,
    pub dim: bool,
}

fn list_row_line(r: &ListRow, no: usize, numw: usize, selected: bool, w: usize) -> Line<'static> {
    let base = if selected {
        sel_style()
    } else if r.dim {
        Style::default().fg(color(C_MUTED))
    } else {
        Style::default().fg(color(C_TEXT))
    };
    let text = sanitize(&r.text);
    let mark = if selected { "▶ " } else { "  " };
    let prefix = if r.dim {
        mark.to_string()
    } else {
        format!("{mark}{}  ", pad_to(&no.to_string(), numw))
    };
    let square = if r.color.is_some() { "■ " } else { "" };
    let fixed = text_width(&prefix) + text_width(square);
    if fixed >= w {
        // 좁다 — 통째로 줄인다.
        let s = fit(&format!("{prefix}{square}{text}"), w);
        let pad = " ".repeat(if selected {
            w.saturating_sub(text_width(&s))
        } else {
            0
        });
        return Line::from(Span::styled(format!("{s}{pad}"), base));
    }
    let body = fit(&text, w - fixed);
    let used = fixed + text_width(&body);
    let mut spans = vec![Span::styled(prefix, base)];
    if let Some(c) = &r.color {
        let fg = parse_hex(c).unwrap_or(Color::Reset);
        spans.push(Span::styled(square, base.fg(fg)));
    }
    spans.push(Span::styled(body, base));
    if selected {
        spans.push(Span::styled(" ".repeat(w.saturating_sub(used)), base));
    }
    Line::from(spans)
}

/// 하위 목록 화면: body 1행 = 제목, (높이가 되면 빈 줄), 목록, 맨 아래 overlay.
pub fn render_list(f: &mut Frame, head: &HeaderView, v: &ListView, keys: &[&str]) {
    render_list_reserving(f, head, v, keys, 0);
}

/// 조건 수정 칸의 왼쪽 들여쓰기(좁으면 0).
pub(crate) fn form_x_off(body_w: u16) -> u16 {
    if body_w > 12 { 2 } else { 0 }
}

/// 조건 수정 칸 값 칸의 폭(가로 창 계산용) — `body_w` = 화면 body 폭.
pub fn cond_form_value_width(body_w: u16) -> usize {
    usize::from(body_w).saturating_sub(usize::from(form_x_off(body_w)) + 1 + FORM_LABEL_W)
}

/// 오류까지 센 필수 줄 수(대상·규칙 + 값·체크·오류 중 있는 것) — 받은 값·안내 줄은 뺀 것.
fn cond_form_base(v: &CondFormView) -> u16 {
    2 + u16::from(v.value.is_some()) + u16::from(v.flags.is_some()) + u16::from(v.error.is_some())
}

/// 조건 수정 칸 줄 수(필수 줄 + 받은 값·안내 줄 중 있는 것).
pub(crate) fn cond_form_lines(v: &CondFormView) -> u16 {
    cond_form_base(v) + u16::from(v.received.is_some()) + u16::from(v.hint.is_some())
}

/// `h`줄에서 받은 값·안내 줄이 그려지는가 — 모자라면 안내 → 받은 값 순으로 뺀다(필수 줄이 먼저).
fn extras_shown(v: &CondFormView, h: usize) -> (bool, bool) {
    let base = usize::from(cond_form_base(v));
    let received = v.received.is_some() && base < h;
    let hint = v.hint.is_some() && base + usize::from(received) < h;
    (received, hint)
}

/// body 맨 아래 `h`줄 자리에 조건 칸을 지우고 그린다(목록 화면들이 같이 쓴다).
pub(crate) fn render_form_at_bottom(f: &mut Frame, body: Rect, h: u16, fv: &CondFormView) {
    if body.height == 0 || body.width == 0 || h == 0 {
        return;
    }
    let x_off = form_x_off(body.width);
    let area = Rect::new(
        body.x.saturating_add(x_off),
        body.y.saturating_add(body.height.saturating_sub(h)),
        body.width.saturating_sub(x_off),
        h,
    );
    f.render_widget(Clear, area);
    render_cond_form(f, area, fv);
}

/// 하위 목록 + (열려 있으면) 조건 수정 칸. 폼이 있으면 목록은 폼 높이만큼 줄어든 영역에 그려
/// 고른 줄이 폼에 가리지 않는다(커서 줄이 늘 보이게 창을 민다). 폼은 body 맨 아래.
pub fn render_list_with_form(
    f: &mut Frame,
    head: &HeaderView,
    v: &ListView,
    keys: &[&str],
    form: Option<&CondFormView>,
) {
    let Some(fv) = form else {
        render_list(f, head, v, keys);
        return;
    };
    let body = sub_layout(f.area()).body;
    let h = cond_form_lines(fv).min(body.height);
    let body = render_list_reserving(f, head, v, keys, usize::from(h));
    render_form_at_bottom(f, body, h, fv);
}

/// `reserve` = body 맨 아래에 비워 둘 줄 수(조건 수정 칸 자리). 그린 body를 돌려준다.
fn render_list_reserving(
    f: &mut Frame,
    head: &HeaderView,
    v: &ListView,
    keys: &[&str],
    reserve: usize,
) -> Rect {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return body;
    }
    let w = usize::from(body.width);
    let bh = usize::from(body.height);
    let row = |i: usize| Rect::new(body.x, body.y.saturating_add(i as u16), body.width, 1);
    let ov_rows = overlay_rows(v.overlay.as_ref(), w, bh);
    let oh = ov_rows.len().max(reserve).min(bh);
    if bh > oh {
        put(f, row(0), title_line(v.title, None, w));
    }
    let (top, list_h) = list_geometry(bh, oh);
    let mut sel_rows = None;
    if v.rows.is_empty() {
        if list_h > 0 {
            let line = Line::from(Span::styled(
                fit(&format!("  {}", text::NONE), w),
                Style::default().fg(color(C_MUTED)),
            ));
            put(f, row(top), line);
        }
    } else {
        let start = first_visible(v.cursor, v.rows.len(), list_h);
        let numw = digits(v.rows.len());
        for (i, r) in v.rows[start..].iter().take(list_h).enumerate() {
            let idx = start + i;
            let selected = idx == v.cursor && !r.dim;
            let y = row(top + i).y;
            if selected {
                sel_rows = Some((y, y));
            }
            put(
                f,
                row(top + i),
                list_row_line(r, idx + 1, numw, selected, w),
            );
        }
    }
    let n_ov = ov_rows.len().min(oh);
    for (i, l) in ov_rows.into_iter().take(n_ov).enumerate() {
        put(f, row(bh - n_ov + i), l);
    }
    if let Some(OverlayView::Pick {
        title,
        options,
        cursor,
    }) = &v.overlay
    {
        render_pick(f, body, sel_rows, title, options, *cursor);
    }
    body
}

// ---------- 조건 수정 칸 ----------

pub struct CondFormView<'a> {
    /// 읽기 전용 대상(`상태코드`·`헤더 X` …)
    pub target: &'a str,
    /// 이 대상이 허용하는 규칙 라벨들(`text::cond_op_label`)
    pub ops: &'a [&'static str],
    pub op: usize,
    /// 값 칸(없으면 규칙이 값을 안 쓴다). `LineInput::view`의 (가로 창 글자, 창 안 커서 열)
    pub value: Option<(String, usize)>,
    /// (대소문자 무시, 앞뒤 공백 무시) — 없으면 체크 칸 없음
    pub flags: Option<(bool, bool)>,
    pub focus: CondFocus,
    pub error: Option<&'a str>,
    /// 값 목록에서 고른 받은 값(대상 줄 아래 `받은 값` 줄, 원격 글자 — 그릴 때 `sanitize`). 없으면 줄 없음.
    pub received: Option<&'a str>,
    /// 맨 아래 안내 줄(흐리게). 없으면 줄 없음.
    pub hint: Option<&'a str>,
}

/// 라벨 칸 폭(표시 폭).
const FORM_LABEL_W: usize = 8;

fn field_spans(t: &str, cursor_x: usize, fw: usize, focused: bool) -> Vec<Span<'static>> {
    let field = Style::default().fg(color(C_TEXT)).bg(INPUT_BG);
    if fw == 0 {
        return vec![];
    }
    let (shown, cx) = window(&sanitize(t), cursor_x, fw);
    let (mut pre, mut cur, mut post) = (String::new(), String::new(), String::new());
    let mut col = 0;
    for c in shown.chars() {
        if focused && cur.is_empty() && col >= cx {
            cur.push(c);
        } else if cur.is_empty() && focused {
            pre.push(c);
        } else if focused {
            post.push(c);
        } else {
            pre.push(c);
        }
        col += col_w(c);
    }
    if focused && cur.is_empty() {
        cur.push(' ');
    }
    let used = text_width(&pre) + text_width(&cur) + text_width(&post);
    vec![
        Span::styled(pre, field),
        Span::styled(cur, field.add_modifier(Modifier::REVERSED)),
        Span::styled(post, field),
        Span::styled(" ".repeat(fw.saturating_sub(used)), field),
    ]
}

/// 입력 칸 바탕(`settings`와 같은 값).
const INPUT_BG: Color = Color::Rgb(0x26, 0x31, 0x3d);

fn form_label(label: &str, w: usize) -> Span<'static> {
    Span::styled(
        fit(&format!(" {}", pad_to(label, FORM_LABEL_W)), w),
        Style::default().fg(color(C_TEXT)),
    )
}

/// 조건 수정 칸(목업 §4 오른쪽): `area`의 줄 위에서부터 대상 · 규칙 · 값 · 체크 · 오류. 모자란 줄은 아래부터 생략.
pub fn render_cond_form(f: &mut Frame, area: Rect, v: &CondFormView) {
    let w = usize::from(area.width);
    if w == 0 {
        return;
    }
    let mut lines: Vec<Line<'static>> = Vec::new();
    let text_style = Style::default().fg(color(C_TEXT));
    let fw = w.saturating_sub(1 + FORM_LABEL_W);
    let label_w = w.min(1 + FORM_LABEL_W);

    lines.push(Line::from(vec![
        form_label(text::COND_FORM_TARGET, label_w),
        Span::styled(fit(&sanitize(v.target), fw), text_style),
    ]));

    let (show_received, show_hint) = extras_shown(v, usize::from(area.height));
    if let (true, Some(r)) = (show_received, v.received) {
        lines.push(Line::from(vec![
            form_label(text::PICK_COL_VALUE, label_w),
            Span::styled(fit(&sanitize(r), fw), text_style),
        ]));
    }

    let op_label = v
        .ops
        .get(v.op.min(v.ops.len().saturating_sub(1)))
        .copied()
        .unwrap_or("");
    let mut op_style = text_style.bg(INPUT_BG);
    if v.focus == CondFocus::Op {
        op_style = op_style.add_modifier(Modifier::REVERSED);
    }
    lines.push(Line::from(vec![
        form_label(text::COND_FORM_OP, label_w),
        Span::styled(fit(&format!("‹ {} ›", sanitize(op_label)), fw), op_style),
    ]));

    if let Some((t, cx)) = &v.value {
        let mut spans = vec![form_label(text::COND_FORM_VALUE, label_w)];
        spans.extend(field_spans(t, *cx, fw, v.focus == CondFocus::Value));
        lines.push(Line::from(spans));
    }

    if let Some((ic, tr)) = v.flags {
        let mark = |on: bool| if on { "[x]" } else { "[ ]" };
        let piece = |on: bool, label: &str, focused: bool| {
            let st = if focused {
                text_style.add_modifier(Modifier::REVERSED)
            } else {
                text_style
            };
            (format!("{} {}", mark(on), label), st)
        };
        let p0 = piece(ic, text::COND_IGNORE_CASE, v.focus == CondFocus::IgnoreCase);
        let p1 = piece(tr, text::COND_TRIM, v.focus == CondFocus::Trim);
        let full = 1 + text_width(&p0.0) + 3 + text_width(&p1.0);
        let line = if full <= w {
            Line::from(vec![
                Span::raw(" "),
                Span::styled(p0.0, p0.1),
                Span::raw("   "),
                Span::styled(p1.0, p1.1),
            ])
        } else {
            let p = if v.focus == CondFocus::Trim { p1 } else { p0 };
            Line::from(vec![
                Span::raw(" "),
                Span::styled(fit(&p.0, w.saturating_sub(1)), p.1),
            ])
        };
        lines.push(line);
    }

    if let Some(e) = v.error {
        lines.push(Line::from(Span::styled(
            format!(" {}", fit(&sanitize(e), w.saturating_sub(1))),
            Style::default().fg(color(C_FAIL)),
        )));
    }

    if let (true, Some(h)) = (show_hint, v.hint) {
        lines.push(Line::from(Span::styled(
            format!(" {}", fit(&sanitize(h), w.saturating_sub(1))),
            Style::default().fg(color(C_MUTED)),
        )));
    }

    for (i, l) in lines.into_iter().take(usize::from(area.height)).enumerate() {
        put(
            f,
            Rect::new(area.x, area.y.saturating_add(i as u16), area.width, 1),
            l,
        );
    }
}

// ---------- 환경/시나리오 변수 ----------

pub struct VarsView<'a> {
    /// `환경 변수 · 운영`
    pub title: String,
    /// 오른쪽 안내(`text::usage_note` / `usage_note_scenario`)
    pub usage: String,
    pub rows: Vec<VarRow>,
    pub cursor: usize,
    pub loading: bool,
    pub failed: Option<&'a str>,
    pub overlay: Option<OverlayView<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VarRow {
    pub key: String,
    /// 이미 가림 처리된 표시값(`env_display`) — 렌더러는 원문을 받지 않는다.
    pub value: String,
    /// 생성 변수·못 고치는 모양 사유(있으면 줄을 흐리게)
    pub note: Option<&'static str>,
}

fn var_row_line(r: &VarRow, keycol: usize, selected: bool, w: usize) -> Line<'static> {
    let base = if selected {
        sel_style()
    } else if r.note.is_some() {
        Style::default().fg(color(C_MUTED))
    } else {
        Style::default().fg(color(C_TEXT))
    };
    let mark = if selected { "▶ " } else { "  " };
    let key = sanitize(&r.key);
    let value = sanitize(&r.value);
    let rest = match (value.is_empty(), r.note) {
        (_, None) => value,
        (true, Some(n)) => n.to_string(),
        (false, Some(n)) => format!("{value}  {n}"),
    };
    let fixed = 2 + keycol + 2;
    let s = if fixed >= w {
        fit(&format!("{mark}{key}"), w)
    } else {
        let k = pad_to(&fit(&key, keycol), keycol);
        format!("{mark}{k}  {}", fit(&rest, w - fixed))
    };
    let pad = " ".repeat(if selected {
        w.saturating_sub(text_width(&s))
    } else {
        0
    });
    Line::from(Span::styled(format!("{s}{pad}"), base))
}

/// 변수 화면: 제목 + 오른쪽 사용 안내, 키·값(·사유) 줄, 맨 아래 overlay. 불러오는 중·실패는 목록 자리에.
pub fn render_vars(f: &mut Frame, head: &HeaderView, v: &VarsView, keys: &[&str]) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let bh = usize::from(body.height);
    let row = |i: usize| Rect::new(body.x, body.y.saturating_add(i as u16), body.width, 1);
    let ov_rows = overlay_rows(v.overlay.as_ref(), w, bh);
    let oh = ov_rows.len().min(bh);
    if bh > oh {
        put(f, row(0), title_line(&v.title, Some(&v.usage), w));
    }
    let (top, list_h) = list_geometry(bh, oh);
    let mut sel_rows = None;
    if list_h > 0 {
        if v.loading {
            put(
                f,
                row(top),
                Line::from(Span::styled(
                    fit(&format!("  {}", text::LOADING), w),
                    Style::default().fg(color(C_MUTED)),
                )),
            );
        } else if let Some(m) = v.failed {
            put(
                f,
                row(top),
                Line::from(Span::styled(
                    fit(&format!("  {}", sanitize(m)), w),
                    Style::default().fg(color(C_FAIL)),
                )),
            );
        } else if v.rows.is_empty() {
            put(
                f,
                row(top),
                Line::from(Span::styled(
                    fit(&format!("  {}", text::NONE), w),
                    Style::default().fg(color(C_MUTED)),
                )),
            );
        } else {
            let widest = v
                .rows
                .iter()
                .map(|r| text_width(&sanitize(&r.key)))
                .max()
                .unwrap_or(0);
            let keycol = widest.min(w.saturating_sub(4) / 2);
            let start = first_visible(v.cursor, v.rows.len(), list_h);
            for (i, r) in v.rows[start..].iter().take(list_h).enumerate() {
                let selected = start + i == v.cursor;
                let y = row(top + i).y;
                if selected {
                    sel_rows = Some((y, y));
                }
                put(f, row(top + i), var_row_line(r, keycol, selected, w));
            }
        }
    }
    for (i, l) in ov_rows.into_iter().take(oh).enumerate() {
        put(f, row(bh - oh + i), l);
    }
    if let Some(OverlayView::Pick {
        title,
        options,
        cursor,
    }) = &v.overlay
    {
        render_pick(f, body, sel_rows, title, options, *cursor);
    }
}
