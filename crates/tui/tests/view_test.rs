//! 화면 렌더링 — 뷰 모델·시각 줄·줄 우선순위·격자·각 화면(ratatui `TestBackend`).

use std::path::Path;

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::{BoardConfig, DisplayItem, PanelConfig, Threshold};
use handicap_tui::judge::{PanelState, format_hm, format_hms};
use handicap_tui::logging::LogLoc;
use handicap_tui::poll::PollSnapshot;
use handicap_tui::prefs::BorderStyle;
use handicap_tui::session::{Stage, StartError};
use handicap_tui::view::axis::{Mark, axis_marks, axis_uses_seconds};
use handicap_tui::view::error::{render_error, render_usage};
use handicap_tui::view::graph::{column, label_width, threshold_rows};
use handicap_tui::view::model::{
    Bar, BarKind, BigValue, PanelView, Row, ThresholdView, build_panels, panel_rows_s, parse_hex,
};
use handicap_tui::view::monitor::{
    KeyBar, MonitorScreen, layout, panel_at, render, render_header_view, render_with_keys,
};
use handicap_tui::view::overlay::{render_help, render_quit_confirm};
use handicap_tui::wire::{BoardResponse, PanelStatus, StatusResponse};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
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

fn res(at: i64, verdict: Verdict, ms: Option<u64>) -> CheckResult {
    CheckResult {
        at_ms: at,
        verdict,
        latency_ms: ms,
        reason: None,
        detail: None,
        display: vec![],
    }
}
fn ok(at: i64, ms: u64) -> CheckResult {
    res(at, Verdict::Ok, Some(ms))
}
fn fail(at: i64, reason: &str) -> CheckResult {
    CheckResult {
        reason: Some(reason.to_string()),
        ..res(at, Verdict::Fail, None)
    }
}
fn panel(id: &str, title: &str) -> PanelConfig {
    PanelConfig {
        id: id.into(),
        title: title.into(),
        ..Default::default()
    }
}
fn board(panels: Vec<PanelConfig>, stats: bool) -> BoardResponse {
    BoardResponse {
        id: "b1".into(),
        name: "운영 API 보드".into(),
        config: BoardConfig {
            panels,
            show_latency_stats: stats,
            ..Default::default()
        },
        enabled: true,
        created_at: 0,
        updated_at: 0,
    }
}
fn pstatus(id: &str, results: Vec<CheckResult>, consec: u32, since: Option<i64>) -> PanelStatus {
    PanelStatus {
        panel_id: id.into(),
        results,
        consecutive_fail: consec,
        fail_since_ms: since,
        running: false,
        check_budget_seconds: 5,
    }
}
fn snap(panels: Vec<PanelStatus>, now: i64) -> PollSnapshot {
    PollSnapshot {
        board_id: "b1".into(),
        last: Some(StatusResponse {
            now_ms: now,
            board_updated_at: 0,
            enabled: true,
            started_at_ms: Some(0),
            panels,
        }),
        server_down: false,
    }
}
fn view(title: &str, state: PanelState, label: &'static str, big: &str) -> PanelView {
    PanelView {
        title: title.into(),
        state,
        label,
        big: BigValue::Text(big.into()),
        consecutive: None,
        bars: vec![],
        stats: None,
        display: vec![],
        interval_seconds: 10,
        timeout_seconds: 5,
        graph_max_ms: 2000,
        thresholds: vec![],
        show_stats: true,
        n_display_items: 0,
    }
}
fn screen(panels: Vec<PanelView>, pos: (usize, usize), selected: usize) -> MonitorScreen {
    MonitorScreen {
        board_name: "운영 API 보드".into(),
        board_pos: pos,
        server_time: Some(1_700_000_000_000),
        server_down: false,
        panels,
        selected,
        border: BorderStyle::Heavy,
    }
}

// ---------- build_panels ----------

#[test]
fn build_panels_ok_panel() {
    let b = board(vec![panel("p1", "로그인")], true);
    let s = snap(
        vec![pstatus("p1", vec![ok(1000, 100), ok(2000, 182)], 0, None)],
        2500,
    );
    let v = build_panels(&b, &s);
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].title, "로그인");
    assert_eq!(v[0].state, PanelState::Ok);
    assert_eq!(v[0].label, "✔ 정상");
    assert_eq!(v[0].big, BigValue::Text("182 ms".into()));
    assert_eq!(v[0].consecutive, None);
    assert!(v[0].stats.as_deref().unwrap().contains("평균"));
    assert_eq!(v[0].bars.len(), 60);
}

#[test]
fn build_panels_fail_consecutive_and_stats() {
    let b = board(vec![panel("p1", "주문")], true);
    let s = snap(
        vec![pstatus(
            "p1",
            vec![ok(1000, 100), fail(2000, "HTTP 503")],
            4,
            Some(1500),
        )],
        2500,
    );
    let v = build_panels(&b, &s);
    assert_eq!(v[0].state, PanelState::Fail);
    let c = v[0].consecutive.as_deref().unwrap();
    assert!(c.contains("4회 연속 · "), "{c}");
    assert!(c.contains("부터"), "{c}");
    assert!(v[0].stats.is_some());
    assert!(matches!(v[0].big, BigValue::Reason(_)));
}

#[test]
fn build_panels_fail_without_since_has_no_consecutive() {
    let b = board(vec![panel("p1", "주문")], true);
    let s = snap(vec![pstatus("p1", vec![fail(2000, "x")], 4, None)], 2500);
    assert_eq!(build_panels(&b, &s)[0].consecutive, None);
    let s = snap(
        vec![pstatus("p1", vec![fail(2000, "x")], 1, Some(2000))],
        2500,
    );
    assert_eq!(build_panels(&b, &s)[0].consecutive, None);
}

#[test]
fn build_panels_stale_has_no_stats() {
    let b = board(vec![panel("p1", "로그인")], true);
    let s = snap(
        vec![pstatus("p1", vec![ok(1000, 100)], 0, None)],
        1000 + 100_000,
    );
    let v = build_panels(&b, &s);
    assert_eq!(v[0].state, PanelState::Stale);
    assert_eq!(v[0].stats, None);
}

#[test]
fn build_panels_before_first_status() {
    let b = board(vec![panel("p1", "로그인")], true);
    let mut s = PollSnapshot {
        board_id: "b1".into(),
        last: None,
        server_down: false,
    };
    assert_eq!(build_panels(&b, &s)[0].state, PanelState::Pending);
    s.server_down = true;
    assert_eq!(build_panels(&b, &s)[0].state, PanelState::Stale);
}

#[test]
fn build_panels_ignores_snapshot_of_other_board() {
    let b = board(vec![panel("p1", "로그인")], true);
    let mut s = snap(vec![pstatus("p1", vec![ok(1000, 100)], 0, None)], 1500);
    s.board_id = "other".into();
    assert_eq!(build_panels(&b, &s)[0].state, PanelState::Pending);
}

#[test]
fn build_panels_stats_off() {
    let b = board(vec![panel("p1", "로그인")], false);
    let s = snap(vec![pstatus("p1", vec![ok(1000, 100)], 0, None)], 1500);
    assert_eq!(build_panels(&b, &s)[0].stats, None);
}

#[test]
fn build_panels_bars_kinds_and_colors() {
    let mut p = panel("p1", "x");
    p.bar_count = 10;
    p.graph_max_ms = 800;
    p.thresholds = vec![Threshold {
        ms: 500,
        color: "#f59e0b".into(),
    }];
    let b = board(vec![p], true);
    let s = snap(
        vec![pstatus(
            "p1",
            vec![
                ok(1000, 100),
                ok(2000, 700),
                fail(3000, "x"),
                res(4000, Verdict::ConfigError, None),
            ],
            0,
            None,
        )],
        4500,
    );
    let bars = &build_panels(&b, &s)[0].bars;
    assert_eq!(bars.len(), 10);
    assert_eq!(bars[0].kind, BarKind::Empty);
    assert_eq!(bars[0].at_ms, None);
    // 100/800*8 = 1 → ▁, 기본 초록
    assert_eq!(bars[6].kind, BarKind::Ok { latency_ms: 100 });
    assert_eq!(bars[6].color, Color::Rgb(0x22, 0xc5, 0x5e));
    assert_eq!(bars[6].at_ms, Some(1000));
    // 700/800*8 = 7 → ▇, 임계값 색
    assert_eq!(bars[7].kind, BarKind::Ok { latency_ms: 700 });
    assert_eq!(bars[7].color, Color::Rgb(0xf5, 0x9e, 0x0b));
    assert_eq!(bars[8].kind, BarKind::Fail);
    assert_eq!(bars[8].color, Color::Rgb(0xef, 0x44, 0x44));
    assert_eq!(bars[9].kind, BarKind::ConfigError);
    assert_eq!(bars[9].color, Color::Rgb(0x47, 0x55, 0x69));
    let v = &build_panels(&b, &s)[0];
    assert_eq!(v.graph_max_ms, 800);
    assert_eq!(
        v.thresholds,
        vec![ThresholdView {
            ms: 500,
            color: Color::Rgb(0xf5, 0x9e, 0x0b)
        }]
    );
    assert_eq!(v.timeout_seconds, panel("p1", "x").timeout_seconds);
    assert_eq!(v.n_display_items, 0);
    assert!(v.show_stats);
}

#[test]
fn display_missing_value_shows_dash() {
    let mut p = panel("p1", "x");
    p.display_items = vec![DisplayItem::default(), DisplayItem::default()];
    let b = board(vec![p], true);
    let mut r = ok(2000, 50);
    r.display = vec![Some("A".into()), None];
    let s = snap(vec![pstatus("p1", vec![r], 0, None)], 2500);
    assert_eq!(build_panels(&b, &s)[0].display, vec!["A", "—"]);

    // 실패 칸은 전부 비면 줄을 생략한다.
    let mut f = fail(2000, "HTTP 500");
    f.display = vec![None, Some(String::new())];
    let s = snap(vec![pstatus("p1", vec![f], 1, None)], 2500);
    assert!(build_panels(&b, &s)[0].display.is_empty());
}

#[test]
fn parse_hex_cases() {
    assert_eq!(parse_hex("#22c55e"), Some(Color::Rgb(0x22, 0xc5, 0x5e)));
    assert_eq!(parse_hex("#EF4444"), Some(Color::Rgb(0xef, 0x44, 0x44)));
    assert_eq!(parse_hex("22c55e"), None);
    assert_eq!(parse_hex("#fff"), None);
    assert_eq!(parse_hex("#gggggg"), None);
    assert_eq!(parse_hex(""), None);
}

// ---------- layout / hit-test ----------

#[test]
fn layout_grid_3_is_3x1() {
    let l = layout(Rect::new(0, 0, 80, 24), 3).unwrap();
    assert_eq!(l.panels.len(), 3);
    for r in &l.panels {
        assert_eq!(r.y, 1);
        assert_eq!(r.height, 22);
    }
    assert!(l.panels[0].x < l.panels[1].x && l.panels[1].x < l.panels[2].x);
    let total: u16 = l.panels.iter().map(|r| r.width).sum();
    assert_eq!(total, 80);
}

#[test]
fn layout_too_small_reports_need() {
    let e = layout(Rect::new(0, 0, 60, 15), 9).unwrap_err();
    assert_eq!(e.have, (60, 15));
    assert_eq!(e.need, (72, 20));
    assert!(layout(Rect::new(0, 0, 24, 8), 1).is_ok());
    assert!(layout(Rect::new(0, 0, 23, 8), 1).is_err());
    assert!(layout(Rect::new(0, 0, 24, 7), 1).is_err());
}

#[test]
fn panel_at_hits_and_misses() {
    let l = layout(Rect::new(0, 0, 80, 24), 3).unwrap();
    let r0 = l.panels[0];
    let r1 = l.panels[1];
    assert_eq!(panel_at(&l, r0.x + 3, r0.y + 3), Some(0));
    assert_eq!(panel_at(&l, r0.x, r0.y), Some(0)); // 테두리
    assert_eq!(panel_at(&l, r0.x + r0.width - 1, r0.y + 2), Some(0));
    assert_eq!(panel_at(&l, r1.x, r1.y + 2), Some(1)); // 칸 사이 경계는 오른쪽 칸 테두리
    assert_eq!(panel_at(&l, 5, 0), None); // 머리 줄
    assert_eq!(panel_at(&l, 5, 23), None); // 키 안내 줄
    assert_eq!(panel_at(&l, 200, 5), None);

    let l5 = layout(Rect::new(0, 0, 90, 20), 5).unwrap();
    assert_eq!(l5.panels.len(), 5);
    assert_eq!(panel_at(&l5, 80, 15), None); // 빈 여섯째 칸
}

// ---------- 화면 ----------

#[test]
fn render_too_small() {
    let panels: Vec<PanelView> = (0..9)
        .map(|i| view(&format!("p{i}"), PanelState::Ok, "✔ 정상", "1 ms"))
        .collect();
    let s = screen(panels, (1, 1), 0);
    let text = draw(60, 15, |f| render(f, &s));
    assert!(text.contains("창을 키워 주세요"), "{text}");
    assert!(text.contains("60×15"), "{text}");
    assert!(!text.contains('┌') && !text.contains('┏'), "{text}");
}

