//! TS(`ui/src/monitor/__tests__/logic.test.ts`·`display.test.ts`) ↔ Rust 1:1 패리티.

use handicap_controller::monitor::check::{CheckResult, Verdict};
use handicap_controller::monitor::config::Threshold;
use handicap_tui::judge::*;
use handicap_tui::text;

fn mk(at: i64, verdict: Verdict, ms: Option<u64>) -> CheckResult {
    CheckResult {
        at_ms: at,
        verdict,
        latency_ms: ms,
        reason: None,
        detail: None,
        display: vec![],
    }
}
fn ok(at: i64, ms: Option<u64>) -> CheckResult {
    mk(at, Verdict::Ok, ms)
}
fn th() -> Vec<Threshold> {
    vec![
        Threshold {
            ms: 1000,
            color: "#f59e0b".into(),
        },
        Threshold {
            ms: 3000,
            color: "#ef4444".into(),
        },
    ]
}

struct Args {
    latest: Option<CheckResult>,
    now_ms: i64,
    started_at_ms: Option<i64>,
    enabled: bool,
    server_down: bool,
    interval_sec: u32,
    budget_sec: u32,
    thresholds: Vec<Threshold>,
}
fn base() -> Args {
    Args {
        latest: None,
        now_ms: 100_000,
        started_at_ms: Some(50_000),
        enabled: true,
        server_down: false,
        interval_sec: 10,
        budget_sec: 5,
        thresholds: th(),
    }
}
fn state(a: &Args) -> PanelState {
    panel_state(&PanelStateInput {
        latest: a.latest.as_ref(),
        now_ms: a.now_ms,
        started_at_ms: a.started_at_ms,
        enabled: a.enabled,
        server_down: a.server_down,
        interval_sec: a.interval_sec,
        budget_sec: a.budget_sec,
        thresholds: &a.thresholds,
    })
}

#[test]
fn format_ms_integer_commas() {
    assert_eq!(format_ms(1350.0), "1,350 ms");
    assert_eq!(format_ms(7.0), "7 ms");
    assert_eq!(format_stat_num(1350.0), "1,350");
}

#[test]
fn bar_color_highest_crossed() {
    let t = th();
    assert_eq!(bar_color(999, &t), "#22c55e");
    assert_eq!(bar_color(1000, &t), "#f59e0b");
    assert_eq!(bar_color(5000, &t), "#ef4444");
    assert_eq!(bar_color(5000, &[]), "#22c55e");
    assert_eq!(DEFAULT_BAR_COLOR, "#22c55e");
}

#[test]
fn slots_right_fill() {
    let (r1, r2) = (ok(1, Some(1)), ok(2, Some(2)));
    let v = [r1.clone(), r2.clone()];
    let s = bar_slots(&v, 5);
    assert_eq!(s, vec![None, None, None, Some(&r1), Some(&r2)]);
}

#[test]
fn slots_evict_oldest() {
    let rs: Vec<_> = (0..12).map(|i| ok(i, Some(i as u64))).collect();
    let s = bar_slots(&rs, 10);
    assert_eq!(s.len(), 10);
    assert_eq!(s[0].unwrap().at_ms, 2);
    assert_eq!(s[9].unwrap().at_ms, 11);
}

#[test]
fn state_slow_uses_current_thresholds() {
    let mut a = base();
    a.latest = Some(ok(99_000, Some(1500)));
    assert_eq!(state(&a), PanelState::Slow);
    a.thresholds = vec![];
    assert_eq!(state(&a), PanelState::Ok);
    let mut b = base();
    b.latest = Some(ok(99_000, None));
    assert_eq!(state(&b), PanelState::Ok);
}

#[test]
fn state_fail_and_config_error() {
    let mut a = base();
    a.latest = Some(mk(99_000, Verdict::Fail, None));
    assert_eq!(state(&a), PanelState::Fail);
    a.latest = Some(mk(99_000, Verdict::ConfigError, None));
    assert_eq!(state(&a), PanelState::ConfigError);
}

#[test]
fn stale_after_grace() {
    assert_eq!(stale_after_ms(10, 5), 40_000);
    let mut a = base();
    a.latest = Some(ok(60_000, Some(5)));
    a.now_ms = 100_000;
    assert_eq!(state(&a), PanelState::Stale);
    a.now_ms = 99_000;
    assert_eq!(state(&a), PanelState::Ok);
}

