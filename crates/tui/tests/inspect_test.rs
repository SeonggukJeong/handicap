//! 오류 보기 — 목록 모델·커서·사유 캐시·화면 틀·목록 그리기(spec §5.3-1, 목업 §1).

use std::collections::HashSet;

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::Threshold;
use handicap_tui::api::ApiError;
use handicap_tui::inspect::{
    ErrorRow, ErrorsInput, ErrorsState, ErrorsView, Reason, ReasonCache, cursor_index,
    error_results, errors_view, is_failure, move_cursor, reason_of, row_state, sanitize,
    visible_results, window_start,
};
use handicap_tui::judge::{PanelState, format_hms};
use handicap_tui::text;
use handicap_tui::view::inspect::{errors_list_height, render_errors, sub_layout};
use handicap_tui::view::monitor::HeaderView;
use handicap_tui::wire::CheckRecord;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::Span;

/// 행마다 셀 심볼을 잇되 넓은 문자 뒤 빈 채움 셀은 건너뛴다.
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
            let w = Span::raw(sym.to_string()).width();
            skip = w.saturating_sub(1);
            out.push_str(sym);
        }
        out.push('\n');
    }
    out
}

fn draw<F: FnOnce(&mut ratatui::Frame)>(w: u16, h: u16, f: F) -> String {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(f).unwrap();
    buffer_text(t.backend().buffer())
}

// ---------- fixtures ----------

const NOW: i64 = 1_700_000_000_000;

fn res(at: i64, verdict: Verdict, latency: Option<u64>) -> CheckResult {
    CheckResult {
        at_ms: at,
        verdict,
        latency_ms: latency,
        reason: None,
        detail: None,
        display: vec![],
    }
}

fn with_reason(mut r: CheckResult, reason: &str) -> CheckResult {
    r.reason = Some(reason.to_string());
    r
}

fn head() -> HeaderView {
    HeaderView {
        board_name: "운영 API 보드".into(),
        board_pos: (1, 1),
        server_time: Some(NOW),
        server_down: false,
        notice: None,
    }
}

fn th(ms: u32) -> Threshold {
    Threshold {
        ms,
        color: "#f59e0b".into(),
    }
}

fn row(at: i64, state: PanelState, latency: Option<u64>, reason: Reason) -> ErrorRow {
    ErrorRow {
        at_ms: at,
        state,
        latency_ms: latency,
        reason,
    }
}

fn known(s: &str) -> Reason {
    Reason::Known {
        reason: Some(s.to_string()),
        detail: None,
    }
}

fn at(k: i64) -> i64 {
    NOW - k * 5000
}

/// 목업 §1 — 실패만 보기, 커서는 첫 줄.
fn sample_view() -> ErrorsView {
    ErrorsView {
        title: "주문 조회".into(),
        rows: vec![
            row(at(0), PanelState::Fail, None, known("HTTP 503")),
            row(at(1), PanelState::Blocked, None, known("앞 단계 실패")),
            row(at(2), PanelState::Fail, None, Reason::Loading),
            row(at(3), PanelState::ConfigError, None, Reason::Gone),
        ],
        cursor: Some(0),
        failures: 3,
        total: 5,
        span_secs: 25,
        show_all: false,
        board_off: false,
    }
}

fn keys() -> Vec<&'static str> {
    vec!["↑↓ 고르기", "Enter 자세히", "a 전체 회차", "Esc 모니터로"]
}

fn render_view(w: u16, h: u16, v: &ErrorsView) -> String {
    let k = keys();
    draw(w, h, |f| render_errors(f, &head(), v, &k))
}

// ---------- sanitize ----------

#[test]
fn sanitize_replaces_control_chars() {
    assert_eq!(sanitize("a\tb"), "a    b");
    assert_eq!(sanitize("a\rb"), "ab");
    assert_eq!(sanitize("x\x1b[31my"), "x\u{FFFD}[31my");
    assert_eq!(sanitize("\u{7}"), "\u{FFFD}");
    // bidi 제어(대상 응답이 줄을 시각적으로 뒤집어 URL·상태를 다르게 보이게 하는 것)도 치환
    for c in [
        '\u{202A}', '\u{202E}', '\u{2066}', '\u{2069}', '\u{200E}', '\u{200F}', '\u{061C}',
    ] {
        assert_eq!(sanitize(&format!("a{c}b")), "a\u{FFFD}b", "{:?}", c);
    }
    assert_eq!(sanitize("a\u{2028}b\u{2029}"), "a\u{FFFD}b\u{FFFD}");
    assert_eq!(sanitize("한글 OK"), "한글 OK");
}

#[test]
fn render_errors_sanitizes_reason() {
    let mut v = sample_view();
    v.rows[0].reason = known("a\x1bb\tc");
    v.title = "주문\x1b조회".into();
    let t = render_view(100, 14, &v);
    // ratatui가 그릴 때 제어 문자 grapheme을 이미 걸러 이 단언만으론 공허하다 —
    // 회귀 가드는 아래 `a\u{FFFD}b    c` 긍정 단언.
    assert!(!t.contains('\x1b'), "{t}");
    assert!(t.contains("a\u{FFFD}b    c"), "{t}");
    assert!(t.contains("주문\u{FFFD}조회"), "{t}");
}

// ---------- 목록 모델 ----------

#[test]
fn error_results_filters_and_orders() {
    let rs = vec![
        res(1, Verdict::Ok, Some(10)),
        res(2, Verdict::Fail, None),
        res(3, Verdict::ConfigError, None),
        res(4, Verdict::BranchSkipped, None),
        res(5, Verdict::UpstreamFailed, None),
    ];
    let only: Vec<i64> = error_results(&rs, false).iter().map(|r| r.at_ms).collect();
    assert_eq!(only, vec![5, 3, 2]);
    let all: Vec<i64> = error_results(&rs, true).iter().map(|r| r.at_ms).collect();
    assert_eq!(all, vec![5, 4, 3, 2, 1]);
    assert!(is_failure(Verdict::Fail));
    assert!(is_failure(Verdict::ConfigError));
    assert!(is_failure(Verdict::UpstreamFailed));
    assert!(!is_failure(Verdict::Ok));
    assert!(!is_failure(Verdict::BranchSkipped));
}

#[test]
fn row_state_matches_wall_rules() {
    let t = [th(800)];
    assert_eq!(
        row_state(&res(1, Verdict::Ok, Some(612)), &t),
        PanelState::Ok
    );
    assert_eq!(
        row_state(&res(1, Verdict::Ok, Some(1620)), &t),
        PanelState::Slow
    );
    assert_eq!(row_state(&res(1, Verdict::Ok, None), &t), PanelState::Ok);
    assert_eq!(
        row_state(&res(1, Verdict::Fail, None), &t),
        PanelState::Fail
    );
    assert_eq!(
        row_state(&res(1, Verdict::ConfigError, None), &t),
        PanelState::ConfigError
    );
    assert_eq!(
        row_state(&res(1, Verdict::UpstreamFailed, None), &t),
        PanelState::Blocked
    );
    assert_eq!(
        row_state(&res(1, Verdict::BranchSkipped, None), &t),
        PanelState::Skipped
    );
    assert_eq!(
        row_state(&res(1, Verdict::Ok, Some(9999)), &[]),
        PanelState::Ok
    );
}

#[test]
fn cursor_stays_on_same_round_when_new_results_arrive() {
    assert_eq!(cursor_index(&[30, 20, 10], Some(20)), 1);
    assert_eq!(cursor_index(&[40, 30, 20, 10], Some(20)), 2);
}

#[test]
fn cursor_falls_to_next_older_when_evicted() {
    assert_eq!(cursor_index(&[40, 30, 10], Some(20)), 2);
    assert_eq!(cursor_index(&[40, 30], Some(20)), 1);
    assert_eq!(cursor_index(&[], Some(20)), 0);
    assert_eq!(cursor_index(&[40, 30], None), 0);
}

#[test]
fn move_cursor_clamps() {
    let rows = [30, 20, 10];
    assert_eq!(move_cursor(&rows, None, 1), Some(20));
    assert_eq!(move_cursor(&rows, Some(10), 1), Some(10));
    assert_eq!(move_cursor(&rows, Some(30), -5), Some(30));
    assert_eq!(move_cursor(&rows, Some(30), 2), Some(10));
    assert_eq!(move_cursor(&[], Some(30), 1), None);
}

