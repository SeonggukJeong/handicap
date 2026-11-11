//! 편집 작업자(`spawn_edit_worker`) — in-process 세션 + tempdir 보드 파일 + tempdir 상태 디렉터리.
//! App 루프 없이 작업자에게 `EditReq`를 직접 보낸다(plan Task 10 Step 1).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use handicap_controller::monitor::config::BoardConfig;
use handicap_tui::app::{EditDone, EditReq, FileErr, SavedValue, SavedWhat, spawn_edit_worker};
use handicap_tui::filesave::{FileState, WriteError, WriteStage};
use handicap_tui::session::Session;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;
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

struct Rig {
    s: Session,
    file: PathBuf,
    start: Vec<u8>,
    tx: UnboundedSender<EditReq>,
    worker: JoinHandle<()>,
    rx: mpsc::Receiver<EditDone>,
    _dirs: (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir),
}

async fn rig(srv: &MockServer) -> Rig {
    rig_with(bundle_for(srv).into_bytes()).await
}

async fn rig_with(start: Vec<u8>) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", &start);
    let dbdir = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let mut s = Session::start(&file, dbdir.path()).await.unwrap();
    let fs = FileState {
        target: s.target.clone(),
        start: s.start_fp,
        expected: s.start_fp,
        first_done: false,
        state_dir: Some(state.path().to_path_buf()),
    };
    let start_bytes = s.start_bytes.take().unwrap();
    let ids: Vec<String> = s.boards.iter().map(|b| b.id.clone()).collect();
    let (out_tx, rx) = mpsc::channel();
    let (tx, worker) = spawn_edit_worker(
        &tokio::runtime::Handle::current(),
        s.api.clone(),
        ids,
        fs,
        start_bytes,
        out_tx,
    );
    Rig {
        s,
        file,
        start,
        tx,
        worker,
        rx,
        _dirs: (tmp, dbdir, state),
    }
}

