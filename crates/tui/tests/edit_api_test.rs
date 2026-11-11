use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use handicap_tui::session::Session;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEMPLATE: &str = include_str!("fixtures/bundle_template.json");
const ENV_ID: &str = "01J0000000000000000000EN01";
const SC_ID: &str = "01J0000000000000000000SC01";

async fn target() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

fn bundle_for(server: &MockServer) -> String {
    TEMPLATE.replace("__BASE__", &server.uri())
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

async fn start(srv: &MockServer) -> (Session, tempfile::TempDir, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    (s, tmp, dbdir)
}

#[tokio::test(flavor = "multi_thread")]
async fn env_and_scenario_round_trip_real_controller() {
    let srv = target().await;
    let (s, _t, _d) = start(&srv).await;
    let env = s.api.environment(ENV_ID).await.unwrap();
    assert_eq!(env.name, "대상");
    assert_eq!(
        env.vars.get("BASE_URL").map(String::as_str),
        Some(srv.uri().as_str())
    );
    let dbg = format!("{env:?}");
    assert!(!dbg.contains(&srv.uri()), "Debug leaked a value: {dbg}");
    let sc = s.api.scenario(SC_ID).await.unwrap();
    assert_eq!(sc.name, "tui-fixture");
    assert!(sc.yaml.contains("ping"));
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn put_board_returns_normalized_board() {
    let srv = target().await;
    let (s, _t, _d) = start(&srv).await;
    let id = s.boards[0].id.clone();
    let b = s.api.board(&id).await.unwrap();
    let mut cfg = b.config.clone();
    cfg.panels[0].timeout_seconds = 7;
    let out = s.api.put_board(&id, &b.name, &cfg).await.unwrap();
    assert_eq!(out.config.panels[0].timeout_seconds, 7);
    assert_eq!(
        s.api.board(&id).await.unwrap().config.panels[0].timeout_seconds,
        7
    );
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn put_board_rejects_with_server_message() {
    let srv = target().await;
    let (s, _t, _d) = start(&srv).await;
    let id = s.boards[0].id.clone();
    let b = s.api.board(&id).await.unwrap();
    let mut cfg = b.config.clone();
    cfg.panels[0].timeout_seconds = 45;
    let e = s.api.put_board(&id, &b.name, &cfg).await.unwrap_err();
    assert_eq!(e.status, Some(400));
    assert_eq!(e.message, "칸 1: 제한 시간은 1~30초여야 합니다");
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn export_bytes_reimport() {
    let srv = target().await;
    let (s, _t, _d) = start(&srv).await;
    let id = s.boards[0].id.clone();
    let bytes = s.api.export(std::slice::from_ref(&id)).await.unwrap();
    let tmp2 = tempfile::tempdir().unwrap();
    let file = write(tmp2.path(), "x.json", &bytes);
    let db2 = tempfile::tempdir().unwrap();
    let s2 = Session::start(&file, db2.path()).await.unwrap();
    assert_eq!(s2.boards[0].id, id);
    s2.shutdown().await;
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn put_environment_and_scenario() {
    let srv = target().await;
    let (s, _t, _d) = start(&srv).await;
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    vars.insert("BASE_URL".into(), "http://changed.invalid".into());
    s.api.put_environment(ENV_ID, "대상", &vars).await.unwrap();
    let env = s.api.environment(ENV_ID).await.unwrap();
    assert_eq!(env.vars.get("BASE_URL").unwrap(), "http://changed.invalid");

    let sc = s.api.scenario(SC_ID).await.unwrap();
    let ok = s
        .api
        .put_scenario(SC_ID, &sc.yaml, sc.version)
        .await
        .unwrap();
    assert_eq!(ok.yaml, sc.yaml);
    let e = s
        .api
        .put_scenario(SC_ID, &sc.yaml, sc.version - 1)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(409));
    s.shutdown().await;
}
