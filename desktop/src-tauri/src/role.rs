//! 셸 역할 상태(혼자 쓰기 / 서버)와 시작·정지·전환·이 PC 부하기 (spec R1·R3·R4·R6·R8).
//!
//! **잠금 규칙**: 긴 작업(`run_in_process`·정지)은 잠금 없이. 잠금 안에선 플래그·`take()`·설치만
//! (풀 스냅샷 `pool_workers()`는 메모리 조회라 잠금 안에서 읽는다).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::grpc::coordinator::PoolWorkerInfo;
use handicap_controller::in_process::{
    run_in_process, InProcessConfig, InProcessWorkerMode, RunningController, ABORT_MSG_APP_EXIT,
    ABORT_MSG_ROLE_SWITCH,
};
use handicap_desktop_core::config::{DesktopConfig, Loaded, Role};
use handicap_desktop_core::token::{generate_token, is_usable_token};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config_store;

/// 전환이 이미 진행 중일 때 두 번째 `switch`(또는 시작)가 즉시 돌려주는 사유.
pub const MSG_ALREADY_SWITCHING: &str = "이미 전환 중입니다";
/// 전환 중에 토글을 바꾸려 할 때.
pub const MSG_SWITCHING: &str = "전환 중입니다";
/// 이 PC 부하기가 run을 실행 중이라 토글이 잠겼을 때(R4).
pub const MSG_SELF_WORKER_BUSY: &str = "이 PC가 테스트를 실행하는 중이라 끝난 뒤 바꿀 수 있습니다";
/// PC 이름이 비어 이 PC 부하기를 쓸 수 없을 때(R4).
pub const MSG_NO_HOSTNAME: &str = "PC 이름을 읽지 못해 쓸 수 없습니다";

/// 이 PC 부하기 정지 대기 상한.
const SELF_WORKER_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// 종료가 진행 중 전환을 기다리는 상한(Review Focus 5).
const SHUTDOWN_SWITCH_WAIT: Duration = Duration::from_secs(10);
/// 이 PC 부하기의 선언 용량 = CLI 워커 기본값.
const SELF_WORKER_CAPACITY_VUS: u32 = 1000;

/// 이 PC 부하기 세대 번호(단조 증가). `spawn_self_worker`는 잠금 밖에서 불리는 동기 함수라
/// `ShellState` 필드 대신 프로세스 전역 카운터를 쓴다 — 늦게 끝난 감시 블록이 새 부하기를 지우지 않게.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub struct Env {
    pub config_dir: PathBuf,
    pub db: Option<String>,
    pub hostname: fn() -> String,
    /// 테스트 전용 문: 있으면 `switch`가 정지 뒤·시작 전에 `notified().await`로 멈춘다.
    pub start_gate: Option<Arc<Notify>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Notices {
    pub port_changed: Option<(u16, u16)>,
    pub save_failed: bool,
    pub self_worker_excluded: bool,
    pub self_worker_unavailable: Option<String>,
    pub start_error: Option<String>,
}

pub struct SelfWorker {
    pub generation: u64,
    /// 셸이 쥔 토큰 — 셸이 멈출 때 취소한다.
    pub parent: CancellationToken,
    /// 워커에 넘긴 자식 토큰 — 서버의 `Disconnect`(대시보드 「제외」)는 이것만 취소한다.
    pub child: CancellationToken,
    pub handle: JoinHandle<()>,
    pub worker_id: String,
}

pub struct Running {
    pub controller: RunningController,
    pub base_url: String,
    pub self_worker: Option<SelfWorker>,
}

pub struct ShellState {
    pub env: Env,
    pub config: DesktopConfig,
    pub config_warning: bool,
    pub running: Option<Running>,
    pub switching: bool,
    pub notices: Notices,
}

impl ShellState {
    pub fn new(loaded: Loaded, env: Env) -> Self {
        Self {
            env,
            config: loaded.config,
            config_warning: loaded.warning,
            running: None,
            switching: false,
            notices: Notices::default(),
        }
    }
}

pub type Shared = Arc<Mutex<ShellState>>;

#[derive(Clone)]
pub struct Shell {
    pub state: Shared,
    pub switch_done: Arc<Notify>,
}

impl Shell {
    pub fn new(state: ShellState) -> Self {
        Self {
            state: Arc::new(Mutex::new(state)),
            switch_done: Arc::new(Notify::new()),
        }
    }
}