#[test]
fn panel_state_new_states() {
    let mut a = base();
    a.latest = Some(mk(99_000, Verdict::UpstreamFailed, Some(9999)));
    assert_eq!(state(&a), PanelState::Blocked);
    a.latest = Some(mk(99_000, Verdict::BranchSkipped, Some(9999)));
    assert_eq!(state(&a), PanelState::Skipped);
}

#[test]
fn stale_outranks_new_states() {
    for v in [Verdict::UpstreamFailed, Verdict::BranchSkipped] {
        let mut a = base();
        a.latest = Some(mk(1_000, v, None));
        a.now_ms = 1_000_000;
        assert_eq!(state(&a), PanelState::Stale);
    }
}

#[test]
fn stale_uses_budget() {
    let mut a = base();
    a.latest = Some(ok(54_000, Some(5)));
    a.budget_sec = 53;
    a.now_ms = 100_000;
    assert_eq!(state(&a), PanelState::Ok);
    a.latest = Some(ok(11_000, Some(5)));
    assert_eq!(state(&a), PanelState::Stale);
}

#[test]
fn pending_until_grace_after_start() {
    let mut a = base();
    a.now_ms = 60_000;
    assert_eq!(state(&a), PanelState::Pending);
    a.now_ms = 100_000;
    assert_eq!(state(&a), PanelState::Stale);
    let mut b = base();
    b.started_at_ms = None;
    assert_eq!(state(&b), PanelState::Pending);
}

#[test]
fn stale_off_when_disabled() {
    let mut a = base();
    a.enabled = false;
    a.latest = Some(ok(99_000, Some(1)));
    assert_eq!(state(&a), PanelState::StaleOff);
}

#[test]
fn server_down_forces_stale() {
    let mut a = base();
    a.server_down = true;
    a.enabled = false;
    a.latest = Some(ok(99_000, Some(1)));
    assert_eq!(state(&a), PanelState::Stale);
}

#[test]
fn grid_table() {
    let t = [
        (1, 1, 1),
        (2, 2, 1),
        (3, 3, 1),
        (4, 2, 2),
        (5, 3, 2),
        (6, 3, 2),
        (7, 3, 3),
        (9, 3, 3),
    ];
    for (n, cols, rows) in t {
        assert_eq!(grid_for(n), (cols, rows), "n={n}");
    }
}

#[test]
fn big_value_text_cases() {
    assert_eq!(
        big_value_text(PanelState::Ok, Some(&ok(1, Some(1350)))),
        "1,350 ms"
    );
    assert_eq!(
        big_value_text(PanelState::Slow, Some(&ok(1, Some(1350)))),
        "1,350 ms"
    );
    assert_eq!(big_value_text(PanelState::Ok, Some(&ok(1, None))), "—");
    let mut f = mk(1, Verdict::Fail, None);
    f.reason = Some("시간 초과(5초)".into());
    assert_eq!(big_value_text(PanelState::Fail, Some(&f)), "시간 초과(5초)");
    f.reason = Some("r".into());
    assert_eq!(big_value_text(PanelState::ConfigError, Some(&f)), "r");
    assert_eq!(big_value_text(PanelState::Stale, Some(&f)), "—");
    assert_eq!(big_value_text(PanelState::StaleOff, None), "—");
    assert_eq!(big_value_text(PanelState::Pending, None), "—");
}

#[test]
fn consecutive_threshold() {
    assert!(!show_consecutive(1));
    assert!(show_consecutive(2));
}

#[test]
fn latency_stats_avg_max_rounded() {
    let v = [ok(1, Some(100)), ok(1, Some(201)), ok(1, Some(300))];
    assert_eq!(latency_stats(&v), Some((200, 300)));
    assert_eq!(
        latency_stats(&[ok(1, Some(1)), ok(1, Some(2))]),
        Some((2, 2))
    );
}

#[test]
fn latency_stats_includes_slow() {
    assert_eq!(
        latency_stats(&[ok(1, Some(100)), ok(1, Some(99_000))]),
        Some((49_550, 99_000))
    );
}

#[test]
fn latency_stats_excludes_fail_config_null() {
    let v = [
        mk(1, Verdict::Fail, None),
        mk(1, Verdict::ConfigError, None),
        ok(1, None),
        ok(1, Some(50)),
    ];
    assert_eq!(latency_stats(&v), Some((50, 50)));
}

#[test]
fn latency_stats_none_when_empty() {
    assert_eq!(latency_stats(&[]), None);
    assert_eq!(
        latency_stats(&[
            mk(1, Verdict::Fail, None),
            mk(1, Verdict::ConfigError, None)
        ]),
        None
    );
}

