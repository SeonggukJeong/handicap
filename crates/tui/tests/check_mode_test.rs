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