/// 현재 config를 저장하고 결과를 `save_failed`에 반영한다(잠금 안에서 — 짧은 파일 쓰기).
fn persist(st: &mut ShellState) {
    match config_store::save(&st.env.config_dir, &st.config) {
        Ok(()) => st.notices.save_failed = false,
        Err(e) => {
            eprintln!("desktop: 역할 설정 저장 실패: {e}");
            st.notices.save_failed = true;
        }
    }
}

/// 앱 시작: 저장된 역할로 시작. 성공이면 base_url. 시작 중 토큰 생성·포트 변경으로 config가
/// 바뀌었으면 여기서 저장. 실패면 `notices.start_error` 기록 후 `Err`(R6 실패 화면).
/// 시작 동안 `switching`을 세워 두어 동시 전환은 거절되고 종료는 이를 기다린다.
pub async fn boot(shell: &Shell) -> Result<String, String> {
    let (mut config, mut notices) = {
        let mut st = shell.state.lock().await;
        if st.switching {
            return Err(MSG_ALREADY_SWITCHING.into());
        }
        st.switching = true;
        (st.config.clone(), st.notices.clone())
    };
    let original = config.clone();
    let result = start_running(shell, &mut config, &mut notices).await;

    let mut st = shell.state.lock().await;
    let out = match result {
        Ok(r) => {
            let url = r.base_url.clone();
            notices.start_error = None;
            st.running = Some(r);
            st.config = config;
            st.notices = notices;
            if st.config != original {
                persist(&mut st);
            }
            Ok(url)
        }
        Err(e) => {
            notices.start_error = Some(e.clone());
            st.config = config;
            st.notices = notices;
            Err(e)
        }
    };
    st.switching = false;
    drop(st);
    shell.switch_done.notify_waiters();
    out
}

/// `config.role`로 컨트롤러(+ 이 PC 부하기)를 띄운다. **잠금 없이 호출** — `config`·`notices`는
/// 호출자가 잠금 밖으로 복제해 온 사본이고, 끝나면 호출자가 잠금 안에서 설치한다.
pub async fn start_running(
    shell: &Shell,
    config: &mut DesktopConfig,
    notices: &mut Notices,
) -> Result<Running, String> {
    let (db, hostname) = {
        let st = shell.state.lock().await;
        (st.env.db.clone(), st.env.hostname)
    };
    match config.role {
        Role::Local => {
            let rc = run_in_process(InProcessConfig {
                db,
                ..InProcessConfig::default()
            })
            .await
            .map_err(|e| format!("{e:#}"))?;
            notices.self_worker_unavailable = None;
            Ok(Running {
                base_url: crate::launch::base_url(rc.rest_addr().port()),
                controller: rc,
                self_worker: None,
            })
        }
        Role::Server => {
            if !config.server.token.as_deref().is_some_and(is_usable_token) {
                config.server.token = Some(generate_token(&mut rand::rngs::OsRng));
            }
            let token = config.server.token.clone().unwrap_or_default();
            let saved = config.server.grpc_port;
            let rc = run_in_process(InProcessConfig {
                db,
                rest: SocketAddr::from(([127, 0, 0, 1], 0)),
                grpc: SocketAddr::from(([0, 0, 0, 0], saved)),
                worker_token: Some(token.clone()),
                worker_mode: InProcessWorkerMode::Pool,
                grpc_port_fallback: true,
                ..InProcessConfig::default()
            })
            .await
            .map_err(|e| format!("{e:#}"))?;
            let actual = rc.grpc_addr().port();
            if actual != saved {
                notices.port_changed = Some((saved, actual));
                config.server.grpc_port = actual;
            }
            let mut self_worker = None;
            notices.self_worker_unavailable = None;
            if config.server.self_worker {
                let name = hostname();
                if name.is_empty() {
                    notices.self_worker_unavailable = Some(MSG_NO_HOSTNAME.into());
                } else {
                    self_worker = Some(spawn_self_worker(shell, actual, &token, name));
                }
            }
            Ok(Running {
                base_url: crate::launch::base_url(rc.rest_addr().port()),
                controller: rc,
                self_worker,
            })
        }
    }
}