#[test]
fn split_reason_at_first_separator() {
    assert_eq!(
        split_reason("HTTP 503 · 회원 인증 · 2단계"),
        (
            "HTTP 503".to_string(),
            Some("회원 인증 · 2단계".to_string())
        )
    );
    assert_eq!(
        split_reason("시간 초과(5초)"),
        ("시간 초과(5초)".to_string(), None)
    );
}

#[test]
fn reason_parts_without_detail_splits_as_before() {
    assert_eq!(
        reason_parts("HTTP 503 · 인증", None),
        ReasonParts::Split {
            fixed: "HTTP 503".into(),
            step: Some("인증".into())
        }
    );
}

#[test]
fn reason_parts_detail_never_splits() {
    assert_eq!(
        reason_parts("a · b", Some("x = y")),
        ReasonParts::Detail {
            big: "a · b".into(),
            small: "x = y".into()
        }
    );
}

#[test]
fn reason_parts_not_contained_three_conditions() {
    assert_eq!(
        reason_parts("\"OK\" 포함 안 됨", Some("본문 전체 글자 포함 OK")),
        ReasonParts::NotContained {
            needle: "OK".into(),
            small: "본문 전체 글자 포함 OK".into()
        }
    );
    let is_detail =
        |r: &str, d: &str| matches!(reason_parts(r, Some(d)), ReasonParts::Detail { .. });
    assert!(is_detail("비어 있음", "본문 전체 값 있음"));
    assert!(is_detail("응답 본문이 너무 큼", "본문 전체 글자 포함 OK"));
    assert!(is_detail("\"OK\" 포함 안 됨", "본문 · 포함 OK"));
    assert!(is_detail("\"OK", "본문 전체 글자 포함 OK"));
    assert!(is_detail("\"OK\" 포함 안 됨", "본문 전체 · 포함 OK"));
}

#[test]
fn format_hm_shape() {
    for ms in [0_i64, 1_700_000_000_000, 1_762_500_123_456, 86_399_999] {
        let hms = format_hms(ms);
        let hm = format_hm(ms);
        assert_eq!(hm.len(), 5, "{hm}");
        assert_eq!(hm, hms[..5]);
        let b: Vec<char> = hms.chars().collect();
        assert_eq!(b.len(), 8);
        for (i, c) in b.iter().enumerate() {
            if i == 2 || i == 5 {
                assert_eq!(*c, ':');
            } else {
                assert!(c.is_ascii_digit(), "{hms}");
            }
        }
    }
}

#[test]
fn text_labels_match_ko() {
    use PanelState::*;
    let expect = [
        (Ok, "✔ 정상"),
        (Slow, "▲ 느림"),
        (Fail, "✖ 실패"),
        (ConfigError, "⚠ 설정 오류"),
        (Blocked, "― 확인 못 함"),
        (Skipped, "○ 분기 제외"),
        (Stale, "– 확인 불가"),
        (StaleOff, "– 확인 불가 · 점검 꺼짐"),
        (Pending, "… 확인 중"),
    ];
    for (s, l) in expect {
        assert_eq!(text::state_label(s), l);
    }
    assert_eq!(text::consecutive(4, "09:39:51"), "4회 연속 · 09:39:51부터");
    assert_eq!(text::STATS_AVG, "평균");
    assert_eq!(text::STATS_MAX, "최대");
    assert_eq!(text::SERVER_DOWN, "서버 응답 없음");
    assert_eq!(text::NO_VALUE, "—");
}

/// GUI와 같은 뜻의 TUI 문구가 `ui/src/i18n/ko.ts` 값과 글자까지 같다(이후 task가 행을 더한다).
#[test]
fn mirrored_text_exists_in_ko_ts() {
    let ko = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ui/src/i18n/ko.ts"
    ))
    .unwrap();
    assert_eq!(text::LOADING, "불러오는 중…");
    assert!(
        ko.contains(&format!("loading: \"{}\"", text::LOADING)),
        "ko.monitor.loading"
    );
    assert_eq!(
        text::record_load_error("m"),
        "기록을 불러오지 못했습니다: m"
    );
    let tmpl = text::record_load_error("${msg}");
    assert!(
        ko.contains(&format!("recordLoadError: (msg: string) => `{tmpl}`")),
        "ko.monitor.recordLoadError"
    );
}

#[test]
fn reason_parts_multibyte_needle() {
    assert_eq!(
        reason_parts("\"한글\" 포함 안 됨", Some("본문 전체 글자 포함 x")),
        ReasonParts::NotContained {
            needle: "한글".into(),
            small: "본문 전체 글자 포함 x".into(),
        }
    );
}
