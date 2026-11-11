//! 새 화면(오류 보기·칸 설정)이 같이 쓰는 틀(머리 줄·무입력 안내 줄·키 줄)과 오류 목록 그리기.
//! 배치 기준은 목업 `docs/superpowers/specs/2026-11-10-tui-1b-mockups/01-screens.html` §1·§2·§3.

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
use crate::inspect::{
    BodyLine, BodyLineKind, ErrorRow, ErrorsView, Note, Reason, RecordBody, RecordView, StepLine,
    sanitize, window_start,
};
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
        Span::raw(" ".repeat(w.saturating_sub(tw + cw))),
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

// ---------- 기록 상세 (목업 §2) ----------

/// 스텝 이름 칸 최대 폭.
const NAME_MAX: usize = 20;
/// 이보다 좁으면 URL을 줄이지 않고 `METHOD URL` 칸을 통째로 뺀다.
const URL_MIN: usize = 8;
/// 스텝 열 사이 공백.
const SGAP: &str = "  ";
/// `▶ ` + 순번 2칸 + 2칸 — 스텝 이름 칸 시작(조건 분기·오류 줄 들여쓰기).
const NAME_X: usize = MARK_W + 2 + 2;

fn muted() -> Style {
    Style::default().fg(color(C_MUTED))
}

fn fail_style() -> Style {
    Style::default().fg(color(C_FAIL))
}

/// 스텝 표 열 폭. `req == 0`이면 `METHOD URL` 칸 생략.
#[derive(Debug, Clone, Copy)]
struct StepCols {
    name: usize,
    method: usize,
    req: usize,
    status: usize,
    lat: usize,
    /// `focus` 줄이 있으면 `   ◀ 이 칸` 폭
    focus: usize,
}

fn http_name(name: &str, loop_index: Option<u32>) -> String {
    let n = sanitize(name);
    match loop_index {
        Some(i) => format!("{n} #{i}"),
        None => n,
    }
}

/// 반복 회차 ` #n`은 반복끼리 구분하는 유일한 표시라 이름만 줄이고 회차는 지킨다
/// (회차조차 안 들어가는 폭이면 통째로 `fit`).
fn fit_name(name: &str, loop_index: Option<u32>, width: usize) -> String {
    let n = sanitize(name);
    match loop_index {
        Some(i) => {
            let suffix = format!(" #{i}");
            let sw = text_width(&suffix);
            if width > sw {
                format!("{}{suffix}", fit(&n, width - sw))
            } else {
                fit(&format!("{n}{suffix}"), width)
            }
        }
        None => fit(&n, width),
    }
}

fn status_text(status: Option<u16>) -> String {
    status.map_or_else(|| text::NO_VALUE.to_string(), |s| s.to_string())
}

fn lat_text(latency_ms: Option<u64>, timed_out: bool) -> String {
    if timed_out {
        return text::TIMED_OUT.to_string();
    }
    latency_ms.map_or_else(|| text::NO_VALUE.to_string(), |ms| format_ms(ms as f64))
}

fn focus_suffix() -> String {
    format!("   {}", text::THIS_PANEL)
}

fn step_cols(lines: &[StepLine], w: usize) -> StepCols {
    let (_, h_name, h_req, h_status, h_lat) = text::RECORD_COLS;
    let mut c = StepCols {
        name: text_width(h_name),
        method: 0,
        req: 0,
        status: text_width(h_status),
        lat: text_width(h_lat),
        focus: 0,
    };
    let mut url_w = 0;
    for l in lines {
        let StepLine::Http {
            loop_index,
            name,
            method,
            url,
            status,
            latency_ms,
            timed_out,
            focus,
            ..
        } = l
        else {
            continue;
        };
        c.name = c.name.max(text_width(&http_name(name, *loop_index)));
        if let Some(m) = method {
            c.method = c.method.max(text_width(&sanitize(m)));
        }
        if let Some(u) = url {
            url_w = url_w.max(text_width(&sanitize(u)));
        }
        c.status = c.status.max(text_width(&status_text(*status)));
        c.lat = c.lat.max(text_width(&lat_text(*latency_ms, *timed_out)));
        if *focus {
            c.focus = text_width(&focus_suffix());
        }
    }
    c.name = c.name.min(NAME_MAX);
    let natural = (c.method + 1 + url_w).max(text_width(h_req));
    // 요청 칸 없이: 이름 시작 + 이름 + 2 + 응답 + 2 + 지연 + 이 칸.
    let without = NAME_X + c.name + 2 + c.status + 2 + c.lat + c.focus;
    let room = w.saturating_sub(without + 2);
    if room >= c.method + 1 + URL_MIN {
        c.req = natural.min(room);
    } else {
        // 요청 칸을 통째로 빼고, 그래도 넘치면 이름을 줄인다.
        let others = NAME_X + 2 + c.status + 2 + c.lat + c.focus;
        c.name = c.name.min(w.saturating_sub(others));
    }
    c
}