/// in-process 풀 워커 하나(이 PC 부하기)를 띄운다. 워커가 끝나면 감시 블록이 먼저 **잠금 없이**
/// `child` 취소 ∧ `parent` 미취소(= 서버가 `Disconnect`로 제외)를 보고, 그때만 잠금을 잡아
/// 자기 세대가 현재일 때 토글을 끄고 저장한다. 셸이 멈춘 경우(`parent` 취소)는 잠금을 잡지 않으므로
/// 잠금 밖에서 `handle`을 기다리는 쪽과 교착이 없다.
pub fn spawn_self_worker(shell: &Shell, port: u16, token: &str, worker_id: String) -> SelfWorker {
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let parent = CancellationToken::new();
    let child = parent.child_token();
    let args = handicap_worker::WorkerArgs {
        controller: format!("http://127.0.0.1:{port}"),
        run_id: None,
        worker_id: Some(worker_id.clone()),
        capacity_vus: SELF_WORKER_CAPACITY_VUS,
        token: Some(token.to_owned()),
    };
    let (sh, p, c) = (shell.clone(), parent.clone(), child.clone());
    let handle = tokio::spawn(async move {
        if let Err(e) = handicap_worker::run_pool_until(args, c.clone()).await {
            eprintln!("desktop: 이 PC 부하기가 에러로 끝남: {e:#}");
        }
        if c.is_cancelled() && !p.is_cancelled() {
            on_self_worker_excluded(&sh, generation).await;
        }
    });
    SelfWorker {
        generation,
        parent,
        child,
        handle,
        worker_id,
    }
}

/// 서버가 이 PC 부하기를 제외했다 — 현재 세대일 때만 토글 끄기·저장·안내.
async fn on_self_worker_excluded(shell: &Shell, generation: u64) {
    let mut guard = shell.state.lock().await;
    let st: &mut ShellState = &mut guard;
    let Some(running) = st.running.as_mut() else {
        return;
    };
    if !running
        .self_worker
        .as_ref()
        .is_some_and(|w| w.generation == generation)
    {
        return;
    }
    // 자기 JoinHandle을 버린다(분리될 뿐 — 지금 이 태스크가 곧 끝난다).
    running.self_worker = None;
    st.config.server.self_worker = false;
    st.notices.self_worker_excluded = true;
    persist(st);
}

/// 셸이 이 PC 부하기를 멈춘다: `parent` 취소 → bounded 대기(초과 시 강제 중단).
async fn stop_self_worker(sw: SelfWorker) {
    sw.parent.cancel();
    let mut handle = sw.handle;
    if tokio::time::timeout(SELF_WORKER_STOP_TIMEOUT, &mut handle)
        .await
        .is_err()
    {
        eprintln!("desktop: 이 PC 부하기가 제한 시간 안에 멈추지 않아 강제 중단");
        handle.abort();
        let _ = handle.await;
    }
}

/// R8 정지 경로(전환·종료 공통): 활성 run `aborted` 기록·abort 전송 → 이 PC 부하기 정지 →
/// 컨트롤러 shutdown. **기록이 먼저** — 부하기를 먼저 끊으면 `worker_disconnected`가 `failed`를 쓴다.
pub async fn stop_running(r: Running, message: &str) {
    if let Err(e) = r.controller.abort_active_runs(message).await {
        eprintln!("desktop: 활성 run 중단 기록 실패(계속): {e:#}");
    }
    if let Some(sw) = r.self_worker {
        stop_self_worker(sw).await;
    }
    r.controller.shutdown().await;
}

fn is_busy(workers: &[PoolWorkerInfo], id: &str) -> bool {
    workers
        .iter()
        .any(|w| w.worker_id == id && w.assigned_run.is_some())
}

