//! 하위 목록·조건 수정 칸·환경/시나리오 변수 화면 그리기(목업 §4·§5, tui-2a-1 Task 9).

use handicap_tui::app::CondFocus;
use handicap_tui::text;
use handicap_tui::view::edit::{
    CondFormView, ListKind, ListRow, ListView, VarRow, VarsView, cond_form_keys, env_display,
    list_keys, received_head, render_cond_form, render_list, render_vars, vars_keys,
};
use handicap_tui::view::monitor::HeaderView;
use handicap_tui::view::settings::OverlayView;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier};
use ratatui::text::Span;

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

fn width(s: &str) -> usize {
    Span::raw(s.to_string()).width()
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

fn row(text: &str) -> ListRow {
    ListRow {
        text: text.into(),
        color: None,
        dim: false,
    }
}

fn draw_list(w: u16, h: u16, v: &ListView, keys: &[&str]) -> (Buffer, String) {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_list(f, &head(), v, keys)).unwrap();
    let buf = t.backend().buffer().clone();
    let txt = buffer_text(&buf);
    (buf, txt)
}

fn draw_vars(w: u16, h: u16, v: &VarsView, keys: &[&str]) -> (Buffer, String) {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_vars(f, &head(), v, keys)).unwrap();
    let buf = t.backend().buffer().clone();
    let txt = buffer_text(&buf);
    (buf, txt)
}

fn draw_form(w: u16, h: u16, v: &CondFormView) -> (Buffer, String) {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_cond_form(f, Rect::new(0, 0, w, h), v))
        .unwrap();
    let buf = t.backend().buffer().clone();
    let txt = buffer_text(&buf);
    (buf, txt)
}

fn vars_view<'a>(rows: Vec<VarRow>, cursor: usize) -> VarsView<'a> {
    VarsView {
        title: "환경 변수 · 운영".into(),
        usage: text::usage_note(4, 2),
        rows,
        cursor,
        loading: false,
        failed: None,
        overlay: None,
    }
}

fn vrow(key: &str, value: &str) -> VarRow {
    VarRow {
        key: key.into(),
        value: value.into(),
        note: None,
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
                skip = ratatui::text::Span::raw(sym.to_string()).width() == 2;
                line.push_str(sym);
            }
            line.contains(needle)
        })
        .unwrap_or_else(|| panic!("{needle:?} 줄 없음"))
}

/// 그 줄의 `sym` 칸 x.
fn col_of(buf: &Buffer, y: u16, sym: &str) -> u16 {
    (0..buf.area.width)
        .find(|&x| buf[(x, y)].symbol() == sym)
        .unwrap_or_else(|| panic!("{sym:?} 칸 없음"))
}

fn find_cell(buf: &Buffer, sym: &str) -> Option<(u16, u16)> {
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            if buf[(x, y)].symbol() == sym {
                return Some((x, y));
            }
        }
    }
    None
}

#[test]
fn env_values_masked_until_v() {
    assert_eq!(env_display("", false), "••••••••");
    assert_eq!(env_display("SECRET-TOKEN", false), "••••••••");
    assert_eq!(
        env_display("x", false),
        env_display(&"y".repeat(500), false)
    );
    assert_eq!(env_display("SECRET-TOKEN", true), "SECRET-TOKEN");

    let masked = vars_view(
        vec![
            vrow("API_TOKEN", &env_display("SECRET-TOKEN", false)),
            vrow("SHOP_ID", &env_display("", false)),
        ],
        0,
    );
    let (_, txt) = draw_vars(100, 20, &masked, &[]);
    assert!(!txt.contains("SECRET"), "{txt}");
    assert!(txt.contains("••••••••"), "{txt}");
    let shown = vars_view(
        vec![vrow("API_TOKEN", &env_display("SECRET-TOKEN", true))],
        0,
    );
    let (_, txt) = draw_vars(100, 20, &shown, &[]);
    assert!(txt.contains("SECRET-TOKEN"), "{txt}");
}

#[test]
fn vars_rows_notes() {
    let mut gen_row = vrow("nonce", "");
    gen_row.note = Some(text::VAR_GENERATED);
    let v = vars_view(
        vec![vrow("order_id", "A-1001"), vrow("page_size", "20"), gen_row],
        0,
    );
    let (buf, txt) = draw_vars(100, 20, &v, &["↑↓ 고르기"]);
    assert!(txt.contains("환경 변수 · 운영"), "{txt}");
    assert!(txt.contains("이 환경을 쓰는 칸 4개(보드 2개)"), "{txt}");
    assert!(txt.contains("생성 변수 — GUI에서"), "{txt}");
    assert!(txt.contains("▶ order_id"), "{txt}");
    // 생성 변수 줄은 흐림: 일반 줄 글자색과 다르다.
    let gy = row_with(&buf, "nonce");
    let py = row_with(&buf, "page_size");
    assert_ne!(
        buf[(col_of(&buf, gy, "n"), gy)].fg,
        buf[(col_of(&buf, py, "p"), py)].fg
    );
    // 고른 줄은 줄 전체가 흰 바탕, 고르지 않은 줄은 아니다.
    let sy = row_with(&buf, "▶ order_id");
    for x in [
        col_of(&buf, sy, "▶"),
        col_of(&buf, sy, "A"),
        buf.area.width - 2,
    ] {
        assert_eq!(buf[(x, sy)].bg, SEL_BG, "x={x}");
    }
    assert_ne!(buf[(col_of(&buf, py, "p"), py)].bg, SEL_BG);
    assert_ne!(buf[(col_of(&buf, gy, "n"), gy)].bg, SEL_BG);
}

