use std::path::{Path, PathBuf};
use std::time::Duration;

use handicap_tui::check_mode::run_with_cap;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEMPLATE: &str = include_str!("fixtures/bundle_template.json");

async fn target(resp: ResponseTemplate) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(resp)
        .mount(&s)
        .await;
    s
}

fn write_bundle(dir: &Path, server: &MockServer) -> PathBuf {
    let p = dir.join("b.json");
    std::fs::write(&p, TEMPLATE.replace("__BASE__", &server.uri())).unwrap();
    p
}

#[tokio::test(flavor = "multi_thread")]
async fn check_ok_exit0() {
    let srv = target(ResponseTemplate::new(200)).await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write_bundle(tmp.path(), &srv);
    let db = tempfile::tempdir().unwrap();
    let (code, out) = run_with_cap(&file, db.path(), None).await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("테스트 보드 / 핑"), "{out}");
    assert!(out.contains("✔ 정상"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_503_still_exit0() {
    let srv = target(ResponseTemplate::new(503)).await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write_bundle(tmp.path(), &srv);
    let db = tempfile::tempdir().unwrap();
    let (code, out) = run_with_cap(&file, db.path(), None).await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("✖ 실패"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_bad_file_exit1() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("b.json");
    std::fs::write(&file, b"{").unwrap();
    let db = tempfile::tempdir().unwrap();
    let (code, out) = run_with_cap(&file, db.path(), None).await;
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("보드 가져오기"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_cap_exceeded_exit2() {
    let srv = target(ResponseTemplate::new(200).set_delay(Duration::from_secs(5))).await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write_bundle(tmp.path(), &srv);
    let db = tempfile::tempdir().unwrap();
    let (code, out) = run_with_cap(&file, db.path(), Some(Duration::from_secs(1))).await;
    assert_eq!(code, 2, "{out}");
    // 세션 정리: 임시 DB가 남지 않는다.
    let left = std::fs::read_dir(db.path()).unwrap().count();
    assert_eq!(left, 0);
}
#[test]
fn sanitize_maps_control_chars_to_space() {
    use handicap_tui::check_mode::sanitize;
    assert_eq!(sanitize("a\u{1b}[31mb"), "a [31mb");
    assert_eq!(sanitize("x\ny\r\tz"), "x y  z");
    assert_eq!(sanitize("l\u{2028}m\u{2029}n"), "l m n");
    assert_eq!(sanitize("한글 ✔ 정상"), "한글 ✔ 정상");
}

#[tokio::test(flavor = "multi_thread")]
async fn check_rejects_title_with_control_char() {
    let srv = target(ResponseTemplate::new(200)).await;
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("b.json");
    let json = TEMPLATE
        .replace("__BASE__", &srv.uri())
        .replace("\"핑\"", "\"핑\\u001b[2J\"");
    assert!(json.contains("u001b"), "fixture title must be patched");
    std::fs::write(&file, json).unwrap();
    let db = tempfile::tempdir().unwrap();
    let (code, out) = run_with_cap(&file, db.path(), None).await;
    // tui-2b-secrets §4: 서버가 제어 글자가 든 칸 제목을 가져오기에서 거절한다 — 출력엔 날것 ESC가 없다.
    assert_eq!(code, 1, "{out}");
    assert!(!out.contains('\u{1b}'), "{out:?}");
    assert!(out.contains("칸 제목에 쓸 수 없는 글자"), "{out:?}");
}

#[cfg(unix)]
#[test]
fn sigterm_in_check_mode_exits_1_and_removes_db_dir() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let srv = rt.block_on(target(
        ResponseTemplate::new(200).set_delay(Duration::from_secs(30)),
    ));
    let tmp = tempfile::tempdir().unwrap();
    let file = write_bundle(tmp.path(), &srv);
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_handicap-tui"))
        .arg("--check")
        .arg(&file)
        .env("HOME", tmp.path())
        .env("XDG_STATE_HOME", tmp.path().join("state"))
        .env("XDG_RUNTIME_DIR", tmp.path())
        .env_remove("RUST_LOG")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let has_db_dir = || {
        std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("handicap-tui-"))
    };
    let t0 = std::time::Instant::now();
    while !has_db_dir() {
        assert!(
            t0.elapsed() < Duration::from_secs(20),
            "db dir never appeared"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // 컨트롤러가 뜨고 가져오기/시작이 진행될 시간을 준다.
    std::thread::sleep(Duration::from_millis(1500));
    // SAFETY: 방금 띄운 자식 프로세스에 SIGTERM을 보낸다.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let t1 = std::time::Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if t1.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            panic!("did not exit within 10s of SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(status.code(), Some(1));
    assert!(!has_db_dir(), "db dir must be removed");
    drop(rt);
}
