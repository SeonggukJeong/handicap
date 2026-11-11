//! 값 목록 화면·선택 창 그리기(tui-2b Task 3, spec §3.1·§3.2) — 뷰 모델만 받아 그린다.

use handicap_tui::app::CondFocus;
use handicap_tui::pick::{PickValue, RowKind, RowText, ValueList, ValueRow, ValuesState};
use handicap_tui::text;
use handicap_tui::view::edit::CondFormView;
use handicap_tui::view::inspect::sub_layout;
use handicap_tui::view::monitor::HeaderView;
use handicap_tui::view::settings::OverlayView;
use handicap_tui::view::values::{ValuesView, fit_head, mark_text, render_values};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::text::Span;
use std::cell::Cell;

fn buffer_text(buf: &Buffer) -> String {
    let area = buf.area;
    let mut out = String::new();
    for y in 0..area.height {
        let mut skip = 0usize;
        for x in 0..area.width {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            let sym = buf[(x, y)].symbol();
            skip = Span::raw(sym.to_string()).width().saturating_sub(1);
            out.push_str(sym);
        }
        out.push('\n');
    }
    out
}

fn head() -> HeaderView {
    HeaderView {
        board_name: "운영 API 보드".into(),
        board_pos: (1, 1),
        server_time: Some(1_700_000_000_000),
        server_down: false,
        notice: None,
    }
}

/// 고른 줄 바탕(`monitor.rs` `C_TEXT`).
const SEL_BG: Color = Color::Rgb(0xf2, 0xf5, 0xf8);

/// `needle`이 든 첫 **본문** 줄(머리 줄 y=0 제외)의 y.
fn row_with(buf: &Buffer, needle: &str) -> u16 {
    (1..buf.area.height)
        .find(|&y| {
            // 넓은 글자의 둘째 칸(채움 공백)은 건너뛴다.
            let mut line = String::new();
            let mut skip = false;
            for x in 0..buf.area.width {
                if skip {
                    skip = false;
                    continue;
                }
                let sym = buf[(x, y)].symbol();
                skip = Span::raw(sym.to_string()).width() == 2;
                line.push_str(sym);
            }
            line.contains(needle)
        })
        .unwrap_or_else(|| panic!("{needle:?} 줄 없음"))
}

/// `needle`이 든 첫 줄 글자(없으면 패닉).
fn line_of(txt: &str, needle: &str) -> String {
    txt.lines()
        .find(|l| l.contains(needle))
        .unwrap_or_else(|| panic!("{needle:?} 줄 없음\n{txt}"))
        .to_string()
}

fn draw(w: u16, h: u16, v: &ValuesView, keys: &[&str]) -> (Buffer, String) {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_values(f, &head(), v, keys)).unwrap();
    let buf = t.backend().buffer().clone();
    let txt = buffer_text(&buf);
    (buf, txt)
}

/// 줄 글자 + 표지 + 대상 폭을 묶은 시험용 재료(뷰는 이것을 빌린다).
struct Fix {
    rows: Vec<RowText>,
    tw: usize,
    marks: Vec<(usize, bool)>,
}

fn rv(target: &str, shown: &str) -> RowText {
    RowText::new(target, shown)
}

fn fix(rows: Vec<RowText>) -> Fix {
    let tw = rows
        .iter()
        .map(|r| Span::raw(r.target().to_string()).width())
        .max()
        .unwrap_or(0);
    let marks = vec![(0, false); rows.len()];
    Fix { rows, tw, marks }
}

const TITLE: &str = "주문 조회 · 14:01:58 · 2 주문 상세";

impl Fix {
    fn view<'a>(
        &'a self,
        marks: &'a dyn Fn(usize) -> (usize, bool),
        cursor: usize,
    ) -> ValuesView<'a> {
        ValuesView {
            title: TITLE,
            notes: vec![],
            blocked: None,
            rows: &self.rows,
            target_width: self.tw,
            marks,
            cursor,
            overlay: None,
            form: None,
        }
    }
}