#[test]
fn list_thresholds_colored() {
    let v = ListView {
        title: "응답속도 기준선 · 주문 조회",
        rows: vec![
            ListRow {
                text: "800 ms".into(),
                color: Some("#f59e0b".into()),
                dim: false,
            },
            ListRow {
                text: "1,500 ms".into(),
                color: Some("zz-not-a-color".into()),
                dim: false,
            },
        ],
        cursor: 0,
        overlay: None,
    };
    let (buf, txt) = draw_list(100, 20, &v, &[text::KEYS_PICK]);
    assert!(txt.contains("▶ 1  ■ 800 ms"), "{txt}");
    assert!(txt.contains("2  ■ 1,500 ms"), "{txt}");
    let mut found = vec![];
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            if buf[(x, y)].symbol() == "■" {
                found.push(buf[(x, y)].fg);
            }
        }
    }
    assert_eq!(found.len(), 2);
    assert_eq!(found[0], Color::Rgb(0xf5, 0x9e, 0x0b));
    assert_ne!(found[1], Color::Rgb(0xf5, 0x9e, 0x0b));
    // 고른 줄만 흰 바탕.
    let sy = row_with(&buf, "▶ 1  ■ 800 ms");
    let uy = row_with(&buf, "2  ■ 1,500 ms");
    assert_eq!(buf[(col_of(&buf, sy, "▶"), sy)].bg, SEL_BG);
    assert_eq!(buf[(col_of(&buf, sy, "8"), sy)].bg, SEL_BG);
    assert_ne!(buf[(col_of(&buf, uy, "2"), uy)].bg, SEL_BG);
}

#[test]
fn list_empty_shows_guidance() {
    let guide = ListRow {
        text: text::EDIT_ADD_HINT.into(),
        color: None,
        dim: true,
    };
    let v = ListView {
        title: "성공 조건 · 주문 조회",
        rows: vec![guide],
        cursor: 0,
        overlay: None,
    };
    let (buf, txt) = draw_list(100, 20, &v, &[]);
    assert!(txt.contains(text::EDIT_ADD_HINT), "{txt}");
    assert_eq!(
        text::EDIT_ADD_HINT,
        "없음 — a로 추가(지금 점검 뒤 응답에서 값 고르기)"
    );
    assert!(!txt.contains('▶'), "안내 줄은 고르지 않는다: {txt}");
    let gy = row_with(&buf, text::EDIT_ADD_HINT);
    assert_ne!(buf[(col_of(&buf, gy, "없"), gy)].bg, SEL_BG);
    // 줄이 하나도 없으면 `없음`.
    let v = ListView {
        title: "응답속도 기준선 · 주문 조회",
        rows: vec![],
        cursor: 0,
        overlay: None,
    };
    let (_, txt) = draw_list(100, 20, &v, &[]);
    assert!(txt.contains(text::NONE), "{txt}");
}