/// 역할 전환(R6 전환 순서). 진행 중이면 기다리지 않고 즉시 `Err("이미 전환 중입니다")`.
/// 새 역할 시작이 실패하면 이전 역할로, 그것도 실패하면 혼자 쓰기로 되살리고 `Err(사유)` —
/// 역할은 **성공 뒤에만** 저장한다(R1).
pub async fn switch(shell: &Shell, target: Role) -> Result<(), String> {
    let (prev, config, notices, gate) = {
        let mut st = shell.state.lock().await;
        if st.switching {
            return Err(MSG_ALREADY_SWITCHING.into());
        }
        st.switching = true;
        (
            st.running.take(),
            st.config.clone(),
            st.notices.clone(),
            st.env.start_gate.clone(),
        )
    };
    if let Some(prev) = prev {
        stop_running(prev, ABORT_MSG_ROLE_SWITCH).await;
    }
    if let Some(g) = gate {
        g.notified().await;
    }

    let mut attempt = config.clone();
    attempt.role = target;
    let mut n = notices.clone();
    let (installed, new_config, mut new_notices, result) =
        match start_running(shell, &mut attempt, &mut n).await {
            Ok(r) => {
                n.start_error = None;
                (Some(r), attempt, n, Ok(()))
            }
            Err(e) => {
                eprintln!("desktop: 역할 전환 실패: {e}");
                let (r, c, nn) = restore_after_failure(shell, &config, &notices).await;
                (r, c, nn, Err(e))
            }
        };
    if let Err(e) = &result {
        new_notices.start_error = Some(e.clone());
    }

    let mut st = shell.state.lock().await;
    st.running = installed;
    st.config = new_config;
    st.notices = new_notices;
    if result.is_ok() {
        persist(&mut st);
    }
    st.switching = false;
    drop(st);
    shell.switch_done.notify_waiters();
    result
}

/// 전환 실패 뒤 복구: 이전 역할로 다시 시작, 그것도 실패하면 혼자 쓰기. 둘 다 실패면 `None`.
async fn restore_after_failure(
    shell: &Shell,
    config: &DesktopConfig,
    notices: &Notices,
) -> (Option<Running>, DesktopConfig, Notices) {
    let mut fb = config.clone();
    let mut fbn = notices.clone();
    match start_running(shell, &mut fb, &mut fbn).await {
        Ok(r) => return (Some(r), fb, fbn),
        Err(e) => eprintln!("desktop: 이전 역할 복구 실패: {e}"),
    }
    if fb.role == Role::Local {
        return (None, fb, fbn);
    }
    let mut lc = config.clone();
    lc.role = Role::Local;
    let mut ln = notices.clone();
    match start_running(shell, &mut lc, &mut ln).await {
        Ok(r) => (Some(r), lc, ln),
        Err(e) => {
            eprintln!("desktop: 혼자 쓰기 복구 실패: {e}");
            (None, lc, ln)
        }
    }
}

/// 앱 종료. 전환 중이면 최대 10초 기다린 뒤(깨우기 유실 방지 — 잠금을 쥔 채 `enable`)
/// 같은 bounded 정지 경로로 끝낸다. 무한 대기 없음.
pub async fn shutdown(shell: &Shell) {
    let done = shell.switch_done.notified();
    tokio::pin!(done);
    let switching = {
        let st = shell.state.lock().await;
        if st.switching {
            done.as_mut().enable();
        }
        st.switching
    };
    if switching
        && tokio::time::timeout(SHUTDOWN_SWITCH_WAIT, done)
            .await
            .is_err()
    {
        eprintln!("desktop: 종료 — 진행 중 전환이 10초 안에 끝나지 않아 그대로 정지");
    }
    let r = shell.state.lock().await.running.take();
    if let Some(r) = r {
        stop_running(r, ABORT_MSG_APP_EXIT).await;
    }
}

/// 「이 PC도 부하 내기」 토글(R4). 정지는 잠금 안에서 `take()`한 뒤 잠금을 풀고 기다린다.
pub async fn set_self_worker(shell: &Shell, enabled: bool) -> Result<(), String> {
    let mut guard = shell.state.lock().await;
    let st: &mut ShellState = &mut guard;
    if st.switching {
        return Err(MSG_SWITCHING.into());
    }
    if st.config.role != Role::Server {
        return Err("서버 모드에서만 바꿀 수 있습니다".into());
    }
    let Some(running) = st.running.as_mut() else {
        return Err("서버가 실행 중이 아닙니다".into());
    };
    if let Some(sw) = running.self_worker.as_ref() {
        if is_busy(&running.controller.pool_workers().await, &sw.worker_id) {
            return Err(MSG_SELF_WORKER_BUSY.into());
        }
    }
    if enabled {
        if running.self_worker.is_none() {
            let name = (st.env.hostname)();
            if name.is_empty() {
                st.notices.self_worker_unavailable = Some(MSG_NO_HOSTNAME.into());
                return Err(MSG_NO_HOSTNAME.into());
            }
            let Some(token) = st.config.server.token.clone() else {
                return Err("접속 토큰이 없습니다".into());
            };
            let port = running.controller.grpc_addr().port();
            running.self_worker = Some(spawn_self_worker(shell, port, &token, name));
        }
        st.config.server.self_worker = true;
        st.notices.self_worker_excluded = false;
        persist(st);
        Ok(())
    } else {
        let sw = running.self_worker.take();
        st.config.server.self_worker = false;
        persist(st);
        drop(guard);
        if let Some(sw) = sw {
            stop_self_worker(sw).await;
        }
        Ok(())
    }
}

