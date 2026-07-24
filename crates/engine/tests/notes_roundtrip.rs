//! scenario `notes` — 운반-전용 필드 라운드트립 (spec R1/R7).
use handicap_engine::scenario::Scenario;

const BASE_NO_NOTES: &str = "version: 1\nname: base\nsteps: []\n";

#[test]
fn absent_notes_roundtrip_stays_absent() {
    let s = Scenario::from_yaml(BASE_NO_NOTES).expect("parses");
    assert_eq!(s.notes, None);
    let out = s.to_yaml().expect("serializes");
    assert!(
        !out.contains("notes"),
        "notes 미사용 시나리오 직렬화에 notes 키 등장: {out}"
    );
    assert_eq!(Scenario::from_yaml(&out).expect("reparses").notes, None);
}

#[test]
fn multiline_notes_roundtrip_preserved() {
    let yaml =
        "version: 1\nname: base\nnotes: |-\n  운영 환경 금지.\n  BASE_URL 필수.\nsteps: []\n";
    let s = Scenario::from_yaml(yaml).expect("parses");
    assert_eq!(s.notes.as_deref(), Some("운영 환경 금지.\nBASE_URL 필수."));
    let out = s.to_yaml().expect("serializes");
    let s2 = Scenario::from_yaml(&out).expect("reparses");
    assert_eq!(
        s2.notes, s.notes,
        "notes 값이 라운드트립에서 보존되어야 한다"
    );
}

#[test]
fn unknown_top_level_key_still_denied() {
    let yaml = "version: 1\nname: base\nbogus: 1\nsteps: []\n";
    assert!(
        Scenario::from_yaml(yaml).is_err(),
        "deny_unknown_fields 회귀 가드"
    );
}