fn form<'a>(op: usize, ops: &'a [&'static str], focus: CondFocus) -> CondFormView<'a> {
    let has_value = op == 0;
    CondFormView {
        target: "status",
        ops,
        op,
        value: has_value.then(|| ("OK".to_string(), 2)),
        flags: has_value.then_some((true, false)),
        focus,
        error: None,
        received: None,
        hint: None,
    }
}

#[test]
fn cond_form_received_and_hint() {
    let ops = ["= 같음", "키 있음"];
    let mut v = form(0, &ops, CondFocus::Op);
    v.received = Some("\"OK\"");
    v.hint = Some("매번 바뀌는 값이면 실패합니다");
    // 넉넉하면 두 줄 다 — 받은 값은 대상 줄 바로 아래, 안내는 맨 아래.
    let (_, txt) = draw_form(60, 8, &v);
    let lines: Vec<&str> = txt.lines().collect();
    assert!(lines[0].contains("대상    status"), "{txt}");
    assert!(lines[1].contains("받은 값 \"OK\""), "{txt}");
    assert!(lines[2].contains("규칙"), "{txt}");
    assert!(lines[3].contains("값      OK"), "{txt}");
    assert!(lines[4].contains("[x] 대소문자 무시"), "{txt}");
    assert!(lines[5].contains("매번 바뀌는 값이면 실패합니다"), "{txt}");
    // 높이 5(= 기본 4줄 + 한 줄): 안내가 먼저 빠지고 받은 값이 남는다.
    let (_, txt) = draw_form(60, 5, &v);
    assert!(txt.contains("받은 값"), "{txt}");
    assert!(!txt.contains("매번 바뀌는"), "{txt}");
    assert!(txt.contains("규칙") && txt.contains("값      OK"), "{txt}");
    assert!(txt.contains("[x] 대소문자 무시"), "{txt}");
    // 높이 4(= 대상·규칙·값·체크): 받은 값도 빠지고 규칙·값은 남는다.
    let (_, txt) = draw_form(60, 4, &v);
    assert!(!txt.contains("받은 값"), "{txt}");
    assert!(!txt.contains("매번 바뀌는"), "{txt}");
    assert!(txt.contains("규칙") && txt.contains("값      OK"), "{txt}");
    assert!(txt.contains("[x] 대소문자 무시"), "{txt}");
    // 줄 수 계산 — 오류 줄이 있으면 오류가 안내보다 먼저 남는다.
    v.error = Some("값이 비어 있습니다");
    let (_, txt) = draw_form(60, 6, &v);
    assert!(txt.contains("값이 비어 있습니다"), "{txt}");
    assert!(txt.contains("받은 값"), "{txt}");
    assert!(!txt.contains("매번 바뀌는"), "{txt}");
    // exists 규칙(값·체크 줄 없음)이면 같은 높이에 안내까지 들어간다.
    let mut v = form(1, &ops, CondFocus::Op);
    v.received = Some("1");
    v.hint = Some("안내 한 줄");
    let (_, txt) = draw_form(60, 4, &v);
    assert!(
        txt.contains("받은 값") && txt.contains("안내 한 줄"),
        "{txt}"
    );
}

#[test]
fn cond_form_received_sanitized() {
    let ops = ["= 같음", "키 있음"];
    let mut v = form(0, &ops, CondFocus::Op);
    v.received = Some("a\u{1b}[31mb\u{202e}c");
    let (_, txt) = draw_form(60, 8, &v);
    assert!(txt.contains('\u{FFFD}'), "{txt}");
    assert!(txt.contains("a\u{FFFD}[31mb\u{FFFD}c"), "{txt}");
}

#[test]
fn cond_form_layout() {
    let ops = ["= 같음", "키 있음"];
    let v = form(0, &ops, CondFocus::Op);
    let (buf, txt) = draw_form(60, 8, &v);
    assert!(txt.contains("대상    status"), "{txt}");
    assert!(txt.contains("규칙    "), "{txt}");
    assert!(txt.contains("= 같음"), "{txt}");
    assert!(txt.contains("값      OK"), "{txt}");
    assert!(
        txt.contains("[x] 대소문자 무시   [ ] 앞뒤 공백 무시"),
        "{txt}"
    );
    // 포커스 칸(규칙) 반전.
    let (x, y) = find_cell(&buf, "=").unwrap();
    assert!(buf[(x, y)].modifier.contains(Modifier::REVERSED));
    let (tx, ty) = find_cell(&buf, "s").unwrap();
    assert!(!buf[(tx, ty)].modifier.contains(Modifier::REVERSED));
    // 체크 포커스 = 그 체크만 반전.
    let v = form(0, &ops, CondFocus::Trim);
    let (buf, _) = draw_form(60, 8, &v);
    let (x, y) = find_cell(&buf, "앞").unwrap();
    assert!(buf[(x, y)].modifier.contains(Modifier::REVERSED));
    let (x, y) = find_cell(&buf, "대").unwrap();
    assert!(!buf[(x, y)].modifier.contains(Modifier::REVERSED));
    // 값 칸 포커스 = 커서 칸 반전.
    let v = form(0, &ops, CondFocus::Value);
    let (buf, _) = draw_form(60, 8, &v);
    let reversed = (0..buf.area.width)
        .filter(|x| buf[(*x, 2)].modifier.contains(Modifier::REVERSED))
        .count();
    assert_eq!(reversed, 1);
    // exists = 값 줄·체크 줄 없음.
    let v = form(1, &ops, CondFocus::Op);
    let (_, txt) = draw_form(60, 8, &v);
    assert!(txt.contains("키 있음"), "{txt}");
    assert!(!txt.contains("값 "), "{txt}");
    assert!(!txt.contains("[x]") && !txt.contains("[ ]"), "{txt}");
    // 오류 줄.
    let mut v = form(0, &ops, CondFocus::Op);
    v.error = Some("값이 비어 있습니다");
    let (_, txt) = draw_form(60, 8, &v);
    assert!(txt.contains("값이 비어 있습니다"), "{txt}");
}

#[test]
fn vars_loading_and_failed() {
    let mut v = vars_view(vec![], 0);
    v.loading = true;
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("불러오는 중…"), "{txt}");
    v.loading = false;
    v.failed = Some("환경을 찾을 수 없습니다");
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("환경을 찾을 수 없습니다"), "{txt}");
    assert!(!txt.contains("불러오는 중…"), "{txt}");
}