fn choice<'a>(cursor: usize) -> OverlayView<'a> {
    OverlayView::Choice {
        head: "status  =  \"OK\"".into(),
        options: [
            (text::COND_ADD_CHOICE, None),
            (text::DISPLAY_ADD_CHOICE, Some(text::DISPLAY_MAX)),
        ],
        cursor,
    }
}

#[test]
fn renders_rows_and_marks() {
    let mut f = fix(vec![
        rv("상태코드", "200"),
        rv("헤더 content-type", "application/json"),
        rv("헤더 x-request-id", "7f3a91c2…"),
        rv("status", "\"OK\""),
        rv("data.order.id", "7"),
        rv("data.order.state", "\"PAID\""),
        rv("data.items[0].sku", "\"A-100\""),
        rv("data.queue", "12"),
    ]);
    f.marks[3] = (1, false);
    f.marks[5] = (0, true);
    let m = |i: usize| f.marks[i];
    let v = f.view(&m, 3);
    let (_, txt) = draw(80, 24, &v, &["↑↓ 고르기"]);
    assert!(txt.contains("4/8"), "{txt}");
    assert!(txt.contains("주문 상세 — 값 고르기"), "{txt}");
    assert!(txt.contains("대상") && txt.contains("받은 값"), "{txt}");
    for t in [
        "상태코드",
        "헤더 content-type",
        "application/json",
        "7f3a91c2…",
        "data.order.id",
        "data.items[0].sku",
        "\"A-100\"",
        "data.queue",
    ] {
        assert!(txt.contains(t), "{t:?} 없음\n{txt}");
    }
    // 표지는 그 줄 오른쪽 끝.
    assert!(
        line_of(&txt, "data.order.state")
            .trim_end()
            .ends_with("표시"),
        "{txt}"
    );
    let l = line_of(&txt, "\"OK\"");
    assert!(l.starts_with("▶ status"), "{l:?}");
    assert!(l.trim_end().ends_with("조건"), "{l:?}");
    // 표지 없는 줄은 표지로 끝나지 않는다.
    assert!(!line_of(&txt, "data.queue").trim_end().ends_with("표시"));
}

#[test]
fn mark_text_forms() {
    assert_eq!(mark_text(0, false), "");
    assert_eq!(mark_text(1, false), "조건");
    assert_eq!(mark_text(2, false), "조건 2");
    assert_eq!(mark_text(0, true), "표시");
    assert_eq!(mark_text(1, true), "조건 · 표시");
    assert_eq!(mark_text(2, true), "조건 2 · 표시");
}

#[test]
fn selected_row_highlight() {
    let f = fix(vec![
        rv("rowAAA", "1"),
        rv("rowBBB", "2"),
        rv("rowCCC", "3"),
    ]);
    let m = |i: usize| f.marks[i];
    let v = f.view(&m, 1);
    let (buf, _) = draw(60, 14, &v, &[]);
    let y = row_with(&buf, "rowBBB");
    // 고른 줄은 본문 줄 칸(대상 첫 글자·줄 오른쪽 끝)이 선택 바탕.
    assert_eq!(buf[(2, y)].bg, SEL_BG);
    assert_eq!(buf[(59, y)].bg, SEL_BG);
    for other in ["rowAAA", "rowCCC"] {
        let oy = row_with(&buf, other);
        assert_ne!(buf[(2, oy)].bg, SEL_BG, "{other}");
        assert_ne!(buf[(59, oy)].bg, SEL_BG, "{other}");
    }
}

#[test]
fn cursor_always_visible() {
    let f = fix((0..200)
        .map(|i| rv(&format!("row{i:03}"), &i.to_string()))
        .collect());
    let m = |i: usize| f.marks[i];
    for cursor in [0usize, 1, 11, 150, 198, 199] {
        let v = f.view(&m, cursor);
        let (buf, txt) = draw(80, 12, &v, &[]);
        let needle = format!("row{cursor:03}");
        let y = row_with(&buf, &needle);
        assert_eq!(buf[(2, y)].bg, SEL_BG, "{needle}\n{txt}");
        // 선택 창이 아래를 차지해도 고른 줄이 보인다.
        let mut v = f.view(&m, cursor);
        v.overlay = Some(choice(0));
        let (buf, txt) = draw(80, 12, &v, &[]);
        let y = row_with(&buf, &needle);
        assert_eq!(buf[(2, y)].bg, SEL_BG, "{needle}\n{txt}");
        assert!(txt.contains(text::COND_ADD_CHOICE), "{txt}");
    }
}

