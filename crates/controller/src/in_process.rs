//! controller in-process 구동 진입점(bundle 전용). `main.rs` bundle 부트스트랩을
//! 라이브러리로 추출한 것 — desktop 셸(Slice 2)·standalone bundle exe가 함께 쓴다.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::app::{self, AppState};
use crate::dispatcher::{SharedDispatcher, subprocess::SubprocessDispatcher};
use crate::grpc::coordinator::{CoordinatorService, CoordinatorState, DEFAULT_WORKER_CAPACITY_VUS};
use crate::settings::SettingsState;
use crate::store::Db;
use handicap_proto::v1::coordinator_server::CoordinatorServer;

// Task 3 (run_in_process shutdown path) uses this constant directly.
const GRACEFUL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// `SettingsState::build`에 넘길 8개 런타임 설정의 CLI-기본 시드.
/// 필드명·기본값은 `main.rs` `ControllerArgs`의 `default_value_t`와 1:1.
#[derive(Debug, Clone)]
pub struct SettingsSeeds {
    pub worker_capacity_vus: u32,
    pub dataset_max_rows: u64,
    pub scheduler_tick_seconds: u64,
    pub pool_heartbeat_interval_seconds: u64,
    pub pool_stale_timeout_seconds: u64,
    pub pool_keepalive_seconds: u64,
    pub run_startup_grace_seconds: u64,
    pub run_backstop_grace_seconds: u64,
}

impl Default for SettingsSeeds {
    fn default() -> Self {
        Self {
            worker_capacity_vus: DEFAULT_WORKER_CAPACITY_VUS,
            dataset_max_rows: 1_000_000,
            scheduler_tick_seconds: 30,
            pool_heartbeat_interval_seconds: 10,
            pool_stale_timeout_seconds: 30,
            pool_keepalive_seconds: 20,
            run_startup_grace_seconds: 90,
            run_backstop_grace_seconds: 120,
        }
    }
}

impl SettingsSeeds {
    /// `SettingsState::build(&overrides, &seeds)`가 받는 `(key, i64)` 시드 슬라이스.
    /// R5c stale-clamp는 build 호출 *전*에 raw 시드에 대해 별도로 처리하므로 여기선 raw 값만.
    ///
    /// 주의(리뷰 적발): `scheduler_tick_seconds`·`pool_keepalive_seconds`는 `SETTINGS`
    /// 레지스트리에 **readonly(`mutable:false`)** 항목이라(settings.rs:144/154) `build`가
    /// 가변 스냅샷이 아니라 `readonly` 표시값으로만 보관한다(settings.rs:252). 결정 지점은
    /// settings 스냅샷이 아니라 `SettingsSeeds` 필드에서 **직접** 읽는다(run_in_process §8
    /// scheduler tick·§11 keepalive·가변 accessor 부재). main.rs:272/275도 같은 8키를
    /// 넘기므로 parity 유지 — 미래 독자가 "죽은 시드"로 오인해 제거하지 않도록 8키를 그대로 둔다.
    fn to_seed_array(&self) -> [(&'static str, i64); 8] {
        [
            ("worker_capacity_vus", self.worker_capacity_vus as i64),
            ("dataset_max_rows", self.dataset_max_rows as i64),
            ("scheduler_tick_seconds", self.scheduler_tick_seconds as i64),
            (
                "pool_heartbeat_interval_seconds",
                self.pool_heartbeat_interval_seconds as i64,
            ),
            (
                "pool_stale_timeout_seconds",
                self.pool_stale_timeout_seconds as i64,
            ),
            ("pool_keepalive_seconds", self.pool_keepalive_seconds as i64),
            (
                "run_startup_grace_seconds",
                self.run_startup_grace_seconds as i64,
            ),
            (
                "run_backstop_grace_seconds",
                self.run_backstop_grace_seconds as i64,
            ),
        ]
    }
}

/// in-process controller 구동 설정. `db: None` → dirs data-local-dir의 기본 DB,
/// `rest`/`grpc` 기본 `127.0.0.1:0`(OS가 빈 포트 할당). **고정: worker_mode = Subprocess, ui_dir = None.**
#[derive(Clone)]
pub struct InProcessConfig {
    pub db: Option<String>,
    pub rest: SocketAddr,
    pub grpc: SocketAddr,
    pub worker_token: Option<String>,
    pub scheduler_disabled: bool,
    pub scheduler_timezone: String,
    pub settings_seeds: SettingsSeeds,
}

impl Default for InProcessConfig {
    fn default() -> Self {
        Self {
            db: None,
            rest: SocketAddr::from(([127, 0, 0, 1], 0)),
            grpc: SocketAddr::from(([127, 0, 0, 1], 0)),
            worker_token: None,
            scheduler_disabled: false,
            scheduler_timezone: "Asia/Seoul".to_string(),
            settings_seeds: SettingsSeeds::default(),
        }
    }
}

impl std::fmt::Debug for InProcessConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InProcessConfig")
            .field("db", &self.db)
            .field("rest", &self.rest)
            .field("grpc", &self.grpc)
            .field(
                "worker_token",
                &self.worker_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("scheduler_disabled", &self.scheduler_disabled)
            .field("scheduler_timezone", &self.scheduler_timezone)
            .field("settings_seeds", &self.settings_seeds)
            .finish()
    }
}