#[test]
fn remote_strings_sanitized() {
    // 키.
    let v = vars_view(vec![vrow("K\u{202E}E\x1bY", "v")], 0);
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("K\u{FFFD}E\u{FFFD}Y"), "key: {txt}");
    assert!(!txt.contains('\u{202E}'));
    // 드러낸 값.
    let v = vars_view(vec![vrow("K", &env_display("a\u{202E}b\x1bc", true))], 0);
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("a\u{FFFD}b\u{FFFD}c"), "value: {txt}");
    // 서버 실패 문구.
    let mut v = vars_view(vec![], 0);
    v.failed = Some("x\u{202E}y");
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("x\u{FFFD}y"), "failed: {txt}");
    // 제목.
    let mut v = vars_view(vec![], 0);
    v.title = "환경 \u{202E}이름".into();
    let (_, txt) = draw_vars(80, 12, &v, &[]);
    assert!(txt.contains("환경 \u{FFFD}이름"), "title: {txt}");
    // 목록 줄.
    let v = ListView {
        title: "성공 조건",
        rows: vec![row("status = a\u{202E}b")],
        cursor: 0,
        overlay: None,
    };
    let (_, txt) = draw_list(80, 12, &v, &[]);
    assert!(txt.contains("status = a\u{FFFD}b"), "list row: {txt}");
    // 목록 제목.
    let v = ListView {
        title: "성공 \u{2028}조건",
        rows: vec![row("a")],
        cursor: 0,
        overlay: None,
    };
    let (_, txt) = draw_list(80, 12, &v, &[]);
    assert!(txt.contains("성공 \u{FFFD}조건"), "list title: {txt}");
    // 조건 칸 대상·값·오류.
    let ops = ["= 같음"];
    let mut v = form(0, &ops, CondFocus::Op);
    v.target = "h\u{202E}x";
    v.value = Some(("v\u{202E}w".into(), 1));
    v.error = Some("e\u{202E}r");
    let (_, txt) = draw_form(60, 8, &v);
    assert!(txt.contains("h\u{FFFD}x"), "target: {txt}");
    assert!(txt.contains("v\u{FFFD}w"), "form value: {txt}");
    assert!(txt.contains("e\u{FFFD}r"), "form error: {txt}");
}

#[test]
fn key_fragments() {
    assert_eq!(
        vars_keys(true, false),
        vec!["↑↓ 고르기", "Enter 수정", "v 값 보기", "Esc 뒤로"]
    );
    assert_eq!(vars_keys(true, true)[2], "v 가리기");
    assert_eq!(
        vars_keys(false, false),
        vec!["↑↓ 고르기", "Enter 수정", "Esc 뒤로"]
    );
    assert_eq!(
        list_keys(ListKind::Thresholds, 2),
        vec!["↑↓ 고르기", "Enter 수정", "a 추가", "d 삭제", "Esc 뒤로"]
    );
    assert_eq!(
        list_keys(ListKind::Conditions, 2),
        vec!["↑↓ 고르기", "Enter 수정", "a 추가", "d 삭제", "Esc 뒤로"]
    );
    assert_eq!(
        list_keys(ListKind::Display, 2),
        vec!["↑↓ 고르기", "a 추가", "s 자리 바꾸기", "d 삭제", "Esc 뒤로"]
    );
    assert_eq!(
        list_keys(ListKind::Display, 1),
        vec!["↑↓ 고르기", "a 추가", "d 삭제", "Esc 뒤로"]
    );
    // 빈 목록 = 삭제·수정 없음, `a 추가`는 세 종류 모두(tui-2b §2.7).
    for k in [
        ListKind::Thresholds,
        ListKind::Conditions,
        ListKind::Display,
    ] {
        assert_eq!(
            list_keys(k, 0),
            vec!["↑↓ 고르기", "a 추가", "Esc 뒤로"],
            "{k:?}"
        );
    }
    // 조건 수정 칸에는 `d 삭제`가 없다(spec §6.7 — 그 칸의 키가 아니다).
    assert_eq!(
        cond_form_keys(),
        vec!["Tab 다음 칸", "Space 켜기·끄기", "Enter 저장", "Esc 취소"]
    );
}

#[test]
fn large_list_keeps_cursor_visible() {
    let rows: Vec<ListRow> = (0..100).map(|i| row(&format!("조건-{i}"))).collect();
    let v = ListView {
        title: "성공 조건",
        rows,
        cursor: 99,
        overlay: None,
    };
    let (_, txt) = draw_list(80, 12, &v, &[]);
    assert!(txt.contains("▶ 100  조건-99"), "{txt}");
    let v = ListView {
        title: "성공 조건",
        rows: (0..100).map(|i| row(&format!("조건-{i}"))).collect(),
        cursor: 50,
        overlay: None,
    };
    let (_, txt) = draw_list(80, 12, &v, &[]);
    assert!(txt.contains("▶ 51   조건-50"), "{txt}");
    let vars = vars_view((0..100).map(|i| vrow(&format!("K{i}"), "v")).collect(), 99);
    let (_, txt) = draw_vars(80, 12, &vars, &[]);
    assert!(txt.contains("▶ K99"), "{txt}");
}

fn overlays<'a>(opts: &'a [String]) -> Vec<Option<OverlayView<'a>>> {
    vec![
        None,
        Some(OverlayView::Input {
            label: "기준선(ms)",
            text: "1800".into(),
            cursor_x: 4,
            hint: Some("1~600000".into()),
            error: Some("오류 문구"),
            share: Some("이 값을 쓰는 칸 4개가 함께 바뀝니다"),
        }),
        Some(OverlayView::Pick {
            title: "고르기",
            options: opts,
            cursor: 1,
        }),
        Some(OverlayView::Confirm(
            "1번을 지울까요? y 지우기 · 다른 키 취소",
        )),
        Some(OverlayView::Saving),
        Some(OverlayView::Notice("알림")),
    ]
}