async fn recv(rx: &mpsc::Receiver<EditDone>) -> EditDone {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(d) = rx.try_recv() {
            return d;
        }
        assert!(Instant::now() < deadline, "no EditDone within 20s");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 첫 보드의 설정을 받아 `f`로 고친 `SaveBoard`.
async fn save_req(r: &Rig, seq: u64, f: impl FnOnce(&mut BoardConfig)) -> EditReq {
    let id = r.s.boards[0].id.clone();
    let b = r.s.api.board(&id).await.unwrap();
    let mut config = b.config.clone();
    f(&mut config);
    EditReq::SaveBoard {
        seq,
        board_id: id,
        panel_id: b.config.panels[0].id.clone(),
        panel_no: 1,
        name: b.name,
        config,
    }
}

async fn shutdown(r: Rig) {
    r.worker.abort();
    let _ = r.worker.await;
    r.s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn save_board_writes_file_and_backups() {
    let srv = target().await;
    let r = rig(&srv).await;
    let req = save_req(&r, 1, |c| c.panels[0].timeout_seconds = 9).await;
    r.tx.send(req).unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 1,
            req: SavedWhat::Board { board_id },
            server: Ok(SavedValue::Board(b)),
            file: Some(Ok(())),
        } => {
            assert_eq!(board_id, r.s.boards[0].id);
            assert_eq!(b.config.panels[0].timeout_seconds, 9);
        }
        other => panic!("unexpected {other:?}"),
    }
    // 보드 파일을 다시 가져온 새 세션에서 그 칸 9.
    let db2 = tempfile::tempdir().unwrap();
    let s2 = Session::start(&r.file, db2.path()).await.unwrap();
    let b2 = s2.api.board(&s2.boards[0].id).await.unwrap();
    assert_eq!(b2.config.panels[0].timeout_seconds, 9);
    s2.shutdown().await;
    let t = &r.s.target;
    assert_eq!(std::fs::read(t.bak()).unwrap(), r.start);
    assert_eq!(std::fs::read(t.orig_bak()).unwrap(), r.start);
    assert_ne!(std::fs::read(&r.file).unwrap(), r.start);
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn save_rejected_keeps_file_and_cache() {
    let srv = target().await;
    let r = rig(&srv).await;
    let req = save_req(&r, 4, |c| c.panels[0].timeout_seconds = 45).await;
    r.tx.send(req).unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 4,
            server: Err(m),
            file: None,
            ..
        } => assert_eq!(m, "제한 시간은 1~30초여야 합니다"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(std::fs::read(&r.file).unwrap(), r.start);
    assert!(!r.s.target.bak().exists());
    assert!(!r.s.target.orig_bak().exists());
    let b = r.s.api.board(&r.s.boards[0].id).await.unwrap();
    assert_eq!(b.config.panels[0].timeout_seconds, 5);
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn file_changed_outside_reports() {
    let srv = target().await;
    let r = rig(&srv).await;
    let other = b"{\"someone\":\"else\"}".to_vec();
    std::fs::write(&r.file, &other).unwrap();
    let req = save_req(&r, 2, |c| c.panels[0].timeout_seconds = 9).await;
    r.tx.send(req).unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            server: Ok(_),
            file:
                Some(Err(FileErr::Write(WriteError {
                    stage: WriteStage::ChangedOutside,
                    ..
                }))),
            ..
        } => {}
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(std::fs::read(&r.file).unwrap(), other);
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn worker_processes_in_order() {
    let srv = target().await;
    let r = rig(&srv).await;
    let save = save_req(&r, 7, |c| c.panels[0].timeout_seconds = 8).await;
    r.tx.send(EditReq::LoadEnv { id: ENV_ID.into() }).unwrap();
    r.tx.send(save).unwrap();
    r.tx.send(EditReq::LoadScenario { id: SC_ID.into() })
        .unwrap();
    match recv(&r.rx).await {
        EditDone::Env { id, result: Ok(e) } => {
            assert_eq!(id, ENV_ID);
            assert_eq!(e.name, "대상");
        }
        other => panic!("1st {other:?}"),
    }
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 7,
            server: Ok(_),
            file: Some(Ok(())),
            ..
        } => {}
        other => panic!("2nd {other:?}"),
    }
    match recv(&r.rx).await {
        EditDone::Scenario { id, result: Ok(s) } => {
            assert_eq!(id, SC_ID);
            assert_eq!(s.name, "tui-fixture");
        }
        other => panic!("3rd {other:?}"),
    }
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_aborts_worker() {
    let srv = target().await;
    let r = rig(&srv).await;
    // 큐에 요청을 쌓아 둔 채 abort — 통로 닫기만으론 큐를 다 처리하므로 abort·await가 끝나야 한다.
    for _ in 0..5 {
        r.tx.send(EditReq::LoadEnv { id: ENV_ID.into() }).unwrap();
    }
    r.worker.abort();
    tokio::time::timeout(Duration::from_secs(10), r.worker)
        .await
        .expect("worker did not stop after abort")
        .ok();
    assert!(r.tx.send(EditReq::LoadEnv { id: ENV_ID.into() }).is_err());
    r.s.shutdown().await;
}

/// 첫 파일 쓰기가 ⓒ(`.bak`)에서 실패한 뒤 재시도해도 `.orig.bak`은 시작 바이트 — 작업자가 실패한 시도 뒤에
/// 시작 바이트를 버리면 재시도의 ⓑ가 `.orig.bak`을 0바이트로 덮는다(Task 4 리뷰 fold).
#[tokio::test(flavor = "multi_thread")]
async fn orig_bak_survives_failed_first_write() {
    let srv = target().await;
    let r = rig(&srv).await;
    let bak = r.s.target.bak();
    std::fs::create_dir(&bak).unwrap();
    let req = save_req(&r, 1, |c| c.panels[0].timeout_seconds = 9).await;
    r.tx.send(req).unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            server: Ok(_),
            file:
                Some(Err(FileErr::Write(WriteError {
                    stage: WriteStage::Backup,
                    ..
                }))),
            ..
        } => {}
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(std::fs::read(&r.file).unwrap(), r.start);
    std::fs::remove_dir(&bak).unwrap();
    let req = save_req(&r, 2, |c| c.panels[0].timeout_seconds = 8).await;
    r.tx.send(req).unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 2,
            file: Some(Ok(())),
            ..
        } => {}
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(std::fs::read(r.s.target.orig_bak()).unwrap(), r.start);
    assert_eq!(std::fs::read(&bak).unwrap(), r.start);
    shutdown(r).await;
}