#[test]
fn window_start_cases() {
    assert_eq!(window_start(0, 10, 4), 0);
    assert_eq!(window_start(5, 10, 4), 3);
    assert_eq!(window_start(9, 10, 4), 6);
    assert_eq!(window_start(2, 3, 10), 0);
    assert_eq!(window_start(0, 0, 0), 0);
    assert_eq!(window_start(3, 10, 0), 0);
}

// ---------- 사유 캐시 ----------

#[test]
fn reason_for_latest_and_ok_need_no_fetch() {
    let latest = with_reason(res(3, Verdict::Fail, None), "HTTP 503");
    let old_fail = res(2, Verdict::Fail, None);
    let old_ok = res(1, Verdict::Ok, Some(10));
    let mut c = ReasonCache::default();
    assert_eq!(c.reason_for(&latest, true), known("HTTP 503"));
    assert_eq!(
        c.reason_for(&old_ok, false),
        Reason::Known {
            reason: None,
            detail: None
        }
    );
    assert_eq!(c.reason_for(&old_fail, false), Reason::Loading);
    let vis = [&latest, &old_fail, &old_ok];
    assert_eq!(c.wanted(&vis, Some(3)), vec![2]);
    c.mark_loading(&[2]);
    assert_eq!(c.wanted(&vis, Some(3)), Vec::<i64>::new());
    c.put(2, known("시간 초과"));
    assert_eq!(c.reason_for(&old_fail, false), known("시간 초과"));
}

#[test]
fn reason_of_maps_404_and_errors() {
    let gone = Err(ApiError {
        status: Some(404),
        message: "없음".into(),
    });
    assert_eq!(reason_of(gone), Reason::Gone);
    let failed = Err(ApiError {
        status: None,
        message: "m".into(),
    });
    assert_eq!(reason_of(failed), Reason::Failed("m".into()));
    let server = Err(ApiError {
        status: Some(500),
        message: "s".into(),
    });
    assert_eq!(reason_of(server), Reason::Failed("s".into()));
    let mut result = with_reason(res(7, Verdict::Fail, None), "HTTP 503");
    result.detail = Some("기대 200".into());
    let rec = CheckRecord {
        at_ms: 7,
        limit_kb: 64,
        result,
        trace: None,
        clipped: vec![],
    };
    assert_eq!(
        reason_of(Ok(rec)),
        Reason::Known {
            reason: Some("HTTP 503".into()),
            detail: Some("기대 200".into())
        }
    );
}

#[test]
fn cache_retain_drops_evicted() {
    let mut c = ReasonCache::default();
    c.put(1, known("a"));
    c.put(2, known("b"));
    c.retain(&HashSet::from([2]));
    assert_eq!(
        c.reason_for(&res(1, Verdict::Fail, None), false),
        Reason::Loading
    );
    assert_eq!(
        c.reason_for(&res(2, Verdict::Fail, None), false),
        known("b")
    );
}

// ---------- errors_view ----------

#[test]
fn errors_view_window_and_counts() {
    // 오래된 → 최신: at 1..=12, ok는 at 3·9.
    let rs: Vec<CheckResult> = (1..=12)
        .map(|a| {
            if a == 3 || a == 9 {
                res(a, Verdict::Ok, Some(100 + a as u64))
            } else {
                res(a, Verdict::Fail, None)
            }
        })
        .collect();
    let i = ErrorsInput {
        title: "주문 조회",
        results: &rs,
        thresholds: &[],
        interval_seconds: 5,
        enabled: true,
    };
    // 실패만 최신 순: [12,11,10,8,7,6,5,4,2,1] — 가운데(7, 5번째 줄).
    let st = ErrorsState {
        board_id: "B".into(),
        panel_id: "P".into(),
        show_all: false,
        cursor_at: Some(7),
        cache: ReasonCache::default(),
    };
    let v = errors_view(&i, &st, 4);
    assert_eq!(v.title, "주문 조회");
    assert_eq!(v.rows.len(), 4);
    let ats: Vec<i64> = v.rows.iter().map(|r| r.at_ms).collect();
    assert_eq!(ats, vec![10, 8, 7, 6]);
    assert_eq!(v.cursor, Some(2));
    assert_eq!(v.failures, 10);
    assert_eq!(v.total, 12);
    assert_eq!(v.span_secs, 60);
    assert!(!v.show_all);
    // 최신(12)은 /status 사유, 나머지 실패는 조회 전이라 Loading.
    let vis: Vec<i64> = visible_results(&rs, &st, 4)
        .iter()
        .map(|r| r.at_ms)
        .collect();
    assert_eq!(vis, ats);

    let st_all = ErrorsState {
        show_all: true,
        cursor_at: Some(9),
        ..st
    };
    let v = errors_view(&i, &st_all, 4);
    assert!(v.show_all);
    let ok_row = v.rows.iter().find(|r| r.at_ms == 9).unwrap();
    assert_eq!(ok_row.state, PanelState::Ok);
    assert_eq!(ok_row.latency_ms, Some(109));
    assert_eq!(v.rows.len(), 4);
    let vis: Vec<i64> = visible_results(&rs, &st_all, 4)
        .iter()
        .map(|r| r.at_ms)
        .collect();
    assert_eq!(vis, v.rows.iter().map(|r| r.at_ms).collect::<Vec<_>>());

    // 빈 목록 → cursor None.
    let empty = ErrorsInput { results: &[], ..i };
    let v = errors_view(&empty, &ErrorsState::default(), 4);
    assert!(v.rows.is_empty());
    assert_eq!(v.cursor, None);
    assert_eq!(v.total, 0);
}

#[test]
fn span_text_minutes_and_seconds() {
    assert_eq!(text::span_text(1500), "약 25분");
    assert_eq!(text::span_text(60), "약 1분");
    assert_eq!(text::span_text(45), "약 45초");
    assert_eq!(text::span_text(0), "약 0초");
}

// ---------- 화면 틀 ----------

#[test]
fn sub_layout_rows() {
    let l = sub_layout(Rect::new(0, 0, 100, 24));
    assert_eq!(l.head, Some(Rect::new(0, 0, 100, 1)));
    assert_eq!(l.keys, Some(Rect::new(0, 23, 100, 1)));
    assert_eq!(l.idle, Some(Rect::new(0, 22, 100, 1)));
    assert_eq!(l.body, Rect::new(0, 1, 100, 21));

    let l = sub_layout(Rect::new(0, 0, 100, 9));
    assert_eq!(l.idle, None);
    assert!(l.head.is_some() && l.keys.is_some());
    assert_eq!(l.body, Rect::new(0, 1, 100, 7));

    let l = sub_layout(Rect::new(0, 0, 30, 24));
    assert_eq!(l.idle, None);
    assert_eq!(l.body.height, 22);

    let l = sub_layout(Rect::new(0, 0, 80, 2));
    assert_eq!(l.head, None);
    assert_eq!(l.keys, Some(Rect::new(0, 1, 80, 1)));
    assert_eq!(l.body, Rect::new(0, 0, 80, 1));

    let l = sub_layout(Rect::new(0, 0, 80, 0));
    assert_eq!(l.keys, None);
    assert_eq!(l.head, None);
    assert_eq!(l.body.height, 0);

    // 목록 줄 수 = body - 제목 1 - (높이 ≥ 4면) 열 이름 1.
    assert_eq!(errors_list_height(Rect::new(0, 1, 100, 11)), 9);
    assert_eq!(errors_list_height(Rect::new(0, 1, 100, 3)), 2);
    assert_eq!(errors_list_height(Rect::new(0, 1, 100, 1)), 0);
    assert_eq!(errors_list_height(Rect::new(0, 1, 100, 0)), 0);
}

// ---------- 목록 그리기 ----------