#[test]
fn marks_called_only_for_visible_rows() {
    let f = fix((0..5000)
        .map(|i| rv(&format!("row{i:04}"), &i.to_string()))
        .collect());
    let calls = Cell::new(0usize);
    let m = |_i: usize| {
        calls.set(calls.get() + 1);
        (0, false)
    };
    for cursor in [0usize, 2500, 4999] {
        calls.set(0);
        let v = f.view(&m, cursor);
        let (_, txt) = draw(80, 12, &v, &[]);
        assert!(txt.contains(&format!("row{cursor:04}")), "{txt}");
        assert!(calls.get() <= 12, "marks {}번 호출", calls.get());
    }
}

#[test]
fn long_target_keeps_tail() {
    let long = format!("data.{}.leaf_key", "a".repeat(300));
    let f = fix(vec![rv(&long, &"v".repeat(300)), rv("short", "ok")]);
    let m = |i: usize| f.marks[i];
    let v = f.view(&m, 0);
    let (_, txt) = draw(80, 14, &v, &[]);
    let l = line_of(&txt, "leaf_key");
    assert!(l.starts_with("▶ …"), "{l:?}");
    assert!(l.contains("leaf_key"), "{l:?}");
    // 받은 값은 뒤를 줄인다.
    assert!(l.trim_end().ends_with('…'), "{l:?}");
    assert!(l.contains("vvv"), "{l:?}");
    assert!(!l.contains("data.aaa"), "앞이 남았다: {l:?}");
    // 절반 폭 상한 — 짧은 대상은 그대로.
    assert!(line_of(&txt, "short").contains("short"));
    // fit_head 단독.
    assert_eq!(fit_head("abcdef", 6), "abcdef");
    assert_eq!(fit_head("abcdef", 4), "…def");
    assert_eq!(fit_head("abcdef", 1), "…");
    assert_eq!(fit_head("abcdef", 0), "");
}

#[test]
fn fit_head_drops_leading_combining() {
    // 잘린 경계가 결합 문자 바로 앞 — 결합 문자가 `…` 위에 얹히지 않는다.
    let s = "ae\u{301}bc";
    for w in 1..=6 {
        let r = fit_head(s, w);
        let after = r.strip_prefix('…').unwrap_or(&r);
        assert!(
            !after.starts_with('\u{301}'),
            "w={w} {r:?}: 결합 문자가 … 바로 뒤"
        );
    }
    assert_eq!(fit_head(s, 3), "…bc");
}

#[test]
fn notes_and_blocked() {
    let f = fix(vec![rv("tgt1", "1"), rv("tgt2", "2")]);
    let m = |i: usize| f.marks[i];
    let mut v = f.view(&m, 0);
    v.notes = vec!["안내A 풀어서 표시 중".into(), "안내B 반복".into()];
    let (buf, txt) = draw(80, 20, &v, &[]);
    let head_y = row_with(&buf, "받은 값");
    assert!(row_with(&buf, "안내A") < head_y, "{txt}");
    assert!(row_with(&buf, "안내B") < head_y, "{txt}");
    assert!(row_with(&buf, "안내A") < row_with(&buf, "안내B"));
    assert!(row_with(&buf, "tgt1") > head_y);

    // 막힘 — 그 문구만(표 머리·줄 없음), 80칸에서 줄바꿈.
    let reason = format!("{}끝", "가".repeat(100));
    let f = fix(vec![rv("should_hide", "1")]);
    let m = |i: usize| f.marks[i];
    let mut v = f.view(&m, 0);
    v.notes = vec!["안내A".into()];
    v.blocked = Some(reason);
    let (_, txt) = draw(80, 20, &v, &[]);
    assert!(!txt.contains("받은 값"), "{txt}");
    assert!(!txt.contains("should_hide"), "{txt}");
    assert!(txt.contains("끝"), "{txt}");
    let n = txt.lines().filter(|l| l.contains('가')).count();
    assert!(n >= 2, "줄바꿈 안 됨 {n}\n{txt}");
    // 줄이 0개면 `n/m` 없음.
    assert!(!txt.contains("0/0") && !txt.contains("1/1"), "{txt}");
}