#[test]
fn render_monitor_contains() {
    let mut p2 = view("주문 조회", PanelState::Fail, "✖ 실패", "");
    p2.big = BigValue::Text("HTTP 503".into());
    p2.consecutive = Some("4회 연속 · 09:39:51부터".into());
    p2.bars = vec![
        Bar {
            kind: BarKind::Ok { latency_ms: 400 },
            color: Color::Green,
            at_ms: Some(1_700_000_000_000),
        },
        Bar {
            kind: BarKind::Fail,
            color: Color::Red,
            at_ms: Some(1_700_000_010_000),
        },
    ];
    p2.stats = Some("평균 201 · 최대 340 ms".into());
    let s = screen(
        vec![
            view("로그인", PanelState::Ok, "✔ 정상", "182 ms"),
            p2,
            view("결제", PanelState::Slow, "▲ 느림", "1,350 ms"),
        ],
        (1, 2),
        0,
    );
    let mut t = Terminal::new(TestBackend::new(80, 24)).unwrap();
    t.draw(|f| render(f, &s)).unwrap();
    let text = buffer_text(t.backend().buffer());
    println!("{text}");
    for want in [
        "✔ 정상",
        "✖ 실패",
        "▲ 느림",
        "운영 API 보드",
        "(1/2)",
        "로그인",
        "결제",
    ] {
        assert!(text.contains(want), "{want}\n{text}");
    }
    assert!(
        text.contains("Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"),
        "{text}"
    );
    // 80열·보드 2개는 다 안 들어가 맨 앞 `b 테두리`만 통째로 빠진다.
    assert!(!text.contains("b 테두리"), "{text}");
    // 모든 칸이 같은 굵은 테두리, 선택은 `▶` 제목으로 구분한다.
    assert_eq!(text.matches('┏').count(), 3, "{text}");
    assert!(!text.contains('┌'), "{text}");
    assert!(text.contains("▶ 로그인"), "{text}");
}

#[test]
fn render_key_bar_single_board_omits_tab() {
    let s = screen(
        vec![view("로그인", PanelState::Ok, "✔ 정상", "182 ms")],
        (1, 1),
        0,
    );
    let text = draw(80, 24, |f| render(f, &s));
    assert!(
        text.contains("b 테두리  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"),
        "{text}"
    );
    assert!(!text.contains("Tab 다음 보드"), "{text}");
    assert!(!text.contains("(1/1)"), "{text}");
}

#[test]
fn render_error_import() {
    let e = StartError {
        stage: Stage::Import,
        message: "서버가 거절했습니다: 보드 이름 중복".into(),
        rest_addr: None,
    };
    let text = draw(80, 24, |f| {
        render_error(
            f,
            &e,
            Path::new("/tmp/b.json"),
            &LogLoc::Path("/tmp/tui.log".into()),
        )
    });
    assert!(
        text.contains("서버가 거절했습니다: 보드 이름 중복"),
        "{text}"
    );
    assert!(text.contains("보드 가져오기"), "{text}");
    assert!(text.contains("r 다시 시도  q 종료"), "{text}");
    assert!(text.contains("/tmp/b.json"), "{text}");
}

#[test]
fn render_usage_text() {
    let text = draw(80, 24, render_usage);
    assert!(text.contains("handicap-tui <보드 파일.json>"), "{text}");
    assert!(text.contains("tui-monitor.md"), "{text}");
}

#[test]
fn render_help_has_paths() {
    let text = draw(80, 24, |f| {
        render_help(
            f,
            Path::new("/tmp/b.json"),
            &LogLoc::Path("/tmp/tui.log".into()),
        )
    });
    assert!(text.contains("/tmp/b.json"), "{text}");
    assert!(text.contains("/tmp/tui.log"), "{text}");
    assert!(text.contains("Shift+드래그"), "{text}");
    assert!(text.contains("Esc 닫기"), "{text}");
    let text = draw(80, 24, |f| {
        render_help(
            f,
            Path::new("/tmp/b.json"),
            &LogLoc::Unavailable("권한 없음".into()),
        )
    });
    assert!(text.contains("로그 없음: 권한 없음"), "{text}");
}

#[test]
fn render_quit_confirm_text() {
    let text = draw(80, 24, render_quit_confirm);
    assert!(text.contains("종료할까요? y 종료 · 다른 키 취소"), "{text}");
}

// ---------- 시각 줄 ----------

fn lab5(ms: i64) -> String {
    format!("{:02}:{:02}", ms / 3_600_000 % 24, ms / 60_000 % 60)
}
fn lab8(ms: i64) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        ms / 3_600_000 % 24,
        ms / 60_000 % 60,
        ms / 1000 % 60
    )
}
const BASE: i64 = 10 * 3_600_000;

fn series(w: usize, none: usize, step_ms: i64) -> Vec<Option<i64>> {
    (0..w)
        .map(|k| {
            if k < none {
                None
            } else {
                Some(BASE + (k - none) as i64 * step_ms)
            }
        })
        .collect()
}

#[test]
fn axis_empty_when_no_results() {
    assert!(axis_marks(&[None; 20], &lab5).is_empty());
    assert!(axis_marks(&[], &lab5).is_empty());
}

#[test]
fn axis_single_result_right_aligned() {
    let mut t = vec![None; 10];
    t[9] = Some(BASE);
    let m = axis_marks(&t, &lab5);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].start, 5);
}

#[test]
fn axis_few_results_clamped() {
    let t = series(26, 23, 60_000);
    let m = axis_marks(&t, &lab5);
    assert_eq!(m[0].start, 21);
    assert_eq!(m[0].text, lab5(BASE));
}

#[test]
fn axis_ends_and_middle() {
    let t = series(26, 0, 60_000);
    let m = axis_marks(&t, &lab5);
    assert_eq!(m[0].start, 0);
    let last = m.last().unwrap();
    assert_eq!(last.start as usize + last.text.chars().count(), 26);
    assert!(m.len() >= 3, "{m:?}");
    assert!(m[1].start >= 1);
}

#[test]
fn axis_too_narrow_keeps_left() {
    let t = series(12, 0, 60_000);
    let m = axis_marks(&t, &lab8);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].start, 0);
}

#[test]
fn axis_duplicate_text_skipped() {
    let t = series(26, 0, 1);
    let m = axis_marks(&t, &lab5);
    assert_eq!(m.len(), 1);
}

#[test]
fn axis_middle_differs_from_right() {
    let t: Vec<Option<i64>> = (0..60)
        .map(|k| {
            // 앞 3슬롯만 분 M, 나머지는 M+1.
            if k < 3 {
                Some(BASE + 30_000 + k * 1000)
            } else {
                Some(BASE + 60_000 + k * 1000)
            }
        })
        .collect();
    let m = axis_marks(&t, &lab5);
    assert_eq!(m.len(), 2, "{m:?}");
    assert_ne!(m[0].text, m[1].text);
}

#[test]
fn axis_invariants_sweep() {
    let irregular = [1_000i64, 1_000, 47_000, 1_000, 120_000];
    for w in 1..=60usize {
        for none in 0..=w {
            for (label, len) in [(&lab5 as &dyn Fn(i64) -> String, 5usize), (&lab8, 8)] {
                for kind in 0..4 {
                    let mut acc = BASE;
                    let t: Vec<Option<i64>> = (0..w)
                        .map(|k| {
                            if k < none {
                                return None;
                            }
                            if k > none {
                                acc += match kind {
                                    0 => 1_000,
                                    1 => 5_000,
                                    2 => 60_000,
                                    _ => irregular[(k - none - 1) % irregular.len()],
                                };
                            }
                            Some(acc)
                        })
                        .collect();
                    let ctx = format!("w={w} none={none} len={len} kind={kind}");
                    let m = axis_marks(&t, label);
                    let first = t.iter().position(|x| x.is_some());
                    if first.is_none() || w < len {
                        assert!(m.is_empty(), "{ctx}");
                        continue;
                    }
                    let f = first.unwrap();
                    assert!(!m.is_empty(), "{ctx}");
                    for (i, k) in m.iter().enumerate() {
                        let s = k.start as usize;
                        let e = s + k.text.chars().count();
                        assert!(e <= w, "{ctx} 폭 밖 {m:?}");
                        assert!(
                            (s..e).any(|j| t[j].is_some_and(|ms| label(ms) == k.text)),
                            "{ctx} 자기 막대 없음 {m:?}"
                        );
                        if i > 0 {
                            let p: &Mark = &m[i - 1];
                            let pe = p.start as usize + p.text.chars().count();
                            assert!(s >= pe + 2, "{ctx} 간격 {m:?}");
                            assert_ne!(p.text, k.text, "{ctx} 이웃 글자 같음 {m:?}");
                        }
                    }
                    assert_eq!(m[0].start as usize, f.min(w - len), "{ctx} {m:?}");
                    assert_eq!(m[0].text, label(t[f].unwrap()), "{ctx}");
                    let last_t = t[w - 1].unwrap();
                    if f + 2 * len + 2 <= w && label(t[f].unwrap()) != label(last_t) {
                        let l = m.last().unwrap();
                        assert_eq!(l.start as usize + l.text.chars().count(), w, "{ctx} {m:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn axis_seconds_threshold() {
    assert!(!axis_uses_seconds(21, 30)); // 600 s
    assert!(axis_uses_seconds(20, 30)); // 570 s
    assert!(axis_uses_seconds(2, 599));
    assert!(!axis_uses_seconds(2, 600));
    assert!(axis_uses_seconds(0, 30));
    assert!(axis_uses_seconds(1, 30));
}

#[test]
fn panel_rows_priority() {
    use Row::*;
    assert_eq!(panel_rows_s(1, true, true, true, 2).0, vec![Status]);
    assert_eq!(panel_rows_s(2, true, true, true, 2).0, vec![Status, Bars]);
    assert_eq!(
        panel_rows_s(3, true, true, true, 2).0,
        vec![Status, Bars, Axis]
    );
    assert_eq!(
        panel_rows_s(4, true, true, true, 2).0,
        vec![Status, Consecutive, Bars, Axis]
    );
    assert_eq!(
        panel_rows_s(4, true, false, true, 2).0,
        vec![Status, ReasonSmall, Bars, Axis]
    );
    assert_eq!(
        panel_rows_s(5, true, true, true, 2).0,
        vec![Status, ReasonSmall, Consecutive, Bars, Axis]
    );
    assert_eq!(
        panel_rows_s(5, false, false, true, 2).0,
        vec![Status, Bars, Axis, Stats, Display(0)]
    );
    let six = panel_rows_s(6, false, true, true, 2).0;
    assert!(!six.contains(&Display(1)));
    assert_eq!(six.len(), 6);
    assert_eq!(
        panel_rows_s(9, true, true, true, 2).0,
        vec![
            Status,
            ReasonSmall,
            Consecutive,
            Bars,
            Axis,
            Stats,
            Display(0),
            Display(1)
        ]
    );
    assert!(panel_rows_s(0, true, true, true, 2).0.is_empty());
}

// ---------- 막대·시각 줄 렌더 ----------

#[test]
fn render_axis_shows_bar_times() {
    for (interval, secs) in [(60u32, false), (10u32, true)] {
        let mut p1 = panel("p1", "a");
        p1.bar_count = 40;
        p1.interval_seconds = interval;
        let mut p2 = p1.clone();
        p2.id = "p2".into();
        let mut p3 = p1.clone();
        p3.id = "p3".into();
        let b = board(vec![p1, p2, p3], false);
        let base = 1_700_000_000_000i64;
        let rs: Vec<CheckResult> = (0..30)
            .map(|i| ok(base + i * interval as i64 * 1000, 100))
            .collect();
        let now = rs.last().unwrap().at_ms + 1000;
        let s = snap(
            vec![
                pstatus("p1", rs.clone(), 0, None),
                pstatus("p2", rs.clone(), 0, None),
                pstatus("p3", rs.clone(), 0, None),
            ],
            now,
        );
        let sc = screen(build_panels(&b, &s), (1, 1), 0);
        let buf = render_buf(80, 24, &sc);
        let text = buffer_text(&buf);
        let lay = layout(Rect::new(0, 0, 80, 24), 3).unwrap();
        let fmt: fn(i64) -> String = if secs { format_hms } else { format_hm };
        for r in &lay.panels {
            // L·M(80×24 3칸 = M): 사용 폭 = 칸 폭 − 4(테두리·여백) → 보이는 막대 = 사용 폭(26 → 22, 27 → 23).
            // 통계 끔 → 시각 줄 = 안쪽 맨 아랫줄.
            let usable = r.width - 4;
            let oldest = rs[30 - usize::from(usable)].at_ms;
            let newest = rs[29].at_ms;
            let axis = text_at(&buf, r.y + r.height - 2, r.x + 2, r.x + r.width - 3);
            assert!(axis.starts_with(&fmt(oldest)), "{axis}\n{text}");
            assert!(axis.trim_end().ends_with(&fmt(newest)), "{axis}\n{text}");
            if !secs {
                assert!(!axis.contains(&format_hms(oldest)), "{axis}\n{text}");
            }
        }
    }
}

#[test]
fn render_min_panel_keeps_axis() {
    let mut p = panel("p1", "로그인");
    p.bar_count = 40;
    let b = board(vec![p], true);
    let base = 1_700_000_000_000i64;
    let rs = vec![
        ok(base, 100),
        fail(base + 10_000, "HTTP 503 · 로그인 단계"),
        fail(base + 20_000, "HTTP 503 · 로그인 단계"),
        fail(base + 30_000, "HTTP 503 · 로그인 단계"),
    ];
    let s = snap(
        vec![pstatus("p1", rs.clone(), 3, Some(base + 10_000))],
        base + 31_000,
    );
    let panels = build_panels(&b, &s);
    assert_eq!(panels[0].state, PanelState::Fail);
    assert!(panels[0].stats.is_some());
    let mut sc = screen(panels, (1, 1), 0);
    // 머리 줄 시계가 결과 시각과 같은 글자를 만들지 않게 한다.
    sc.server_time = Some(base + 3 * 3_600_000 + 7 * 60_000 + 9_000);
    assert_ne!(clock_hms(sc.server_time.unwrap()), format_hms(base));
    let mut t = Terminal::new(TestBackend::new(24, 8)).unwrap();
    t.draw(|f| render(f, &sc)).unwrap();
    let text = buffer_text(t.backend().buffer());
    println!("{text}");
    assert!(text.contains("✖ 실패"), "{text}");
    assert!(text.contains("3회 연속"), "{text}");
    assert!(text.contains('█'), "{text}");
    // 시각 줄 = 막대 줄 바로 다음 줄이어야 한다.
    let lines: Vec<&str> = text.lines().collect();
    let bar_row = lines.iter().position(|l| l.contains('█')).unwrap();
    assert!(
        lines[bar_row + 1].contains(&format_hms(base)),
        "시각 줄\n{text}"
    );
    assert!(!text.contains("로그인 단계"), "{text}");
    assert!(!text.contains("평균"), "{text}");
}

fn clock_hms(ms: i64) -> String {
    format_hms(ms)
}

fn col_of_last_nonblank(buf: &Buffer, y: u16) -> u16 {
    (0..buf.area.width)
        .rev()
        .find(|&x| {
            buf[(x, y)].symbol() != " "
                && buf[(x, y)].symbol() != "┃"
                && buf[(x, y)].symbol() != "│"
        })
        .unwrap()
}

fn render_buf(w: u16, h: u16, sc: &MonitorScreen) -> Buffer {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| render(f, sc)).unwrap();
    t.backend().buffer().clone()
}

// ---------- fix round 1 ----------

fn header_of(w: u16, down: bool) -> String {
    let mut sc = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 2), 0);
    sc.server_down = down;
    let t = draw(w, 8, |f| render(f, &sc));
    println!("{t}");
    t.lines().next().unwrap().to_string()
}

#[test]
fn header_degrades_by_whole_parts() {
    let h80 = header_of(80, false);
    assert!(
        h80.contains("Handicap 모니터 · 운영 API 보드 (1/2)"),
        "{h80}"
    );
    // 머리 줄 날짜는 이 PC의 로컬 시각이다 — 기대값도 로컬로 구해야 CI(UTC)·개발기(KST) 둘 다 맞는다.
    let date = {
        use chrono::TimeZone;
        chrono::Local
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .unwrap()
            .format("%Y-%m-%d")
            .to_string()
    };
    assert!(h80.contains(&date), "{date} / {h80}");
    assert!(h80.contains("점검 중"), "{h80}");

    let h48 = header_of(48, false);
    assert!(h48.contains("운영 API 보드 (1/2)"), "{h48}");
    assert!(!h48.contains("Handicap"), "{h48}");
    assert!(h48.contains("점검 중"), "{h48}");

    let h24 = header_of(24, false);
    assert!(h24.contains("점검 중"), "{h24}");
    assert!(h24.contains("(1/2)"), "{h24}");
    assert!(h24.contains('…'), "{h24}");
    assert!(!h24.contains("2023"), "{h24}");

    for w in [24u16, 48, 80] {
        let d = header_of(w, true);
        assert!(d.contains("서버 응답 없음"), "w={w} {d}");
        assert!(d.contains("(1/2)"), "w={w} {d}");
    }
}

#[test]
fn key_bar_drops_whole_segments() {
    let s = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 2), 0);
    let t = draw(24, 8, |f| render(f, &s));
    let last = t.lines().last().unwrap();
    assert!(last.contains("? 도움말  q 종료"), "{t}");
    assert!(!last.contains("Tab"), "{t}");
    assert!(!last.contains("칸 이동"), "{t}");
    let s1 = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 1), 0);
    let t = draw(24, 8, |f| render(f, &s1));
    let last = t.lines().last().unwrap();
    assert!(last.contains("? 도움말  q 종료"), "{t}");
    assert!(!last.contains("칸 이동"), "{t}");
    let t = draw(10, 8, |f| render(f, &s1));
    assert!(t.lines().last().unwrap().contains("q 종료"), "{t}");
}