#[test]
fn render_sweep_no_panic() {
    let opts: Vec<String> = vec!["가".into(), "나나".into(), "다다다".into()];
    let ops = ["= 같음", "≠ 다름", "키 있음"];
    let rows = || -> Vec<ListRow> {
        vec![
            ListRow {
                text: "800 ms 가나다".into(),
                color: Some("#f59e0b".into()),
                dim: false,
            },
            row("상태코드 = 200 · 주문 상세 · 대소문자 무시"),
            ListRow {
                text: String::new(),
                color: Some(String::new()),
                dim: true,
            },
        ]
    };
    let mut vr = vec![vrow("API_TOKEN", "••••••••"), vrow("한글키", "값")];
    vr.push(VarRow {
        key: "nonce".into(),
        value: String::new(),
        note: Some(text::VAR_SHAPE),
    });
    vr.push(vrow("", ""));
    for w in 1..=60u16 {
        for h in 1..=16u16 {
            for (oi, _) in overlays(&opts).iter().enumerate() {
                for cursor in [0usize, 1, 2, 7, usize::MAX] {
                    let ov = overlays(&opts).into_iter().nth(oi).unwrap();
                    let v = ListView {
                        title: "응답속도 기준선 · 주문 조회",
                        rows: rows(),
                        cursor,
                        overlay: ov,
                    };
                    let _ = draw_list(w, h, &v, &[text::KEYS_PICK, text::KEYS_EDIT]);
                    let ov = overlays(&opts).into_iter().nth(oi).unwrap();
                    let mut vv = vars_view(vr.clone(), cursor);
                    vv.overlay = ov;
                    let _ = draw_vars(w, h, &vv, &[text::KEYS_PICK]);
                }
            }
            let ov = ListView {
                title: "빈",
                rows: vec![],
                cursor: usize::MAX,
                overlay: None,
            };
            let _ = draw_list(w, h, &ov, &[]);
            let mut ld = vars_view(vec![], 0);
            ld.loading = true;
            let _ = draw_vars(w, h, &ld, &[]);
            ld.loading = false;
            ld.failed = Some("서버 문구가 아주 길어서 좁은 화면에서는 잘려야 합니다");
            let _ = draw_vars(w, h, &ld, &[]);
            for op in 0..3 {
                for focus in [
                    CondFocus::Op,
                    CondFocus::Value,
                    CondFocus::IgnoreCase,
                    CondFocus::Trim,
                ] {
                    let mut f = form(op.min(1), &ops, focus);
                    f.op = op.min(2);
                    f.value = (op == 0).then(|| ("값값값".to_string(), usize::MAX));
                    f.error = Some("오류");
                    let _ = draw_form(w, h, &f);
                }
            }
        }
    }
    // 큰 화면.
    let v = ListView {
        title: "성공 조건",
        rows: rows(),
        cursor: 1,
        overlay: None,
    };
    let (_, txt) = draw_list(200, 60, &v, &[]);
    assert!(txt.contains("▶ 2"));
    let (buf, _) = draw_vars(200, 60, &vars_view(vr, 1), &[]);
    for y in 0..buf.area.height {
        let line: String = (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect();
        assert!(width(&line) <= 200 * 2);
    }
}

/// 리뷰 B4: 조건 수정 칸이 열려 있으면 목록은 폼 높이만큼 줄어든 영역에 그려져 고른(마지막) 줄 `▶`가 폼 위에 보인다.
#[test]
fn cond_form_does_not_hide_selected_row() {
    use handicap_tui::view::edit::render_list_with_form;
    let rows: Vec<ListRow> = (1..=12).map(|i| row(&format!("조건-{i:02}"))).collect();
    let ops = ["= 같음", "키 있음"];
    let fv = form(0, &ops, CondFocus::Op);
    for h in [12u16, 14, 16, 20, 24] {
        let v = ListView {
            title: "성공 조건 · 핑",
            rows: rows.clone(),
            cursor: 11,
            overlay: None,
        };
        let mut t = Terminal::new(TestBackend::new(60, h)).unwrap();
        t.draw(|f| render_list_with_form(f, &head(), &v, &[], Some(&fv)))
            .unwrap();
        let txt = buffer_text(t.backend().buffer());
        let lines: Vec<&str> = txt.lines().collect();
        let sel = lines
            .iter()
            .position(|l| l.contains("▶") && l.contains("조건-12"))
            .unwrap_or_else(|| panic!("h{h}: selected row hidden\n{txt}"));
        let target = lines
            .iter()
            .position(|l| l.contains("대상"))
            .unwrap_or_else(|| panic!("h{h}: form missing\n{txt}"));
        assert!(sel < target, "h{h}: selected row below form\n{txt}");
    }
    // 폼 없음 = render_list와 같은 화면.
    let v = ListView {
        title: "성공 조건 · 핑",
        rows: rows.clone(),
        cursor: 11,
        overlay: None,
    };
    let mut a = Terminal::new(TestBackend::new(60, 16)).unwrap();
    a.draw(|f| render_list_with_form(f, &head(), &v, &[], None))
        .unwrap();
    let mut b = Terminal::new(TestBackend::new(60, 16)).unwrap();
    b.draw(|f| render_list(f, &head(), &v, &[])).unwrap();
    assert_eq!(a.backend().buffer(), b.backend().buffer());
    // 아주 작은 화면에서도 패닉 없음.
    for w in 1..=20u16 {
        for h in 1..=8u16 {
            let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
            t.draw(|f| render_list_with_form(f, &head(), &v, &[], Some(&fv)))
                .unwrap();
        }
    }
}

// ---------- tui-2b Task 7 (리뷰 접음 a): 조건 칸의 `받은 값`은 sanitize 전에 앞부분만 ----------

#[test]
fn cond_form_long_received_is_clipped_before_sanitize() {
    // 순수 함수: 폭의 4배(글자 수) 이하로 자르고, 잘렸는지 알려 준다.
    let long: String = "가".repeat(50_000) + &"x".repeat(50_000);
    for fw in [0usize, 1, 10, 47, 200] {
        let (head, cut) = received_head(&long, fw);
        assert!(head.chars().count() <= fw.max(1) * 4, "{fw}");
        assert!(long.starts_with(head));
        assert!(cut, "{fw}");
    }
    assert_eq!(received_head("\"OK\"", 47), ("\"OK\"", false));
    assert_eq!(
        received_head("abcd", 1),
        ("abcd", false),
        "딱 상한이면 안 자른다"
    );
    assert_eq!(received_head("abcde", 1), ("abcd", true));
    // 그리기: 10만 자 받은 값 — 앞부분이 보이고 끝이 `…`, 패닉 없음.
    let ops = ["= 같음", "키 있음"];
    let mut v = form(0, &ops, CondFocus::Op);
    let r = "AB".to_string() + &"z".repeat(100_000);
    v.received = Some(&r);
    let (_, txt) = draw_form(60, 8, &v);
    let line = txt.lines().nth(1).unwrap().trim_end();
    assert!(line.starts_with(" 받은 값 ABzzz"), "{txt}");
    assert!(line.ends_with('…'), "{line}");
    // 폭이 아주 좁아도(값 칸 0~몇 칸) 패닉 없음.
    for w in 1..16 {
        draw_form(w, 8, &v);
    }
    // 잘린 앞부분이 폭보다 좁아도(폭 0 글자) 잘렸다는 `…`가 남는다.
    let zw = "\u{0301}".repeat(5_000) + "끝";
    v.received = Some(&zw);
    let (_, txt) = draw_form(60, 8, &v);
    let line = txt.lines().nth(1).unwrap().trim_end();
    assert!(line.ends_with('…'), "{line}");
    assert!(!line.contains('끝'), "{line}");
}

// ---------- tui-2b-polish: 대상 줄바꿈 ----------

/// 조건 칸 값 칸이 시작하는 열(들여쓰기 2 + 라벨 칸 9) — 화면 폭 13 이상.
const FORM_VALUE_X: usize = 11;

/// 시험용 긴 대상 — 마디마다 번호를 섞어 줄 순서가 바뀌면 이어 붙인 글자가 달라진다. 정확히 `n`자(ASCII).
fn long_target(n: usize) -> String {
    let mut s = String::from("$.");
    let mut i = 0;
    while s.len() < n {
        s.push_str(&format!("seg{i:03}abc."));
        i += 1;
    }
    s.truncate(n);
    s
}

/// 표시 폭 `cols` 뒤의 글자.
fn after_cols(line: &str, cols: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in line.chars() {
        if used >= cols {
            out.push(c);
        } else {
            used += width(c.encode_utf8(&mut [0; 4]));
        }
    }
    out
}

/// 조건 칸 라벨 줄(들여쓰기 2 + ` 라벨`)인가.
fn is_label(line: &str, label: &str) -> bool {
    line.starts_with(&format!("   {label} "))
}

/// `대상` 라벨 줄부터 다음 라벨 줄(`받은 값`·`규칙`) 전까지의 줄 번호들.
fn target_line_ids(lines: &[&str]) -> Vec<usize> {
    let Some(start) = lines
        .iter()
        .position(|l| is_label(l, text::COND_FORM_TARGET))
    else {
        return vec![];
    };
    let end = (start + 1..lines.len())
        .find(|&i| {
            is_label(lines[i], text::PICK_COL_VALUE) || is_label(lines[i], text::COND_FORM_OP)
        })
        .unwrap_or(lines.len());
    (start..end).collect()
}

fn cond_list() -> Vec<ListRow> {
    (1..=12).map(|i| row(&format!("조건-{i:02}"))).collect()
}

fn draw_list_form(w: u16, h: u16, v: &ListView, fv: &CondFormView) -> String {
    use handicap_tui::view::edit::render_list_with_form;
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render_list_with_form(f, &head(), v, &[], Some(fv)))
        .unwrap();
    buffer_text(t.backend().buffer())
}