/// serve 태스크를 graceful drain하되 **절대 무한 대기하지 않는다**(스펙 §6).
/// `timeout` 내 완료 → `true`. 초과 → 태스크를 hard-abort하고 `false`.
/// (JoinHandle을 그냥 drop하면 detach될 뿐 abort되지 않으므로 명시적 `abort()` 필요.)
async fn bounded_drain(mut handle: tokio::task::JoinHandle<()>, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, &mut handle).await {
        Ok(_) => true,
        Err(_) => {
            handle.abort();
            let _ = handle.await;
            false
        }
    }
}

/// 활성(`pending`/`running`) run에 in-memory Abort를 보낸다(send-only).
/// `coord.abort(id)`는 in-memory 워커 엔트리가 없으면 `false`를 돌려주는데(아직 미등록 pending 등)
/// 이는 **no-op이지 에러가 아니다** — 그런 run은 워커 self-cancel(R4b)·다음 startup
/// `mark_orphans_failed`(R4c)가 커버한다. 반환값은 활성 run 개수.
pub async fn abort_all(coord: &CoordinatorState, db: &Db) -> anyhow::Result<usize> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM runs WHERE status IN ('pending','running')")
            .fetch_all(db)
            .await
            .context("query active run ids")?;
    for id in &ids {
        let _ = coord.abort(id).await;
    }
    Ok(ids.len())
}

/// in-process로 구동 중인 controller 핸들. serve/scheduler/heartbeat 태스크를 보유하고
/// graceful 종료(`shutdown`)·블로킹 대기(`join`)를 제공한다.
pub struct RunningController {
    rest_addr: SocketAddr,
    grpc_addr: SocketAddr,
    token: CancellationToken,
    serve: Mutex<Option<tokio::task::JoinHandle<()>>>,
    scheduler: Mutex<Option<tokio::task::JoinHandle<()>>>,
    heartbeat: Mutex<Option<tokio::task::JoinHandle<()>>>,
    coord: CoordinatorState,
    db: Db,
}

impl RunningController {
    pub fn rest_addr(&self) -> SocketAddr {
        self.rest_addr
    }
    pub fn grpc_addr(&self) -> SocketAddr {
        self.grpc_addr
    }

    /// graceful 종료. 절대 무한 hang하지 않는다(스펙 §6): 활성 run abort(R4a) →
    /// 토큰 취소(axum/tonic graceful drain·scheduler/heartbeat 정지) → bounded drain
    /// (초과 시 serve 태스크 hard-stop).
    pub async fn shutdown(&self) {
        match abort_all(&self.coord, &self.db).await {
            Ok(n) => info!(aborted = n, "shutdown: aborted active runs"),
            Err(e) => warn!(error = ?e, "shutdown: abort_all failed (continuing)"),
        }
        self.token.cancel();
        let serve = self.serve.lock().unwrap().take();
        if let Some(handle) = serve {
            if !bounded_drain(handle, GRACEFUL_DRAIN_TIMEOUT).await {
                warn!(
                    timeout_s = GRACEFUL_DRAIN_TIMEOUT.as_secs(),
                    "graceful drain exceeded deadline — serve task hard-stopped"
                );
            }
        }
        // 토큰 취소로 select!를 빠져나오지만 백스톱으로 abort.
        if let Some(h) = self.scheduler.lock().unwrap().take() {
            h.abort();
        }
        if let Some(h) = self.heartbeat.lock().unwrap().take() {
            h.abort();
        }
    }

