//! 점검 기록 가공(`monitor::record`)의 공개 표면 — 세부 규칙은 `record.rs` 인라인 테스트.

#[test]
fn mask_constant_is_four_bullets() {
    assert_eq!(handicap_controller::monitor::record::MASK, "••••");
    assert_eq!(
        handicap_controller::monitor::record::MASK.chars().count(),
        4
    );
    assert!(
        handicap_controller::monitor::record::MASK
            .chars()
            .all(|c| c == '\u{2022}')
    );
}