fn consecutive_line(n: u32) -> String {
    let mut p = panel("p1", "로그인");
    p.bar_count = 40;
    let b = board(vec![p], true);
    let base = 1_700_000_000_000i64;
    let rs = vec![fail(base, "HTTP 503")];
    let s = snap(vec![pstatus("p1", rs, n, Some(base))], base + 1000);
    let sc = screen(build_panels(&b, &s), (1, 1), 0);
    let t = draw(24, 8, |f| render(f, &sc));
    println!("{t}");
    t.lines()
        .find(|l| l.contains("회 연속"))
        .unwrap()
        .to_string()
}

#[test]
fn consecutive_degrades_to_short_form() {
    for n in [3u32, 123] {
        let l = consecutive_line(n);
        assert!(l.contains(&format!("{n}회 연속")), "{l}");
        assert!(!l.contains('부'), "조각난 글자 없음 {l}");
        assert!(!l.contains('·'), "{l}");
    }
    // 넓으면 전체 문구.
    let mut p = panel("p1", "x");
    p.bar_count = 40;
    let b = board(vec![p], true);
    let base = 1_700_000_000_000i64;
    let s = snap(
        vec![pstatus("p1", vec![fail(base, "e")], 3, Some(base))],
        base + 1000,
    );
    let sc = screen(build_panels(&b, &s), (1, 1), 0);
    let t = draw(60, 10, |f| render(f, &sc));
    assert!(t.contains("3회 연속 · ") && t.contains("부터"), "{t}");
}

fn not_contained_view() -> PanelView {
    let mut v = view("체크", PanelState::Fail, "✖ 실패", "");
    v.big = BigValue::Reason(handicap_tui::judge::ReasonParts::NotContained {
        needle: "success".into(),
        small: "본문 전체 글자 포함 ok".into(),
    });
    v
}

#[test]
fn not_contained_keeps_quote_and_tail() {
    let sc = screen(vec![not_contained_view()], (1, 1), 0);
    let t = draw(24, 8, |f| render(f, &sc));
    println!("{t}");
    let row = t.lines().find(|l| l.contains("실패")).unwrap();
    assert!(row.contains("\"s…\" 포함 안 됨"), "{row}");
    let t = draw(80, 12, |f| render(f, &sc));
    assert!(t.contains("\"success\" 포함 안 됨"), "{t}");
}

#[test]
fn long_title_gets_ellipsis() {
    let sc = screen(
        vec![view(
            "아주아주아주아주 긴 칸 제목입니다",
            PanelState::Ok,
            "✔ 정상",
            "1 ms",
        )],
        (1, 1),
        0,
    );
    let t = draw(24, 8, |f| render(f, &sc));
    assert!(t.lines().nth(1).unwrap().contains('…'), "{t}");
}

#[test]
fn too_small_shows_quit_key() {
    let panels: Vec<PanelView> = (0..9)
        .map(|i| view(&format!("p{i}"), PanelState::Ok, "✔ 정상", "1 ms"))
        .collect();
    let s = screen(panels, (1, 1), 0);
    let text = draw(60, 15, |f| render(f, &s));
    assert!(text.lines().last().unwrap().contains("q 종료"), "{text}");
}

#[test]
fn help_short_terminal_keeps_esc_row_and_aligns() {
    let text = draw(80, 12, |f| {
        render_help(
            f,
            Path::new("/tmp/b.json"),
            &LogLoc::Unavailable("권한 없음".into()),
        )
    });
    println!("{text}");
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[10].contains("Esc 닫기"), "{text}");
    assert!(text.contains("로그 없음: 권한 없음"), "{text}");
    assert!(!text.contains("로그: 로그"), "{text}");
    let col = |needle: &str| {
        let l = lines.iter().find(|l| l.contains(needle)).unwrap();
        let idx = l.find(needle).unwrap();
        Span::raw(l[..idx].to_string()).width()
    };
    assert_eq!(col("칸 선택 이동"), col("다음 / 이전 보드"));
    // 높이 12: 키 줄은 앞 5줄만(고정 줄 4 = 경로·로그·무입력·복사) — 보이는 줄끼리 정렬.
    assert_eq!(col("칸 선택 이동"), col("선택 칸 오류 보기"));
    assert_eq!(col("칸 선택 이동"), col("글자 크기"));
}

#[test]
fn help_long_path_keeps_log_and_copy_rows() {
    let path = format!("/{}", "Z".repeat(150));
    let text = draw(80, 24, |f| {
        render_help(f, Path::new(&path), &LogLoc::Path("/tmp/tui.log".into()))
    });
    println!("{text}");
    assert_eq!(text.matches('Z').count(), 150, "{text}");
    assert!(text.contains("로그: /tmp/tui.log"), "{text}");
    assert!(text.contains("Shift+드래그"), "{text}");
    assert!(text.contains("방향키"), "{text}");
    assert!(text.contains("Esc 닫기"), "{text}");
}

#[test]
fn help_tiny_height_drops_key_rows_before_paths() {
    let path = format!("/{}", "Z".repeat(150));
    let log = LogLoc::Path("/tmp/tui.log".into());
    // 높이 9: 본문 6행 = 경로 3 + 로그 1 + 무입력 1 + 복사 1 (키 줄 0 — 키 줄이 먼저 빠진다)
    let text = draw(80, 9, |f| render_help(f, Path::new(&path), &log));
    println!("{text}");
    assert_eq!(text.matches('Z').count(), 150, "{text}");
    assert!(text.contains("로그: /tmp/tui.log"), "{text}");
    assert!(text.contains("Shift+드래그"), "{text}");
    assert!(!text.contains("마우스 왼쪽 클릭"), "{text}");
    // 높이 7: 본문 4행 — 복사 안내가 먼저 빠지지만 경로·로그는 남는다.
    let text = draw(80, 7, |f| render_help(f, Path::new(&path), &log));
    println!("{text}");
    assert_eq!(text.matches('Z').count(), 150, "{text}");
    assert!(text.contains("로그: /tmp/tui.log"), "{text}");
    assert!(text.contains("Esc 닫기"), "{text}");
}

#[test]
fn usage_screen_has_key_bar() {
    let text = draw(80, 24, render_usage);
    assert!(text.lines().last().unwrap().contains("q 종료"), "{text}");
}

#[test]
fn error_screen_key_bar_stays_on_last_row() {
    let e = StartError {
        stage: Stage::Import,
        message: "아주 긴 오류 문구 ".repeat(40),
        rest_addr: None,
    };
    let text = draw(40, 10, |f| {
        render_error(
            f,
            &e,
            Path::new("/tmp/b.json"),
            &LogLoc::Path("/tmp/tui.log".into()),
        )
    });
    println!("{text}");
    assert!(
        text.lines().last().unwrap().contains("r 다시 시도  q 종료"),
        "{text}"
    );
    let text = draw(8, 10, |f| {
        render_error(
            f,
            &e,
            Path::new("/tmp/b.json"),
            &LogLoc::Path("/tmp/tui.log".into()),
        )
    });
    assert!(text.lines().last().unwrap().contains("q 종료"), "{text}");
}

#[test]
fn colors_match_gui() {
    let rgb = |h: u32| Color::Rgb((h >> 16) as u8, (h >> 8) as u8, h as u8);
    // (state, border, label, big, small)
    let cases = [
        (
            PanelState::Blocked,
            0x475569u32,
            0x94a3b8u32,
            0x94a3b8u32,
            Some(0x64748bu32),
        ),
        (
            PanelState::Skipped,
            0x64748b,
            0x94a3b8,
            0xe2e8f0,
            Some(0xe2e8f0),
        ),
        (
            PanelState::ConfigError,
            0x64748b,
            0x94a3b8,
            0x94a3b8,
            Some(0x94a3b8),
        ),
        (PanelState::Stale, 0x64748b, 0x94a3b8, 0x94a3b8, None),
        (
            PanelState::Fail,
            0xef4444,
            0xef4444,
            0xef4444,
            Some(0xef4444),
        ),
        (PanelState::Ok, 0x22c55e, 0x22c55e, 0xf2f5f8, None),
    ];
    for (state, border, label, big, small) in cases {
        let mut v = view("t", state, "L", "abc");
        if small.is_some() {
            v.big = BigValue::Reason(handicap_tui::judge::ReasonParts::Split {
                fixed: "abc".into(),
                step: Some("xyz".into()),
            });
        }
        let sc = screen(vec![v], (1, 1), 0);
        // 80×24 1칸 → L: 머리 줄 y2, 블록 y3..=7(소문자는 가운데 줄 y5에 일반 글자), 사유 작은 줄 y8.
        let buf = render_buf(80, 24, &sc);
        let t = buffer_text(&buf);
        assert_eq!(buf[(0, 1)].fg, rgb(border), "{state:?} border");
        let x = col_of_last_nonblank(&buf, 2);
        assert_eq!(buf[(x, 2)].symbol(), "L", "{state:?} label\n{t}");
        assert_eq!(buf[(x, 2)].fg, rgb(label), "{state:?} label");
        let x = col_of_last_nonblank(&buf, 5);
        assert_eq!(buf[(x, 5)].symbol(), "c", "{state:?} big\n{t}");
        assert_eq!(buf[(x, 5)].fg, rgb(big), "{state:?} big");
        if let Some(sm) = small {
            let x = col_of_last_nonblank(&buf, 8);
            assert_eq!(buf[(x, 8)].symbol(), "z", "{state:?} small\n{t}");
            assert_eq!(buf[(x, 8)].fg, rgb(sm), "{state:?} small");
        }
    }
}