    /// serve 태스크를 await(토큰이 취소되지 않는 한 사실상 영원). standalone bundle exe용.
    pub async fn join(self) {
        let serve = self.serve.lock().unwrap().take();
        if let Some(handle) = serve {
            let _ = handle.await;
        }
    }
}

pub async fn run_in_process(cfg: InProcessConfig) -> anyhow::Result<RunningController> {
    // 1) data-dir + DB 경로 해석 (bundle: dirs data-local-dir, in-process는 worker_mode 고정 Subprocess).
    let data_dir: Option<std::path::PathBuf> =
        dirs::data_local_dir().map(|base| crate::launch::app_data_dir(&base));
    if let Some(dir) = &data_dir {
        std::fs::create_dir_all(dir).context("create app data dir")?;
    }
    let db_path = crate::launch::resolve_db_path(cfg.db.as_deref(), data_dir.as_deref());
    info!(db = %db_path, "resolved database path");
    let db_url = crate::store::url_from_path(&db_path);
    let db = crate::store::connect(&db_url).await?;

    // 2) 고아 run 정리(R4c) + Coordinator 상태.
    let recovered = crate::store::runs::mark_orphans_failed(
        &db,
        "controller restarted while run was in progress",
    )
    .await
    .context("mark_orphans_failed")?;
    if recovered > 0 {
        info!(count = recovered, "marked orphan runs as failed on startup");
    }
    let coord_state = CoordinatorState::new(db.clone());
    // NOTE: In-process mode uses Subprocess self-exe workers that do NOT present a token; the
    // in-process gRPC listener's security boundary is the `127.0.0.1` loopback bind, not the
    // token. `worker_token` here applies only to the LAN-pool model (remote workers presenting a
    // shared PSK), which the in-process path does not use — so setting it on a bundle build has
    // no effect on locally self-spawned workers. Do not mistake this for in-process gRPC auth.
    coord_state.set_worker_token(cfg.worker_token.clone());

    // 3) 포트 pre-bind(빈 포트 fallback) → 실제 주소 확보(브라우저/worker가 dial).
    let rest_listener = crate::launch::bind_with_fallback(cfg.rest, true).context("bind REST")?;
    let rest_addr = rest_listener.local_addr().context("REST local_addr")?;
    let grpc_listener = crate::launch::bind_with_fallback(cfg.grpc, true).context("bind gRPC")?;
    let grpc_addr = grpc_listener.local_addr().context("gRPC local_addr")?;
    info!(rest = %rest_addr, grpc = %grpc_addr, "listeners (in-process)");

    // 4) dispatcher: in-process는 항상 Subprocess(self-exe 멀티콜 워커).
    let self_exe = std::env::current_exe()
        .context("resolve current_exe for worker self-spawn")?
        .to_string_lossy()
        .into_owned();
    let dispatcher: SharedDispatcher = Arc::new(
        SubprocessDispatcher::new(self_exe, grpc_addr, db.clone())
            .with_leading_args(vec!["worker".to_string()]),
    );
    coord_state.set_dispatcher(dispatcher.clone());

    let scheduler_tz: chrono_tz::Tz = cfg
        .scheduler_timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid scheduler timezone: {}", cfg.scheduler_timezone))?;

    // 5) settings: R5c stale-clamp(시드 stale ≤ interval이면 interval+1) 후 build.
    let overrides = crate::store::settings::load_overrides(&db).await?;
    let mut seeds = cfg.settings_seeds.clone();
    if seeds.pool_stale_timeout_seconds <= seeds.pool_heartbeat_interval_seconds {
        warn!(
            interval = seeds.pool_heartbeat_interval_seconds,
            stale = seeds.pool_stale_timeout_seconds,
            "stale ≤ interval seed — clamping to interval+1"
        );
        seeds.pool_stale_timeout_seconds = seeds.pool_heartbeat_interval_seconds + 1;
    }
    let settings = SettingsState::build(&overrides, &seeds.to_seed_array());

    // 6) AppState (ui_dir 고정 None — bundle은 rust-embed로 임베드 UI 서빙).
    let state = AppState {
        db: db.clone(),
        coord: coord_state.clone(),
        dispatcher: dispatcher.clone(),
        ui_dir: None,
        settings: settings.clone(),
        scheduler_tz,
    };

    // 7) graceful 종료 토큰.
    let token = CancellationToken::new();

    // 8) scheduler 루프(토큰 취소 시 종료).
    let scheduler_handle = if !cfg.scheduler_disabled {
        let sched_state = state.clone();
        let tick = Duration::from_secs(seeds.scheduler_tick_seconds);
        let sched_token = token.clone();
        info!("scheduler enabled");
        Some(tokio::spawn(async move {
            tokio::select! {
                _ = crate::schedule::run_scheduler(sched_state, tick) => {}
                _ = sched_token.cancelled() => {}
            }
        }))
    } else {
        None
    };

    // 9) heartbeat-reaper(pool 모드에서만; in-process는 Subprocess라 dormant — R6 충실 배선).
    let heartbeat_handle = if coord_state.is_pool_mode() {
        let coord = coord_state.clone();
        let settings = settings.clone();
        let hb_token = token.clone();
        Some(tokio::spawn(async move {
            loop {
                let interval = settings.pool_heartbeat_interval_seconds().max(1);
                let stale = settings.pool_stale_timeout_seconds();
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                    _ = hb_token.cancelled() => break,
                }
                coord
                    .pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(stale))
                    .await;
            }
        }))
    } else {
        None
    };

    // 10) gRPC 서비스.
    let grpc_svc = CoordinatorServer::new(CoordinatorService {
        state: coord_state.clone(),
    });

    // 11) serve 태스크: axum(REST) + tonic(gRPC)을 graceful shutdown 토큰과 함께 한 태스크에서.
    let app_router = app::router(state);
    let rest_token = token.clone();
    let grpc_token = token.clone();
    let keepalive = Duration::from_secs(seeds.pool_keepalive_seconds);
    let serve_handle = tokio::spawn(async move {
        rest_listener
            .set_nonblocking(true)
            .expect("rest set_nonblocking");
        let rest_l = TcpListener::from_std(rest_listener).expect("rest from_std");
        let rest_fut = axum::serve(rest_l, app_router)
            .with_graceful_shutdown(async move { rest_token.cancelled().await });

        grpc_listener
            .set_nonblocking(true)
            .expect("grpc set_nonblocking");
        let grpc_incoming =
            TcpListenerStream::new(TcpListener::from_std(grpc_listener).expect("grpc from_std"));
        let grpc_fut = tonic::transport::Server::builder()
            .http2_keepalive_interval(Some(keepalive))
            .http2_keepalive_timeout(Some(keepalive))
            .add_service(grpc_svc)
            .serve_with_incoming_shutdown(
                grpc_incoming,
                async move { grpc_token.cancelled().await },
            );

        let (rest_res, grpc_res) = tokio::join!(rest_fut, grpc_fut);
        if let Err(e) = rest_res {
            warn!(error = ?e, "REST serve task ended with error");
        }
        if let Err(e) = grpc_res {
            warn!(error = ?e, "gRPC serve task ended with error");
        }
    });

    Ok(RunningController {
        rest_addr,
        grpc_addr,
        token,
        serve: Mutex::new(Some(serve_handle)),
        scheduler: Mutex::new(scheduler_handle),
        heartbeat: Mutex::new(heartbeat_handle),
        coord: coord_state,
        db,
    })
}

