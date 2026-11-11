use handicap_tui::filesave::*;
use std::fs;
use std::path::Path;

fn setup(content: &[u8]) -> (tempfile::TempDir, tempfile::TempDir, FileState) {
    let dir = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let real = dir.path().join("b.json");
    fs::write(&real, content).unwrap();
    let st = FileState {
        target: FileTarget {
            given: real.clone(),
            real,
        },
        start: fingerprint(content),
        expected: fingerprint(content),
        first_done: false,
        state_dir: Some(state.path().to_path_buf()),
    };
    (dir, state, st)
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn write_first_creates_orig_and_bak() {
    let (_d, s, mut st) = setup(b"A");
    write_bundle(&mut st, b"A", b"B").unwrap();
    assert_eq!(fs::read(&st.target.real).unwrap(), b"B");
    assert_eq!(fs::read(st.target.bak()).unwrap(), b"A");
    assert_eq!(fs::read(st.target.orig_bak()).unwrap(), b"A");
    assert_eq!(
        last_written(s.path(), &st.target.real),
        Some(fingerprint(b"B"))
    );
}

#[test]
fn orig_kept_when_last_written_matches() {
    let (_d, s, mut st) = setup(b"A");
    record_written(s.path(), &st.target.real, &fingerprint(b"A")).unwrap();
    write_bundle(&mut st, b"A", b"B").unwrap();
    assert!(!st.target.orig_bak().exists());
    let (_d2, s2, mut st2) = setup(b"A");
    record_written(s2.path(), &st2.target.real, &fingerprint(b"A")).unwrap();
    fs::write(st2.target.orig_bak(), b"O").unwrap();
    write_bundle(&mut st2, b"A", b"B").unwrap();
    assert_eq!(fs::read(st2.target.orig_bak()).unwrap(), b"O");
}

#[test]
fn orig_refreshed_when_from_outside() {
    let (_d, s, mut st) = setup(b"A");
    record_written(s.path(), &st.target.real, &fingerprint(b"X")).unwrap();
    fs::write(st.target.orig_bak(), b"O").unwrap();
    write_bundle(&mut st, b"A", b"B").unwrap();
    assert_eq!(fs::read(st.target.orig_bak()).unwrap(), b"A");
    let (_d2, _s2, mut st2) = setup(b"A");
    st2.state_dir = None;
    fs::write(st2.target.orig_bak(), b"O").unwrap();
    write_bundle(&mut st2, b"A", b"B").unwrap();
    assert_eq!(fs::read(st2.target.orig_bak()).unwrap(), b"A");
}

#[test]
fn second_write_keeps_orig_updates_bak() {
    let (_d, _s, mut st) = setup(b"A");
    write_bundle(&mut st, b"A", b"B").unwrap();
    write_bundle(&mut st, b"A", b"C").unwrap();
    assert_eq!(fs::read(&st.target.real).unwrap(), b"C");
    assert_eq!(fs::read(st.target.orig_bak()).unwrap(), b"A");
    assert_eq!(fs::read(st.target.bak()).unwrap(), b"B");
}

#[test]
fn changed_outside_refuses() {
    let (_d, _s, mut st) = setup(b"A");
    fs::write(&st.target.real, b"Z").unwrap();
    let e = write_bundle(&mut st, b"A", b"B").unwrap_err();
    assert_eq!(e.stage, WriteStage::ChangedOutside);
    assert_eq!(fs::read(&st.target.real).unwrap(), b"Z");
    assert!(!st.target.bak().exists());
    assert!(!st.target.orig_bak().exists());
}

#[cfg(unix)]
#[test]
fn permissions_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, _s, mut st) = setup(b"A");
    fs::set_permissions(&st.target.real, fs::Permissions::from_mode(0o640)).unwrap();
    write_bundle(&mut st, b"A", b"B").unwrap();
    for p in [
        st.target.real.clone(),
        st.target.bak(),
        st.target.orig_bak(),
    ] {
        let m = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o640, "{p:?}");
    }
}

#[cfg(unix)]
#[test]
fn symlink_target_replaced_link_kept() {
    let dir = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("real")).unwrap();
    let real_file = dir.path().join("real/b.json");
    fs::write(&real_file, b"A").unwrap();
    let link = dir.path().join("link.json");
    std::os::unix::fs::symlink(&real_file, &link).unwrap();
    let real = fs::canonicalize(&link).unwrap();
    let mut st = FileState {
        target: FileTarget {
            given: link.clone(),
            real: real.clone(),
        },
        start: fingerprint(b"A"),
        expected: fingerprint(b"A"),
        first_done: false,
        state_dir: Some(state.path().to_path_buf()),
    };
    write_bundle(&mut st, b"A", b"B").unwrap();
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(&real_file).unwrap(), b"B");
    assert_eq!(fs::read(real.with_file_name("b.json.bak")).unwrap(), b"A");
}

#[test]
fn backup_failure_leaves_original() {
    let (d, _s, mut st) = setup(b"A");
    fs::create_dir(st.target.bak()).unwrap();
    let before = names(d.path());
    let e = write_bundle(&mut st, b"A", b"B").unwrap_err();
    assert_eq!(e.stage, WriteStage::Backup);
    assert_eq!(fs::read(&st.target.real).unwrap(), b"A");
    // .orig.bak 은 ⓑ에서 이미 만들어졌을 수 있다 — 임시 파일만 없으면 된다.
    let after = names(d.path());
    assert!(
        after
            .iter()
            .all(|n| n == "b.json" || n == "b.json.bak" || n == "b.json.orig.bak"),
        "{after:?}"
    );
    assert!(before.iter().all(|n| after.contains(n)));
}

#[test]
fn replace_atomic_failure_cleans_temp() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("d");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("x"), b"x").unwrap();
    let perm = fs::metadata(&target).unwrap().permissions();
    let e = replace_atomic(&target, b"new", perm).unwrap_err();
    assert_eq!(e.stage, WriteStage::Persist);
    assert!(target.is_dir());
    assert_eq!(names(dir.path()), vec!["d".to_string()]);
}

#[test]
fn record_file_roundtrip_and_corrupt() {
    let s = tempfile::tempdir().unwrap();
    let a = Path::new("/x/a.json");
    let b = Path::new("/x/b.json");
    record_written(s.path(), a, &fingerprint(b"1")).unwrap();
    record_written(s.path(), b, &fingerprint(b"2")).unwrap();
    assert_eq!(last_written(s.path(), a), Some(fingerprint(b"1")));
    assert_eq!(last_written(s.path(), b), Some(fingerprint(b"2")));
    fs::write(s.path().join("tui-writes.json"), b"{not json").unwrap();
    assert_eq!(last_written(s.path(), a), None);
}