fn cond_list_view(rows: &[ListRow]) -> ListView<'_> {
    ListView {
        title: "성공 조건 · 핑",
        rows: rows.to_vec(),
        cursor: rows.len().saturating_sub(1),
        overlay: None,
    }
}

#[test]
fn cond_form_target_wraps_fully() {
    let target = long_target(500);
    assert_eq!(target.len(), 500);
    let ops = ["= 같음", "키 있음"];
    let mut fv = form(0, &ops, CondFocus::Op);
    fv.target = &target;
    let rows = cond_list();
    let txt = draw_list_form(80, 24, &cond_list_view(&rows), &fv);
    let lines: Vec<&str> = txt.lines().collect();
    let ids = target_line_ids(&lines);
    assert_eq!(ids.len(), 8, "500자 / 69칸 = 8줄\n{txt}");
    let joined: String = ids
        .iter()
        .map(|&i| after_cols(lines[i], FORM_VALUE_X).trim_end().to_string())
        .collect();
    assert_eq!(joined, target, "{txt}");
    // 이어지는 줄은 라벨 칸이 빈칸.
    for &i in &ids[1..] {
        assert!(lines[i].starts_with(&" ".repeat(FORM_VALUE_X)), "{txt}");
    }
}

#[test]
fn cond_form_target_ellipsis_when_short() {
    let target = long_target(500);
    let ops = ["= 같음", "키 있음"];
    let mut fv = form(0, &ops, CondFocus::Op);
    fv.target = &target;
    let short = form(0, &ops, CondFocus::Op);
    let rows = cond_list();
    let v = cond_list_view(&rows);
    let mut ellipsis_seen = 0;
    for h in (5..=24u16).rev() {
        let txt = draw_list_form(80, h, &v, &fv);
        let lines: Vec<&str> = txt.lines().collect();
        // 필수 줄: `규칙`은 한 줄 대상 조건 칸에서 보이면 긴 쪽에서도 보인다.
        let short_txt = draw_list_form(80, h, &v, &short);
        if short_txt.lines().any(|l| is_label(l, text::COND_FORM_OP)) {
            assert!(
                lines.iter().any(|l| is_label(l, text::COND_FORM_OP)),
                "h{h}: 규칙 줄 없음\n{txt}"
            );
        }
        let ids = target_line_ids(&lines);
        assert!(!ids.is_empty(), "h{h}: 대상 줄 없음\n{txt}");
        let joined: String = ids
            .iter()
            .map(|&i| after_cols(lines[i], FORM_VALUE_X).trim_end().to_string())
            .collect();
        if joined != target {
            let last = lines[*ids.last().unwrap()].trim_end();
            assert!(last.ends_with('…'), "h{h}: 잘린 대상의 마지막 줄\n{txt}");
            ellipsis_seen += 1;
        }
    }
    assert!(ellipsis_seen >= 1, "스윕 안에 잘린 높이가 없다 — 공허");
}