#[test]
fn render_errors_shows_rows() {
    let t = render_view(100, 14, &sample_view());
    println!("{t}");
    let lines: Vec<&str> = t.lines().collect();
    assert!(lines[0].contains("Handicap 모니터 · 운영 API 보드"), "{t}");
    assert!(lines[1].contains("오류 보기 · 주문 조회"), "{t}");
    assert!(lines[1].contains("실패 3회 · 최근 5회(약 25초) 중"), "{t}");
    assert!(
        lines[2].contains("시각") && lines[2].contains("상태") && lines[2].contains("사유"),
        "{t}"
    );
    assert!(lines[3].starts_with("▶ "), "{t}");
    assert!(lines[3].contains(&format_hms(at(0))), "{t}");
    assert!(lines[3].contains("✖ 실패"), "{t}");
    assert!(lines[3].contains("HTTP 503"), "{t}");
    assert!(lines[4].starts_with("  "), "{t}");
    assert!(lines[4].contains("― 확인 못 함"), "{t}");
    assert!(lines[4].contains("앞 단계 실패"), "{t}");
    assert!(lines[5].contains("불러오는 중…"), "{t}");
    assert!(lines[6].contains("⚠ 설정 오류"), "{t}");
    assert!(lines[6].contains("기록 지남"), "{t}");
    // 열 위치가 목록과 같다(표시 폭 기준): 열 머리 글자가 첫 줄의 같은 열 글자와 같은 칸.
    let col = |line: &str, needle: &str| {
        line.find(needle)
            .map(|b| Span::raw(line[..b].to_string()).width())
    };
    assert_eq!(col(lines[2], "시각"), col(lines[3], &format_hms(at(0))));
    assert_eq!(col(lines[2], "상태"), col(lines[3], "✖ 실패"));
    assert_eq!(col(lines[2], "사유"), col(lines[3], "HTTP 503"));
    assert_eq!(col(lines[3], "HTTP 503"), col(lines[4], "앞 단계 실패"));
    assert_eq!(
        lines[lines.len() - 2].trim(),
        "5분 동안 입력이 없으면 모니터로 돌아갑니다"
    );
    assert_eq!(
        lines[lines.len() - 1].trim(),
        "↑↓ 고르기  Enter 자세히  a 전체 회차  Esc 모니터로"
    );
    assert!(!t.contains("판정 상세"), "{t}");
}

#[test]
fn render_errors_failed_reason_text() {
    let mut v = sample_view();
    v.rows[2].reason = Reason::Failed("응답 시간이 초과되었습니다".into());
    v.rows[1].reason = Reason::Known {
        reason: None,
        detail: None,
    };
    let t = render_view(120, 14, &v);
    assert!(
        t.contains("기록을 불러오지 못했습니다: 응답 시간이 초과되었습니다"),
        "{t}"
    );
    let line = t.lines().nth(4).unwrap();
    assert!(line.trim_end().ends_with(text::NO_VALUE), "{t}");
}

#[test]
fn render_errors_all_mode_shows_latency() {
    let v = ErrorsView {
        title: "주문 조회".into(),
        rows: vec![
            row(at(0), PanelState::Ok, Some(612), Reason::Loading),
            row(at(1), PanelState::Fail, None, known("HTTP 503")),
            row(at(2), PanelState::Slow, Some(1620), Reason::Loading),
            row(at(3), PanelState::Ok, None, Reason::Loading),
        ],
        cursor: Some(1),
        failures: 1,
        total: 5,
        span_secs: 25,
        show_all: true,
        board_off: false,
    };
    let t = render_view(100, 14, &v);
    println!("{t}");
    let lines: Vec<&str> = t.lines().collect();
    assert!(lines[1].contains("전체 5회"), "{t}");
    assert!(!lines[1].contains("실패 1회"), "{t}");
    assert!(
        lines[3].contains("✔ 정상") && lines[3].contains("612 ms"),
        "{t}"
    );
    assert!(lines[4].starts_with("▶ "), "{t}");
    assert!(
        lines[5].contains("▲ 느림") && lines[5].contains("1,620 ms"),
        "{t}"
    );
    assert!(lines[6].trim_end().ends_with(text::NO_VALUE), "{t}");
    assert!(!t.contains("불러오는 중"), "{t}");
}

#[test]
fn render_errors_empty_messages() {
    let mut v = sample_view();
    v.rows.clear();
    v.cursor = None;
    v.failures = 0;
    let t = render_view(100, 14, &v);
    assert!(t.contains("이 구간에 실패가 없습니다"), "{t}");
    v.show_all = true;
    v.total = 0;
    let t = render_view(100, 14, &v);
    assert!(t.contains("아직 점검 결과가 없습니다"), "{t}");
}

#[test]
fn render_errors_narrow_drops_whole_parts() {
    let mut v = sample_view();
    v.rows[0].reason = known("주문 상세: HTTP 503 Service Unavailable");
    let t = render_view(30, 14, &v);
    println!("{t}");
    assert!(!t.contains("5분 동안"), "{t}");
    assert!(!t.contains("실패 3회"), "{t}");
    assert!(!t.contains("최근 5회"), "{t}");
    assert!(t.contains('…'), "{t}");
    assert!(t.contains("오류 보기"), "{t}");
    for s in [
        PanelState::Fail,
        PanelState::Blocked,
        PanelState::ConfigError,
    ] {
        let label = text::state_label(s);
        let mark: String = label.chars().next().unwrap().to_string();
        if t.contains(&mark) {
            assert!(t.contains(label), "{label} 일부만: {t}");
        }
    }
    // 아주 좁으면 시각도 통째로 빠진다(잘린 시각 없음).
    for w in 1..=60u16 {
        let t = render_view(w, 14, &v);
        // 머리 줄 시계는 같은 시각이라 목록 줄만 본다.
        let list: String = t.lines().skip(1).collect::<Vec<_>>().join("\n");
        let hms = format_hms(at(0));
        let partial = &hms[..5];
        if list.contains(partial) {
            assert!(list.contains(&hms), "w={w} 잘린 시각: {t}");
        }
        for s in [
            PanelState::Fail,
            PanelState::Blocked,
            PanelState::ConfigError,
        ] {
            let label = text::state_label(s);
            let body: String = t.lines().skip(1).collect::<Vec<_>>().join("\n");
            let mark: String = label.chars().next().unwrap().to_string();
            if body.contains(&mark) {
                assert!(body.contains(label), "w={w} {label} 일부만: {t}");
            }
        }
    }
}

#[test]
fn errors_size_sweep_no_panic() {
    let base = sample_view();
    for cursor in [0usize, 1, 3] {
        let mut v = base.clone();
        v.cursor = Some(cursor);
        for w in 1..=60u16 {
            for h in 1..=12u16 {
                let _ = render_view(w, h, &v);
                let mut all = v.clone();
                all.show_all = true;
                let _ = render_view(w, h, &all);
            }
        }
    }
    let mut empty = base;
    empty.rows.clear();
    empty.cursor = None;
    for w in 1..=60u16 {
        for h in 1..=12u16 {
            let _ = render_view(w, h, &empty);
        }
    }
}

// ---------- 기록 상세 (Task 4, 목업 §2) ----------

use std::collections::BTreeMap;

use handicap_controller::monitor::config::PanelConfig;
use handicap_engine::{ScenarioTrace, StepKind, StepTrace, TracedRequest, TracedResponse};
use handicap_tui::inspect::{
    Note, RecordBody, RecordLoad, RecordState, RecordView, StepLine, branch_text,
    initial_step_cursor, load_of, neighbor_http, record_notes, record_view, step_lines,
};
use handicap_tui::judge::format_date_hms;
use handicap_tui::names::Names;
use handicap_tui::view::inspect::render_record;

/// `names_test.rs`의 `NESTED` 그대로.
const NESTED: &str = r#"
version: 1
name: 중첩
steps:
  - { id: "01J00000000000000000000A01", name: a, type: http, request: { method: GET, url: "/a" }, assert: [] }
  - id: "01J00000000000000000000L01"
    name: 반복
    type: loop
    repeat: 2
    do:
      - { id: "01J00000000000000000000A02", name: b, type: http, request: { method: GET, url: "/b" }, assert: [] }
  - id: "01J00000000000000000000I01"
    name: 분기
    type: if
    cond: { left: "{{code}}", op: eq, right: "200" }
    then:
      - { id: "01J00000000000000000000A03", name: c, type: http, request: { method: GET, url: "/c" }, assert: [] }
    elif:
      - cond: { left: "{{code}}", op: eq, right: "404" }
        then:
          - { id: "01J00000000000000000000A04", name: d, type: http, request: { method: GET, url: "/d" }, assert: [] }
    else:
      - { id: "01J00000000000000000000A05", name: e, type: http, request: { method: GET, url: "/e" }, assert: [] }
  - id: "01J00000000000000000000P01"
    name: 동시
    type: parallel
    branches:
      - name: x
        steps:
          - { id: "01J00000000000000000000A06", name: f, type: http, request: { method: GET, url: "/f" }, assert: [] }
      - name: y
        steps:
          - { id: "01J00000000000000000000A07", name: g, type: http, request: { method: GET, url: "/g" }, assert: [] }
"#;

