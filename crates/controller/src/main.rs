use std::net::SocketAddr;
use std::path::PathBuf;

#[cfg(not(feature = "bundle"))]
use std::sync::Arc;

#[cfg(not(feature = "bundle"))]
use anyhow::Context;

use clap::{Parser, ValueEnum};

#[cfg(not(feature = "bundle"))]
use handicap_controller::dispatcher::{
    NoopDispatcher, SharedDispatcher, kubernetes::KubernetesDispatcher,
    subprocess::SubprocessDispatcher,
};
#[cfg(not(feature = "bundle"))]
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
#[cfg(not(feature = "bundle"))]
use handicap_controller::{app, store};
#[cfg(not(feature = "bundle"))]
use handicap_proto::v1::coordinator_server::CoordinatorServer;
#[cfg(not(feature = "bundle"))]
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum WorkerMode {
    Subprocess,
    Kubernetes,
    Pool,
}

#[derive(Debug, Parser)]
struct Cli {
    /// bundle 빌드에서만: `worker` 서브커맨드로 자기 자신을 워커로 재실행(멀티콜). 없으면 컨트롤러.
    #[cfg(feature = "bundle")]
    #[command(subcommand)]
    cmd: Option<Cmd>,
    #[command(flatten)]
    controller: ControllerArgs,
}

#[cfg(feature = "bundle")]
#[derive(Debug, clap::Subcommand)]
enum Cmd {
    /// 컨트롤러가 내부적으로 spawn하는 워커 모드(직접 호출 불필요).
    Worker(handicap_worker::WorkerArgs),
}

#[derive(Debug, clap::Args)]
struct ControllerArgs {
    /// SQLite DB 경로. 생략 시: bundle은 사용자 데이터 폴더(<data>/handicap/handicap.db),
    /// 비-bundle은 ./handicap.db.
    #[arg(long)]
    db: Option<String>,
    #[arg(long, default_value = "127.0.0.1:8080")]
    rest: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:8081")]
    grpc: SocketAddr,
    /// How to launch workers for new runs.
    #[arg(long, value_enum, default_value_t = WorkerMode::Subprocess)]
    worker_mode: WorkerMode,
    /// Path to the worker binary (only used when --worker-mode=subprocess).
    #[arg(long, default_value = "target/debug/worker")]
    worker_bin: String,
    /// Kubernetes namespace for worker Jobs (only used when --worker-mode=kubernetes).
    #[arg(long, default_value = "handicap")]
    namespace: String,
    /// Helm release name used as a label prefix on worker Jobs (only used when --worker-mode=kubernetes).
    #[arg(long, default_value = "handicap")]
    release_name: String,
    /// Container image for worker Pods (required when --worker-mode=kubernetes).
    #[arg(long, default_value = "")]
    worker_image: String,
    /// gRPC URL workers should dial back to (required when --worker-mode=kubernetes).
    #[arg(long, default_value = "")]
    controller_grpc_url: String,
    /// Directory of built UI assets (e.g. ui/dist). If omitted, no static SPA is served.
    #[arg(long)]
    ui_dir: Option<PathBuf>,
    /// Max dataset rows a per-iteration binding may stream into a worker
    /// (per_vu is not capped). Guards worker memory. Spec §10.
    #[arg(long, default_value_t = 1_000_000)]
    dataset_max_rows: u64,
    /// Per-worker VU capacity. The controller fans a run out to
    /// N = ceil(total_vus / this). (A3a spec §2.1.)
    #[arg(long, default_value_t = handicap_controller::grpc::coordinator::DEFAULT_WORKER_CAPACITY_VUS)]
    worker_capacity_vus: u32,
    /// Scheduler tick interval in seconds (how often due schedules are checked).
    #[arg(long, default_value_t = 30)]
    scheduler_tick_seconds: u64,
    /// IANA timezone for cron evaluation (e.g. Asia/Seoul, UTC). chrono::Local is
    /// silently UTC in stock containers, so cron TZ is explicit (spec §3).
    #[arg(long, default_value = "Asia/Seoul")]
    scheduler_timezone: String,
    /// Disable the in-process scheduler loop entirely (no auto-fire).
    #[arg(long, default_value_t = false)]
    scheduler_disabled: bool,
    // SECURITY: never `?args`-debug-dump this struct — the token would leak in logs. Log explicit fields + worker_token_set.
    /// Shared preshared key required from workers on Register (LAN). Omit = no auth.
    #[arg(long)]
    worker_token: Option<String>,
    /// Pool heartbeat: how often the controller pings idle pool workers (seconds).
    #[arg(long, default_value_t = 10)]
    pool_heartbeat_interval_seconds: u64,
    /// Pool heartbeat: evict a pool worker after this many seconds of silence.
    #[arg(long, default_value_t = 30)]
    pool_stale_timeout_seconds: u64,
    /// gRPC HTTP/2 keepalive interval/timeout (seconds).
    #[arg(long, default_value_t = 20)]
    pool_keepalive_seconds: u64,
    /// 등록 후 첫 메트릭을 기다리는 최소 시간(초). 실제 grace는 http_timeout과
    /// 선두 rate=0 stage를 더해 늘어난다(per-run). hung 워커를 이 안에 못 잡으면 backstop이 닫는다.
    #[arg(long, default_value_t = 90)]
    run_startup_grace_seconds: u64,
    /// run 예상 종료 시각을 넘어 terminal을 기다리는 grace(초). 이 시간을 넘기면 hung으로 보고 Failed.
    #[arg(long, default_value_t = 120)]
    run_backstop_grace_seconds: u64,
    /// (bundle) 시작 시 기본 브라우저 자동 오픈을 끈다(헤드리스/CI/라이브검증용).
    /// bundle 전용 — 비-bundle 빌드엔 이 플래그가 없다(off=CLI 표면까지 byte-identical).
    #[cfg(feature = "bundle")]
    #[arg(long, default_value_t = false)]
    no_open: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // 멀티콜: `controller worker …` → 워커로 동작(자기 자신 재실행 대상). bundle 전용.
    #[cfg(feature = "bundle")]
    if let Some(Cmd::Worker(wargs)) = cli.cmd {
        handicap_worker::init_worker_tracing();
        return handicap_worker::run_dispatch(wargs).await;
    }