#[test]
fn cond_form_keeps_selected_row_with_long_target() {
    let target = long_target(500);
    let ops = ["= 같음", "키 있음"];
    let mut long = form(0, &ops, CondFocus::Op);
    long.target = &target;
    let short = form(0, &ops, CondFocus::Op);
    let rows = cond_list();
    let v = cond_list_view(&rows);
    assert_eq!(v.cursor, 11);
    let sel = |txt: &str| {
        txt.lines()
            .position(|l| l.contains("▶") && l.contains("조건-12"))
    };
    let mut checked = 0;
    for h in 8..=24u16 {
        let s_txt = draw_list_form(80, h, &v, &short);
        if sel(&s_txt).is_none() {
            continue;
        }
        checked += 1;
        let txt = draw_list_form(80, h, &v, &long);
        let lines: Vec<&str> = txt.lines().collect();
        let s = sel(&txt).unwrap_or_else(|| panic!("h{h}: 고른 줄이 가려짐\n{txt}"));
        let t = lines
            .iter()
            .position(|l| is_label(l, text::COND_FORM_TARGET))
            .unwrap_or_else(|| panic!("h{h}: 대상 줄 없음\n{txt}"));
        assert!(s < t, "h{h}: 고른 줄이 대상 줄 아래\n{txt}");
    }
    assert!(
        checked >= 10,
        "짧은 대상에서 고른 줄이 보이는 높이가 너무 적다: {checked}"
    );
}

#[test]
fn cond_form_width_sweep() {
    use handicap_tui::view::edit::cond_form_value_width;
    let ascii = long_target(500);
    let hangul = "$.가나다라마바사아자차".repeat(20);
    let ops = ["= 같음", "키 있음"];
    let rows = cond_list();
    let v = cond_list_view(&rows);
    for target in [&ascii, &hangul] {
        let mut fv = form(0, &ops, CondFocus::Op);
        fv.target = target;
        for w in 1..=120u16 {
            for h in [6u16, 10, 24] {
                let txt = draw_list_form(w, h, &v, &fv);
                let lines: Vec<&str> = txt.lines().collect();
                let fw = cond_form_value_width(w);
                if (13..=18).contains(&w) {
                    assert!(fw < 8, "w{w}: fw {fw}");
                    let ids = target_line_ids(&lines);
                    assert_eq!(ids.len(), 1, "w{w} h{h}: fw<8은 한 줄\n{txt}");
                    assert!(
                        is_label(lines[ids[0] + 1], text::COND_FORM_OP),
                        "w{w} h{h}: 규칙 줄이 대상 바로 다음\n{txt}"
                    );
                }
                if w == 19 && h != 6 {
                    assert_eq!(fw, 8);
                    let ids = target_line_ids(&lines);
                    assert!(ids.len() >= 2, "w{w} h{h}: fw 8은 줄바꿈\n{txt}");
                }
            }
        }
    }
}

