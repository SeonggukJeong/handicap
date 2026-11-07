//! 화면 렌더링 — 뷰 모델·시각 줄·줄 우선순위·격자·각 화면(ratatui `TestBackend`).

use std::path::Path;

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::{BoardConfig, DisplayItem, PanelConfig, Threshold};
use handicap_tui::judge::{PanelState, format_hm, format_hms};
use handicap_tui::logging::LogLoc;
use handicap_tui::poll::PollSnapshot;
use handicap_tui::session::{Stage, StartError};
use handicap_tui::view::axis::{Mark, axis_marks, axis_uses_seconds};
use handicap_tui::view::error::{render_error, render_usage};
use handicap_tui::view::graph::{column, label_width, threshold_rows};
use handicap_tui::view::model::{
    Bar, BarKind, BigValue, PanelView, Row, ThresholdView, build_panels, panel_rows, parse_hex,
};
use handicap_tui::view::monitor::{
    KeyBar, MonitorScreen, layout, panel_at, render, render_with_keys,
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
        text.contains("←↑↓→ 칸 이동  Tab 다음 보드  ? 도움말  q 종료"),
        "{text}"
    );
    assert!(text.contains('┏'), "선택 칸 굵은 테두리\n{text}");
    assert!(text.contains('┌'), "비선택 칸 일반 테두리\n{text}");
    // 선택 칸이 하나뿐이어야 한다.
    assert_eq!(text.matches('┏').count(), 1, "{text}");
}

#[test]
fn render_key_bar_single_board_omits_tab() {
    let s = screen(
        vec![view("로그인", PanelState::Ok, "✔ 정상", "182 ms")],
        (1, 1),
        0,
    );
    let text = draw(80, 24, |f| render(f, &s));
    assert!(text.contains("←↑↓→ 칸 이동  ? 도움말  q 종료"), "{text}");
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
    assert_eq!(panel_rows(1, true, true, true, 2), vec![Status]);
    assert_eq!(panel_rows(2, true, true, true, 2), vec![Status, Bars]);
    assert_eq!(panel_rows(3, true, true, true, 2), vec![Status, Bars, Axis]);
    assert_eq!(
        panel_rows(4, true, true, true, 2),
        vec![Status, Consecutive, Bars, Axis]
    );
    assert_eq!(
        panel_rows(4, true, false, true, 2),
        vec![Status, ReasonSmall, Bars, Axis]
    );
    assert_eq!(
        panel_rows(5, true, true, true, 2),
        vec![Status, ReasonSmall, Consecutive, Bars, Axis]
    );
    assert_eq!(
        panel_rows(5, false, false, true, 2),
        vec![Status, Bars, Axis, Stats, Display(0)]
    );
    let six = panel_rows(6, false, true, true, 2);
    assert!(!six.contains(&Display(1)));
    assert_eq!(six.len(), 6);
    assert_eq!(
        panel_rows(9, true, true, true, 2),
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
    assert!(panel_rows(0, true, true, true, 2).is_empty());
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
        let text = draw(80, 24, |f| render(f, &sc));
        // 안쪽 폭 24(칸 폭 26) → 보이는 막대 24개 → 가장 오래된 보이는 결과는 30-24 = 6번.
        let oldest = rs[6].at_ms;
        if secs {
            assert!(text.contains(&format_hms(oldest)), "{text}");
        } else {
            assert!(text.contains(&format_hm(oldest)), "{text}");
            assert!(!text.contains(&format_hms(oldest)), "{text}");
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
    assert!(h80.contains("2023-11-15"), "{h80}");
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
    assert_eq!(col("칸 선택 이동"), col("그 칸 선택"));
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
    // 높이 9: 본문 6행 = 경로 3 + 로그 1 + 복사 1 + 키 1
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
    // (state, border, big, small)
    let cases = [
        (
            PanelState::Blocked,
            0x475569u32,
            0x94a3b8u32,
            Some(0x64748bu32),
        ),
        (PanelState::Skipped, 0x64748b, 0xe2e8f0, Some(0xe2e8f0)),
        (PanelState::ConfigError, 0x64748b, 0x94a3b8, Some(0x94a3b8)),
        (PanelState::Stale, 0x64748b, 0x94a3b8, None),
        (PanelState::Fail, 0xef4444, 0xef4444, Some(0xef4444)),
        (PanelState::Ok, 0x22c55e, 0xf2f5f8, None),
    ];
    for (state, border, big, small) in cases {
        let mut v = view("t", state, "L", "abc");
        if small.is_some() {
            v.big = BigValue::Reason(handicap_tui::judge::ReasonParts::Split {
                fixed: "abc".into(),
                step: Some("xyz".into()),
            });
        }
        let sc = screen(vec![v], (1, 1), 0);
        let buf = render_buf(80, 24, &sc);
        assert_eq!(buf[(0, 1)].fg, rgb(border), "{state:?} border");
        let x = col_of_last_nonblank(&buf, 2);
        assert_eq!(buf[(x, 2)].fg, rgb(big), "{state:?} big");
        if let Some(sm) = small {
            let x = col_of_last_nonblank(&buf, 3);
            assert_eq!(buf[(x, 3)].fg, rgb(sm), "{state:?} small");
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
    t.draw(|f| render_with_keys(f, &s, bar)).unwrap();
    last_row(t.backend().buffer())
}

#[test]
fn bottom_key_bar_shows_only_keys_of_the_open_screen() {
    // 모니터 단독: 기존 그대로(보드 2개라 Tab 포함).
    let monitor = key_bar_row(KeyBar::Monitor);
    assert_eq!(monitor, "←↑↓→ 칸 이동  Tab 다음 보드  ? 도움말  q 종료");
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
}