#[test]
fn render_nine_panels_at_minimum() {
    let panels: Vec<PanelView> = (0..9)
        .map(|i| view(&format!("칸 {i}"), PanelState::Ok, "✔ 정상", "182 ms"))
        .collect();
    let s = screen(panels, (1, 1), 4);
    let t = draw(72, 20, |f| render(f, &s));
    println!("{t}");
    assert_eq!(t.matches("✔ 정상").count(), 9, "{t}");
    assert!(!t.contains("창을 키워"), "{t}");
}

#[test]
fn stats_degrade_by_whole_segments() {
    use handicap_tui::text::stats_for_width;
    let full = "평균 1,409 · 최대 1,413 ms";
    // 넓으면 전체(단위 포함).
    assert_eq!(stats_for_width(full, 40), full);
    assert_eq!(stats_for_width(full, 26), full);
    // 25~23칸: 단위만 뺀다(23칸 = 두 수가 온전한 최소 폭) — 숫자는 온전히.
    assert_eq!(stats_for_width(full, 25), "평균 1,409 · 최대 1,413");
    assert_eq!(stats_for_width(full, 24), "평균 1,409 · 최대 1,413");
    assert_eq!(stats_for_width(full, 23), "평균 1,409 · 최대 1,413");
    // 22칸: 평균을 통째로 빼고 `최대 M`(숫자를 자르지 않는다).
    assert_eq!(stats_for_width(full, 22), "최대 1,413");
    // 큰 숫자도 두 수가 온전하다.
    let big = "평균 12,345 · 최대 29,999 ms";
    let got = stats_for_width(big, 25);
    assert_eq!(got, "평균 12,345 · 최대 29,999");
    // 22칸에선 최대만 — 수가 잘리지 않는다.
    assert_eq!(stats_for_width(big, 22), "최대 29,999");
    // 평균까지 못 담으면 `최대 M`만.
    assert_eq!(stats_for_width(full, 11), "최대 1,413");
    assert_eq!(stats_for_width(full, 14), "최대 1,413");
    // 최대조차 못 담으면 마지막 수단으로 말줄임.
    assert!(stats_for_width(full, 6).contains('…'));
}

#[test]
fn label_degrades_by_whole_segments() {
    use handicap_tui::text::label_for_width;
    let off = "– 확인 불가 · 점검 꺼짐"; // 23칸
    assert_eq!(label_for_width(off, 23), off);
    assert_eq!(label_for_width(off, 40), off);
    // 22칸: 뒤 조각을 통째로 뺀다(`점검 꺼…` 같은 중간 자르기 없음).
    assert_eq!(label_for_width(off, 22), "– 확인 불가");
    assert_eq!(label_for_width(off, 11), "– 확인 불가");
    // 첫 조각조차 안 들어가면 마지막 수단으로 말줄임.
    assert_eq!(label_for_width(off, 6), "– 확…");
    assert_eq!(label_for_width("✔ 정상", 6), "✔ 정상");
    assert_eq!(label_for_width("✔ 정상", 4), "✔ …");
}

#[test]
fn narrow_three_column_panel_keeps_max_number() {
    let mut a = view("A", PanelState::Ok, "✔ 정상", "182 ms");
    a.stats = Some("평균 1,409 · 최대 1,413 ms".into());
    let s = screen(vec![a.clone(), a.clone(), a], (1, 1), 0);
    let mut t = Terminal::new(TestBackend::new(72, 24)).unwrap();
    t.draw(|f| render(f, &s)).unwrap();
    let text = buffer_text(t.backend().buffer());
    assert!(text.contains("최대 1,413"), "{text}");
    assert!(!text.contains("1,4…"), "{text}");
}

fn last_row(buf: &Buffer) -> String {
    let area = buf.area;
    let mut sub = Buffer::empty(Rect::new(0, 0, area.width, 1));
    for x in 0..area.width {
        sub[(x, 0)] = buf[(x, area.height - 1)].clone();
    }
    buffer_text(&sub).trim().to_string()
}

fn key_bar_row(bar: KeyBar) -> String {
    let s = screen(
        vec![view("로그인", PanelState::Ok, "✔ 정상", "182 ms")],
        (1, 2),
        0,
    );
    let mut t = Terminal::new(TestBackend::new(80, 24)).unwrap();
    t.draw(|f| {
        let _ = render_with_keys(f, &s, bar);
    })
    .unwrap();
    last_row(t.backend().buffer())
}

#[test]
fn bottom_key_bar_shows_only_keys_of_the_open_screen() {
    // 모니터 단독: 기존 그대로(보드 2개라 Tab 포함).
    let monitor = key_bar_row(KeyBar::Monitor);
    assert_eq!(
        monitor,
        "Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
    // 도움말: 닫기 키만.
    assert_eq!(key_bar_row(KeyBar::Help), "Esc 닫기");
    // 종료 확인: 확인 키만.
    assert_eq!(key_bar_row(KeyBar::QuitConfirm), "y 종료  다른 키 취소");
    // `render`는 Monitor와 같다.
    let s = screen(
        vec![view("로그인", PanelState::Ok, "✔ 정상", "182 ms")],
        (1, 2),
        0,
    );
    let mut t = Terminal::new(TestBackend::new(80, 24)).unwrap();
    t.draw(|f| render(f, &s)).unwrap();
    assert_eq!(last_row(t.backend().buffer()), monitor);
}

fn okbar(ms: u64) -> Bar {
    Bar {
        kind: BarKind::Ok { latency_ms: ms },
        color: Color::Green,
        at_ms: Some(0),
    }
}
fn kbar(kind: BarKind) -> Bar {
    Bar {
        kind,
        color: Color::Green,
        at_ms: Some(0),
    }
}

#[test]
fn column_heights_scale_with_latency() {
    let b = okbar;
    assert_eq!(column(&b(1), 4, 1000, 0), vec![Some('▁'), None, None, None]);
    assert_eq!(
        column(&b(500), 4, 1000, 0),
        vec![Some('█'), Some('█'), None, None]
    );
    assert_eq!(
        column(&b(531), 4, 1000, 0),
        vec![Some('█'), Some('█'), Some('▁'), None]
    );
    assert_eq!(column(&b(9999), 4, 1000, 0), vec![Some('█'); 4]);
    // graph_max 0 → 패닉 없음
    assert_eq!(column(&b(5), 2, 0, 0), vec![Some('█'); 2]);
}

#[test]
fn column_fail_full_height_stripes_no_mark() {
    let c0 = column(&kbar(BarKind::Fail), 6, 1000, 0);
    assert_eq!(c0.len(), 6);
    for (r, ch) in c0.iter().enumerate() {
        assert_eq!(*ch, Some(if r % 3 == 0 { '▒' } else { '█' }), "row {r}");
    }
    let c1 = column(&kbar(BarKind::Fail), 6, 1000, 1);
    assert_eq!(c1[0], Some('█'));
    assert_eq!(c1[2], Some('▒'));
    assert!(c1.iter().all(|c| matches!(c, Some('█') | Some('▒'))));
    assert_eq!(column(&kbar(BarKind::ConfigError), 6, 1000, 0), c0);
}

#[test]
fn column_upstream_low_and_skipped_mark() {
    assert_eq!(
        column(&kbar(BarKind::Upstream), 5, 1000, 0),
        vec![Some('▅'), None, None, None, None]
    );
    assert_eq!(
        column(&kbar(BarKind::Skipped), 3, 1000, 0),
        vec![Some('·'), None, None]
    );
    assert_eq!(
        column(&kbar(BarKind::Empty), 3, 1000, 0),
        vec![None, None, None]
    );
}

#[test]
fn threshold_rows_clamp_and_dedupe() {
    let t = |ms, c| ThresholdView { ms, color: c };
    let r = threshold_rows(
        &[t(700, Color::Red), t(1200, Color::Blue), t(1, Color::Green)],
        1000,
        5,
    );
    let rows: Vec<u16> = r.iter().map(|(row, _)| *row).collect();
    assert_eq!(rows, vec![0, 3, 4]);
    let r = threshold_rows(&[t(700, Color::Red), t(750, Color::Blue)], 1000, 3);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].0, 2);
    assert_eq!(r[0].1.ms, 750);
    assert!(threshold_rows(&[t(700, Color::Red)], 1000, 0).is_empty());
}

#[test]
fn label_width_rules() {
    let t = |ms| ThresholdView {
        ms,
        color: Color::Red,
    };
    assert_eq!(label_width(&[t(700)], 40, true), 4);
    assert_eq!(label_width(&[t(700), t(1200)], 40, true), 5);
    assert_eq!(label_width(&[t(700)], 40, false), 0);
    assert_eq!(label_width(&[], 40, true), 0);
    assert_eq!(label_width(&[t(700), t(1200)], 16, true), 0);
    // 막대 폭 = inner_w - (열 + 구분 1칸): 17 → 11 < 12, 18 → 12
    assert_eq!(label_width(&[t(700), t(1200)], 17, true), 0);
    assert_eq!(label_width(&[t(700), t(1200)], 18, true), 5);
}

#[test]
fn build_panels_display_count_capped_and_stats_flag() {
    let mut p = panel("p1", "x");
    p.display_items = vec![DisplayItem::default(); 3];
    let b = board(vec![p], false);
    let s = snap(vec![pstatus("p1", vec![ok(1000, 100)], 0, None)], 1500);
    let v = &build_panels(&b, &s)[0];
    assert_eq!(v.n_display_items, 2);
    assert!(!v.show_stats);
}

// ---------- tui-readability Task 2: S 단계 여러 줄 막대 ----------

#[test]
fn panel_rows_s_gives_leftover_to_bars() {
    use Row::*;
    assert_eq!(
        panel_rows_s(10, false, false, true, 0),
        (vec![Status, Bars, Axis, Stats], 7)
    );
    assert_eq!(
        panel_rows_s(4, false, true, true, 2),
        (vec![Status, Consecutive, Bars, Axis], 1)
    );
    assert_eq!(
        panel_rows_s(6, false, false, true, 2),
        (vec![Status, Bars, Axis, Stats, Display(0), Display(1)], 1)
    );
    assert_eq!(
        panel_rows_s(5, false, false, true, 2),
        (vec![Status, Bars, Axis, Stats, Display(0)], 1)
    );
    assert_eq!(panel_rows_s(1, true, true, true, 2), (vec![Row::Status], 0));
    assert_eq!(panel_rows_s(0, true, true, true, 2), (vec![], 0));
}

fn s_bar(kind: BarKind, at: i64) -> Bar {
    Bar {
        kind,
        color: Color::Green,
        at_ms: Some(at),
    }
}
fn s_ok(ms: u64, at: i64) -> Bar {
    s_bar(BarKind::Ok { latency_ms: ms }, at)
}
fn s_view(bars: Vec<Bar>, max: u32) -> PanelView {
    let mut v = view("S칸", PanelState::Ok, "✔ 정상", "100 ms");
    v.bars = bars;
    v.graph_max_ms = max;
    v
}
fn th(ms: u32, hex: &str) -> ThresholdView {
    ThresholdView {
        ms,
        color: parse_hex(hex).unwrap(),
    }
}
fn blocks_in_col(buf: &Buffer, x: u16) -> usize {
    (0..buf.area.height)
        .filter(|&y| buf[(x, y)].symbol() == "█")
        .count()
}
fn row_text(buf: &Buffer, y: u16, x0: u16, x1: u16) -> String {
    (x0..=x1)
        .map(|x| buf[(x, y)].symbol().to_string())
        .collect()
}
fn assert_s_title(buf: &Buffer) {
    assert!(
        row_text(buf, 1, 0, 79).contains("S칸"),
        "S 배치 표지(위 테두리 제목)"
    );
}
fn rightmost_block(buf: &Buffer) -> u16 {
    (0..buf.area.width)
        .rev()
        .find(|&x| blocks_in_col(buf, x) > 0)
        .unwrap()
}

#[test]
fn s_bars_have_height_variation() {
    let v = s_view(
        vec![s_ok(100, 0), s_ok(500, 10_000), s_ok(1000, 20_000)],
        1000,
    );
    let buf = render_buf(80, 11, &screen(vec![v], (1, 1), 0));
    assert_s_title(&buf);
    let c: Vec<usize> = (76..=78).map(|x| blocks_in_col(&buf, x)).collect();
    assert_eq!(c, vec![0, 2, 4], "{}", buffer_text(&buf));
}

#[test]
fn s_threshold_line_and_label_column() {
    let mut v = s_view(vec![s_ok(100, 0), s_ok(1500, 10_000)], 1500);
    v.thresholds = vec![th(700, "#facc15"), th(1200, "#f97316")];
    let buf = render_buf(80, 13, &screen(vec![v], (1, 1), 0));
    assert_s_title(&buf);
    let t = buffer_text(&buf);
    // 안쪽 9줄 → 막대 6줄(y 3..=8), 기준선 700 = 아래에서 2번째 줄 y6, 1200 = y4.
    assert_eq!(buf[(10, 6)].symbol(), "╌", "{t}");
    assert_eq!(buf[(10, 6)].fg, Color::Rgb(250, 204, 21));
    assert_eq!(buf[(10, 4)].symbol(), "╌", "{t}");
    assert_eq!(buf[(10, 4)].fg, Color::Rgb(249, 115, 22));
    // 막대가 있는 글자 칸(x72, 전체 높이)에는 점선 없음.
    assert_eq!(buf[(72, 6)].symbol(), "█", "{t}");
    assert_eq!(buf[(72, 4)].symbol(), "█", "{t}");
    // 숫자 열(x74..=78): 굵게 + 기준선 색 + 오른쪽 정렬.
    assert_eq!(row_text(&buf, 6, 74, 78), "  700", "{t}");
    assert_eq!(row_text(&buf, 4, 74, 78), "1,200", "{t}");
    assert!(
        buf[(78, 6)]
            .modifier
            .contains(ratatui::style::Modifier::BOLD)
    );
    assert_eq!(buf[(78, 6)].fg, Color::Rgb(250, 204, 21));
    assert_eq!(buf[(78, 4)].fg, Color::Rgb(249, 115, 22));
    // 시각 줄(y9) 오른쪽에 (ms).
    assert_eq!(row_text(&buf, 9, 74, 78), " (ms)", "{t}");
}