    let args = cli.controller;

    // 컨트롤러 경로: tracing init(과거 top-of-main에 있던 것과 동일 — byte-identical).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // bundle: run_in_process로 위임. 비-bundle: 현행 인라인 부트스트랩(byte-identical).
    #[cfg(feature = "bundle")]
    return run_bundle(args).await;

    #[cfg(not(feature = "bundle"))]
    {
        info!(
            rest = %args.rest,
            grpc = %args.grpc,
            worker_mode = ?args.worker_mode,
            worker_token_set = args.worker_token.is_some(),
            "controller starting"
        );

        if let Some(d) = &args.ui_dir {
            if !d.exists() {
                anyhow::bail!("--ui-dir {:?} does not exist", d);
            }
            if !d.join("index.html").exists() {
                anyhow::bail!("--ui-dir {:?} has no index.html", d);
            }
        }

        // 비-bundle: data_dir=None → ./handicap.db(현행).
        let data_dir: Option<std::path::PathBuf> = None;

        if let Some(dir) = &data_dir {
            std::fs::create_dir_all(dir).context("create app data dir")?;
        }
        let db_path =
            handicap_controller::launch::resolve_db_path(args.db.as_deref(), data_dir.as_deref());
        info!(db = %db_path, "resolved database path");
        let db_url = store::url_from_path(&db_path);
        let db = store::connect(&db_url).await?;
        let recovered = handicap_controller::store::runs::mark_orphans_failed(
            &db,
            "controller restarted while run was in progress",
        )
        .await
        .context("mark_orphans_failed")?;
        if recovered > 0 {
            info!(count = recovered, "marked orphan runs as failed on startup");
        }
        let coord_state = CoordinatorState::new(db.clone());
        coord_state.set_worker_token(args.worker_token.clone());

        // 비-bundle: 현행처럼 serve 시점에 바인딩, 주소만 args에서.
        let (rest_addr, grpc_addr) = (args.rest, args.grpc);
        info!(rest = %rest_addr, grpc = %grpc_addr, "listeners");

        let dispatcher: SharedDispatcher = match args.worker_mode {
            WorkerMode::Subprocess => Arc::new(SubprocessDispatcher::new(
                args.worker_bin.clone(),
                grpc_addr,
                db.clone(),
            )),
            WorkerMode::Kubernetes => {
                if args.worker_image.is_empty() {
                    anyhow::bail!("--worker-image is required when --worker-mode=kubernetes");
                }
                if args.controller_grpc_url.is_empty() {
                    anyhow::bail!(
                        "--controller-grpc-url is required when --worker-mode=kubernetes"
                    );
                }
                Arc::new(
                    KubernetesDispatcher::try_new(
                        args.namespace.clone(),
                        args.release_name.clone(),
                        args.worker_image.clone(),
                        args.controller_grpc_url.clone(),
                    )
                    .await?,
                )
            }
            WorkerMode::Pool => {
                // Pool mode: always-on workers register idle; spawn_run uses
                // reserve_idle_pool + assign_pool_workers instead of dispatcher.
                coord_state.set_pool_mode(true);
                Arc::new(NoopDispatcher) as SharedDispatcher
            }
        };
        // Let the coordinator tear down workers on finalize (completion/failure/abort).
        coord_state.set_dispatcher(dispatcher.clone());
        let scheduler_tz: chrono_tz::Tz = args.scheduler_timezone.parse().map_err(|_| {
            anyhow::anyhow!("invalid --scheduler-timezone: {}", args.scheduler_timezone)
        })?;
        // Build the runtime settings snapshot: DB overrides ?? CLI/registry seeds.
        // The CLI flags (--worker-capacity-vus, --dataset-max-rows, scheduler tick)
        // feed seeds — values are byte-identical when there are no DB overrides (R5).
        let overrides = handicap_controller::store::settings::load_overrides(&db).await?;
        // R5(c): build()는 CLI 시드를 range-check 안 하므로(§3.6), stale ≤ interval 시드를
        // 여기서 clamp(+warn)해 startup이 destructive flapping 상태로 부팅하는 걸 막는다.
        let pool_interval_seed = args.pool_heartbeat_interval_seconds;
        let pool_stale_seed = if args.pool_stale_timeout_seconds <= pool_interval_seed {
            tracing::warn!(
                interval = pool_interval_seed,
                stale = args.pool_stale_timeout_seconds,
                "stale ≤ interval 시드 — interval+1로 clamp"
            );
            pool_interval_seed + 1
        } else {
            args.pool_stale_timeout_seconds
        };
        let settings = handicap_controller::settings::SettingsState::build(
            &overrides,
            &[
                ("worker_capacity_vus", args.worker_capacity_vus as i64),
                ("dataset_max_rows", args.dataset_max_rows as i64),
                ("scheduler_tick_seconds", args.scheduler_tick_seconds as i64),
                ("pool_heartbeat_interval_seconds", pool_interval_seed as i64),
                ("pool_stale_timeout_seconds", pool_stale_seed as i64),
                ("pool_keepalive_seconds", args.pool_keepalive_seconds as i64),
                (
                    "run_startup_grace_seconds",
                    args.run_startup_grace_seconds as i64,
                ),
                (
                    "run_backstop_grace_seconds",
                    args.run_backstop_grace_seconds as i64,
                ),
            ],
        );
        tracing::info!(
            startup_grace_s = settings.run_startup_grace_seconds(),
            backstop_grace_s = settings.run_backstop_grace_seconds(),
            "run-liveness watchdog grace (settings)"
        );
        let state = app::AppState {
            db: db.clone(),
            coord: coord_state.clone(),
            dispatcher: dispatcher.clone(),
            ui_dir: args.ui_dir.clone(),
            settings,
            scheduler_tz,
        };
        if !args.scheduler_disabled {
            let sched_state = state.clone();
            let tick = std::time::Duration::from_secs(args.scheduler_tick_seconds);
            tokio::spawn(handicap_controller::schedule::run_scheduler(
                sched_state,
                tick,
            ));
            info!(
                tick_seconds = args.scheduler_tick_seconds,
                tz = %scheduler_tz,
                "scheduler loop started"
            );
        }
        if coord_state.is_pool_mode() {
            let coord = coord_state.clone();
            let settings = state.settings.clone(); // R2: 매 sweep 임계값 fresh 재읽기 위해 캡처
            // Snapshot seed values for the startup log (settings is moved into the spawn below).
            let log_interval = settings.pool_heartbeat_interval_seconds();
            let log_stale = settings.pool_stale_timeout_seconds();
            tokio::spawn(async move {
                loop {
                    // R9: interval 0(시드 우회)이어도 tight-loop 방지.
                    let interval = settings.pool_heartbeat_interval_seconds().max(1);
                    let stale = settings.pool_stale_timeout_seconds();
                    tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                    coord
                        .pool_heartbeat_tick(
                            tokio::time::Instant::now(),
                            std::time::Duration::from_secs(stale),
                        )
                        .await;
                }
            });
            tracing::info!(
                interval_s = log_interval,
                stale_s = log_stale,
                keepalive_s = args.pool_keepalive_seconds,
                "pool heartbeat reaper started (runtime-tunable)"
            );
        }
        let app_router = app::router(state);

        let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

        // 비-bundle: 현행 그대로 bind.
        let rest_fut = async {
            let l = TcpListener::bind(args.rest).await.context("bind REST")?;
            axum::serve(l, app_router).await.context("serve REST")
        };

        // 비-bundle: 현행 `.serve(args.grpc)`.
        let grpc_fut = async {
            info!(addr = %grpc_addr, "gRPC listening");
            tonic::transport::Server::builder()
                .http2_keepalive_interval(Some(std::time::Duration::from_secs(
                    args.pool_keepalive_seconds,
                )))
                .http2_keepalive_timeout(Some(std::time::Duration::from_secs(
                    args.pool_keepalive_seconds,
                )))
                .add_service(grpc_svc)
                .serve(args.grpc)
                .await
                .context("serve gRPC")
        };

        info!(addr = %rest_addr, "REST listening");
        tokio::try_join!(rest_fut, grpc_fut)?;
        Ok(())
    }
}

