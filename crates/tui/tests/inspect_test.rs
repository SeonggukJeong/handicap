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
    assert_eq!(sanitize("a\u{2028}b\u{2029}"), "a\u{FFFD}b\u{FFFD}");
    assert_eq!(sanitize("한글 OK"), "한글 OK");
}

#[test]
fn render_errors_sanitizes_reason() {
    let mut v = sample_view();
    v.rows[0].reason = known("a\x1bb\tc");
    v.title = "주문\x1b조회".into();
    let t = render_view(100, 14, &v);
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
