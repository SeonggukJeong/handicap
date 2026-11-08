//! 설정 파일 입출력 — 실제 `~/.config`는 건드리지 않고 임시 디렉터리만 쓴다.

use std::ffi::OsString;
use std::path::PathBuf;

use handicap_tui::prefs::{BorderStyle, Loaded, Prefs, config_dir_from, load, save};

#[test]
fn prefs_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("새/하위/tui.json");
    let p = Prefs {
        border: BorderStyle::Block,
    };
    save(&path, &p).unwrap();
    assert_eq!(load(&path), Loaded::Ok(p));
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"block\""), "{raw}");
}

#[test]
fn prefs_missing_is_silent_default() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(load(&dir.path().join("없음.json")), Loaded::Missing);
}

#[test]
fn prefs_bad_inputs_fall_back() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("tui.json");
    std::fs::write(&p, "{깨짐").unwrap();
    assert!(matches!(load(&p), Loaded::Invalid(_)));
    std::fs::write(&p, r#"{"border":"weird"}"#).unwrap();
    assert!(matches!(load(&p), Loaded::Invalid(_)));
    // 모르는 키는 무시.
    std::fs::write(&p, r#"{"border":"block","future":1}"#).unwrap();
    assert_eq!(
        load(&p),
        Loaded::Ok(Prefs {
            border: BorderStyle::Block
        })
    );
    // 경로가 디렉터리 — 패닉 없이 Invalid / Err.
    assert!(matches!(load(dir.path()), Loaded::Invalid(_)));
    assert!(save(dir.path(), &Prefs::default()).is_err());
}

#[test]
fn config_dir_from_rules() {
    let os = |s: &str| Some(OsString::from(s));
    assert_eq!(
        config_dir_from(os("/x"), None),
        Some(PathBuf::from("/x/handicap"))
    );
    assert_eq!(
        config_dir_from(None, os("/h")),
        Some(PathBuf::from("/h/.config/handicap"))
    );
    assert_eq!(
        config_dir_from(os(""), os("/h")),
        Some(PathBuf::from("/h/.config/handicap"))
    );
    assert_eq!(config_dir_from(None, None), None);
    assert_eq!(config_dir_from(os(""), os("")), None);
}