/// bundle 부트스트랩: InProcessConfig를 조립해 run_in_process에 위임.
/// 비-bundle 빌드에서는 컴파일되지 않는다(cfg-gated).
///
/// `--ui-dir` 존재 검증을 의도적으로 드롭한다: in-process 경로는 `ui_dir = None` 고정
/// (bundle은 rust-embed 임베드 UI가 authoritative)이므로 외부 `ui_dir`는 수용-후-무시.
/// SECURITY: args를 통째 ?-덤프하지 말 것 — worker_token 누출 위험.
#[cfg(feature = "bundle")]
async fn run_bundle(args: ControllerArgs) -> anyhow::Result<()> {
    use handicap_controller::in_process::{InProcessConfig, SettingsSeeds, run_in_process};

    // 보안: args를 통째 ?-덤프하지 말 것(worker_token 누출). 명시 필드 + bool만.
    info!(
        rest = %args.rest,
        grpc = %args.grpc,
        worker_token_set = args.worker_token.is_some(),
        "controller starting (in-process bundle)"
    );

    let cfg = InProcessConfig {
        db: args.db.clone(),
        rest: args.rest,
        grpc: args.grpc,
        worker_token: args.worker_token.clone(),
        scheduler_disabled: args.scheduler_disabled,
        scheduler_timezone: args.scheduler_timezone.clone(),
        settings_seeds: SettingsSeeds {
            worker_capacity_vus: args.worker_capacity_vus,
            dataset_max_rows: args.dataset_max_rows,
            scheduler_tick_seconds: args.scheduler_tick_seconds,
            pool_heartbeat_interval_seconds: args.pool_heartbeat_interval_seconds,
            pool_stale_timeout_seconds: args.pool_stale_timeout_seconds,
            pool_keepalive_seconds: args.pool_keepalive_seconds,
            run_startup_grace_seconds: args.run_startup_grace_seconds,
            run_backstop_grace_seconds: args.run_backstop_grace_seconds,
        },
    };

    let rc = run_in_process(cfg).await?;

    if !args.no_open {
        let url = format!("http://localhost:{}", rc.rest_addr().port());
        info!(%url, "opening browser");
        handicap_controller::bundle::open_browser(&url);
    }
    info!(rest = %rc.rest_addr(), "REST listening (in-process)");

    rc.join().await;
    Ok(())
}

#[cfg(test)]
mod cli_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn flat_controller_invocation_still_parses() {
        // 서브커맨드 없는 기존 호출이 깨지지 않아야 한다.
        let cli = Cli::try_parse_from([
            "controller",
            "--db",
            "x.db",
            "--rest",
            "127.0.0.1:8080",
            "--ui-dir",
            "ui/dist",
        ])
        .expect("flat controller args must parse");
        assert_eq!(cli.controller.db.as_deref(), Some("x.db"));
    }

    #[cfg(feature = "bundle")]
    #[test]
    fn worker_subcommand_parses() {
        let cli = Cli::try_parse_from([
            "controller",
            "worker",
            "--controller",
            "http://127.0.0.1:8081",
            "--run-id",
            "r1",
            "--worker-id",
            "w1",
        ])
        .expect("worker subcommand must parse");
        match cli.cmd {
            Some(Cmd::Worker(w)) => {
                assert_eq!(w.run_id.as_deref(), Some("r1"));
                assert_eq!(w.worker_id.as_deref(), Some("w1"));
            }
            _ => panic!("expected Worker subcommand"),
        }
    }
}
