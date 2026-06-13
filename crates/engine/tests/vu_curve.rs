use handicap_engine::RampDown;

#[test]
fn ramp_down_default_is_graceful() {
    assert_eq!(RampDown::default(), RampDown::Graceful);
}

#[test]
fn ramp_down_serde_lowercase_round_trip() {
    assert_eq!(
        serde_json::to_string(&RampDown::Immediate).unwrap(),
        "\"immediate\""
    );
    assert_eq!(
        serde_json::from_str::<RampDown>("\"graceful\"").unwrap(),
        RampDown::Graceful
    );
}
