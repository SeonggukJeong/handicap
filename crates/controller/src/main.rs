use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use clap::{Parser, ValueEnum};
use handicap_controller::dispatcher::{
    SharedDispatcher, kubernetes::KubernetesDispatcher, subprocess::SubprocessDispatcher,
};
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum WorkerMode {
    Subprocess,
    Kubernetes,
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
    /// (bundle) 시작 시 기본 브라우저 자동 오픈을 끈다(헤드리스/CI/라이브검증용).
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
        return handicap_worker::run(wargs).await;
    }

    let args = cli.controller;

    // 컨트롤러 경로: tracing init(과거 top-of-main에 있던 것과 동일 — byte-identical).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    info!(?args, "controller starting");

    if let Some(d) = &args.ui_dir {
        if !d.exists() {
            anyhow::bail!("--ui-dir {:?} does not exist", d);
        }
        if !d.join("index.html").exists() {
            anyhow::bail!("--ui-dir {:?} has no index.html", d);
        }
    }

    // bundle: 사용자 데이터 폴더(%LOCALAPPDATA%\handicap / ~/Library/Application Support/handicap)
    // 를 만들고 거기에 DB를 둔다. 비-bundle: data_dir=None → ./handicap.db(현행).
    #[cfg(feature = "bundle")]
    let data_dir: Option<std::path::PathBuf> =
        dirs::data_local_dir().map(|base| handicap_controller::launch::app_data_dir(&base));
    #[cfg(not(feature = "bundle"))]
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

    // bundle: 포트가 사용 중이면 빈 포트로 폴백해 미리 바인딩 → 실제 주소 확보(브라우저/worker가 dial).
    //         이 리스너를 serve로 넘긴다(아래). 비-bundle: 현행처럼 serve 시점에 바인딩, 주소만 args에서.
    #[cfg(feature = "bundle")]
    let (rest_listener, rest_addr, grpc_listener, grpc_addr) = {
        let rl = handicap_controller::launch::bind_with_fallback(args.rest, true)
            .context("bind REST")?;
        let ra = rl.local_addr().context("REST local_addr")?;
        let gl = handicap_controller::launch::bind_with_fallback(args.grpc, true)
            .context("bind gRPC")?;
        let ga = gl.local_addr().context("gRPC local_addr")?;
        (rl, ra, gl, ga)
    };
    #[cfg(not(feature = "bundle"))]
    let (rest_addr, grpc_addr) = (args.rest, args.grpc);
    info!(rest = %rest_addr, grpc = %grpc_addr, "listeners");

    let dispatcher: SharedDispatcher = match args.worker_mode {
        WorkerMode::Subprocess => {
            #[cfg(feature = "bundle")]
            {
                // 멀티콜: 자기 자신(current_exe)을 `worker` 서브커맨드로 재실행.
                let self_exe = std::env::current_exe()
                    .context("resolve current_exe for worker self-spawn")?
                    .to_string_lossy()
                    .into_owned();
                Arc::new(
                    SubprocessDispatcher::new(self_exe, grpc_addr, db.clone())
                        .with_leading_args(vec!["worker".to_string()]),
                )
            }
            #[cfg(not(feature = "bundle"))]
            {
                Arc::new(SubprocessDispatcher::new(
                    args.worker_bin.clone(),
                    grpc_addr,
                    db.clone(),
                ))
            }
        }
        WorkerMode::Kubernetes => {
            if args.worker_image.is_empty() {
                anyhow::bail!("--worker-image is required when --worker-mode=kubernetes");
            }
            if args.controller_grpc_url.is_empty() {
                anyhow::bail!("--controller-grpc-url is required when --worker-mode=kubernetes");
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
    let settings = handicap_controller::settings::SettingsState::build(
        &overrides,
        &[
            ("worker_capacity_vus", args.worker_capacity_vus as i64),
            ("dataset_max_rows", args.dataset_max_rows as i64),
            ("scheduler_tick_seconds", args.scheduler_tick_seconds as i64),
        ],
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
    let app_router = app::router(state);

    let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

    // REST — bundle: 미리 바인딩한 std 리스너를 tokio로 변환. 비-bundle: 현행 그대로 bind.
    #[cfg(feature = "bundle")]
    let rest_fut = async {
        rest_listener
            .set_nonblocking(true)
            .context("rest set_nonblocking")?;
        let l = TcpListener::from_std(rest_listener).context("rest into tokio listener")?;
        axum::serve(l, app_router).await.context("serve REST")
    };
    #[cfg(not(feature = "bundle"))]
    let rest_fut = async {
        let l = TcpListener::bind(args.rest).await.context("bind REST")?;
        axum::serve(l, app_router).await.context("serve REST")
    };

    // gRPC — bundle: 미리 바인딩한 리스너로 serve_with_incoming. 비-bundle: 현행 `.serve(args.grpc)`.
    #[cfg(feature = "bundle")]
    let grpc_fut = async {
        info!(addr = %grpc_addr, "gRPC listening");
        grpc_listener
            .set_nonblocking(true)
            .context("grpc set_nonblocking")?;
        let incoming = tokio_stream::wrappers::TcpListenerStream::new(
            TcpListener::from_std(grpc_listener).context("grpc into tokio listener")?,
        );
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve_with_incoming(incoming)
            .await
            .context("serve gRPC")
    };
    #[cfg(not(feature = "bundle"))]
    let grpc_fut = async {
        info!(addr = %grpc_addr, "gRPC listening");
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve(args.grpc)
            .await
            .context("serve gRPC")
    };

    info!(addr = %rest_addr, "REST listening");
    #[cfg(feature = "bundle")]
    if !args.no_open {
        let url = format!("http://localhost:{}", rest_addr.port());
        info!(%url, "opening browser");
        handicap_controller::bundle::open_browser(&url);
    }
    tokio::try_join!(rest_fut, grpc_fut)?;
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
                assert_eq!(w.run_id, "r1");
                assert_eq!(w.worker_id.as_deref(), Some("w1"));
            }
            _ => panic!("expected Worker subcommand"),
        }
    }
}