#[test]
fn cond_form_wide_and_bidi() {
    let hangul = "$.가나다라마바사아자차".repeat(20);
    let ops = ["= 같음", "키 있음"];
    let rows = cond_list();
    let v = cond_list_view(&rows);
    let mut fv = form(0, &ops, CondFocus::Op);
    fv.target = &hangul;
    // 넓은 글자가 화면 폭을 넘지 않는다.
    for w in [20u16, 33, 61, 80, 81] {
        let txt = draw_list_form(w, 24, &v, &fv);
        for l in txt.lines() {
            assert!(width(l) <= usize::from(w), "w{w}: {l}");
        }
    }
    // 잘리는 높이에서 마지막 대상 줄이 `…`.
    let txt = draw_list_form(80, 12, &v, &fv);
    let lines: Vec<&str> = txt.lines().collect();
    let ids = target_line_ids(&lines);
    assert!(ids.len() >= 2, "{txt}");
    assert!(
        lines[*ids.last().unwrap()].trim_end().ends_with('…'),
        "{txt}"
    );
    // 둘째 줄 이후 자리의 bidi 제어 문자는 이어지는 줄에 `\u{FFFD}`로 보인다.
    let mut bidi = long_target(500);
    bidi.replace_range(100..101, "\u{202E}");
    fv.target = &bidi;
    let txt = draw_list_form(80, 24, &v, &fv);
    assert!(!txt.contains('\u{202E}'), "{txt}");
    let lines: Vec<&str> = txt.lines().collect();
    let ids = target_line_ids(&lines);
    assert!(!lines[ids[0]].contains('\u{FFFD}'), "{txt}");
    assert!(
        ids[1..].iter().any(|&i| lines[i].contains('\u{FFFD}')),
        "이어지는 줄에 \\u{{FFFD}} 없음\n{txt}"
    );
}

#[test]
fn cond_form_height_matches_drawn() {
    use handicap_tui::view::edit::cond_form_height;
    use handicap_tui::view::inspect::sub_layout;
    let w = 80u16;
    let ops = ["= 같음", "키 있음"];
    let rows = cond_list();
    let v = cond_list_view(&rows);
    for body_h in [5u16, 8, 12, 21] {
        let h = (1..=60u16)
            .find(|&h| sub_layout(Rect::new(0, 0, w, h)).body.height == body_h)
            .unwrap_or_else(|| panic!("body {body_h} 화면 높이 없음"));
        let body = sub_layout(Rect::new(0, 0, w, h)).body;
        for len in [10usize, 70, 200, 500] {
            let target = long_target(len);
            for extras in [false, true] {
                let mut fv = form(0, &ops, CondFocus::Op);
                fv.target = &target;
                if extras {
                    fv.received = Some("\"OK\"");
                    fv.hint = Some("매번 바뀌는 값이면 실패합니다");
                }
                let fh = cond_form_height(&fv, body.width, body.height);
                assert!(fh <= body.height);
                let txt = draw_list_form(w, h, &v, &fv);
                let lines: Vec<&str> = txt.lines().collect();
                let bottom = usize::from(body.y + body.height);
                let top = bottom - usize::from(fh);
                let area = &lines[top..bottom];
                let ctx = format!("body{body_h} len{len} extras{extras} fh{fh}\n{txt}");
                // ⓐ 빈 줄 없음.
                for l in area {
                    assert!(!l.trim().is_empty(), "빈 줄: {ctx}");
                }
                // ⓑ 첫 줄 = 대상 라벨, 영역 안에 규칙 라벨.
                assert!(is_label(area[0], text::COND_FORM_TARGET), "{ctx}");
                assert!(
                    area.iter().any(|l| is_label(l, text::COND_FORM_OP)),
                    "{ctx}"
                );
                // ⓒ 다 들어가는 높이에서는 대상 줄 수 == 줄바꿈 줄 수.
                if body_h == 21 {
                    let ids = target_line_ids(area);
                    assert_eq!(ids.len(), len.div_ceil(69), "{ctx}");
                }
            }
        }
    }
}

#[test]
fn cond_form_height_short_target_unchanged() {
    use handicap_tui::view::edit::cond_form_height;
    let ops = ["= 같음", "키 있음"];
    // 필수 4줄(대상·규칙·값·체크).
    let fv = form(0, &ops, CondFocus::Op);
    assert_eq!(cond_form_height(&fv, 80, 21), 4);
    // + 받은 값·안내.
    let mut fv = form(0, &ops, CondFocus::Op);
    fv.received = Some("\"OK\"");
    fv.hint = Some("매번 바뀌는 값이면 실패합니다");
    assert_eq!(cond_form_height(&fv, 80, 21), 6);
    // 값을 안 쓰는 규칙 = 대상·규칙.
    let fv = form(1, &ops, CondFocus::Op);
    assert_eq!(cond_form_height(&fv, 80, 21), 2);
    // 본문이 낮으면 본문 높이.
    let fv = form(0, &ops, CondFocus::Op);
    assert_eq!(cond_form_height(&fv, 80, 3), 3);
    // 오류 줄 + 좁은 폭.
    let mut fv = form(0, &ops, CondFocus::Op);
    fv.error = Some("값이 비어 있습니다");
    assert_eq!(cond_form_height(&fv, 15, 10), 5);
}