/// `names_test.rs` `names_from_bundle_resolves`의 번들(S1·E1) 그대로.
fn names() -> Names {
    let file = serde_json::to_vec(&serde_json::json!({
        "format": "handicap-bundle",
        "format_version": 1,
        "boards": [],
        "scenarios": [{ "id": "S1", "yaml": NESTED }],
        "environments": [
            { "id": "E1", "name": "운영", "vars": { "K": "비밀" } }
        ]
    }))
    .unwrap();
    Names::from_bundle(&file)
}

fn sid(tail: &str) -> String {
    format!("01J00000000000000000000{tail}")
}

fn http(
    step: &str,
    loop_index: Option<u32>,
    status: Option<u16>,
    error: Option<&str>,
) -> StepTrace {
    StepTrace {
        step_id: sid(step),
        kind: StepKind::Http,
        loop_index,
        branch: None,
        request: Some(TracedRequest {
            method: "GET".into(),
            url: format!("http://h/{}", step.to_lowercase()),
            headers: BTreeMap::new(),
            body: None,
        }),
        response: status.map(|s| TracedResponse {
            status: s,
            latency_ms: 12,
            download_ms: None,
            headers: BTreeMap::new(),
            set_cookies: vec![],
            body: String::new(),
            body_truncated: false,
        }),
        extracted: BTreeMap::new(),
        unbound_vars: vec![],
        error: error.map(str::to_string),
        branch_eval: vec![],
        timed_out: false,
    }
}

fn if_row(step: &str, branch: &str) -> StepTrace {
    StepTrace {
        step_id: sid(step),
        kind: StepKind::If,
        loop_index: None,
        branch: Some(branch.into()),
        request: None,
        response: None,
        extracted: BTreeMap::new(),
        unbound_vars: vec![],
        error: None,
        branch_eval: vec![],
        timed_out: false,
    }
}

fn trace(steps: Vec<StepTrace>) -> ScenarioTrace {
    ScenarioTrace {
        ok: false,
        total_ms: 0,
        steps,
        final_vars: BTreeMap::new(),
        truncated: false,
        error: None,
    }
}

fn http_line(l: &StepLine) -> (usize, usize, &str, bool) {
    match l {
        StepLine::Http {
            trace_idx,
            no,
            name,
            focus,
            ..
        } => (*trace_idx, *no, name.as_str(), *focus),
        StepLine::If { .. } => panic!("if 줄: {l:?}"),
    }
}

#[test]
fn branch_text_cases() {
    assert_eq!(branch_text("none"), "(미매치)");
    assert_eq!(branch_text("then"), "then");
    assert_eq!(branch_text("else"), "else");
    assert_eq!(branch_text("elif_2"), "elif 2");
    assert_eq!(branch_text("elif_"), "elif_");
    assert_eq!(branch_text("elif_x"), "elif_x");
    assert_eq!(branch_text("x"), "x");
}

#[test]
fn step_lines_names_and_fields() {
    let mut t4 = http("A04", None, Some(503), Some("boom"));
    t4.timed_out = true;
    let tr = trace(vec![
        http("A01", None, Some(200), None),
        if_row("I01", "elif_0"),
        t4,
        http("Z99", Some(3), None, None),
    ]);
    let lines = step_lines(&tr, &names(), "S1", None);
    assert_eq!(lines.len(), 4);
    assert_eq!(
        lines[0],
        StepLine::Http {
            trace_idx: 0,
            no: 1,
            loop_index: None,
            name: "a".into(),
            method: Some("GET".into()),
            url: Some("http://h/a01".into()),
            status: Some(200),
            latency_ms: Some(12),
            error: None,
            timed_out: false,
            focus: false,
        }
    );
    assert_eq!(
        lines[1],
        StepLine::If {
            branch: "elif 0".into()
        }
    );
    assert_eq!(
        lines[2],
        StepLine::Http {
            trace_idx: 2,
            no: 2,
            loop_index: None,
            name: "d".into(),
            method: Some("GET".into()),
            url: Some("http://h/a04".into()),
            status: Some(503),
            latency_ms: Some(12),
            error: Some("boom".into()),
            timed_out: true,
            focus: false,
        }
    );
    // Names에 없는 step_id → 이름 = step_id, 응답 없음 → status/latency None.
    match &lines[3] {
        StepLine::Http {
            no,
            name,
            loop_index,
            status,
            latency_ms,
            ..
        } => {
            assert_eq!(*no, 3);
            assert_eq!(name, &sid("Z99"));
            assert_eq!(*loop_index, Some(3));
            assert_eq!(*status, None);
            assert_eq!(*latency_ms, None);
        }
        other => panic!("{other:?}"),
    }
    // 시나리오를 못 읽으면 이름 = step_id.
    let other = step_lines(&tr, &names(), "S2", None);
    assert_eq!(http_line(&other[0]).2, sid("A01"));
}

#[test]
fn focus_is_last_http_row_of_step() {
    let tr = trace(vec![
        http("A02", Some(0), Some(200), None),
        http("A02", Some(1), Some(200), None),
        if_row("A02", "then"),
        http("A03", None, Some(200), None),
    ]);
    let a02 = sid("A02");
    let lines = step_lines(&tr, &names(), "S1", Some(&a02));
    let focus: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l, StepLine::Http { focus: true, .. }))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(focus, vec![1]);
    let none = step_lines(&tr, &names(), "S1", None);
    assert!(
        none.iter()
            .all(|l| !matches!(l, StepLine::Http { focus: true, .. }))
    );
}

#[test]
fn initial_cursor_rules() {
    let a03 = sid("A03");
    let tr = trace(vec![
        if_row("I01", "then"),
        http("A01", None, Some(200), None),
        http("A02", None, None, Some("e")),
        http("A03", None, Some(200), None),
    ]);
    // focus 줄
    assert_eq!(
        initial_step_cursor(&step_lines(&tr, &names(), "S1", Some(&a03))),
        3
    );
    // focus 없음 → error 있는 첫 Http
    assert_eq!(
        initial_step_cursor(&step_lines(&tr, &names(), "S1", None)),
        2
    );
    // 둘 다 없음 → 첫 Http
    let plain = trace(vec![
        if_row("I01", "then"),
        http("A01", None, Some(200), None),
    ]);
    assert_eq!(
        initial_step_cursor(&step_lines(&plain, &names(), "S1", None)),
        1
    );
    assert_eq!(initial_step_cursor(&[]), 0);
}

#[test]
fn neighbor_http_skips_if_rows() {
    let tr = trace(vec![
        http("A01", None, Some(200), None),
        if_row("I01", "then"),
        http("A02", None, Some(200), None),
        http("A03", None, Some(200), None),
    ]);
    let l = step_lines(&tr, &names(), "S1", None);
    assert_eq!(neighbor_http(&l, 0, 1), Some(2));
    assert_eq!(neighbor_http(&l, 2, -1), Some(0));
    assert_eq!(neighbor_http(&l, 2, 1), Some(3));
    assert_eq!(neighbor_http(&l, 3, 1), None);
    assert_eq!(neighbor_http(&l, 0, -1), None);
    assert_eq!(neighbor_http(&[], 0, 1), None);
}

fn record(trace: Option<ScenarioTrace>, reason: Option<&str>, detail: Option<&str>) -> CheckRecord {
    let mut result = res(NOW, Verdict::Fail, Some(1204));
    result.reason = reason.map(str::to_string);
    result.detail = detail.map(str::to_string);
    CheckRecord {
        at_ms: NOW,
        limit_kb: 16,
        result,
        trace,
        clipped: vec![],
    }
}

#[test]
fn record_notes_match_gui_branches() {
    let none = record(None, None, None);
    assert_eq!(
        record_notes(&none, Verdict::ConfigError),
        vec![Note::NoTraceConfig]
    );
    assert_eq!(
        record_notes(&none, Verdict::Fail),
        vec![Note::NoTraceTimeout]
    );
    let mut t = trace(vec![]);
    t.error = Some("e".into());
    t.truncated = true;
    assert_eq!(
        record_notes(&record(Some(t), None, None), Verdict::Fail),
        vec![Note::TraceError("e".into()), Note::TraceCut]
    );
    assert_eq!(
        record_notes(&record(Some(trace(vec![])), None, None), Verdict::Fail),
        vec![]
    );
}

#[test]
fn load_of_maps_errors() {
    assert!(matches!(
        load_of(Ok(record(None, None, None))),
        RecordLoad::Loaded(_)
    ));
    assert!(matches!(
        load_of(Err(ApiError {
            status: Some(404),
            message: "x".into()
        })),
        RecordLoad::Gone
    ));
    match load_of(Err(ApiError {
        status: None,
        message: "m".into(),
    })) {
        RecordLoad::Failed(m) => assert_eq!(m, "m"),
        other => panic!("{other:?}"),
    }
}