/// 값을 품는 새 타입의 `Debug`는 종류·id·길이만(plan: 손 Debug).
#[test]
fn edit_req_and_done_debug_hide_values() {
    let mut vars = std::collections::BTreeMap::new();
    vars.insert("SECRET_KEY_NAME".to_string(), "ENV-VALUE-91".to_string());
    let reqs = [
        EditReq::SaveEnv {
            seq: 1,
            id: "e1".into(),
            name: "ENV-NAME-3".into(),
            vars,
        },
        EditReq::SaveScenario {
            seq: 2,
            id: "s1".into(),
            yaml: "variables:\n  a: YAML-VALUE-42\n".into(),
            version: 3,
        },
    ];
    for r in &reqs {
        let d = format!("{r:?}");
        for leak in [
            "ENV-VALUE-91",
            "SECRET_KEY_NAME",
            "YAML-VALUE-42",
            "ENV-NAME-3",
        ] {
            assert!(!d.contains(leak), "{leak} leaked: {d}");
        }
    }
    let env = serde_json::from_value(serde_json::json!({
        "id": "e1", "name": "n", "vars": {"K": "ENV-VALUE-91"},
        "created_at": 1, "updated_at": 2
    }))
    .unwrap();
    let dones = [
        EditDone::Env {
            id: "e1".into(),
            result: Ok(env),
        },
        EditDone::Env {
            id: "e1".into(),
            result: Err("SERVER-MSG-5".into()),
        },
        EditDone::Saved {
            seq: 1,
            req: SavedWhat::Env { id: "e1".into() },
            server: Err("SERVER-MSG-5".into()),
            file: Some(Err(FileErr::Export("SERVER-MSG-5".into()))),
        },
    ];
    for d in &dones {
        let s = format!("{d:?}");
        for leak in ["ENV-VALUE-91", "SERVER-MSG-5"] {
            assert!(!s.contains(leak), "{leak} leaked: {s}");
        }
    }
}

// ---- tui-2a-1 Task 11: 환경 값·시나리오 변수 저장이 다음 점검에 닿는다 ----

const FLOW_YAML: &str = "version: 1\nname: tui-flow\nvariables:\n  # 주문 번호\n  order_id: \"A-1\"\nsteps:\n  - id: 01J0000000000000000000ST01\n    name: ping\n    type: http\n    request:\n      method: GET\n      url: ${BASE_URL}/orders/{{order_id}}\n      headers:\n        X-Token: ${TOKEN}\n    assert:\n      - status: 200\n";

/// `${TOKEN}` 헤더·`{{order_id}}` URL을 쓰는 시나리오 + 환경 BASE_URL·TOKEN=old-token. 점검 주기 1초.
fn flow_bundle(server: &MockServer) -> Vec<u8> {
    let mut v: serde_json::Value = serde_json::from_str(TEMPLATE).unwrap();
    v["scenarios"][0]["yaml"] = FLOW_YAML.into();
    v["environments"][0]["vars"] = serde_json::json!({
        "BASE_URL": server.uri(),
        "TOKEN": "old-token",
    });
    serde_json::to_vec_pretty(&v).unwrap()
}