/// 스텝 표 머리(C_MUTED).
fn step_head_line(c: &StepCols, w: usize) -> Line<'static> {
    let (no, name, req, status, lat) = text::RECORD_COLS;
    let mut out = format!(
        "{}{:>2}{SGAP}{}",
        " ".repeat(MARK_W),
        no,
        pad_to(name, c.name)
    );
    if c.req > 0 {
        out.push_str(SGAP);
        out.push_str(&pad_to(req, c.req));
    }
    out.push_str(SGAP);
    out.push_str(&pad_to(status, c.status));
    out.push_str(SGAP);
    out.push_str(lat);
    Line::from(Span::styled(fit(&out, w), muted()))
}

/// 스팬들을 폭 `w`에서 자른다(마지막으로 걸치는 스팬은 `fit`).
fn clip_spans(spans: Vec<Span<'static>>, w: usize) -> Line<'static> {
    let mut used = 0usize;
    let mut out = Vec::with_capacity(spans.len());
    for sp in spans {
        let sw = text_width(&sp.content);
        if used + sw <= w {
            used += sw;
            out.push(sp);
        } else {
            let rest = w.saturating_sub(used);
            if rest > 0 {
                out.push(Span::styled(fit(&sp.content, rest), sp.style));
            }
            break;
        }
    }
    Line::from(out)
}

fn http_row(l: &StepLine, cursor: bool, c: &StepCols, w: usize) -> Line<'static> {
    let StepLine::Http {
        no,
        loop_index,
        name,
        method,
        url,
        status,
        latency_ms,
        timed_out,
        focus,
        ..
    } = l
    else {
        return Line::default();
    };
    let bold = |s: Style| {
        if cursor {
            s.add_modifier(Modifier::BOLD)
        } else {
            s
        }
    };
    let base = bold(Style::default().fg(color(C_TEXT)));
    let mut spans = vec![Span::styled(
        format!(
            "{}{:>2}{SGAP}{}",
            if cursor { "▶ " } else { "  " },
            no,
            pad_to(&fit_name(name, *loop_index, c.name), c.name)
        ),
        base,
    )];
    if c.req > 0 {
        let req = match method {
            Some(m) => {
                let url_room = c.req.saturating_sub(c.method + 1);
                let u = url.as_deref().map(sanitize).unwrap_or_default();
                format!("{} {}", pad_to(&sanitize(m), c.method), fit(&u, url_room))
            }
            None => String::new(),
        };
        spans.push(Span::styled(format!("{SGAP}{}", pad_to(&req, c.req)), base));
    }
    // 응답 없음(`—`)만 실패색 — 4xx/5xx 코드는 칸 조건이 판정하므로(조건 `status = 404`인
    // 칸에선 404가 정상) 코드 자체에 색을 입히지 않는다(목업 §2·GUI `StepRow`와 같다).
    let st_style = if status.is_none() {
        bold(fail_style())
    } else {
        base
    };
    spans.push(Span::raw(SGAP));
    spans.push(Span::styled(
        pad_to(&status_text(*status), c.status),
        st_style,
    ));
    spans.push(Span::raw(SGAP));
    let lat = lat_text(*latency_ms, *timed_out);
    let lat_style = if *timed_out { bold(fail_style()) } else { base };
    if *focus {
        spans.push(Span::styled(pad_to(&lat, c.lat), lat_style));
    } else {
        spans.push(Span::styled(lat, lat_style));
    }
    let suffix = focus_suffix();
    let used: usize = spans.iter().map(|s| text_width(&s.content)).sum();
    // `◀ 이 칸`은 통째로 — 들어가지 않으면 빼고 자른다.
    if *focus && used + text_width(&suffix) <= w {
        spans.push(Span::styled(
            suffix,
            bold(Style::default().fg(color(C_SLOW))),
        ));
    }
    clip_spans(spans, w)
}

/// 스텝 표의 화면 줄 하나 — (스텝 줄 번호, 오류 줄인가).
type VisRow = (usize, bool);

fn vis_rows(lines: &[StepLine]) -> Vec<VisRow> {
    let mut out = Vec::with_capacity(lines.len());
    for (i, l) in lines.iter().enumerate() {
        out.push((i, false));
        if let StepLine::Http { error: Some(_), .. } = l {
            out.push((i, true));
        }
    }
    out
}