/// worker/src/main.rs:6-11 미러 — `WorkerArgs`는 derive(Args)라 자체 파싱이 안 되므로
/// flatten 래퍼가 `Parser`를 제공한다. (bundle-gated 모듈 안이라 cfg 불필요.)
#[derive(clap::Parser)]
struct WorkerCli {
    #[command(flatten)]
    args: handicap_worker::WorkerArgs,
}

/// 순수: argv[1]=="worker"면 그 토큰을 드롭하고 나머지를 `WorkerArgs`로 파싱한다.
/// dispatcher argv = `[exe, "worker", "--controller", …]`(in_process.rs `with_leading_args`).
/// `[synthetic_prog] ++ argv[2..]`를 `WorkerCli::try_parse_from`에 먹인다(합성 argv[0]=프로그램명).
/// standalone `controller.exe`의 clap `Cmd::Worker`가 같은 argv를 소비하는 방식과 정합.
fn worker_args_from<I, T>(argv: I) -> Option<handicap_worker::WorkerArgs>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString>,
{
    let v: Vec<std::ffi::OsString> = argv.into_iter().map(Into::into).collect();
    if v.get(1)?.to_str()? != "worker" {
        return None;
    }
    let synth = std::iter::once(std::ffi::OsString::from("worker")).chain(v.into_iter().skip(2));
    WorkerCli::try_parse_from(synth).ok().map(|c| c.args)
}