/// `pred`를 만족하는 요청이 올 때까지(최대 10초).
async fn wait_request(srv: &MockServer, what: &str, pred: impl Fn(&wiremock::Request) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if srv
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .any(&pred)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "no request with {what} within 10s"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn token_is(r: &wiremock::Request, v: &str) -> bool {
    r.headers.get("x-token").and_then(|h| h.to_str().ok()) == Some(v)
}

fn file_scenario_yaml(path: &Path) -> String {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    v["scenarios"][0]["yaml"].as_str().unwrap().to_string()
}

fn changed_lines(a: &str, b: &str) -> Vec<usize> {
    let la: Vec<&str> = a.split_inclusive('\n').collect();
    let lb: Vec<&str> = b.split_inclusive('\n').collect();
    assert_eq!(la.len(), lb.len(), "line count changed");
    (0..la.len())
        .filter(|&i| la[i] != lb[i])
        .map(|i| i + 1)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn env_value_change_reaches_next_check() {
    let srv = target().await;
    let r = rig_with(flow_bundle(&srv)).await;
    wait_request(&srv, "old token", |q| token_is(q, "old-token")).await;
    let env = r.s.api.environment(ENV_ID).await.unwrap();
    let mut vars = env.vars.clone();
    vars.insert("TOKEN".into(), "new-token".into());
    r.tx.send(EditReq::SaveEnv {
        seq: 1,
        id: ENV_ID.into(),
        name: env.name.clone(),
        vars,
    })
    .unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 1,
            req: SavedWhat::Env { id },
            server: Ok(SavedValue::Env(e)),
            file: Some(Ok(())),
        } => {
            assert_eq!(id, ENV_ID);
            assert_eq!(e.vars["TOKEN"], "new-token");
        }
        other => panic!("unexpected {other:?}"),
    }
    wait_request(&srv, "new token", |q| token_is(q, "new-token")).await;
    // 파일을 다시 가져온 새 세션에서 그 값.
    let db2 = tempfile::tempdir().unwrap();
    let s2 = Session::start(&r.file, db2.path()).await.unwrap();
    let e2 = s2.api.environment(ENV_ID).await.unwrap();
    assert_eq!(e2.vars["TOKEN"], "new-token");
    assert_eq!(e2.vars["BASE_URL"], srv.uri());
    s2.shutdown().await;
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn scenario_var_change_one_line_in_file() {
    let srv = target().await;
    let r = rig_with(flow_bundle(&srv)).await;
    wait_request(&srv, "/orders/A-1", |q| q.url.path() == "/orders/A-1").await;
    let sc = r.s.api.scenario(SC_ID).await.unwrap();
    let yaml = handicap_tui::yaml_var::splice_static_var(&sc.yaml, "order_id", "B-2").unwrap();
    r.tx.send(EditReq::SaveScenario {
        seq: 3,
        id: SC_ID.into(),
        yaml,
        version: sc.version,
    })
    .unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 3,
            req: SavedWhat::Scenario { id },
            server: Ok(SavedValue::Scenario(s)),
            file: Some(Ok(())),
        } => {
            assert_eq!(id, SC_ID);
            assert!(s.version > sc.version);
        }
        other => panic!("unexpected {other:?}"),
    }
    let in_file = file_scenario_yaml(&r.file);
    let order_line = FLOW_YAML
        .lines()
        .position(|l| l.contains("order_id:"))
        .unwrap()
        + 1;
    assert_eq!(changed_lines(FLOW_YAML, &in_file), vec![order_line]);
    assert!(in_file.contains("\n  # 주문 번호\n"), "{in_file}");
    assert!(in_file.contains("order_id: \"B-2\""), "{in_file}");
    wait_request(&srv, "/orders/B-2", |q| q.url.path() == "/orders/B-2").await;
    shutdown(r).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn scenario_stale_version_409() {
    let srv = target().await;
    let r = rig_with(flow_bundle(&srv)).await;
    let sc = r.s.api.scenario(SC_ID).await.unwrap();
    let yaml = handicap_tui::yaml_var::splice_static_var(&sc.yaml, "order_id", "C-3").unwrap();
    r.tx.send(EditReq::SaveScenario {
        seq: 4,
        id: SC_ID.into(),
        yaml,
        version: sc.version - 1,
    })
    .unwrap();
    match recv(&r.rx).await {
        EditDone::Saved {
            seq: 4,
            server: Err(m),
            file: None,
            ..
        } => assert_eq!(m, "다른 곳에서 시나리오가 바뀌었습니다 — 다시 열어 주세요"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(std::fs::read(&r.file).unwrap(), r.start);
    shutdown(r).await;
}