/// 이 PC 부하기가 지금 run을 실행 중인지(토글 잠금 표시용).
pub async fn self_worker_busy(shell: &Shell) -> bool {
    let st = shell.state.lock().await;
    let Some(running) = st.running.as_ref() else {
        return false;
    };
    let Some(sw) = running.self_worker.as_ref() else {
        return false;
    };
    is_busy(&running.controller.pool_workers().await, &sw.worker_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_store;
    use handicap_controller::in_process::ABORT_MSG_ROLE_SWITCH;
    use handicap_desktop_core::config::ServerSettings;
    use handicap_desktop_core::token::is_usable_token;
    use std::future::Future;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn host() -> String {
        "test-host".into()
    }

    fn local() -> DesktopConfig {
        DesktopConfig::default()
    }

    fn server(port: u16) -> DesktopConfig {
        DesktopConfig {
            role: Role::Server,
            server: ServerSettings {
                token: None,
                grpc_port: port,
                self_worker: true,
            },
        }
    }

    /// 빈 포트를 얻고 바로 놓는다(테스트 전용 — 8081 같은 고정 포트를 쓰지 않게).
    fn free_port() -> u16 {
        let l = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        l.local_addr().unwrap().port()
    }

    fn db_path(d: &Path) -> String {
        d.join("handicap-test.db").display().to_string()
    }

    fn build(
        cfg: DesktopConfig,
        config_dir: Option<PathBuf>,
        hostname: fn() -> String,
        start_gate: Option<Arc<Notify>>,
    ) -> (Shell, TempDir) {
        let d = tempfile::tempdir().unwrap();
        let env = Env {
            config_dir: config_dir.unwrap_or_else(|| d.path().to_path_buf()),
            db: Some(db_path(d.path())),
            hostname,
            start_gate,
        };
        let loaded = Loaded {
            config: cfg,
            warning: false,
        };
        (Shell::new(ShellState::new(loaded, env)), d)
    }

    fn shell(cfg: DesktopConfig) -> (Shell, TempDir) {
        build(cfg, None, host, None)
    }
    fn shell_gated(cfg: DesktopConfig, gate: Arc<Notify>) -> (Shell, TempDir) {
        build(cfg, None, host, Some(gate))
    }
    fn shell_with_dir(cfg: DesktopConfig, dir: PathBuf) -> (Shell, TempDir) {
        build(cfg, Some(dir), host, None)
    }
    fn shell_with_host(cfg: DesktopConfig, hostname: fn() -> String) -> (Shell, TempDir) {
        build(cfg, None, hostname, None)
    }

    async fn running(s: &Shell) -> tokio::sync::MappedMutexGuard<'_, Running> {
        tokio::sync::MutexGuard::map(s.state.lock().await, |st| {
            st.running.as_mut().expect("running")
        })
    }

    async fn wait_for<F, Fut>(limit: Duration, what: &str, f: F)
    where
        F: Fn() -> Fut,
        Fut: Future<Output = bool>,
    {
        let deadline = Instant::now() + limit;
        loop {
            if f().await {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{what}: {limit:?} 안에 참이 되지 않음"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// 2s 안에 조건이 참이 될 때까지 10ms 폴링, 아니면 panic.
    async fn wait_until<F, Fut>(f: F)
    where
        F: Fn() -> Fut,
        Fut: Future<Output = bool>,
    {
        wait_for(Duration::from_secs(2), "wait_until", f).await
    }

    async fn self_worker_registered(s: &Shell) -> bool {
        let st = s.state.lock().await;
        match st.running.as_ref() {
            Some(r) => r
                .controller
                .pool_workers()
                .await
                .iter()
                .any(|w| w.worker_id == "test-host"),
            None => false,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn boot_local_is_subprocess() {
        let (s, _d) = shell(local());
        boot(&s).await.unwrap();
        assert!(!running(&s).await.controller.is_pool_mode());
        shutdown(&s).await;
        assert!(s.state.lock().await.running.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn boot_server_generates_token_pools_and_saves() {
        let (s, d) = shell(server(free_port()));
        boot(&s).await.unwrap();
        let saved = config_store::load(d.path()).config;
        assert!(saved.server.token.as_deref().is_some_and(is_usable_token));
        assert_eq!(saved.role, Role::Server);
        assert!(running(&s).await.controller.is_pool_mode());
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn busy_port_records_change_and_persists() {
        let held = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        let p = held.local_addr().unwrap().port();
        let (s, d) = shell(server(p));
        boot(&s).await.unwrap();
        {
            let st = s.state.lock().await;
            assert_eq!(st.notices.port_changed.map(|x| x.0), Some(p));
            let actual = st.running.as_ref().unwrap().controller.grpc_addr().port();
            assert_eq!(st.notices.port_changed.map(|x| x.1), Some(actual));
            assert_eq!(st.config.server.grpc_port, actual);
        }
        assert_ne!(config_store::load(d.path()).config.server.grpc_port, p);
        shutdown(&s).await;
        drop(held);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_switch_is_rejected() {
        let gate = Arc::new(Notify::new());
        let (s, _d) = shell_gated(local(), gate.clone());
        boot(&s).await.unwrap();
        let s2 = s.clone();
        let a = tokio::spawn(async move { switch(&s2, Role::Server).await });
        let sr = &s;
        wait_until(|| async move { sr.state.lock().await.switching }).await; // 첫 전환이 문 앞에 멈춤
        let t = Instant::now();
        assert_eq!(
            switch(&s, Role::Server).await.unwrap_err(),
            "이미 전환 중입니다"
        );
        assert_eq!(
            set_self_worker(&s, false).await.unwrap_err(),
            "전환 중입니다"
        );
        assert!(
            t.elapsed() < Duration::from_secs(1),
            "두 번째 호출은 즉시 거절"
        );
        gate.notify_one();
        a.await.unwrap().unwrap();
        {
            let st = s.state.lock().await;
            assert!(!st.switching);
            assert_eq!(st.config.role, Role::Server);
        }
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_during_switch_is_bounded() {
        let gate = Arc::new(Notify::new());
        let (s, _d) = shell_gated(local(), gate.clone());
        boot(&s).await.unwrap();
        let s2 = s.clone();
        let _a = tokio::spawn(async move {
            let _ = switch(&s2, Role::Server).await;
        });
        let sr = &s;
        wait_until(|| async move { sr.state.lock().await.switching }).await;
        let t = Instant::now();
        // 문을 열지 않음 → 10s 대기 상한 뒤 끝나야
        tokio::time::timeout(Duration::from_secs(25), shutdown(&s))
            .await
            .expect("bounded");
        assert!(t.elapsed() >= Duration::from_secs(9)); // 실제로 전환과 겹쳤다는 증거
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_waits_for_switch_to_finish() {
        // 전환이 10s 안에 끝나면 그 결과(새 컨트롤러)까지 정지한다.
        let gate = Arc::new(Notify::new());
        let (s, _d) = shell_gated(local(), gate.clone());
        boot(&s).await.unwrap();
        let s2 = s.clone();
        let a = tokio::spawn(async move { switch(&s2, Role::Server).await });
        let sr = &s;
        wait_until(|| async move { sr.state.lock().await.switching }).await;
        let g = gate.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            g.notify_one();
        });
        let t = Instant::now();
        shutdown(&s).await;
        assert!(t.elapsed() < Duration::from_secs(9));
        a.await.unwrap().unwrap();
        assert!(s.state.lock().await.running.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switch_save_failure_keeps_result() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("file");
        std::fs::write(&f, "x").unwrap();
        let unwritable = f.join("sub"); // 파일 아래 경로 → create_dir_all 실패
        let (s, _d) = shell_with_dir(local(), unwritable);
        boot(&s).await.unwrap();
        switch(&s, Role::Server).await.unwrap();
        {
            let st = s.state.lock().await;
            assert!(st.notices.save_failed);
            assert_eq!(st.config.role, Role::Server);
            assert!(st.running.as_ref().unwrap().controller.is_pool_mode());
        }
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switch_round_trip_saves_role() {
        let (s, d) = shell(local());
        boot(&s).await.unwrap();
        switch(&s, Role::Server).await.unwrap();
        assert_eq!(config_store::load(d.path()).config.role, Role::Server);
        switch(&s, Role::Local).await.unwrap();
        let saved = config_store::load(d.path()).config;
        assert_eq!(saved.role, Role::Local);
        // 서버 설정(토큰)은 혼자 쓰기로 돌아가도 남아 다음 서버 열기에 재사용된다.
        assert!(saved.server.token.as_deref().is_some_and(is_usable_token));
        assert!(!running(&s).await.controller.is_pool_mode());
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn self_worker_registers_with_hostname() {
        let (s, _d) = shell(server(free_port()));
        boot(&s).await.unwrap();
        let sr = &s;
        wait_for(Duration::from_secs(5), "self worker 등록", || async move {
            self_worker_registered(sr).await
        })
        .await;
        assert_eq!(
            running(&s).await.self_worker.as_ref().unwrap().worker_id,
            "test-host"
        );
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn empty_hostname_skips_self_worker() {
        let (s, _d) = shell_with_host(server(free_port()), String::new);
        boot(&s).await.unwrap();
        {
            let st = s.state.lock().await;
            assert!(st.running.as_ref().unwrap().self_worker.is_none());
            assert_eq!(
                st.notices.self_worker_unavailable.as_deref(),
                Some("PC 이름을 읽지 못해 쓸 수 없습니다")
            );
        }
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn exclusion_turns_toggle_off_and_saves() {
        let (s, d) = shell(server(free_port()));
        boot(&s).await.unwrap();
        let sr = &s;
        wait_for(Duration::from_secs(5), "self worker 등록", || async move {
            self_worker_registered(sr).await
        })
        .await;
        // 서버의 Disconnect가 하는 일 = 워커에 넘긴 자식 토큰만 취소.
        running(&s)
            .await
            .self_worker
            .as_ref()
            .unwrap()
            .child
            .cancel();
        wait_until(|| async move {
            let st = sr.state.lock().await;
            !st.config.server.self_worker
                && st.notices.self_worker_excluded
                && st.running.as_ref().is_some_and(|r| r.self_worker.is_none())
        })
        .await;
        assert!(!config_store::load(d.path()).config.server.self_worker);
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn toggle_off_then_on_restarts_self_worker() {
        let (s, d) = shell(server(free_port()));
        boot(&s).await.unwrap();
        let sr = &s;
        wait_for(Duration::from_secs(5), "self worker 등록", || async move {
            self_worker_registered(sr).await
        })
        .await;
        assert!(!self_worker_busy(&s).await);
        set_self_worker(&s, false).await.unwrap();
        {
            let st = s.state.lock().await;
            assert!(st.running.as_ref().unwrap().self_worker.is_none());
            assert!(!st.config.server.self_worker);
            assert!(!st.notices.self_worker_excluded, "셸이 끈 것은 제외가 아님");
        }
        assert!(!config_store::load(d.path()).config.server.self_worker);
        set_self_worker(&s, true).await.unwrap();
        wait_for(
            Duration::from_secs(5),
            "self worker 재등록",
            || async move { self_worker_registered(sr).await },
        )
        .await;
        assert!(config_store::load(d.path()).config.server.self_worker);
        shutdown(&s).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn set_self_worker_refused_when_local() {
        let (s, _d) = shell(local());
        boot(&s).await.unwrap();
        assert!(set_self_worker(&s, true).await.is_err());
        shutdown(&s).await;
    }

    /// 대상: 요청마다 `delay` 뒤 200을 준다(keep-alive). `None`이면 받기만 하고 아무것도 쓰지 않는다.
    async fn spawn_target(delay: Option<Duration>) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((mut sock, _)) = l.accept().await {
                let Some(delay) = delay else {
                    held.push(sock);
                    continue;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let mut acc: Vec<u8> = Vec::new();
                    loop {
                        let n = match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        acc.extend_from_slice(&buf[..n]);
                        while let Some(pos) = acc.windows(4).position(|w| w == b"\r\n\r\n") {
                            acc.drain(..pos + 4);
                            tokio::time::sleep(delay).await;
                            let resp = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";
                            if sock.write_all(resp).await.is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        addr
    }

    /// 서버 + 이 PC 부하기 등록 → `taddr`를 치는 run(closed vus 1, 60s)이 이 PC 부하기에서
    /// running이 될 때까지 → `switch(Local)` → 같은 DB를 직접 열어 그 run 행을 돌려준다.
    async fn run_then_switch_to_local(
        taddr: std::net::SocketAddr,
    ) -> handicap_controller::store::runs::RunRow {
        let (s, d) = shell(server(free_port()));
        boot(&s).await.unwrap();
        let sr = &s;
        wait_for(Duration::from_secs(5), "self worker 등록", || async move {
            self_worker_registered(sr).await
        })
        .await;
        let rest = running(&s).await.controller.rest_addr();
        let base = format!("http://{rest}");
        let http = reqwest::Client::new();

        let yaml = format!(
            "version: 1\nname: abort-on-switch\nsteps:\n  \
             - id: \"01HX0000000000000000000042\"\n    name: hang\n    type: http\n    request:\n      \
             method: GET\n      url: \"http://{taddr}/hang\"\n"
        );
        let resp = http
            .post(format!("{base}/api/scenarios"))
            .json(&serde_json::json!({ "yaml": yaml }))
            .send()
            .await
            .unwrap();
        assert!(
            resp.status().is_success(),
            "scenario create {}",
            resp.status()
        );
        let v: serde_json::Value = resp.json().await.unwrap();
        let sid = v["id"].as_str().unwrap().to_string();

        let resp = http
            .post(format!("{base}/api/runs"))
            .json(&serde_json::json!({
                "scenario_id": sid,
                "profile": { "vus": 1, "duration_seconds": 60 },
                "env": {}
            }))
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success(), "run create {}", resp.status());
        let v: serde_json::Value = resp.json().await.unwrap();
        let run_id = v["id"].as_str().unwrap().to_string();

        wait_for(Duration::from_secs(5), "이 PC 부하기 배정", || async move {
            let st = sr.state.lock().await;
            st.running
                .as_ref()
                .unwrap()
                .controller
                .pool_workers()
                .await
                .iter()
                .any(|w| w.worker_id == "test-host" && w.assigned_run.is_some())
        })
        .await;
        let (h, b, r) = (&http, &base, &run_id);
        wait_for(Duration::from_secs(5), "run running", || async move {
            let v: serde_json::Value = h
                .get(format!("{b}/api/runs/{r}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            v["status"] == "running"
        })
        .await;

        switch(&s, Role::Local).await.unwrap();

        let db = handicap_controller::store::connect(&handicap_controller::store::url_from_path(
            &db_path(d.path()),
        ))
        .await
        .unwrap();
        let row = handicap_controller::store::runs::get(&db, &run_id)
            .await
            .unwrap()
            .unwrap();
        shutdown(&s).await;
        row
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switch_marks_self_worker_run_aborted_not_failed() {
        // 응답하는(느린) 대상 — 이 PC 부하기가 취소에 곧바로 멈춘다. 그래서 정지 순서가
        // 결과를 가른다: 부하기를 먼저 멈추면 워커가 보고한 Aborted(사유 없음)나
        // worker_disconnected의 failed가 먼저 쓰여 가드 UPDATE가 그 행을 건너뛴다.
        let taddr = spawn_target(Some(Duration::from_millis(100))).await;
        let row = run_then_switch_to_local(taddr).await;
        assert_eq!(row.status.as_str(), "aborted");
        assert_eq!(row.message.as_deref(), Some(ABORT_MSG_ROLE_SWITCH));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn switch_with_hung_target_is_bounded_and_aborted() {
        // 응답하지 않는 대상 — 엔진은 진행 중 요청을 취소하지 않으므로 이 PC 부하기가 5s 안에
        // 멈추지 않아 강제 중단된다. 그래도 전환은 끝나고(bounded) run은 aborted + 사유.
        let taddr = spawn_target(None).await;
        let t = Instant::now();
        let row = tokio::time::timeout(Duration::from_secs(40), run_then_switch_to_local(taddr))
            .await
            .expect("bounded");
        assert!(t.elapsed() < Duration::from_secs(40));
        assert_eq!(row.status.as_str(), "aborted");
        assert_eq!(row.message.as_deref(), Some(ABORT_MSG_ROLE_SWITCH));
    }
}
