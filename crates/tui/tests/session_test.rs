use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use handicap_tui::session::{Session, Stage};
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEMPLATE: &str = include_str!("fixtures/bundle_template.json");

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

fn db_files(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("handicap-tui-"))
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_and_starts_all_boards() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    assert_eq!(s.boards.len(), 1);
    let id = s.boards[0].id.clone();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let st = s.api.status(&id).await.unwrap();
        if !st.panels[0].results.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "no result within 10s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    s.shutdown().await;
    assert_eq!(db_files(dbdir.path()), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn bom_file_imports() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(bundle_for(&srv).as_bytes());
    let file = write(tmp.path(), "b.json", &bytes);
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    assert_eq!(s.boards.len(), 1);
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn session_keeps_names_from_bundle() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = Session::start(&file, dbdir.path()).await.unwrap();
    assert_eq!(
        s.names
            .step_name("01J0000000000000000000SC01", "01J0000000000000000000ST01"),
        Some("ping")
    );
    assert_eq!(
        s.names.scenario_name("01J0000000000000000000SC01"),
        Some("tui-fixture")
    );
    assert_eq!(s.names.env_name("01J0000000000000000000EN01"), Some("대상"));
    s.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_json_is_import_stage_error() {
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", b"{");
    let dbdir = tempfile::tempdir().unwrap();
    let err = match Session::start(&file, dbdir.path()).await {
        Ok(_) => panic!("must fail"),
        Err(e) => e,
    };
    assert_eq!(err.stage, Stage::Import);
    assert!(err.message.contains("JSON 형식 오류"), "{}", err.message);
    let addr: SocketAddr = err.rest_addr.expect("controller was up");
    assert!(
        tokio::net::TcpStream::connect(addr).await.is_err(),
        "controller must be shut down"
    );
    assert_eq!(db_files(dbdir.path()), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_file_is_read_stage_error() {
    let tmp = tempfile::tempdir().unwrap();
    let dbdir = tempfile::tempdir().unwrap();
    let err = match Session::start(&tmp.path().join("none.json"), dbdir.path()).await {
        Ok(_) => panic!("must fail"),
        Err(e) => e,
    };
    assert_eq!(err.stage, Stage::ReadFile);
    assert!(err.message.contains("찾을 수 없습니다"), "{}", err.message);
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_uses_fresh_db() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s1 = Session::start(&file, dbdir.path()).await.unwrap();
    let p1 = s1.db_path().to_path_buf();
    s1.shutdown().await;
    let s2 = Session::start(&file, dbdir.path()).await.unwrap();
    assert_ne!(p1, s2.db_path());
    s2.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn new_file_with_added_panel_starts_both() {
    let srv = target().await;
    let tmp = tempfile::tempdir().unwrap();
    let dbdir = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let s1 = Session::start(&file, dbdir.path()).await.unwrap();
    let id = s1.boards[0].id.clone();
    s1.shutdown().await;

    let mut v: serde_json::Value = serde_json::from_str(&bundle_for(&srv)).unwrap();
    let mut p2 = v["boards"][0]["config"]["panels"][0].clone();
    p2["id"] = "01J0000000000000000000PN02".into();
    p2["title"] = "둘째".into();
    v["boards"][0]["config"]["panels"]
        .as_array_mut()
        .unwrap()
        .push(p2);
    std::fs::write(&file, serde_json::to_vec(&v).unwrap()).unwrap();

    let s2 = Session::start(&file, dbdir.path()).await.unwrap();
    let b = s2.api.board(&id).await.unwrap();
    assert_eq!(b.config.panels.len(), 2);
    s2.shutdown().await;
}

#[test]
fn start_writes_nothing_to_stderr() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let srv = rt.block_on(target());
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_handicap-tui"))
        .args(["--check"])
        .arg(&file)
        .env("HOME", tmp.path())
        .env("XDG_STATE_HOME", tmp.path().join("state"))
        .env("XDG_RUNTIME_DIR", tmp.path())
        .env_remove("RUST_LOG")
        .output()
        .unwrap();
    assert_eq!(
        out.stderr.len(),
        0,
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.status.code(), Some(0));
    let dir = tmp.path().join("state/handicap");
    let log = std::fs::read(dir.join("tui-check.log")).unwrap();
    assert!(!log.is_empty());
    assert!(!dir.join("tui.log").exists());
    drop(rt);
}
#[tokio::test(flavor = "multi_thread")]
async fn oversized_file_is_read_stage_error() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("big.json");
    // 희소 파일 — 실제 디스크는 거의 쓰지 않는다.
    let f = std::fs::File::create(&file).unwrap();
    f.set_len(32 * 1024 * 1024 + 1).unwrap();
    drop(f);
    let dbdir = tempfile::tempdir().unwrap();
    let err = match Session::start(&file, dbdir.path()).await {
        Ok(_) => panic!("must fail"),
        Err(e) => e,
    };
    assert_eq!(err.stage, Stage::ReadFile);
    assert!(err.message.contains("너무 큽니다"), "{}", err.message);
    assert_eq!(db_files(dbdir.path()), 0);
}

#[test]
fn db_dir_has_no_predictable_sidecar_names() {
    // 공유 디렉터리 바로 아래에는 무작위 이름의 전용 디렉터리만 생긴다(S1).
    let rt = tokio::runtime::Runtime::new().unwrap();
    let srv = rt.block_on(target());
    let tmp = tempfile::tempdir().unwrap();
    let file = write(tmp.path(), "b.json", bundle_for(&srv).as_bytes());
    let dbdir = tempfile::tempdir().unwrap();
    let s = rt.block_on(Session::start(&file, dbdir.path())).unwrap();
    let entries: Vec<_> = std::fs::read_dir(dbdir.path())
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].file_type().unwrap().is_dir());
    assert!(s.db_path().starts_with(entries[0].path()));
    rt.block_on(s.shutdown());
    assert_eq!(db_files(dbdir.path()), 0);
}

#[cfg(unix)]
#[test]
fn fifo_and_directory_paths_are_rejected_promptly_without_temp_dir() {
    use std::os::unix::ffi::OsStrExt;
    let tmp = tempfile::tempdir().unwrap();
    let fifo = tmp.path().join("pipe.json");
    let c = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: 유효한 NUL 종료 경로.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let dir_path = tmp.path().join("adir");
    std::fs::create_dir(&dir_path).unwrap();
    let dbdir = tempfile::tempdir().unwrap();
    let db = dbdir.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for p in [fifo, dir_path] {
            let r = rt.block_on(Session::start(&p, &db));
            let _ = tx.send(r.err().map(|e| (e.stage, e.message)));
        }
    });
    for _ in 0..2 {
        let got = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("start must not block on a non-regular file");
        let (stage, msg) = got.expect("must fail");
        assert_eq!(stage, Stage::ReadFile);
        assert!(msg.contains("일반 파일이 아닙니다"), "{msg}");
    }
    assert_eq!(db_files(dbdir.path()), 0);
}
