//! 큰 글꼴(`bigfont`)·크기 단계(`tier`) — 순수 함수.

use handicap_tui::view::bigfont::{Tier, rows, supported, width};
use handicap_tui::view::monitor::layout;
use handicap_tui::view::tier::{TierInput, board_tier, panel_tier, reserved_rows};
use ratatui::layout::Rect;

fn inp(timeout_seconds: u32, has_display_items: bool, show_stats: bool) -> TierInput {
    TierInput {
        timeout_seconds,
        has_display_items,
        show_stats,
    }
}

#[test]
fn bigfont_widths_and_rows() {
    assert_eq!(width("30,000", Tier::M), 21);
    assert_eq!(width("30,000", Tier::L), 42);
    assert!(supported("HTTP 503") && supported("1,407"));
    assert!(!supported("요청 실패") && !supported("—") && !supported("ms"));
    let r = rows("1", Tier::M);
    assert_eq!(r.len(), 3);
    assert!(r.iter().all(|l| l.chars().count() == 3));
    let r = rows("1", Tier::L);
    assert_eq!(r.len(), 5);
    assert!(r.iter().all(|l| l.chars().count() == 6));
    // 모든 지원 글자·두 단계에서 줄 길이 == width
    let all = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-:,. ";
    for t in [Tier::M, Tier::L] {
        let r = rows(all, t);
        assert!(r.iter().all(|l| l.chars().count() == width(all, t)));
    }
    assert_eq!(width("한글", Tier::S), 4);
    assert_eq!(rows("ab", Tier::S), vec!["ab".to_string()]);
}

#[test]
fn tier_is_fixed_by_config_not_value() {
    let p = inp(30, false, true);
    assert_eq!(panel_tier(32, 13, &p), Tier::M);
}

#[test]
fn tier_reserves_fail_rows_and_stats() {
    assert_eq!(reserved_rows(Tier::M, true), 11);
    assert_eq!(reserved_rows(Tier::L, true), 13);
    assert_eq!(reserved_rows(Tier::M, false), 10);
    let p = inp(30, false, true);
    assert_eq!(panel_tier(40, 10, &p), Tier::S);
    assert_eq!(panel_tier(40, 11, &p), Tier::M);
    assert_eq!(panel_tier(100, 13, &p), Tier::L);
}

#[test]
fn tier_display_items_need_left_area() {
    assert_eq!(panel_tier(32, 13, &inp(30, false, true)), Tier::M);
    assert_eq!(panel_tier(32, 13, &inp(30, true, true)), Tier::S);
    assert_eq!(panel_tier(33, 13, &inp(30, true, true)), Tier::M);
}

#[test]
fn board_tier_takes_minimum() {
    let ps = [
        inp(30, false, true),
        inp(30, false, true),
        inp(30, false, true),
    ];
    assert_eq!(board_tier(&[(100, 20), (100, 20), (100, 20)], &ps), Tier::L);
    assert_eq!(board_tier(&[(100, 20), (40, 13), (100, 20)], &ps), Tier::M);
    assert_eq!(board_tier(&[(100, 20), (40, 13), (10, 5)], &ps), Tier::S);
    assert_eq!(board_tier(&[], &[]), Tier::S);
}

#[test]
fn six_panels_at_112x31_and_180x50() {
    let ps: Vec<TierInput> = [5, 30, 5, 30, 5, 30]
        .into_iter()
        .map(|t| inp(t, false, true))
        .collect();
    for (w, h, want) in [(112, 31, Tier::M), (180, 50, Tier::L)] {
        let l = layout(Rect::new(0, 0, w, h), 6).unwrap();
        let inners: Vec<(u16, u16)> = l
            .panels
            .iter()
            .map(|r| (r.width - 2, r.height - 2))
            .collect();
        assert_eq!(board_tier(&inners, &ps), want, "{w}x{h}");
    }
}