fn panel(env: Option<&str>, step: Option<&str>) -> PanelConfig {
    PanelConfig {
        id: "P1".into(),
        title: "주문 조회".into(),
        scenario_id: "S1".into(),
        environment_id: env.map(str::to_string),
        thresholds: vec![th(800)],
        step_id: step.map(str::to_string),
        ..PanelConfig::default()
    }
}

fn rstate(load: RecordLoad, cursor: usize) -> RecordState {
    RecordState {
        board_id: "B1".into(),
        panel_id: "P1".into(),
        at_ms: NOW,
        clicked: res(NOW, Verdict::Fail, Some(1204)),
        load,
        cursor,
    }
}

#[test]
fn record_view_prefers_record_reason() {
    let rec = record(Some(trace(vec![])), Some("HTTP 503"), Some("d"));
    let st = rstate(RecordLoad::Loaded(Box::new(rec)), 0);
    let v = record_view(&panel(Some("E1"), None), &st, &names());
    assert_eq!(v.reason.as_deref(), Some("HTTP 503"));
    assert_eq!(v.detail.as_deref(), Some("d"));
    assert_eq!(v.state, PanelState::Fail);
    assert_eq!(v.latency_ms, Some(1204));
    assert_eq!(v.scenario, "중첩");
    assert_eq!(v.environment.as_deref(), Some("운영"));
    assert_eq!(
        v.title,
        text::record_title("주문 조회", &format_date_hms(NOW))
    );

    let loading = record_view(
        &panel(None, None),
        &rstate(RecordLoad::Loading, 0),
        &names(),
    );
    assert_eq!(loading.reason, None);
    assert_eq!(loading.detail, None);
    assert_eq!(loading.environment, None);
    assert_eq!(loading.body, RecordBody::Loading);

    // 이름이 없으면 id.
    let mut p = panel(Some("E9"), None);
    p.scenario_id = "S9".into();
    let v = record_view(&p, &rstate(RecordLoad::Gone, 0), &names());
    assert_eq!(v.scenario, "S9");
    assert_eq!(v.environment.as_deref(), Some("E9"));
    assert_eq!(v.body, RecordBody::Gone);
}

fn loaded_view() -> RecordView {
    let mut login = http("A01", None, Some(200), None);
    login.request.as_mut().unwrap().method = "POST".into();
    login.request.as_mut().unwrap().url = "http://h/login".into();
    let mut d = http("A04", None, Some(503), None);
    d.response.as_mut().unwrap().latency_ms = 781;
    let mut e = http("A05", None, None, Some("boom"));
    e.timed_out = true;
    let rec = record(
        Some(trace(vec![login, if_row("I01", "elif_0"), d, e])),
        Some("HTTP 503"),
        Some("기대 200"),
    );
    let a04 = sid("A04");
    let p = panel(Some("E1"), Some(&a04));
    let mut st = rstate(RecordLoad::Loaded(Box::new(rec)), 0);
    let v0 = record_view(&p, &st, &names());
    let RecordBody::Loaded { lines, .. } = &v0.body else {
        panic!()
    };
    st.cursor = initial_step_cursor(lines);
    record_view(&p, &st, &names())
}

fn rkeys() -> Vec<&'static str> {
    vec!["↑↓ 스텝 고르기", "Enter 요청·응답 보기", "Esc 목록으로"]
}

fn render_rec(w: u16, h: u16, v: &RecordView) -> String {
    let k = rkeys();
    draw(w, h, |f| render_record(f, &head(), v, &k))
}

#[test]
fn render_record_loaded() {
    let v = loaded_view();
    let t = render_rec(110, 22, &v);
    assert!(
        t.lines().next().unwrap().contains(text::MONITOR_TITLE),
        "{t}"
    );
    assert!(
        t.contains(&format!("주문 조회 · {}", format_date_hms(NOW))),
        "{t}"
    );
    for s in [
        "✖ 실패",
        "1,204 ms",
        "사유",
        "HTTP 503",
        "판정 상세",
        "기대 200",
        "시나리오",
        "중첩",
        "환경 운영",
        "스텝",
        "요청",
        "응답",
        "지연",
        "POST http://h/login",
        "503",
        "781 ms",
        "boom",
        "조건 분기 → elif 0",
        text::IDLE_NOTICE,
    ] {
        assert!(t.contains(s), "{s} 없음:\n{t}");
    }
    let focus: Vec<&str> = t.lines().filter(|l| l.contains("◀ 이 칸")).collect();
    assert_eq!(focus.len(), 1, "{t}");
    assert!(focus[0].trim_start().starts_with("▶ "), "{t}");
    assert!(focus[0].contains(" d "), "{t}");
    // 사유 줄의 `HTTP 503`이 아니라 스텝 표의 상태 칸에 503이 있어야 한다.
    assert!(focus[0].contains("503"), "{t}");
    let timeout = t.lines().find(|l| l.contains(" e ")).unwrap();
    assert!(
        timeout.contains("—") && timeout.contains("시간 초과"),
        "{t}"
    );
    // 오류 줄은 그 스텝 다음 줄.
    let lines: Vec<&str> = t.lines().collect();
    let i = lines.iter().position(|l| l.contains(" e ")).unwrap();
    assert!(lines[i + 1].contains("boom"), "{t}");
}

#[test]
fn render_record_no_env_omits_env_part() {
    let mut v = loaded_view();
    v.environment = None;
    let t = render_rec(110, 22, &v);
    assert!(t.contains("중첩"), "{t}");
    assert!(!t.contains("환경"), "{t}");
}

#[test]
fn render_record_sanitizes_remote_text() {
    let mut v = loaded_view();
    v.reason = Some("a\x1bb\tc".into());
    if let RecordBody::Loaded { lines, .. } = &mut v.body {
        for l in lines.iter_mut() {
            if let StepLine::Http { url, error, .. } = l {
                if let Some(u) = url {
                    *u = "http://h/x\x1by".into();
                }
                if error.is_some() {
                    *error = Some("bo\x1bom".into());
                }
            }
        }
    }
    let t = render_rec(110, 22, &v);
    // ratatui가 제어 문자 grapheme을 이미 걸러 이 단언만으론 공허하다 — 회귀 가드는 아래 긍정 단언.
    assert!(!t.contains('\x1b'), "{t}");
    assert!(t.contains("a\u{FFFD}b    c"), "{t}");
    assert!(t.contains("http://h/x\u{FFFD}y"), "{t}");
    assert!(t.contains("bo\u{FFFD}om"), "{t}");
    let mut v = loaded_view();
    if let RecordBody::Loaded { lines, .. } = &mut v.body {
        for l in lines.iter_mut() {
            if let StepLine::Http { name, .. } = l {
                *name = "na\x1bme".into();
            }
        }
    }
    let t = render_rec(110, 22, &v);
    assert!(t.contains("na\u{FFFD}me"), "{t}");
}

#[test]
fn render_record_states() {
    let base = loaded_view();
    let with = |body: RecordBody| {
        let mut v = base.clone();
        v.body = body;
        render_rec(110, 22, &v)
    };
    assert!(with(RecordBody::Loading).contains(text::LOADING));
    assert!(with(RecordBody::Gone).contains(text::RECORD_MISSING));
    let mut narrow = base.clone();
    narrow.body = RecordBody::Gone;
    assert!(render_rec(40, 22, &narrow).contains("이 점검의 기록이 없습니다"));
    assert!(with(RecordBody::Failed("m".into())).contains("기록을 불러오지 못했습니다: m"));
    let note = |n: Note| {
        with(RecordBody::Loaded {
            notes: vec![n],
            lines: vec![],
            cursor: 0,
        })
    };
    let t = note(Note::NoTraceConfig);
    assert!(t.contains(text::RECORD_NO_TRACE_CONFIG), "{t}");
    assert!(!t.contains("지연"), "스텝 줄 없으면 표 머리 없음: {t}");
    assert!(note(Note::NoTraceTimeout).contains(text::RECORD_NO_TRACE_TIMEOUT));
    assert!(note(Note::TraceError("x".into())).contains("점검 준비 중 오류: x"));
    assert!(note(Note::TraceCut).contains(text::RECORD_TRACE_CUT));
}

#[test]
fn render_record_short_height_keeps_a_step_row() {
    let v = loaded_view();
    let t = render_rec(110, 8, &v);
    assert!(t.contains("✖ 실패"), "{t}");
    assert!(t.contains("HTTP 503"), "{t}");
    assert!(t.contains("▶ "), "{t}");
    assert!(!t.contains("시나리오"), "{t}");
}