#[test]
fn s_no_thresholds_when_worst_case_rows_below_3() {
    // 안쪽 7: 정상 막대 4줄(>=3)이지만 최악(사유·연속 실패 다) 2줄 → 정상에서도 기준선 없음.
    let mut v = s_view(vec![s_ok(100, 0), s_ok(1500, 10_000)], 1500);
    v.thresholds = vec![th(700, "#facc15"), th(1200, "#f97316")];
    let buf = render_buf(80, 11, &screen(vec![v], (1, 1), 0));
    assert_s_title(&buf);
    let t = buffer_text(&buf);
    assert!(!t.contains('╌'), "{t}");
    assert!(!t.contains("(ms)"), "{t}");
    assert!(!t.contains("1,200"), "{t}");
    assert_eq!(rightmost_block(&buf), 78, "{t}");
}

fn s_fail_view(bars: Vec<Bar>, max: u32, th: Vec<ThresholdView>) -> PanelView {
    let mut v = s_view(bars, max);
    v.state = PanelState::Fail;
    v.label = "✖ 실패";
    v.big = BigValue::Reason(handicap_tui::judge::ReasonParts::Detail {
        big: "HTTP 503".into(),
        small: "로그인 단계".into(),
    });
    v.consecutive = Some("3회 연속 · 00:00:10부터".into());
    v.thresholds = th;
    v
}

#[test]
fn s_state_change_keeps_label_column() {
    let ths = vec![th(700, "#facc15"), th(1200, "#f97316")];
    let bars = vec![s_ok(1500, 0), s_ok(1500, 10_000)];
    // 안쪽 8: 최악 3줄 → 정상·실패 둘 다 숫자 열, 최신 막대 x 같음.
    for h in [12u16, 11] {
        let normal = {
            let mut v = s_view(bars.clone(), 1500);
            v.thresholds = ths.clone();
            render_buf(80, h, &screen(vec![v], (1, 1), 0))
        };
        let failing = render_buf(
            80,
            h,
            &screen(
                vec![s_fail_view(bars.clone(), 1500, ths.clone())],
                (1, 1),
                0,
            ),
        );
        let (tn, tf) = (buffer_text(&normal), buffer_text(&failing));
        assert_eq!(tn.contains("(ms)"), h == 12, "{tn}");
        assert_eq!(tf.contains("(ms)"), h == 12, "{tf}");
        assert_eq!(
            rightmost_block(&normal),
            rightmost_block(&failing),
            "{tn}\n{tf}"
        );
        if h == 12 {
            assert_eq!(rightmost_block(&normal), 72, "{tn}");
        } else {
            assert_eq!(rightmost_block(&normal), 78, "{tn}");
        }
    }
}

#[test]
fn s_bars_right_aligned_with_axis() {
    let t0 = 1_700_000_000_000i64;
    let mut bars: Vec<Bar> = (0..9).map(|_| s_bar(BarKind::Empty, 0)).collect();
    bars[..].iter_mut().for_each(|b| b.at_ms = None);
    bars.push(s_ok(1000, t0));
    let buf = render_buf(80, 11, &screen(vec![s_view(bars, 1000)], (1, 1), 0));
    assert_s_title(&buf);
    let t = buffer_text(&buf);
    assert_eq!(blocks_in_col(&buf, 78), 4, "{t}");
    assert_eq!(blocks_in_col(&buf, 77), 0, "{t}");
    // 안쪽 y2 상태, 막대 y3..=6, 시각 y7.
    assert_eq!(col_of_last_nonblank_in(&buf, 7), 78, "{t}");
    assert!(row_text(&buf, 7, 1, 78).contains(&format_hms(t0)), "{t}");
    // 슬롯 300 > W(78).
    let many: Vec<Bar> = (0..300).map(|i| s_ok(1000, t0 + i * 10_000)).collect();
    let buf = render_buf(80, 11, &screen(vec![s_view(many, 1000)], (1, 1), 0));
    let t = buffer_text(&buf);
    assert_eq!(blocks_in_col(&buf, 1), 4, "{t}");
    assert_eq!(blocks_in_col(&buf, 78), 4, "{t}");
    assert_eq!(col_of_last_nonblank_in(&buf, 7), 78, "{t}");
    assert!(
        row_text(&buf, 7, 1, 78).contains(&format_hm(t0 + 299 * 10_000)),
        "{t}"
    );
}

fn col_of_last_nonblank_in(buf: &Buffer, y: u16) -> u16 {
    (1..buf.area.width - 1)
        .rev()
        .find(|&x| buf[(x, y)].symbol() != " ")
        .unwrap()
}

#[test]
fn s_stats_row_kept_blank_when_no_stats() {
    let bars = vec![s_ok(1000, 0)];
    let mut with = s_view(bars.clone(), 1000);
    with.stats = Some("평균 1 · 최대 2 ms".into());
    let without = s_view(bars, 1000);
    let a = render_buf(80, 11, &screen(vec![with], (1, 1), 0));
    let b = render_buf(80, 11, &screen(vec![without], (1, 1), 0));
    assert_s_title(&b);
    assert_eq!(blocks_in_col(&a, 78), 4);
    assert_eq!(blocks_in_col(&b, 78), 4, "{}", buffer_text(&b));
}

#[test]
fn s_display_rows_reserved_by_config() {
    let bars = vec![s_ok(1000, 0)];
    let mut with = s_view(bars.clone(), 1000);
    with.n_display_items = 2;
    with.display = vec!["a".into(), "b".into()];
    let mut without = s_view(bars, 1000);
    without.n_display_items = 2;
    let a = render_buf(80, 11, &screen(vec![with], (1, 1), 0));
    let b = render_buf(80, 11, &screen(vec![without], (1, 1), 0));
    assert_s_title(&b);
    assert_eq!(blocks_in_col(&a, 78), 2, "{}", buffer_text(&a));
    assert_eq!(blocks_in_col(&b, 78), 2, "{}", buffer_text(&b));
}

// ---------- L·M 단계 칸 배치 (Task 4) ----------

const T0: i64 = 1_700_000_000_000;

fn lm_bars(n: usize, ms: u64) -> Vec<Bar> {
    (0..n).map(|i| s_ok(ms, T0 + i as i64 * 10_000)).collect()
}
fn is_big_glyph(sym: &str) -> bool {
    matches!(sym, "▀" | "▄" | "█")
}
fn row_has_big(buf: &Buffer, y: u16, x0: u16, x1: u16) -> bool {
    (x0..=x1).any(|x| is_big_glyph(buf[(x, y)].symbol()))
}
/// `x0..=x1` 글자 칸을 잇되 넓은 문자 뒤 채움 칸은 건너뛴다.
fn text_at(buf: &Buffer, y: u16, x0: u16, x1: u16) -> String {
    let mut out = String::new();
    let mut x = x0;
    while x <= x1 {
        let sym = buf[(x, y)].symbol();
        out.push_str(sym);
        x += Span::raw(sym.to_string()).width().max(1) as u16;
    }
    out
}
fn reason_view(
    title: &str,
    label: &'static str,
    parts: handicap_tui::judge::ReasonParts,
) -> PanelView {
    let mut v = view(title, PanelState::Fail, label, "");
    v.big = BigValue::Reason(parts);
    v
}
fn detail(big: &str, small: &str) -> handicap_tui::judge::ReasonParts {
    handicap_tui::judge::ReasonParts::Detail {
        big: big.into(),
        small: small.into(),
    }
}
fn split(fixed: &str, step: Option<&str>) -> handicap_tui::judge::ReasonParts {
    handicap_tui::judge::ReasonParts::Split {
        fixed: fixed.into(),
        step: step.map(Into::into),
    }
}
fn inner_of(r: Rect) -> Rect {
    Rect::new(r.x + 1, r.y + 1, r.width - 2, r.height - 2)
}

fn six_mixed() -> Vec<PanelView> {
    let ths = vec![th(700, "#facc15"), th(1200, "#f97316")];
    let stats = Some("평균 312 · 최대 498 ms".to_string());
    let ok_panel = |title: &str, big: &str, ms: u64| {
        let mut v = view(title, PanelState::Ok, "✔ 정상", big);
        v.bars = lm_bars(30, ms);
        v.stats = stats.clone();
        v.thresholds = ths.clone();
        v.graph_max_ms = 1500;
        v
    };
    let mut slow = ok_panel("결제 승인", "1,407 ms", 1407);
    slow.state = PanelState::Slow;
    slow.label = "▲ 느림";
    let mut f503 = reason_view("주문 조회", "✖ 실패", detail("HTTP 503", "주문 단계"));
    f503.consecutive = Some("22회 연속 · 04:33:14부터".into());
    f503.bars = lm_bars(30, 300);
    f503.stats = stats.clone();
    f503.thresholds = ths.clone();
    let mut fko = reason_view("외부 연동", "✖ 실패", split("요청 실패", None));
    fko.consecutive = Some("22회 연속 · 04:33:14부터".into());
    fko.bars = lm_bars(30, 300);
    fko.thresholds = ths.clone();
    vec![
        ok_panel("로그인", "413 ms", 413),
        slow,
        f503,
        fko,
        ok_panel("회원 등급 조회", "1,086 ms", 1086),
        ok_panel("재고 조회", "152 ms", 152),
    ]
}

#[test]
fn lm_six_panels_112x31_big_digits_and_few_blank_rows() {
    let sc = screen(six_mixed(), (1, 1), 0);
    let buf = render_buf(112, 31, &sc);
    let t = buffer_text(&buf);
    let lay = layout(Rect::new(0, 0, 112, 31), 6).unwrap();
    for i in [0usize, 1, 4, 5] {
        let inn = inner_of(lay.panels[i]);
        let (x0, x1) = (inn.x + 1, inn.x + inn.width - 2);
        let y0 = inn.y;
        let last = inn.y + inn.height - 1;
        // 머리 줄 다음 3줄 = 큰 글꼴(M).
        for y in y0 + 1..=y0 + 3 {
            assert!(row_has_big(&buf, y, x0, x1), "칸 {i} y{y}\n{t}");
        }
        // 막대 영역 밖(머리·블록·시각·평균) 빈 줄 ≤ 1.
        let outside = [y0, y0 + 1, y0 + 2, y0 + 3, last - 1, last];
        let blank = outside
            .iter()
            .filter(|&&y| {
                text_at(&buf, y, inn.x, inn.x + inn.width - 1)
                    .trim()
                    .is_empty()
            })
            .count();
        assert!(blank <= 1, "칸 {i} 빈 줄 {blank}\n{t}");
        // 막대 영역 맨 아랫줄(시각 줄 바로 위)에 막대가 있다.
        assert!(
            !text_at(&buf, last - 2, x0, x1).trim().is_empty(),
            "칸 {i} 막대\n{t}"
        );
    }
}

#[test]
fn lm_tier_same_for_small_and_large_latency() {
    for (big, ms) in [("2 ms", 2u64), ("29,871 ms", 29_871)] {
        let mut v = view("로그인", PanelState::Ok, "✔ 정상", big);
        v.timeout_seconds = 30;
        v.graph_max_ms = 60_000;
        v.bars = lm_bars(5, ms);
        // 34×17 → 칸 (0,1,34,15), 안쪽 (1,2) 32×13: 머리 y2, 블록 y3..=5, 그다음 y6.
        let buf = render_buf(34, 17, &screen(vec![v], (1, 1), 0));
        let t = buffer_text(&buf);
        assert!(text_at(&buf, 2, 2, 31).contains("✔ 정상"), "{t}");
        for y in 3..=5 {
            assert!(row_has_big(&buf, y, 2, 31), "{big} y{y}\n{t}");
        }
        assert!(!row_has_big(&buf, 6, 2, 31), "{big} M이어야 함\n{t}");
    }
}

#[test]
fn lm_fail_rows_do_not_change_tier() {
    // 34×17(안쪽 32×13) — 그리고 54×16(안쪽 52×12): 폭은 L이 들어가지만 실패 줄 예약 때문에 M.
    for (w, h) in [(34u16, 17u16), (54, 16)] {
        let mut normal = view("로그인", PanelState::Ok, "✔ 정상", "413 ms");
        normal.timeout_seconds = 30;
        normal.bars = lm_bars(5, 413);
        let mut failing = reason_view("로그인", "✖ 실패", detail("HTTP 503", "로그인 단계"));
        failing.timeout_seconds = 30;
        failing.consecutive = Some("3회 연속 · 00:00:10부터".into());
        failing.bars = lm_bars(5, 413);
        let x1 = w - 3;
        for (name, v, label) in [("정상", normal, "✔ 정상"), ("실패", failing, "✖ 실패")]
        {
            let buf = render_buf(w, h, &screen(vec![v], (1, 1), 0));
            let t = buffer_text(&buf);
            assert!(
                text_at(&buf, 2, 2, x1).contains(label),
                "{name} {w}x{h}\n{t}"
            );
            for y in 3..=5 {
                assert!(row_has_big(&buf, y, 2, x1), "{name} {w}x{h} y{y}\n{t}");
            }
            assert!(!row_has_big(&buf, 6, 2, x1), "{name} {w}x{h} M\n{t}");
        }
    }
}