fn vis_line(lines: &[StepLine], r: VisRow, cursor: usize, c: &StepCols, w: usize) -> Line<'static> {
    let (i, is_err) = r;
    let indent = " ".repeat(NAME_X);
    match (&lines[i], is_err) {
        (StepLine::If { branch }, _) => Line::from(Span::styled(
            fit(
                &format!("{indent}{}", text::record_if_row(&sanitize(branch))),
                w,
            ),
            muted(),
        )),
        (StepLine::Http { error, .. }, true) => Line::from(Span::styled(
            fit(
                &format!("{indent}{}", sanitize(error.as_deref().unwrap_or_default())),
                w,
            ),
            fail_style(),
        )),
        (l, false) => http_row(l, i == cursor, c, w),
    }
}

/// 사유·판정 상세·시나리오 칸 이름 폭(+2칸).
fn label_w() -> usize {
    [text::REASON_LABEL, text::JUDGE_DETAIL, text::SET_SCENARIO]
        .iter()
        .map(|s| text_width(s))
        .max()
        .unwrap_or(0)
        + 2
}

fn labeled(label: &str, value: &str, w: usize) -> Line<'static> {
    let lw = label_w();
    clip_spans(
        vec![
            Span::styled(pad_to(label, lw), muted()),
            Span::styled(value.to_string(), Style::default().fg(color(C_TEXT))),
        ],
        w,
    )
}

fn scenario_line(v: &RecordView, w: usize) -> Line<'static> {
    let mut l = labeled(text::SET_SCENARIO, &sanitize(&v.scenario), usize::MAX);
    if let Some(env) = &v.environment {
        l.spans
            .push(Span::styled(format!("   {} ", text::SET_ENV), muted()));
        l.spans.push(Span::styled(
            sanitize(env),
            Style::default().fg(color(C_TEXT)),
        ));
    }
    clip_spans(l.spans, w)
}

fn note_line(n: &Note, w: usize) -> Line<'static> {
    let (s, style) = match n {
        Note::NoTraceConfig => (text::RECORD_NO_TRACE_CONFIG.to_string(), muted()),
        Note::NoTraceTimeout => (text::RECORD_NO_TRACE_TIMEOUT.to_string(), muted()),
        Note::TraceError(e) => (text::record_trace_error(&sanitize(e)), fail_style()),
        Note::TraceCut => (
            text::RECORD_TRACE_CUT.to_string(),
            Style::default().fg(color(C_SLOW)),
        ),
    };
    Line::from(Span::styled(fit(&s, w), style))
}