#[test]
fn record_size_sweep_no_panic() {
    let rows: Vec<StepTrace> = (0..30)
        .map(|i| {
            if i % 7 == 3 {
                if_row("I01", "none")
            } else {
                http("A01", Some(i), Some(200), (i % 5 == 0).then_some("err"))
            }
        })
        .collect();
    let rec = record(Some(trace(rows)), Some("HTTP 503"), Some("d"));
    let p = panel(Some("E1"), Some("01J00000000000000000000A01"));
    for cursor in [0usize, 15, 29] {
        let st = rstate(RecordLoad::Loaded(Box::new(rec.clone())), cursor);
        let v = record_view(&p, &st, &names());
        for w in 1..=60u16 {
            for h in 1..=12u16 {
                let _ = render_rec(w, h, &v);
            }
        }
    }
}

#[test]
fn header_sanitizes_board_name() {
    let mut hv = head();
    hv.board_name = "운영\t보드\x1b이름".into();
    for w in [20u16, 40, 60, 100] {
        let t = draw(w, 3, |f| {
            handicap_tui::view::monitor::render_header_view(f, Rect::new(0, 0, w, 1), &hv)
        });
        let first = t.lines().next().unwrap();
        assert!(
            Span::raw(first.to_string()).width() <= usize::from(w),
            "{t}"
        );
    }
    let t = draw(100, 3, |f| {
        handicap_tui::view::monitor::render_header_view(f, Rect::new(0, 0, 100, 1), &hv)
    });
    assert!(t.contains("운영    보드\u{FFFD}이름"), "{t}");
}

#[test]
fn render_record_keeps_error_row_under_cursor_at_window_bottom() {
    // 스텝 줄 창 높이 2: 커서 스텝(오류 있음)이 창 맨 아래에 오면 그 오류 줄이 잘렸었다.
    let rows: Vec<StepTrace> = (0..6)
        .map(|i| {
            http(
                "A01",
                Some(i),
                Some(200),
                (i == 2).then_some("cursor-step-error"),
            )
        })
        .collect();
    let rec = record(Some(trace(rows)), None, None);
    let p = panel(Some("E1"), None);
    let st = rstate(RecordLoad::Loaded(Box::new(rec)), 2);
    let v = record_view(&p, &st, &names());
    // 머리 1 + 키 1 + body 6(제목·상태·시나리오·표 머리 + 스텝 2줄).
    let t = render_rec(110, 8, &v);
    assert!(t.contains("▶ "), "{t}");
    assert!(t.contains("cursor-step-error"), "{t}");
}

// ---------- 요청·응답 본문 (Task 5, 목업 §3) ----------

use handicap_tui::inspect::{
    BodyInput, BodyLine, BodyLineKind, BodyState, PRETTY_MAX_BYTES, Pretty, body_lines, clip_flags,
    pretty_json,
};
use handicap_tui::view::inspect::{body_height, render_body};
use handicap_tui::wire::{ClipSide, Clipped};

/// 문자열(`"`…`"`) 밖의 JSON 공백을 뺀 글자열.
fn strip_ws_outside_strings(s: &str) -> String {
    let mut out = String::new();
    let (mut in_str, mut esc) = (false, false);
    for c in s.chars() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            ' ' | '\t' | '\n' | '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn json_of(p: Pretty) -> String {
    match p {
        Pretty::Json(s) => s,
        other => panic!("Json 아님: {other:?}"),
    }
}