#[test]
fn lm_stats_row_blank_when_no_stats() {
    let mut a = view("로그인", PanelState::Ok, "✔ 정상", "413 ms");
    a.timeout_seconds = 30;
    a.bars = lm_bars(20, 413);
    a.stats = Some("평균 312 · 최대 498 ms".into());
    let mut b = view("로그인", PanelState::Blocked, "― 확인 못 함", "");
    b.big = BigValue::Reason(split("—", None));
    b.timeout_seconds = 30;
    b.bars = (0..20)
        .map(|i| s_bar(BarKind::Upstream, T0 + i * 10_000))
        .collect();
    b.stats = None;
    let ba = render_buf(34, 17, &screen(vec![a], (1, 1), 0));
    let bb = render_buf(34, 17, &screen(vec![b], (1, 1), 0));
    let (ta, tb) = (buffer_text(&ba), buffer_text(&bb));
    // 안쪽 y2..=14: 평균 줄 y14, 시각 줄 y13, 막대 y6..=12.
    assert!(text_at(&ba, 14, 1, 32).contains("평균"), "{ta}");
    assert!(text_at(&bb, 14, 1, 32).trim().is_empty(), "{tb}");
    for (buf, t) in [(&ba, &ta), (&bb, &tb)] {
        assert!(text_at(buf, 13, 1, 32).contains(':'), "시각 줄 y13\n{t}");
        assert!(
            !text_at(buf, 12, 2, 31).trim().is_empty(),
            "막대 바닥 y12\n{t}"
        );
    }
}

/// 36×17 → 칸 (0,1,36,15), 안쪽 (1,2) 34×13, 사용 x2..=33(폭 32), timeout 5 → M.
fn m36(v: PanelView) -> Buffer {
    render_buf(36, 17, &screen(vec![v], (1, 1), 0))
}

#[test]
fn lm_http_503_big_without_display_items() {
    use handicap_tui::view::bigfont::{Tier, rows};
    let v = reason_view("주문 조회", "✖ 실패", detail("HTTP 503", "주문 단계"));
    let buf = m36(v);
    let t = buffer_text(&buf);
    let want = rows("HTTP 503", Tier::M);
    assert_eq!(want.len(), 3);
    for (i, row) in want.iter().enumerate() {
        // 폭 30 → x4..=33(오른쪽 끝까지).
        let y = 3 + i as u16;
        assert_eq!(&text_at(&buf, y, 4, 33), row, "y{y}\n{t}");
    }
    assert!(text_at(&buf, 3, 2, 3).trim().is_empty(), "{t}");
    // 사유 작은 줄은 블록 바로 아래.
    assert!(text_at(&buf, 6, 2, 33).ends_with("주문 단계"), "{t}");
}

#[test]
fn lm_reason_over_reference_is_plain_with_display_items() {
    let mut v = reason_view("주문 조회", "✖ 실패", detail("HTTP 503", "주문 단계"));
    v.n_display_items = 2;
    v.display = vec!["VIP".into(), "등급".into()];
    let buf = m36(v);
    let t = buffer_text(&buf);
    for y in 3..=5 {
        assert!(!row_has_big(&buf, y, 2, 33), "y{y}\n{t}");
    }
    assert_eq!(text_at(&buf, 4, 26, 33), "HTTP 503", "{t}");
    // 표시 값: 블록 첫 줄 = 첫 값(흰색 굵게), 둘째 줄 = 둘째 값(연한색).
    assert_eq!(text_at(&buf, 3, 2, 4), "VIP", "{t}");
    assert_eq!(buf[(2, 3)].fg, parse_hex("#f2f5f8").unwrap());
    assert!(
        buf[(2, 3)]
            .modifier
            .contains(ratatui::style::Modifier::BOLD)
    );
    assert_eq!(text_at(&buf, 4, 2, 4), "등급", "{t}");
    assert_eq!(buf[(2, 4)].fg, parse_hex("#cbd5e1").unwrap());
    assert!(
        !buf[(2, 4)]
            .modifier
            .contains(ratatui::style::Modifier::BOLD)
    );
}

#[test]
fn lm_latency_unit_on_last_block_row_right_edge() {
    // 36×17 M: 블록 y3..=5, 사용 x2..=33. `ms`는 맨 아래 블록 줄 오른쪽 끝 두 칸, 숫자와 1칸 띄움.
    let mut v = view("로그인", PanelState::Ok, "✔ 정상", "413 ms");
    v.bars = lm_bars(5, 413);
    let buf = m36(v);
    let t = buffer_text(&buf);
    assert_eq!(text_at(&buf, 5, 32, 33), "ms", "{t}");
    assert!(
        buf[(32, 5)]
            .modifier
            .contains(ratatui::style::Modifier::BOLD)
    );
    assert_eq!(buf[(31, 5)].symbol(), " ", "{t}");
    assert!(is_big_glyph(buf[(30, 5)].symbol()), "숫자 끝 x30\n{t}");
    for y in 3..=4 {
        assert_eq!(text_at(&buf, y, 31, 33), "   ", "단위는 맨 아래 줄만\n{t}");
    }
}

#[test]
fn lm_korean_reason_and_dash_plain_on_middle_row() {
    let mut bars = lm_bars(19, 413);
    bars.push(s_bar(BarKind::Fail, T0 + 190_000));
    let mut normal = view("로그인", PanelState::Ok, "✔ 정상", "413 ms");
    normal.bars = bars.clone();
    let mut ko = reason_view("외부 연동", "✖ 실패", split("요청 실패", None));
    ko.bars = bars.clone();
    let mut dash = view("재고", PanelState::Pending, "… 확인 중", "—");
    dash.bars = bars;
    let nb = m36(normal);
    for (v, want, label) in [(ko, "요청 실패", "✖ 실패"), (dash, "—", "… 확인 중")] {
        let buf = m36(v);
        let t = buffer_text(&buf);
        assert!(text_at(&buf, 2, 2, 33).ends_with(label), "{t}");
        assert!(text_at(&buf, 4, 2, 33).ends_with(want), "가운데 줄\n{t}");
        assert!(text_at(&buf, 3, 2, 33).trim().is_empty(), "{t}");
        assert!(text_at(&buf, 5, 2, 33).trim().is_empty(), "{t}");
        // 막대 시작(y6)·끝(y12)·시각 줄(y13)이 정상 칸과 같다 — 최신 막대(실패) x33은 전체 높이.
        for b in [&buf, &nb] {
            assert!(matches!(b[(33, 6)].symbol(), "█" | "▒"), "{t}");
            assert!(matches!(b[(33, 12)].symbol(), "█" | "▒"), "{t}");
            assert!(!matches!(b[(33, 5)].symbol(), "█" | "▒"), "{t}");
            assert!(text_at(b, 13, 2, 33).contains(':'), "{t}");
        }
    }
}

#[test]
fn lm_display_values_left_area_fixed() {
    for (big, state, label) in [
        ("2 ms", PanelState::Ok, "✔ 정상"),
        ("1,407 ms", PanelState::Slow, "▲ 느림"),
    ] {
        let panels: Vec<PanelView> = (0..6)
            .map(|i| {
                let mut v = if i == 0 {
                    view("로그인", state, label, big)
                } else {
                    view(&format!("칸 {i}"), PanelState::Ok, "✔ 정상", "100 ms")
                };
                v.timeout_seconds = 30;
                v.n_display_items = 1;
                v.display = vec!["정상 영업".into()];
                v.bars = lm_bars(30, 100);
                v
            })
            .collect();
        let buf = render_buf(112, 31, &screen(panels, (1, 1), 3));
        let t = buffer_text(&buf);
        // 칸 0: 안쪽 (1,2) 35×12, 사용 33, 왼쪽 자리 33 − 24 − 1 = 8 → x2..=9.
        assert!(row_has_big(&buf, 3, 2, 34), "M\n{t}");
        assert_eq!(text_at(&buf, 3, 2, 10), "정상 영… ", "{big}\n{t}");
    }
}

#[test]
fn lm_latency_over_reference_is_plain() {
    let mut v = view("로그인", PanelState::Ok, "✔ 정상", "12,345 ms");
    v.bars = lm_bars(3, 12_345);
    let buf = m36(v);
    let t = buffer_text(&buf);
    for y in 3..=5 {
        assert!(!row_has_big(&buf, y, 2, 33), "y{y}\n{t}");
    }
    assert_eq!(text_at(&buf, 4, 24, 33), " 12,345 ms", "{t}");
}

#[test]
fn lm_long_title_selected_keeps_state_label() {
    // 24×17 → 안쪽 22×13, 사용 20, timeout 5 → M(기준 폭 20).
    let title = "아주아주아주아주 긴 칸 제목입니다";
    let mut v = view(title, PanelState::Ok, "✔ 정상", "413 ms");
    v.bars = lm_bars(5, 413);
    let buf = render_buf(24, 17, &screen(vec![v], (1, 1), 0));
    let t = buffer_text(&buf);
    assert!(row_has_big(&buf, 3, 2, 21), "M\n{t}");
    let head = text_at(&buf, 2, 2, 21);
    assert!(head.ends_with("✔ 정상"), "{head}\n{t}");
    assert!(head.starts_with("▶ 아주"), "{head}\n{t}");
    assert!(head.contains('…'), "{head}\n{t}");
    // `▶ ` + 제목 칸 ≤ 20 − 6(상태) − 1 = 13 (제목 자체는 선택 표시 2칸을 뺀 11).
    let title_part = head.trim_end_matches("✔ 정상").trim_end();
    assert!(Span::raw(title_part.to_string()).width() <= 13, "{head}");
    // 위 테두리에 제목 없음, 좌우 테두리 그대로.
    assert!(!text_at(&buf, 1, 0, 23).contains("아주"), "{t}");
    assert_eq!(buf[(0, 2)].symbol(), "┃", "{t}");
    assert_eq!(buf[(23, 2)].symbol(), "┃", "{t}");
    // 선택 안 된 칸: 상태 문구 + 1이 사용 폭보다 넓으면 제목 없이 상태 문구만 — 뒤 조각을 통째로
    // 뺀 꼴, 오른쪽 정렬. (두 칸 48×17 → 칸마다 24×17, 칸 1을 선택해 칸 0은 선택 안 됨.)
    let stale = || {
        let mut v = view(title, PanelState::StaleOff, "– 확인 불가 · 점검 꺼짐", "—");
        v.bars = lm_bars(5, 413);
        v
    };
    let buf = render_buf(48, 17, &screen(vec![stale(), stale()], (1, 1), 1));
    let t = buffer_text(&buf);
    let head = text_at(&buf, 2, 2, 21);
    assert!(!head.contains("아주"), "{head}\n{t}");
    assert!(!head.contains("점검"), "{head}\n{t}");
    assert!(!head.contains('▶'), "{head}\n{t}");
    assert!(head.ends_with("– 확인 불가"), "{head}\n{t}");
    assert_eq!(head.trim(), "– 확인 불가", "{head}\n{t}");
    assert_eq!(buf[(23, 2)].symbol(), "┃", "{t}");
    // 선택된 칸(같은 폭): `▶`는 늘 보이고(흰 바탕) 상태 문구는 그 뒤 남은 자리에 통째 조각으로.
    let buf = render_buf(24, 17, &screen(vec![stale()], (1, 1), 0));
    let t = buffer_text(&buf);
    let head = text_at(&buf, 2, 2, 21);
    assert_eq!(buf[(2, 2)].symbol(), "▶", "{head}\n{t}");
    assert_eq!(buf[(2, 2)].bg, rgb("#f2f5f8"), "{head}\n{t}");
    assert_eq!(buf[(2, 2)].fg, rgb("#0b0f14"), "{head}\n{t}");
    assert!(head.ends_with("– 확인 불가"), "{head}\n{t}");
    assert!(!head.contains("점검"), "{head}\n{t}");
    assert_eq!(buf[(0, 2)].symbol(), "┃", "{t}");
    assert_eq!(buf[(23, 2)].symbol(), "┃", "{t}");
}

#[test]
fn lm_selected_stale_off_label_fills_row_no_panic() {
    // 28×15 → 칸 28×13, 안쪽 26×11, 사용 24. 상태 문구(23칸) + 1 = 사용 폭 — 예전엔 선택 표시 2칸을
    // 더해 머리 줄 여백 계산이 음수가 되어 패닉했다.
    let mut v = view(
        "결제 승인 확인",
        PanelState::StaleOff,
        "– 확인 불가 · 점검 꺼짐",
        "—",
    );
    v.bars = lm_bars(5, 413);
    let buf = render_buf(28, 15, &screen(vec![v], (1, 1), 0));
    let t = buffer_text(&buf);
    // L·M 표지: S는 위 테두리에 제목을 쓴다.
    assert!(!text_at(&buf, 1, 0, 27).contains("결제"), "L/M\n{t}");
    let head = text_at(&buf, 2, 2, 25);
    assert_eq!(buf[(2, 2)].symbol(), "▶", "{head}\n{t}");
    assert_eq!(buf[(2, 2)].bg, rgb("#f2f5f8"), "{head}\n{t}");
    let whole = head.ends_with("– 확인 불가 · 점검 꺼짐");
    let seg = head.ends_with("– 확인 불가") && !head.contains("점검");
    assert!(whole || seg, "{head}\n{t}");
    assert!(
        !head.contains('…') || head.contains("결제"),
        "상태 문구는 말줄임 없이 {head}\n{t}"
    );
    for y in 2..13 {
        assert_eq!(buf[(0, y)].symbol(), "┃", "y{y}\n{t}");
        assert_eq!(buf[(27, y)].symbol(), "┃", "y{y}\n{t}");
    }
}