/// 멀티콜 가드. `<exe> worker …`로 실행됐으면 워커로 동작 후 프로세스 종료(절대 return 안 함);
/// 아니면 즉시 return해 호출자가 GUI를 띄우게 한다. **desktop `main()`의 첫 문장으로 호출**해야
/// 한다(Tauri/런타임 init 전). `run_in_process`는 tracing init을 안 하므로(caller 소유) 워커
/// 프로세스는 자기 `init_worker_tracing()`을 호출한다.
pub fn run_worker_if_invoked() {
    let Some(args) = worker_args_from(std::env::args_os()) else {
        return;
    };
    handicap_worker::init_worker_tracing();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build worker runtime");
    let code = match rt.block_on(handicap_worker::run_dispatch(args)) {
        Ok(()) => 0,
        Err(e) => {
            tracing::error!(error = ?e, "worker failed");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    #[test]
    fn settings_seeds_default_maps_keys_and_values() {
        let arr = SettingsSeeds::default().to_seed_array();
        assert_eq!(arr.len(), 8);
        assert_eq!(
            arr[0],
            ("worker_capacity_vus", DEFAULT_WORKER_CAPACITY_VUS as i64)
        );
        assert_eq!(arr[1], ("dataset_max_rows", 1_000_000_i64));
        assert_eq!(arr[2], ("scheduler_tick_seconds", 30));
        assert_eq!(arr[3], ("pool_heartbeat_interval_seconds", 10));
        assert_eq!(arr[4], ("pool_stale_timeout_seconds", 30));
        assert_eq!(arr[5], ("pool_keepalive_seconds", 20));
        assert_eq!(arr[6], ("run_startup_grace_seconds", 90));
        assert_eq!(arr[7], ("run_backstop_grace_seconds", 120));
    }

    #[test]
    fn in_process_config_default_binds_ephemeral_localhost() {
        let c = InProcessConfig::default();
        assert_eq!(c.rest.ip().to_string(), "127.0.0.1");
        assert_eq!(c.rest.port(), 0);
        assert_eq!(c.grpc.ip().to_string(), "127.0.0.1");
        assert_eq!(c.grpc.port(), 0);
        assert_eq!(c.scheduler_timezone, "Asia/Seoul");
        assert!(c.db.is_none());
        assert!(c.worker_token.is_none());
        assert!(!c.scheduler_disabled);
    }

    #[tokio::test]
    async fn bounded_drain_returns_true_when_task_finishes() {
        let h = tokio::spawn(async {});
        assert!(bounded_drain(h, Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn bounded_drain_hard_stops_on_timeout() {
        // pending 태스크 → 타임아웃 → hard-stop. 테스트가 끝난다는 것 자체가 hang 안 함의 증거.
        let h = tokio::spawn(std::future::pending::<()>());
        assert!(!bounded_drain(h, Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn abort_all_counts_active_runs_and_tolerates_absent_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let db_url = store::url_from_path(&tmp.path().join("a.db").display().to_string());
        let db = store::connect(&db_url).await.unwrap();
        // FK: runs.scenario_id REFERENCES scenarios(id) — insert seed scenario first.
        sqlx::query(
            "INSERT INTO scenarios(id,name,yaml,created_at,updated_at,version) VALUES(?,?,?,?,?,?)",
        )
        .bind("scn-1")
        .bind("test")
        .bind("version: 1\nsteps: []\n")
        .bind(0_i64)
        .bind(0_i64)
        .bind(1_i64)
        .execute(&db)
        .await
        .unwrap();
        insert_active_run(&db, "run-a", "running").await;
        insert_active_run(&db, "run-b", "pending").await;
        insert_active_run(&db, "run-c", "completed").await; // 비활성 → 카운트 제외
        let coord = CoordinatorState::new(db.clone());
        // 워커 등록 안 함 → 활성 run 모두 in-memory 엔트리 없음 → abort()는 false지만 에러 아님.
        let n = abort_all(&coord, &db).await.unwrap();
        assert_eq!(n, 2);
    }

    async fn insert_active_run(db: &Db, id: &str, status: &str) {
        sqlx::query(
            "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
             VALUES(?,?,?,?,?,?,?)",
        )
        .bind(id)
        .bind("scn-1")
        .bind("version: 1\nsteps: []\n")
        .bind(r#"{"duration_seconds":1}"#)
        .bind("{}")
        .bind(status)
        .bind(0_i64)
        .execute(db)
        .await
        .unwrap();
    }

    async fn start_test_controller() -> RunningController {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = InProcessConfig {
            db: Some(tmp.path().join("c.db").display().to_string()),
            scheduler_disabled: true, // 테스트 잡음 제거
            ..InProcessConfig::default()
        };
        // tmp는 함수 종료 시 drop되지만 DB connect가 끝난 뒤라 무방(파일 핸들은 풀이 보유).
        std::mem::forget(tmp);
        run_in_process(cfg).await.unwrap()
    }

    #[tokio::test]
    async fn run_in_process_serves_health_then_shuts_down() {
        let rc = start_test_controller().await;
        let port = rc.rest_addr().port();
        assert_ne!(port, 0, "ephemeral 포트가 실제 할당돼야 함");

        let url = format!("http://127.0.0.1:{port}/api/health");
        let body = reqwest::get(&url).await.unwrap().text().await.unwrap();
        assert_eq!(body, "ok");

        // shutdown은 빠르게(절대 hang 없이) 반환해야 한다.
        tokio::time::timeout(Duration::from_secs(10), rc.shutdown())
            .await
            .expect("shutdown must not hang");

        // 종료 후 health는 더 이상 안 떠야 한다.
        let after = reqwest::get(&url).await;
        assert!(after.is_err(), "shutdown 후 REST가 닫혀야 함");
    }

    #[test]
    fn worker_args_from_parses_worker_invocation() {
        let argv = [
            "app",
            "worker",
            "--controller",
            "http://127.0.0.1:8081",
            "--run-id",
            "r1",
            "--worker-id",
            "w1",
        ];
        let got = worker_args_from(argv).expect("worker invocation must parse");
        assert_eq!(got.controller, "http://127.0.0.1:8081");
        assert_eq!(got.run_id.as_deref(), Some("r1"));
        assert_eq!(got.worker_id.as_deref(), Some("w1"));
    }

    #[test]
    fn worker_args_from_ignores_controller_invocation() {
        // GUI/컨트롤러 기동: argv[1]이 "worker"가 아니면 None(가드가 return해 GUI로).
        assert!(worker_args_from(["app"]).is_none());
        assert!(worker_args_from(["app", "--rest", "127.0.0.1:0"]).is_none());
    }

    #[test]
    fn worker_args_from_pool_invocation_without_run_id() {
        // 풀 워커: --run-id 생략(should_run_pool). 토큰 스킵 + 파싱 parity 확인.
        let got = worker_args_from(["app", "worker", "--controller", "http://127.0.0.1:8081"])
            .expect("pool worker invocation must parse");
        assert_eq!(got.controller, "http://127.0.0.1:8081");
        assert!(got.run_id.is_none());
    }
}