/// 기록 상세(목업 §2): 제목 · 상태·지연 · 사유 · 판정 상세 · 시나리오·환경 · 안내 줄 · 표 머리 · 스텝 줄.
/// 높이가 모자라면 스텝 줄이 최소 1줄 보이게 `시나리오` 줄 → `판정 상세` 줄 → 표 머리 순으로 통째 뺀다.
pub fn render_record(f: &mut Frame, head: &HeaderView, v: &RecordView, keys: &[&str]) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let title_style = Style::default()
        .fg(color(C_TEXT))
        .add_modifier(Modifier::BOLD);

    // 위쪽 고정 줄(빠지지 않는 것).
    let mut top: Vec<Line<'static>> = vec![Line::from(Span::styled(
        fit(&sanitize(&v.title), w),
        title_style,
    ))];
    let mut state = vec![Span::styled(
        text::state_label(v.state).to_string(),
        state_style(v.state),
    )];
    if let Some(ms) = v.latency_ms {
        state.push(Span::styled(
            format!("    {}", format_ms(ms as f64)),
            Style::default().fg(color(C_TEXT)),
        ));
    }
    top.push(clip_spans(state, w));
    let reason = v
        .reason
        .as_deref()
        .map(|r| labeled(text::REASON_LABEL, &sanitize(r), w));
    let detail = v
        .detail
        .as_deref()
        .map(|d| labeled(text::JUDGE_DETAIL, &sanitize(d), w));
    let scenario = scenario_line(v, w);

    let mut notes: Vec<Line<'static>> = Vec::new();
    let (lines, cursor): (&[StepLine], usize) = match &v.body {
        RecordBody::Loading => {
            notes.push(Line::from(Span::styled(fit(text::LOADING, w), muted())));
            (&[], 0)
        }
        RecordBody::Gone => {
            notes.push(Line::from(Span::styled(
                fit(text::RECORD_MISSING, w),
                fail_style(),
            )));
            (&[], 0)
        }
        RecordBody::Failed(m) => {
            notes.push(Line::from(Span::styled(
                fit(&text::record_load_error(&sanitize(m)), w),
                fail_style(),
            )));
            (&[], 0)
        }
        RecordBody::Loaded {
            notes: ns,
            lines,
            cursor,
        } => {
            notes.extend(ns.iter().map(|n| note_line(n, w)));
            (lines.as_slice(), *cursor)
        }
    };
    let has_steps = !lines.is_empty();

    // 빠질 수 있는 줄: 시나리오 → 판정 상세 → 표 머리 순으로 뺀다.
    let fixed = top.len() + usize::from(reason.is_some()) + notes.len();
    let mut show_scenario = true;
    let mut show_detail = detail.is_some();
    let mut show_head = has_steps;
    let need = |s: bool, d: bool, h: bool| {
        fixed + usize::from(s) + usize::from(d) + usize::from(h) + usize::from(has_steps)
    };
    let avail = usize::from(body.height);
    if need(show_scenario, show_detail, show_head) > avail {
        show_scenario = false;
    }
    if need(show_scenario, show_detail, show_head) > avail {
        show_detail = false;
    }
    if need(show_scenario, show_detail, show_head) > avail {
        show_head = false;
    }

    let mut out = top;
    out.extend(reason);
    if show_detail {
        out.extend(detail);
    }
    if show_scenario {
        out.push(scenario);
    }
    out.extend(notes);
    let c = step_cols(lines, w);
    if show_head {
        out.push(step_head_line(&c, w));
    }
    if has_steps {
        let rows = vis_rows(lines);
        let h = avail.saturating_sub(out.len());
        let cur_vis = rows
            .iter()
            .position(|&(i, e)| i == cursor && !e)
            .unwrap_or(0);
        let mut start = window_start(cur_vis, rows.len(), h);
        // 커서 스텝에 오류 줄이 딸려 있는데 커서가 창 맨 아래면 한 줄 내려 오류 줄까지 보이게
        // (창이 1줄이면 커서 줄을 지킨다).
        let has_err = rows.get(cur_vis + 1) == Some(&(cursor, true));
        if has_err && h >= 2 && cur_vis + 1 >= start + h {
            start += 1;
        }
        for &r in rows.iter().skip(start).take(h) {
            out.push(vis_line(lines, r, cursor, &c, w));
        }
    }
    for (i, line) in out.into_iter().take(avail).enumerate() {
        let y = body.y.saturating_add(i as u16);
        put(f, Rect::new(body.x, y, body.width, 1), line);
    }
}

// ---------- 요청·응답 본문 (목업 §3) ----------

/// 본문 화면의 body 줄 수(`sub_layout(area).body.height`).
pub fn body_height(area: Rect) -> usize {
    usize::from(sub_layout(area).body.height)
}

fn body_style(k: BodyLineKind) -> Style {
    match k {
        BodyLineKind::Title | BodyLineKind::Heading => Style::default()
            .fg(color(C_TEXT))
            .add_modifier(Modifier::BOLD),
        BodyLineKind::Note => Style::default().fg(color(C_SLOW)),
        BodyLineKind::Error => fail_style(),
        BodyLineKind::Text | BodyLineKind::Summary => Style::default(),
    }
}

/// 요청·응답 본문(목업 §3): `lines[scroll..]`을 body에 그린다. 전체 줄 수가 body 높이보다 많으면
/// 첫 화면 줄 오른쪽 끝에 `{보이는 마지막 줄 번호}/{전체}줄`(폭이 모자라면 통째 생략).
pub fn render_body(
    f: &mut Frame,
    head: &HeaderView,
    lines: &[BodyLine],
    scroll: usize,
    keys: &[&str],
) {
    let body = render_frame(f, head, keys);
    if body.height == 0 || body.width == 0 {
        return;
    }
    let w = usize::from(body.width);
    let h = usize::from(body.height);
    let total = lines.len();
    let scroll = scroll.min(total.saturating_sub(h));
    let end = scroll.saturating_add(h).min(total);
    let pos = (total > h).then(|| text::line_pos(end, total));
    for (row, l) in lines[scroll..end].iter().enumerate() {
        let y = body.y.saturating_add(row as u16);
        let area = Rect::new(body.x, y, body.width, 1);
        let style = body_style(l.kind);
        let text = sanitize(&l.text);
        match pos.as_ref().filter(|p| row == 0 && text_width(p) + 2 <= w) {
            Some(p) => {
                let pw = text_width(p);
                let room = w - pw - 1;
                let shown = fit(&text, room);
                let gap = w.saturating_sub(text_width(&shown) + pw);
                put(
                    f,
                    area,
                    Line::from(vec![
                        Span::styled(shown, style),
                        Span::raw(" ".repeat(gap)),
                        Span::styled(p.clone(), muted()),
                    ]),
                );
            }
            None => put(f, area, Line::from(Span::styled(fit(&text, w), style))),
        }
    }
}