fn sweep_panel(i: usize) -> PanelView {
    let ths = vec![th(300, "#facc15"), th(700, "#f97316"), th(1200, "#ef4444")];
    let mut v = match i % 9 {
        0 => {
            let mut v = view(
                "아주아주아주아주 긴 칸 제목입니다 정말로",
                PanelState::Ok,
                "✔ 정상",
                "1,086 ms",
            );
            v.n_display_items = 2;
            v.display = vec![
                "아주 긴 화면 표시 값 첫째".into(),
                "둘째 값 VIP 등급".into(),
            ];
            v
        }
        1 => {
            let mut v = reason_view(
                "외부 연동",
                "✖ 실패",
                split(
                    "요청 실패: 아주 긴 한글 사유 문구가 계속 이어집니다",
                    Some("로그인 단계 이름이 아주 김"),
                ),
            );
            v.consecutive = Some("123회 연속 · 04:33:14부터".into());
            v
        }
        2 => view(
            "점검 꺼짐",
            PanelState::StaleOff,
            "– 확인 불가 · 점검 꺼짐",
            "—",
        ),
        3 => {
            let mut v = view("결제", PanelState::Slow, "▲ 느림", "29,871 ms");
            v.timeout_seconds = 30;
            v
        }
        4 => {
            let mut v = reason_view("주문", "✖ 실패", detail("HTTP 503", "주문 단계"));
            v.consecutive = Some("3회 연속 · 00:00:10부터".into());
            v
        }
        5 => {
            let mut v = not_contained_view();
            v.n_display_items = 1;
            v.display = vec!["x".into()];
            v
        }
        6 => view("대기", PanelState::Pending, "… 확인 중", "—"),
        7 => {
            let mut v = view("막힘", PanelState::Blocked, "― 확인 못 함", "");
            v.big = BigValue::Reason(split("—", None));
            v
        }
        _ => {
            let mut v = view("제외", PanelState::Skipped, "○ 분기 제외", "");
            v.big = BigValue::Reason(split("분기 제외", None));
            v
        }
    };
    v.bars = (0..40i64)
        .map(|k| {
            if k % 7 == 3 {
                s_bar(BarKind::Fail, T0 + k * 10_000)
            } else {
                s_ok(500 + (k as u64 * 97) % 2500, T0 + k * 10_000)
            }
        })
        .collect();
    v.thresholds = ths;
    v.graph_max_ms = 2000;
    v.stats = Some("평균 12,345 · 최대 29,999 ms".into());
    v
}

/// 처음 표시할 때 만드는 문구.
struct Lazy<F: Fn() -> String>(F);
impl<F: Fn() -> String> std::fmt::Display for Lazy<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&(self.0)())
    }
}

/// 칸 하나의 테두리·머리 줄 불변식: 테두리 온전, 상태 문구는 통째 또는 통째 조각 단위로만 줄고,
/// 선택 칸은 `▶`(흰 바탕)를 늘 보이며 다른 칸엔 `▶`가 없다.
fn assert_panel_frame(
    buf: &Buffer,
    r: &Rect,
    v: &PanelView,
    tier: handicap_tui::view::bigfont::Tier,
    selected: bool,
    ctx: &dyn Fn() -> String,
) {
    use handicap_tui::view::bigfont::Tier;
    let is = |s: &str, set: [&str; 2]| set.contains(&s);
    let (x1, y1) = (r.x + r.width - 1, r.y + r.height - 1);
    // 실패 메시지(화면 전체 글자)는 실패할 때만 만든다 — 스윕이 수천 번 그린다.
    let ctx = Lazy(|| format!("{tier:?} 선택={selected} {}", ctx()));
    assert!(is(buf[(r.x, r.y)].symbol(), ["┌", "┏"]), "{ctx}");
    assert!(is(buf[(x1, r.y)].symbol(), ["┐", "┓"]), "{ctx}");
    assert!(is(buf[(r.x, y1)].symbol(), ["└", "┗"]), "{ctx}");
    assert!(is(buf[(x1, y1)].symbol(), ["┘", "┛"]), "{ctx}");
    for y in r.y + 1..y1 {
        assert!(is(buf[(r.x, y)].symbol(), ["│", "┃"]), "y{y} {ctx}");
        assert!(is(buf[(x1, y)].symbol(), ["│", "┃"]), "y{y} {ctx}");
    }
    for x in r.x + 1..x1 {
        assert!(is(buf[(x, y1)].symbol(), ["─", "━"]), "x{x} {ctx}");
        // S는 위 테두리에 제목을 쓴다.
        if tier != Tier::S {
            assert!(is(buf[(x, r.y)].symbol(), ["─", "━"]), "x{x} {ctx}");
        }
    }
    // 선택 표시: L·M은 머리 줄 첫 칸, S는 위 테두리 제목.
    let (mark_y, mark_x0) = if tier == Tier::S {
        (r.y, r.x + 1)
    } else {
        (r.y + 1, r.x + 2)
    };
    let marks: Vec<u16> = (mark_x0..x1)
        .filter(|&x| buf[(x, mark_y)].symbol() == "▶")
        .collect();
    if selected {
        assert_eq!(marks.len(), 1, "선택 표시 {ctx}");
        if tier != Tier::S {
            assert_eq!(marks[0], r.x + 2, "선택 표시 위치 {ctx}");
        }
        assert_eq!(
            buf[(marks[0], mark_y)].bg,
            rgb("#f2f5f8"),
            "선택 바탕 {ctx}"
        );
    } else {
        assert!(marks.is_empty(), "선택 안 된 칸에 ▶ {ctx}");
    }
    let head = text_at(buf, r.y + 1, r.x + 1, x1 - 1);
    let width = |s: &str| Span::raw(s.to_string()).width() as u16;
    // 상태 문구에 쓸 수 있는 폭: S = 안쪽 전체, L·M = 사용 폭(선택이면 `▶ ` + 사이 1칸을 뺀다).
    let avail = match (tier, selected) {
        (Tier::S, _) => r.width - 2,
        (_, false) => r.width - 4,
        (_, true) => r.width - 4 - 3,
    };
    if !head.contains(v.label) {
        assert!(width(v.label) + 1 > avail, "상태 문구 {} {ctx}", v.label);
        // 통째 조각 단위: ` · `로 나눈 앞 조각들 중 들어가는 가장 긴 것이 보이고,
        // 다음 조각의 일부(단어 중간 자르기)는 없다.
        let segs: Vec<&str> = v.label.split(" · ").collect();
        let fitting = (1..=segs.len())
            .rev()
            .map(|k| segs[..k].join(" · "))
            .find(|p| width(p) <= avail);
        match fitting {
            Some(p) => {
                assert!(head.contains(&p), "상태 문구 조각 {p} {ctx}");
                assert!(
                    !head.contains(&format!("{p} · ")),
                    "상태 문구 중간 자르기 {} {ctx}",
                    v.label
                );
            }
            None => assert!(head.contains('…'), "상태 문구 {} {ctx}", v.label),
        }
    }
}

fn sweep_tier(w: u16, h: u16, panels: &[PanelView]) -> handicap_tui::view::bigfont::Tier {
    use handicap_tui::view::tier::{TierInput, board_tier};
    let lay = layout(Rect::new(0, 0, w, h), panels.len()).unwrap();
    let inners: Vec<(u16, u16)> = lay
        .panels
        .iter()
        .map(|r| (r.width - 2, r.height - 2))
        .collect();
    let inputs: Vec<TierInput> = panels
        .iter()
        .map(|v| TierInput {
            timeout_seconds: v.timeout_seconds,
            has_display_items: v.n_display_items > 0,
            show_stats: v.show_stats,
        })
        .collect();
    board_tier(&inners, &inputs)
}

#[test]
fn lm_resize_sweep_no_overflow() {
    for n in 1..=9usize {
        let (cols, rows) = handicap_tui::judge::grid_for(n);
        let min = (24 * cols as u16, 6 * rows as u16 + 2);
        for (w, h) in [min, (80, 24), (112, 31), (140, 40), (180, 50), (200, 60)] {
            let panels: Vec<PanelView> = (0..n).map(sweep_panel).collect();
            let sc = screen(panels.clone(), (1, 1), 0);
            let buf = render_buf(w, h, &sc);
            let t = buffer_text(&buf);
            let ctx = format!("n={n} {w}x{h}\n{t}");
            assert!(!t.contains("창을 키워"), "{ctx}");
            let lay = layout(Rect::new(0, 0, w, h), n).unwrap();
            let tier = sweep_tier(w, h, &panels);
            for (i, (r, v)) in lay.panels.iter().zip(&panels).enumerate() {
                assert_panel_frame(&buf, r, v, tier, i == 0, &|| format!("칸 {i} {ctx}"));
            }
            let lines: Vec<&str> = t.lines().collect();
            assert!(lines[0].contains("점검 중"), "{ctx}");
            assert!(lines[lines.len() - 1].contains("q 종료"), "{ctx}");
        }
    }
}

/// 선택 칸을 모든 칸 번호로 돌리고 폭은 1칸씩 — 선택 칸이 `점검 꺼짐`(가장 긴 상태 문구)인 경우를
/// 포함한다. 타임아웃·표시 항목을 가볍게 해 좁은 폭에서도 L·M 머리 줄을 지나게 한다.
#[test]
fn selected_panel_sweep_every_index_and_width() {
    use handicap_tui::view::bigfont::Tier;
    let (mut s, mut m, mut l) = (0usize, 0usize, 0usize);
    for n in 1..=9usize {
        let (cols, rows) = handicap_tui::judge::grid_for(n);
        // 칸 높이: S 최소 6 · M 문턱 13(안쪽 11) · L 문턱 15(안쪽 13).
        for ph in [6u16, 13, 15] {
            let h = rows as u16 * ph + 2;
            for w in 24 * cols as u16..=90 {
                for sel in 0..n {
                    // 0: 변형 그대로, 그다음: 선택 칸이 점검 꺼짐(변형 2)이 되게 돌린다.
                    let stale_at_sel = (2 + 9 - sel % 9) % 9;
                    let offsets: &[usize] = if stale_at_sel == 0 {
                        &[0]
                    } else {
                        &[0, stale_at_sel]
                    };
                    for &offset in offsets {
                        let panels: Vec<PanelView> = (0..n)
                            .map(|i| {
                                let mut v = sweep_panel(i + offset);
                                v.timeout_seconds = 5;
                                v.n_display_items = 0;
                                v.display.clear();
                                v
                            })
                            .collect();
                        let buf = render_buf(w, h, &screen(panels.clone(), (1, 1), sel));
                        let tier = sweep_tier(w, h, &panels);
                        match tier {
                            Tier::S => s += 1,
                            Tier::M => m += 1,
                            Tier::L => l += 1,
                        }
                        let lay = layout(Rect::new(0, 0, w, h), n).unwrap();
                        for (i, (r, v)) in lay.panels.iter().zip(&panels).enumerate() {
                            let ctx = || {
                                format!(
                                    "n={n} {w}x{h} 선택 {sel} 칸 {i} offset {offset}\n{}",
                                    buffer_text(&buf)
                                )
                            };
                            assert_panel_frame(&buf, r, v, tier, i == sel, &ctx);
                        }
                    }
                }
            }
        }
    }
    // L·M·S를 모두 지났는지(한 단계에만 머물면 머리 줄 경로를 못 본다).
    assert!(s > 0 && m > 0 && l > 0, "S {s} M {m} L {l}");
}

// ---------- 테두리 모양·선택 제목·바탕 (Task 5) ----------

fn rgb(hex: &str) -> Color {
    parse_hex(hex).unwrap()
}
/// 넓은 글자 뒤 채움 칸 — ratatui가 바탕을 다시 쓰지 않고(터미널이 앞 칸 바탕으로 칠한다) 비워 둔다.
fn is_wide_tail(buf: &Buffer, x: u16, y: u16) -> bool {
    x > 0 && Span::raw(buf[(x - 1, y)].symbol().to_string()).width() == 2
}

#[test]
fn border_styles_heavy_and_block() {
    let panels = || {
        vec![
            view("로그인", PanelState::Ok, "✔ 정상", "182 ms"),
            view("주문 조회", PanelState::Ok, "✔ 정상", "99 ms"),
            view("결제", PanelState::Ok, "✔ 정상", "10 ms"),
        ]
    };
    let mut sc = screen(panels(), (1, 1), 1);
    let heavy = buffer_text(&render_buf(80, 24, &sc));
    assert_eq!(heavy.matches('┏').count(), 3, "{heavy}");
    assert!(!heavy.contains('┌') && !heavy.contains('▛'), "{heavy}");
    sc.border = BorderStyle::Block;
    let block = buffer_text(&render_buf(80, 24, &sc));
    assert_eq!(block.matches('▛').count(), 3, "{block}");
    assert!(!block.contains('┌') && !block.contains('┏'), "{block}");
    assert_eq!(BorderStyle::Heavy.toggled(), BorderStyle::Block);
    assert_eq!(BorderStyle::Block.toggled(), BorderStyle::Heavy);
    assert_eq!(BorderStyle::default(), BorderStyle::Heavy);
}