#[test]
fn low_height_drops_notes_first() {
    let f = fix((1..=5).map(|i| rv(&format!("tgt{i}"), "x")).collect());
    let m = |i: usize| f.marks[i];
    let mut v = f.view(&m, 0);
    v.notes = vec!["안내A".into(), "안내B".into()];
    let mut saw_no_notes_with_head = false;
    let mut saw_no_head = false;
    let mut prev_notes = usize::MAX;
    for h in (3..=24u16).rev() {
        let bh = sub_layout(Rect::new(0, 0, 80, h)).body.height;
        let (_, txt) = draw(80, h, &v, &[]);
        let rows = (1..=5).filter(|i| txt.contains(&format!("tgt{i}"))).count();
        let notes = ["안내A", "안내B"]
            .iter()
            .filter(|n| txt.contains(**n))
            .count();
        let head_shown = txt.contains("받은 값");
        if bh >= 2 {
            assert!(rows >= 1, "h={h} bh={bh}\n{txt}");
        }
        // 안내 → 표 머리 순으로 빠진다.
        assert!(notes <= prev_notes, "h={h}");
        prev_notes = notes;
        if notes > 0 {
            assert!(head_shown, "h={h} 안내가 있는데 표 머리가 없다\n{txt}");
        }
        if bh >= 2 && notes == 0 && head_shown {
            saw_no_notes_with_head = true;
        }
        if bh >= 2 && !head_shown {
            assert_eq!(notes, 0, "h={h}");
            saw_no_head = true;
        }
    }
    assert!(saw_no_notes_with_head, "안내만 빠진 높이가 없다");
    assert!(saw_no_head, "표 머리까지 빠진 높이가 없다");
}