#[test]
fn pretty_json_indents_objects_and_arrays() {
    assert_eq!(
        pretty_json(r#"{"error":"x","n":[1,2],"e":{},"a":[]}"#),
        Pretty::Json(
            "{\n  \"error\": \"x\",\n  \"n\": [\n    1,\n    2\n  ],\n  \"e\": {},\n  \"a\": []\n}"
                .into()
        )
    );
}

#[test]
fn pretty_json_preserves_tokens() {
    let src = r#"{"z":1.0,"a":1e3,"big":12345678901234567890,"s":"a{b,c}:\"d\" \\","k":null}"#;
    let p = json_of(pretty_json(src));
    let keys: Vec<usize> = ["\"z\"", "\"a\"", "\"big\"", "\"s\"", "\"k\""]
        .iter()
        .map(|k| p.find(k).unwrap_or_else(|| panic!("{k} 없음: {p}")))
        .collect();
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "키 순서: {p}");
    assert_eq!(strip_ws_outside_strings(&p), strip_ws_outside_strings(src));
    for tok in ["1.0", "1e3", "12345678901234567890"] {
        assert!(p.contains(tok), "{tok} 없음: {p}");
    }
    assert!(p.contains(r#""a{b,c}:\"d\" \\""#), "{p}");
    // 이미 들여쓴 JSON도 같은 결과(멱등).
    assert_eq!(json_of(pretty_json(&p)), p);
    let spaced = "{ \"z\" : 1.0 ,\n \"a\":1e3,\"big\":12345678901234567890,\"s\":\"a{b,c}:\\\"d\\\" \\\\\",\r\n\t\"k\" : null }";
    assert_eq!(json_of(pretty_json(spaced)), p);
}

#[test]
fn pretty_json_falls_back_to_raw() {
    assert_eq!(pretty_json("plain text"), Pretty::Raw);
    assert_eq!(pretty_json(r#"{"a":"#), Pretty::Raw);
    assert_eq!(pretty_json("42"), Pretty::Raw);
    assert_eq!(pretty_json(r#""s""#), Pretty::Raw);
    assert_eq!(pretty_json(""), Pretty::Raw);
    let big_json = format!(r#"{{"a":"{}"}}"#, "x".repeat(65_537 - 8));
    assert_eq!(big_json.len(), 65_537);
    assert!(big_json.len() > PRETTY_MAX_BYTES);
    assert_eq!(pretty_json(&big_json), Pretty::TooLarge);
    assert_eq!(pretty_json(&"p".repeat(65_537)), Pretty::TooLarge);
}

#[test]
fn pretty_json_depth_limit() {
    let nest = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    assert!(matches!(pretty_json(&nest(64)), Pretty::Json(_)));
    assert_eq!(pretty_json(&nest(65)), Pretty::TooDeep);
    let started = std::time::Instant::now();
    let worst = nest(32_000);
    assert_eq!(worst.len(), 64_000);
    assert_eq!(pretty_json(&worst), Pretty::TooDeep);
    let in_str = format!(r#"{{"s":"{}"}}"#, "[".repeat(100));
    assert!(matches!(pretty_json(&in_str), Pretty::Json(_)));
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn clip_flags_by_trace_index() {
    let c = vec![
        Clipped {
            step: 0,
            side: ClipSide::Request,
        },
        Clipped {
            step: 2,
            side: ClipSide::Response,
        },
    ];
    assert_eq!(clip_flags(&c, 0), (true, false));
    assert_eq!(clip_flags(&c, 2), (false, true));
    assert_eq!(clip_flags(&c, 1), (false, false));
}

fn body_step(req_body: Option<&str>, resp_body: Option<&str>) -> StepTrace {
    let mut s = http("A03", None, Some(503), None);
    let rq = s.request.as_mut().unwrap();
    rq.url = "http://h/orders/1042".into();
    rq.body = req_body.map(str::to_string);
    rq.headers = BTreeMap::from([
        ("accept".to_string(), "application/json".to_string()),
        ("authorization".to_string(), "Basic x".to_string()),
    ]);
    match resp_body {
        Some(b) => {
            let r = s.response.as_mut().unwrap();
            r.latency_ms = 781;
            r.body = b.to_string();
            r.headers = BTreeMap::from([("content-type".to_string(), "text/plain".to_string())]);
        }
        None => s.response = None,
    }
    s
}

fn binput(step: &StepTrace) -> BodyInput<'_> {
    BodyInput {
        panel_title: "주문 조회",
        at_ms: NOW,
        no: 3,
        name: "주문 상세",
        step,
        clipped_req: false,
        clipped_resp: false,
        limit_kb: 128,
        reveal: false,
    }
}

fn kinds_texts(l: &[BodyLine]) -> Vec<(BodyLineKind, &str)> {
    l.iter().map(|b| (b.kind, b.text.as_str())).collect()
}

/// 앞쪽 `Heading` 하나를 건너뛴 뒤 다음 `Heading` 전까지의 `Text` 줄(한 구역).
fn text_lines(l: &[BodyLine]) -> Vec<&str> {
    let skip = usize::from(l.first().is_some_and(|b| b.kind == BodyLineKind::Heading));
    l.iter()
        .skip(skip)
        .take_while(|b| b.kind != BodyLineKind::Heading)
        .filter(|b| b.kind == BodyLineKind::Text)
        .map(|b| b.text.as_str())
        .collect()
}

fn has(l: &[BodyLine], kind: BodyLineKind, text: &str) -> bool {
    l.iter().any(|b| b.kind == kind && b.text == text)
}

#[test]
fn request_body_hidden_until_reveal() {
    let s = body_step(Some("SECRET-PAYLOAD"), Some(""));
    let i = binput(&s);
    let l = body_lines(&i, 80);
    assert!(l.iter().all(|b| !b.text.contains("SECRET")), "{l:?}");
    assert!(has(&l, BodyLineKind::Note, "요청 본문은 가려져 있습니다"));
    assert!(has(&l, BodyLineKind::Heading, "요청 본문"));
    let i = BodyInput {
        reveal: true,
        ..binput(&s)
    };
    let l = body_lines(&i, 80);
    assert!(
        l.iter()
            .any(|b| b.kind == BodyLineKind::Text && b.text.contains("SECRET-PAYLOAD")),
        "{l:?}"
    );
    assert!(!has(&l, BodyLineKind::Note, "요청 본문은 가려져 있습니다"));
    for body in [None, Some("")] {
        let s = body_step(body, Some(""));
        let l = body_lines(&binput(&s), 80);
        assert!(!l.iter().any(|b| b.text == "요청 본문"), "{l:?}");
        assert!(!has(&l, BodyLineKind::Note, "요청 본문은 가려져 있습니다"));
    }
}

#[test]
fn body_lines_sections_and_notes() {
    let s = body_step(None, Some("line1\nline2"));
    let l = body_lines(&binput(&s), 80);
    assert_eq!(
        l[0],
        BodyLine {
            kind: BodyLineKind::Title,
            text: format!("주문 조회 · {} · 3 주문 상세", format_hms(NOW)),
        }
    );
    assert_eq!(
        l[1],
        BodyLine {
            kind: BodyLineKind::Summary,
            text: "GET http://h/orders/1042   →   503   781 ms".into(),
        }
    );
    assert_eq!(
        kinds_texts(&l[2..]),
        vec![
            (BodyLineKind::Heading, "요청 헤더"),
            (BodyLineKind::Text, "  accept         application/json"),
            (BodyLineKind::Text, "  authorization  Basic x"),
            (BodyLineKind::Heading, "응답 헤더"),
            (BodyLineKind::Text, "  content-type  text/plain"),
            (BodyLineKind::Heading, "응답 본문"),
            (BodyLineKind::Text, "  line1"),
            (BodyLineKind::Text, "  line2"),
        ]
    );

    // 응답 잘림·엔진 잘림.
    let mut s2 = body_step(None, Some("line1"));
    s2.response.as_mut().unwrap().body_truncated = true;
    let i = BodyInput {
        clipped_resp: true,
        ..binput(&s2)
    };
    let l = body_lines(&i, 80);
    let h = l.iter().position(|b| b.text == "응답 본문").unwrap();
    assert_eq!(
        (l[h + 1].kind, l[h + 1].text.as_str()),
        (BodyLineKind::Note, "기록 상한 128KB에서 잘림")
    );
    assert!(has(
        &l,
        BodyLineKind::Note,
        "1 MiB에서 잘림 — 실제 응답은 더 큼"
    ));

    // 요청 잘림 + 가림.
    let s3 = body_step(Some("p"), Some(""));
    let i = BodyInput {
        clipped_req: true,
        ..binput(&s3)
    };
    let l = body_lines(&i, 80);
    let n = l
        .iter()
        .position(|b| b.text == "요청 본문은 가려져 있습니다")
        .unwrap();
    assert_eq!(l[n + 1].text, "기록 상한 128KB에서 잘림");

    // 가린 인증 값 안내.
    let mut s4 = body_step(None, Some(""));
    s4.request
        .as_mut()
        .unwrap()
        .headers
        .insert("authorization".into(), "Bearer ••••".into());
    let l = body_lines(&binput(&s4), 80);
    assert_eq!(
        (l.last().unwrap().kind, l.last().unwrap().text.as_str()),
        (BodyLineKind::Note, "인증 값은 ••••로 가렸습니다")
    );
    let l = body_lines(&binput(&s), 80);
    assert!(!l.iter().any(|b| b.text.contains("가렸습니다")));

    // 오류·시간 초과·응답 없음.
    let mut s5 = body_step(None, None);
    s5.error = Some("boom".into());
    s5.timed_out = true;
    let l = body_lines(&binput(&s5), 80);
    assert!(has(&l, BodyLineKind::Error, "boom"));
    assert!(has(&l, BodyLineKind::Note, "시간 초과"));
    assert!(
        !l.iter()
            .any(|b| b.text == "응답 헤더" || b.text == "응답 본문")
    );
    assert_eq!(l[1].text, "GET http://h/orders/1042");
    assert!(!l[1].text.contains('→'));
}

#[test]
fn body_lines_json_body_is_indented() {
    let j = r#"{"error":"service_unavailable","trace_id":"9f"}"#;
    let s = body_step(None, Some(j));
    let l = body_lines(&binput(&s), 80);
    let h = l.iter().position(|b| b.text == "응답 본문").unwrap();
    assert_eq!(
        text_lines(&l[h..]),
        vec![
            "  {",
            "    \"error\": \"service_unavailable\",",
            "    \"trace_id\": \"9f\"",
            "  }"
        ]
    );
    // 잘린 본문 → 원문 한 줄.
    let i = BodyInput {
        clipped_resp: true,
        ..binput(&s)
    };
    let l = body_lines(&i, 80);
    let h = l.iter().position(|b| b.text == "응답 본문").unwrap();
    assert_eq!(text_lines(&l[h..]), vec![format!("  {j}").as_str()]);
    assert!(!l.iter().any(|b| b.text.contains("64KB")));
    // 66KB(JSON이든 평문이든) → 안내 + 원문.
    for big in [
        format!(r#"{{"a":"{}"}}"#, "x".repeat(66 * 1024)),
        "p".repeat(66 * 1024),
    ] {
        let s = body_step(None, Some(&big));
        let l = body_lines(&binput(&s), 70_000);
        assert!(has(
            &l,
            BodyLineKind::Note,
            "64KB를 넘는 본문은 원문으로 표시합니다"
        ));
        let h = l.iter().position(|b| b.text == "응답 본문").unwrap();
        assert_eq!(text_lines(&l[h..]), vec![format!("  {big}").as_str()]);
    }
    // 65단 중첩.
    let deep = format!("{}{}", "[".repeat(65), "]".repeat(65));
    let s = body_step(None, Some(&deep));
    let l = body_lines(&binput(&s), 200);
    assert!(has(
        &l,
        BodyLineKind::Note,
        "너무 깊게 중첩된 본문은 원문으로 표시합니다"
    ));
    assert!(has(&l, BodyLineKind::Text, &format!("  {deep}")));
    // 요청 본문 JSON + reveal.
    let s = body_step(Some(r#"{"user":"qa"}"#), Some(""));
    let i = BodyInput {
        reveal: true,
        ..binput(&s)
    };
    let l = body_lines(&i, 80);
    let h = l.iter().position(|b| b.text == "요청 본문").unwrap();
    assert_eq!(
        text_lines(&l[h..]),
        vec!["  {", "    \"user\": \"qa\"", "  }"]
    );
}

#[test]
fn body_lines_wrap_wide_text() {
    let s = body_step(None, Some(&"가".repeat(12)));
    let l = body_lines(&binput(&s), 10);
    let h = l.iter().position(|b| b.text == "응답 본문").unwrap();
    assert!(text_lines(&l[h..]).len() > 1, "{l:?}");
    for b in &l {
        assert!(Span::raw(b.text.clone()).width() <= 10, "{b:?}");
    }
    let _ = body_lines(&binput(&s), 0);
}

#[test]
fn body_lines_escape_sequence_is_inert() {
    let s = body_step(None, Some("\x1b[2J\x1b[Hpwned"));
    let l = body_lines(&binput(&s), 80);
    assert!(l.iter().all(|b| !b.text.contains('\x1b')), "{l:?}");
    assert!(l.iter().any(|b| b.text.contains("\u{FFFD}[2J")), "{l:?}");
    let s = body_step(None, Some("{\"a\":\"x\x1by\"}"));
    let l = body_lines(&binput(&s), 80);
    assert!(l.iter().all(|b| !b.text.contains('\x1b')), "{l:?}");
    assert!(l.iter().any(|b| b.text.contains("x\u{FFFD}y")), "{l:?}");
    let t = draw(80, 20, |f| render_body(f, &head(), &l, 0, &bkeys()));
    assert!(!t.contains('\x1b'), "{t}");
    assert!(t.contains("x\u{FFFD}y"), "{t}");
}

fn bkeys() -> Vec<&'static str> {
    vec!["↑↓ PgUp PgDn 스크롤", "←→ 이전·다음 스텝", "Esc 자세히로"]
}

fn many_lines(n: usize) -> Vec<BodyLine> {
    (0..n)
        .map(|i| BodyLine {
            kind: if i == 0 {
                BodyLineKind::Title
            } else {
                BodyLineKind::Text
            },
            text: format!("row-{i:02}"),
        })
        .collect()
}

#[test]
fn body_state_caches_and_clamps() {
    let s = body_step(Some("REQ\nREQ2\nREQ3"), Some("a\nb\nc"));
    let i = binput(&s);
    let mut st = BodyState::new(4);
    assert_eq!((st.line_idx, st.reveal, st.scroll), (4, false, 0));
    let n1 = st.ensure(&i, 40);
    assert_eq!(st.ensure(&i, 40), n1);
    assert_eq!(st.lines().len(), n1);
    st.reveal = true;
    let n2 = st.ensure(
        &BodyInput {
            reveal: true,
            ..binput(&s)
        },
        40,
    );
    assert_ne!(n1, n2);
    assert!(st.lines().iter().any(|b| b.text.contains("REQ")));
    // 폭을 바꾸면 다시 만든다(좁은 폭 → 줄바꿈으로 줄 수 증가).
    let n3 = st.ensure(
        &BodyInput {
            reveal: true,
            ..binput(&s)
        },
        8,
    );
    assert!(n3 > n2, "{n3} {n2}");

    // 가림 상태의 단일 소스는 `self.reveal` — 입력의 `reveal: true`는 무시한다.
    let s = body_step(Some("REQ-SECRET"), Some("a"));
    let mut st = BodyState::new(0);
    st.ensure(
        &BodyInput {
            reveal: true,
            ..binput(&s)
        },
        40,
    );
    assert!(
        !st.lines().iter().any(|b| b.text.contains("REQ-SECRET")),
        "self.reveal false인데 요청 본문이 보임"
    );
    st.reveal = true;
    st.ensure(&binput(&s), 40);
    assert!(st.lines().iter().any(|b| b.text.contains("REQ-SECRET")));
    st.reveal = false;
    st.ensure(
        &BodyInput {
            reveal: true,
            ..binput(&s)
        },
        40,
    );
    assert!(!st.lines().iter().any(|b| b.text.contains("REQ-SECRET")));

    // 30줄·height 10.
    let long = "x\n".repeat(30);
    let s = body_step(None, Some(&long));
    let i = binput(&s);
    let mut st = BodyState::new(0);
    let n = st.ensure(&i, 40);
    st.scroll_by(100, 10);
    assert_eq!(st.scroll, n - 10);
    st.scroll_by(-100, 10);
    assert_eq!(st.scroll, 0);
    st.scroll_to_end(10);
    assert_eq!(st.scroll, n - 10);
    st.scroll_by(5, n + 5);
    assert_eq!(st.scroll, 0);
    st.scroll_to_end(n + 5);
    assert_eq!(st.scroll, 0);
}

#[test]
fn render_body_scrolls_and_shows_position() {
    let l = many_lines(40);
    let area = Rect::new(0, 0, 80, 14);
    let h = body_height(area);
    assert_eq!(h, usize::from(sub_layout(area).body.height));
    let t = draw(80, 14, |f| render_body(f, &head(), &l, 0, &bkeys()));
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[0].contains(text::MONITOR_TITLE), "{t}");
    assert!(rows[1].contains("row-00"), "{t}");
    assert!(rows[1].trim_end().ends_with(&format!("{h}/40줄")), "{t}");
    assert!(rows[12].contains(text::IDLE_NOTICE), "{t}");
    assert!(rows[13].contains("Esc 자세히로"), "{t}");
    let t = draw(80, 14, |f| render_body(f, &head(), &l, 15, &bkeys()));
    let rows: Vec<&str> = t.lines().collect();
    assert!(rows[1].contains("row-15"), "{t}");
    assert!(
        rows[1].trim_end().ends_with(&format!("{}/40줄", 15 + h)),
        "{t}"
    );
    let short = many_lines(5);
    let t = draw(80, 14, |f| render_body(f, &head(), &short, 0, &bkeys()));
    assert!(!t.contains("줄\n") && !t.contains("/5줄"), "{t}");
    assert!(t.contains("row-04"), "{t}");
}

#[test]
fn body_size_sweep_no_panic() {
    let s = body_step(
        Some("REQ"),
        Some(&"{\"k\":[1,2,3],\"가\":\"나다\"}\n".repeat(3)),
    );
    for w in 1..=50u16 {
        let i = BodyInput {
            reveal: true,
            ..binput(&s)
        };
        let l = body_lines(&i, usize::from(w));
        for h in 1..=12u16 {
            let bh = body_height(Rect::new(0, 0, w, h));
            for scroll in [0, l.len() / 2, l.len().saturating_sub(bh)] {
                let _ = draw(w, h, |f| render_body(f, &head(), &l, scroll, &bkeys()));
            }
        }
    }
}

#[test]
fn body_lines_wrapped_rows_keep_indent() {
    // 본문·헤더 줄이 줄바꿈돼도 뒷줄이 0칸에서 시작하지 않는다(2칸 들여쓰기 유지).
    let long = "abcdefghij".repeat(6);
    let mut s = body_step(None, Some(&long));
    s.response.as_mut().unwrap().headers = BTreeMap::from([("x-long".to_string(), "v".repeat(50))]);
    for w in [10usize, 12, 20] {
        let l = body_lines(&binput(&s), w);
        let hh = l.iter().position(|b| b.text == "응답 헤더").unwrap();
        let hb = l.iter().position(|b| b.text == "응답 본문").unwrap();
        let rows: Vec<&BodyLine> = l[hh + 1..hb].iter().chain(l[hb + 1..].iter()).collect();
        assert!(rows.len() > 2, "w={w} {l:?}");
        for b in rows {
            assert!(b.text.starts_with("  "), "w={w} {:?}", b.text);
            assert!(Span::raw(b.text.clone()).width() <= w, "w={w} {:?}", b.text);
        }
    }
}

#[test]
fn body_lines_width_3_wide_text_fits() {
    // 폭 3이면 들여쓰기 뒤 1칸에 2칸 글자가 들어가 넘친다 — 들여쓰기 없이 감싼다.
    let s = body_step(None, Some("가나다라"));
    let l = body_lines(&binput(&s), 3);
    for b in &l {
        assert!(Span::raw(b.text.clone()).width() <= 3, "{b:?}");
    }
    let joined: String = l.iter().map(|b| b.text.trim()).collect();
    assert!(joined.contains("가나다라"), "{l:?}");
}

/// roadmap §B48 (2): 꺼진 보드(`/status` `enabled: false`)는 결과가 늘 비어 "실패 없음"과 구분되지 않는다 — 문구를 따로.
#[test]
fn errors_empty_when_board_off() {
    let off = ErrorsInput {
        title: "주문 조회",
        results: &[],
        thresholds: &[],
        interval_seconds: 5,
        enabled: false,
    };
    for show_all in [false, true] {
        let st = ErrorsState {
            show_all,
            ..ErrorsState::default()
        };
        let v = errors_view(&off, &st, 4);
        assert!(v.board_off);
        let t = render_view(80, 12, &v);
        assert!(t.contains("점검이 꺼져 있어 결과가 없습니다"), "{t}");
        assert!(!t.contains(text::ERRORS_EMPTY), "{t}");
        let on = ErrorsInput {
            enabled: true,
            ..off
        };
        let v = errors_view(&on, &st, 4);
        assert!(!v.board_off);
        let t = render_view(80, 12, &v);
        let want = if show_all {
            text::ERRORS_EMPTY_ALL
        } else {
            text::ERRORS_EMPTY
        };
        assert!(t.contains(want), "{t}");
        assert!(!t.contains("점검이 꺼져"), "{t}");
    }
    assert_eq!(text::ERRORS_EMPTY_OFF, "점검이 꺼져 있어 결과가 없습니다");
}