#[test]
fn selected_panel_is_inverted_title_not_border() {
    let inv = rgb("#f2f5f8");
    // L/M: 112×31 여섯 칸, 칸 0 선택.
    let sc = screen(six_mixed(), (1, 1), 0);
    let buf = render_buf(112, 31, &sc);
    let t = buffer_text(&buf);
    let lay = layout(Rect::new(0, 0, 112, 31), 6).unwrap();
    let head = |i: usize| {
        let inn = inner_of(lay.panels[i]);
        (inn.x + 1, inn.y)
    };
    let (x0, y) = head(0);
    assert!(text_at(&buf, y, x0, x0 + 7).starts_with("▶ 로그인"), "{t}");
    for x in (x0..x0 + 8).filter(|&x| !is_wide_tail(&buf, x, y)) {
        assert_eq!(buf[(x, y)].bg, inv, "x{x}\n{t}");
        assert_eq!(buf[(x, y)].fg, rgb("#0b0f14"), "x{x}");
    }
    let (ux, uy) = head(4);
    assert!(
        text_at(&buf, uy, ux, ux + 13).starts_with("회원 등급"),
        "{t}"
    );
    assert!(!text_at(&buf, uy, ux, ux + 13).contains('▶'), "{t}");
    for x in (ux..ux + 14).filter(|&x| !is_wide_tail(&buf, x, uy)) {
        assert_ne!(buf[(x, uy)].bg, inv, "x{x}\n{t}");
    }
    for r in &lay.panels {
        assert_eq!(buf[(r.x, r.y)].symbol(), "┏", "{t}");
    }
    // S: 위 테두리 제목.
    let sv = |title: &str| s_view(lm_bars(3, 100), 2000).tap_title(title);
    let sc = screen(vec![sv("로그인"), sv("주문")], (1, 1), 0);
    let buf = render_buf(60, 12, &sc);
    let t = buffer_text(&buf);
    let top = text_at(&buf, 1, 0, 59);
    let col = top.find("▶ 로그인").map(|b| top[..b].chars().count());
    let col = col.expect(&t) as u16;
    // `▶ 로그인`은 모두 한 칸 폭(▶) + 공백 + 넓은 글자라 열 번호는 글자 수와 같다.
    for x in (col..col + 8).filter(|&x| !is_wide_tail(&buf, x, 1)) {
        assert_eq!(buf[(x, 1)].bg, inv, "x{x}\n{t}");
    }
    assert_eq!(buf[(0, 1)].symbol(), "┏", "{t}");
    let other = text_at(&buf, 1, 30, 59);
    assert!(other.contains("주문") && !other.contains('▶'), "{t}");
}

trait TapTitle {
    fn tap_title(self, t: &str) -> Self;
}
impl TapTitle for PanelView {
    fn tap_title(mut self, t: &str) -> Self {
        self.title = t.into();
        self
    }
}

#[test]
fn tint_slow_and_fail_only() {
    let mut views = six_mixed();
    views[1]
        .bars
        .iter_mut()
        .for_each(|b| b.color = rgb("#f59e0b"));
    views[2]
        .bars
        .iter_mut()
        .for_each(|b| b.color = rgb("#ef4444"));
    let sc = screen(views, (1, 1), 0);
    let buf = render_buf(112, 31, &sc);
    let t = buffer_text(&buf);
    let lay = layout(Rect::new(0, 0, 112, 31), 6).unwrap();
    let inside = |i: usize| {
        let inn = inner_of(lay.panels[i]);
        (inn.y..inn.y + inn.height)
            .flat_map(move |y| (inn.x..inn.x + inn.width).map(move |x| (x, y)))
            .collect::<Vec<_>>()
    };
    let bg_of = |i: usize| buf[(inner_of(lay.panels[i]).x, inner_of(lay.panels[i]).y)].bg;
    let (slow, fail) = (bg_of(1), bg_of(2));
    assert!(
        matches!(slow, Color::Rgb(..)) && matches!(fail, Color::Rgb(..)),
        "{t}"
    );
    assert_ne!(slow, fail);
    assert_ne!(slow, rgb("#f59e0b"));
    assert_ne!(fail, rgb("#ef4444"));
    assert_eq!(bg_of(3), fail, "실패 칸 둘은 같은 바탕");
    for i in [1usize, 2, 3] {
        let want = bg_of(i);
        for (x, y) in inside(i)
            .into_iter()
            .filter(|&(x, y)| !is_wide_tail(&buf, x, y))
        {
            assert_eq!(
                buf[(x, y)].bg,
                want,
                "칸 {i} ({x},{y}) {:?}\n{t}",
                buf[(x, y)].symbol()
            );
        }
    }
    // 실패 칸 안: 막대·점선·기준선 숫자가 실제로 있고 모두 바탕을 유지한다.
    let cells: Vec<(u16, u16)> = inside(2);
    let has = |pred: &dyn Fn(&str) -> bool| cells.iter().any(|&(x, y)| pred(buf[(x, y)].symbol()));
    assert!(has(&|s| s == "█"), "{t}");
    assert!(has(&|s| s == "╌"), "{t}");
    assert!(has(&|s| s == "7"), "기준선 숫자\n{t}");
    for i in [4usize, 5] {
        for (x, y) in inside(i) {
            assert_eq!(buf[(x, y)].bg, Color::Reset, "정상 칸 {i} ({x},{y})");
        }
    }
    // S 단계도 같은 규칙.
    let mut f = s_fail_view(
        vec![s_ok(100, 0), s_bar(BarKind::Fail, 10_000)],
        2000,
        vec![th(700, "#facc15")],
    );
    f.bars[1].color = rgb("#ef4444");
    let ok = s_view(vec![s_ok(100, 0)], 2000);
    let sc = screen(vec![f, ok], (1, 1), 0);
    let buf = render_buf(60, 12, &sc);
    let lay = layout(Rect::new(0, 0, 60, 12), 2).unwrap();
    let (a, b) = (inner_of(lay.panels[0]), inner_of(lay.panels[1]));
    let t = buffer_text(&buf);
    for y in a.y..a.y + a.height {
        for x in (a.x..a.x + a.width).filter(|&x| !is_wide_tail(&buf, x, y)) {
            assert_eq!(buf[(x, y)].bg, fail, "S 실패 ({x},{y})\n{t}");
        }
    }
    for y in b.y..b.y + b.height {
        for x in b.x..b.x + b.width {
            assert_eq!(buf[(x, y)].bg, Color::Reset, "S 정상 ({x},{y})");
        }
    }
}

#[test]
fn render_with_keys_reports_panels_drawn() {
    let s = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 1), 0);
    let mut t = Terminal::new(TestBackend::new(80, 24)).unwrap();
    let mut drawn = false;
    t.draw(|f| drawn = render_with_keys(f, &s, KeyBar::Monitor))
        .unwrap();
    assert!(drawn);
    let mut t = Terminal::new(TestBackend::new(10, 4)).unwrap();
    t.draw(|f| drawn = render_with_keys(f, &s, KeyBar::Monitor))
        .unwrap();
    assert!(!drawn);
}

#[test]
fn key_bar_has_border_key() {
    let s = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 1), 0);
    let t = draw(80, 12, |f| render(f, &s));
    assert_eq!(
        t.lines().last().unwrap().trim(),
        "b 테두리  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
    let t = draw(24, 8, |f| render(f, &s));
    let last = t.lines().last().unwrap();
    assert!(!last.contains("칸 이동"), "{t}");
    assert!(last.contains("q 종료"), "{t}");
    // 좁으면 앞 조각(`b 테두리` → `칸 이동` → …)부터 통째로 빠지고 `? 도움말  q 종료`는 남는다.
    let t = draw(30, 8, |f| render(f, &s));
    let last = t.lines().last().unwrap();
    assert!(last.contains("? 도움말  q 종료"), "{t}");
    assert!(!last.contains("b 테두리"), "{t}");
}

#[test]
fn help_zoom_row_whole_from_50_columns() {
    // US3: 고정 방법(`--zoom=1.6`)이 좁은 터미널에서도 단어 중간에서 잘리지 않는다(도움말은 줄바꿈 안 함).
    let log = LogLoc::Path("/tmp/tui.log".into());
    for w in 50..=80u16 {
        let text = draw(w, 24, |f| render_help(f, Path::new("/tmp/b.json"), &log));
        let line = text.lines().find(|l| l.contains("Ctrl + + / -")).unwrap();
        assert!(line.contains("--zoom=1.6"), "w{w}\n{text}");
        assert!(line.contains("글자 크기"), "w{w}\n{text}");
    }
    // 80칸에서는 키 줄 전부가 통째로 보인다.
    let text = draw(80, 24, |f| render_help(f, Path::new("/tmp/b.json"), &log));
    for (k, d) in handicap_tui::text::HELP_KEYS {
        let line = text
            .lines()
            .find(|l| l.contains(&format!("│{k} ")))
            .unwrap();
        assert!(line.contains(d), "{k} {text}");
    }
    // 폭이 모호한 글자(− U+2212, ↔) 없이 — 터미널마다 1칸/2칸이 달라 줄이 밀린다.
    for (k, d) in handicap_tui::text::HELP_KEYS {
        for c in ['−', '↔'] {
            assert!(!k.contains(c) && !d.contains(c), "{k} {d}");
        }
    }
}

#[test]
fn help_zoom_row_first_and_survives_small_height() {
    let log = LogLoc::Path("/tmp/tui.log".into());
    let text = draw(80, 24, |f| render_help(f, Path::new("/tmp/b.json"), &log));
    let line = text.lines().find(|l| l.contains("Ctrl + + / -")).unwrap();
    assert!(line.contains("--zoom=1.6"), "{text}");
    let zoom_at = text.find("Ctrl + + / -").unwrap();
    for other in ["방향키", "테두리 모양 바꾸기", "마우스 왼쪽 클릭"] {
        assert!(zoom_at < text.find(other).unwrap(), "{other} {text}");
    }
    let path = format!("/{}", "Z".repeat(150));
    // 높이 10: 본문 7행 = 경로 3 + 로그 1 + 무입력 1 + 복사 1 + 키 1 — 남는 한 줄이 글자 크기 줄.
    let text = draw(80, 10, |f| render_help(f, Path::new(&path), &log));
    assert!(text.contains("Ctrl + + / -"), "{text}");
    assert!(!text.contains("방향키"), "{text}");
}

#[test]
fn header_view_matches_monitor_header() {
    for (w, pos, down) in [
        (100u16, (1, 2), false),
        (80, (1, 1), true),
        (40, (2, 3), false),
        (24, (1, 2), true),
    ] {
        let mut sc = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], pos, 0);
        sc.server_down = down;
        let monitor = draw(w, 8, |f| render(f, &sc));
        let h = sc.header();
        assert_eq!(h.board_name, sc.board_name);
        let alone = draw(w, 1, |f| render_header_view(f, f.area(), &h));
        assert_eq!(
            alone.lines().next().unwrap(),
            monitor.lines().next().unwrap(),
            "w={w}"
        );
    }
}

#[test]
fn key_bar_has_errors_and_settings_keys() {
    let one = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 1), 0);
    let t = draw(100, 12, |f| render(f, &one));
    assert_eq!(
        t.lines().last().unwrap().trim(),
        "b 테두리  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
    let two = screen(vec![view("a", PanelState::Ok, "✔ 정상", "1 ms")], (1, 2), 0);
    let t = draw(100, 12, |f| render(f, &two));
    assert_eq!(
        t.lines().last().unwrap().trim(),
        "b 테두리  Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
    let t = draw(80, 12, |f| render(f, &two));
    assert_eq!(
        t.lines().last().unwrap().trim(),
        "Tab 다음 보드  ←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
    let t = draw(60, 12, |f| render(f, &two));
    assert_eq!(
        t.lines().last().unwrap().trim(),
        "←↑↓→ 칸 이동  e 오류 보기  Enter 칸 설정  ? 도움말  q 종료"
    );
}

#[test]
fn help_lists_new_keys_and_idle_rule() {
    let log = LogLoc::Path("/tmp/tui.log".into());
    assert_eq!(handicap_tui::text::HELP_KEYS.len(), 10);
    let text = draw(80, 30, |f| render_help(f, Path::new("/tmp/b.json"), &log));
    println!("{text}");
    for want in [
        "선택 칸 오류 보기",
        "선택 칸 설정 보기",
        "5분 동안 입력이 없으면 모니터로 돌아갑니다",
    ] {
        assert!(text.contains(want), "{want}\n{text}");
    }
    // `e`·`Enter` 줄은 `b` 줄 앞.
    let at = |n: &str| text.find(n).unwrap();
    assert!(at("선택 칸 오류 보기") < at("테두리 모양 바꾸기"), "{text}");
    assert!(at("선택 칸 설정 보기") < at("테두리 모양 바꾸기"), "{text}");
    // 50열: 무입력 문장이 상자 안에서 두 줄로 나뉘고, 테두리 밖 글자·말줄임이 없다.
    let text = draw(50, 30, |f| render_help(f, Path::new("/tmp/b.json"), &log));
    println!("{text}");
    let rows: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("5분") || l.contains("돌아갑니다"))
        .collect();
    assert_eq!(rows.len(), 2, "{text}");
    for l in &rows {
        assert!(l.trim_end().ends_with('│'), "{l:?}\n{text}");
    }
    let joined: String = rows
        .iter()
        .map(|l| l.trim().trim_matches('│').trim())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        joined.contains("5분 동안 입력이 없으면 모니터로 돌아갑니다"),
        "{joined}"
    );
    assert!(!text.contains('…'), "{text}");
}