#[test]
fn width_sweep_no_panic() {
    let mut f = fix(vec![
        rv("상태코드", "200"),
        rv("헤더 content-type", ""),
        rv("한글경로.키.값[0]", "\"가나다라마바사아자차카타파하\""),
        rv("data.order.state", "\"PAID\""),
        rv(&format!("a.{}", "b".repeat(80)), &"한".repeat(60)),
        rv("status", "\"OK\""),
        rv("x", "y"),
    ]);
    f.marks[0] = (2, true);
    f.marks[3] = (0, true);
    f.marks[5] = (1, false);
    let ops: &[&'static str] = &["= 같음", "키 있음"];
    let form = CondFormView {
        target: "status · 주문 상세",
        ops,
        op: 0,
        value: Some(("OK".to_string(), 2)),
        flags: Some((true, false)),
        focus: CondFocus::Value,
        error: Some("값이 비어 있습니다"),
        received: Some("\"OK\""),
        hint: Some("매번 바뀌는 값이면 실패합니다"),
    };
    let notes = vec!["문자열로 감싼 JSON을 풀어서 표시 중".to_string()];
    let n = f.rows.len();
    let m = |i: usize| f.marks[i];
    let heights: Vec<u16> = (1..=12u16).chain([24]).collect();
    for w in 1..=120u16 {
        for &h in &heights {
            for variant in 0..3 {
                for cursor in [0, n / 2, n - 1] {
                    let mut v = f.view(&m, cursor);
                    v.notes = notes.clone();
                    match variant {
                        1 => v.overlay = Some(choice(cursor % 2)),
                        2 => v.form = Some(&form),
                        _ => {}
                    }
                    let _ = draw(w, h, &v, &["↑↓ 고르기", "Enter 추가", "Esc 요청·응답으로"]);
                }
            }
        }
    }
    // 막힘·빈 줄도.
    let e = fix(vec![]);
    let em = |_i: usize| (0, false);
    for w in 1..=120u16 {
        for &h in &heights {
            let mut v = e.view(&em, 0);
            v.blocked = Some("이 칸은 \"로그인\" 스텝만 봅니다".into());
            let _ = draw(w, h, &v, &[]);
            let _ = draw(w, h, &e.view(&em, 0), &[]);
        }
    }
}

#[test]
fn remote_strings_sanitized() {
    // 원격 글자는 `ValuesState::new`가 `sanitize`한다.
    let list = ValueList {
        rows: vec![
            ValueRow {
                kind: RowKind::Header {
                    name: "a\u{1b}[31mb".into(),
                },
                value: PickValue::Header("x\u{202e}y".into()),
            },
            ValueRow {
                kind: RowKind::Header {
                    name: "c\u{2028}d".into(),
                },
                value: PickValue::Header("z".into()),
            },
        ],
        notes: vec![],
    };
    let st = ValuesState::new("S".into(), list, None);
    let m = |_i: usize| (0, false);
    let v = ValuesView {
        title: TITLE,
        notes: vec![],
        blocked: None,
        rows: &st.texts,
        target_width: st.target_width,
        marks: &m,
        cursor: 0,
        overlay: None,
        form: None,
    };
    let (_, txt) = draw(80, 14, &v, &[]);
    assert!(txt.contains('\u{FFFD}'), "{txt}");
    assert!(!txt.contains('\u{202e}'), "{txt}");
    let l = line_of(&txt, "x\u{FFFD}y");
    assert!(l.contains("a\u{FFFD}[31mb"), "{l:?}");
    // 선택 창 머리도.
    let f = fix(vec![rv("k", "v")]);
    let m = |i: usize| f.marks[i];
    let mut v = f.view(&m, 0);
    v.overlay = Some(OverlayView::Choice {
        head: "s\u{202e}t  =  \"u\u{1b}v\"".into(),
        options: [
            (text::COND_ADD_CHOICE, None),
            (text::DISPLAY_ADD_CHOICE, None),
        ],
        cursor: 0,
    });
    let (_, txt) = draw(80, 14, &v, &[]);
    assert!(txt.contains("s\u{FFFD}t"), "{txt}");
    assert!(txt.contains("u\u{FFFD}v"), "{txt}");
}

#[test]
fn choice_rows() {
    let f = fix(vec![rv("status", "\"OK\"")]);
    let m = |i: usize| f.marks[i];
    let mut v = f.view(&m, 0);
    v.overlay = Some(choice(0));
    let (buf, txt) = draw(80, 14, &v, &["Enter 선택"]);
    assert!(txt.contains("  status  =  \"OK\""), "{txt}");
    let l0 = line_of(&txt, text::COND_ADD_CHOICE);
    assert!(l0.starts_with("▶ "), "{l0:?}");
    let l1 = line_of(&txt, text::DISPLAY_ADD_CHOICE);
    assert!(l1.starts_with("  "), "{l1:?}");
    assert!(
        l1.contains(&format!("화면에 추가 — {}", text::DISPLAY_MAX)),
        "{l1:?}"
    );
    // 머리 → 두 줄 순서, 값 목록 줄이 그 위.
    let (yr, yh) = (row_with(&buf, "\"OK\""), row_with(&buf, "status  ="));
    let (y0, y1) = (
        row_with(&buf, text::COND_ADD_CHOICE),
        row_with(&buf, text::DISPLAY_ADD_CHOICE),
    );
    assert!(yr < yh && yh < y0 && y0 + 1 == y1);
    assert_eq!(buf[(2, y0)].bg, SEL_BG);
    assert_ne!(buf[(2, y1)].bg, SEL_BG);
    // 커서를 막힌 줄로 — 선택 바탕 + 이유 글자가 보이고, 흐림도 같이 준다.
    v.overlay = Some(choice(1));
    let (buf, txt) = draw(80, 14, &v, &["Enter 선택"]);
    let l1 = line_of(&txt, text::DISPLAY_ADD_CHOICE);
    assert!(l1.starts_with("▶ "), "{l1:?}");
    assert!(l1.contains(text::DISPLAY_MAX), "{l1:?}");
    let y1 = row_with(&buf, text::DISPLAY_ADD_CHOICE);
    assert_eq!(buf[(2, y1)].bg, SEL_BG);
    assert!(
        buf[(2, y1)].modifier.contains(Modifier::DIM),
        "막힌 줄 위 커서는 흐림"
    );
    // 안 막힌 고른 줄은 흐리지 않다.
    v.overlay = Some(choice(0));
    let (buf, _) = draw(80, 14, &v, &["Enter 선택"]);
    let y0 = row_with(&buf, text::COND_ADD_CHOICE);
    assert!(!buf[(2, y0)].modifier.contains(Modifier::DIM));
    // cursor 5 → 둘째 줄이 고른 줄.
    v.overlay = Some(choice(5));
    let (buf, txt) = draw(80, 14, &v, &["Enter 선택"]);
    assert!(
        line_of(&txt, text::DISPLAY_ADD_CHOICE).starts_with("▶ "),
        "{txt}"
    );
    assert!(line_of(&txt, text::COND_ADD_CHOICE).starts_with("  "));
    assert_eq!(
        buf[(2, row_with(&buf, text::DISPLAY_ADD_CHOICE))].bg,
        SEL_BG
    );
}

#[test]
fn choice_head_wraps() {
    let target = format!("data.{}", "T".repeat(295));
    let value = format!("\"{}END\"", "v".repeat(95));
    let f = fix(vec![rv("status", "1")]);
    let m = |i: usize| f.marks[i];
    let head = format!("{target}  =  {value}");
    let ov = |cursor| OverlayView::Choice {
        head: head.clone(),
        options: [
            (text::COND_ADD_CHOICE, None),
            (text::DISPLAY_ADD_CHOICE, None),
        ],
        cursor,
    };
    let mut v = f.view(&m, 0);
    v.overlay = Some(ov(0));
    let (_, txt) = draw(80, 24, &v, &[]);
    // 대상 앞부분과 값 끝이 모두 화면에 있다 — 머리가 여러 줄.
    assert!(txt.contains("data.TTTT"), "{txt}");
    assert!(txt.contains("vvvEND\""), "{txt}");
    let head_lines = txt
        .lines()
        .filter(|l| l.contains('T') || l.contains("END"))
        .count();
    assert!(head_lines >= 4, "머리 {head_lines}줄\n{txt}");
    // 낮은 화면 — 머리가 잘리고 마지막 머리 줄이 `…`, 두 선택 줄은 다 보인다.
    let (_, txt) = draw(80, 8, &v, &[]);
    assert!(txt.contains(text::COND_ADD_CHOICE), "{txt}");
    assert!(txt.contains(text::DISPLAY_ADD_CHOICE), "{txt}");
    let yc = txt
        .lines()
        .position(|l| l.contains(text::COND_ADD_CHOICE))
        .unwrap();
    let last_head = txt.lines().nth(yc - 1).unwrap();
    assert!(last_head.trim_end().ends_with('…'), "{last_head:?}\n{txt}");
    assert!(!txt.contains("END"), "{txt}");
    // 머리가 한도까지 차도 제목 줄 + 고른 목록 줄은 남는다(spec §3.1 "고른 줄이 늘 보인다").
    assert!(
        txt.lines().any(|l| l.contains("▶ status")),
        "고른 줄이 안 보인다\n{txt}"
    );
    for h in 6..=14u16 {
        let (_, txt) = draw(80, h, &v, &[]);
        assert!(
            txt.lines().any(|l| l.contains("▶ status")),
            "높이 {h}: 고른 줄이 안 보인다\n{txt}"
        );
    }
}
