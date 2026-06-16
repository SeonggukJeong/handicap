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
    #[arg(long, default_value = "./handicap.db")]
    db: String,
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

    let db_url = store::url_from_path(&args.db);
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

    let dispatcher: SharedDispatcher = match args.worker_mode {
        WorkerMode::Subprocess => Arc::new(SubprocessDispatcher::new(
            args.worker_bin.clone(),
            args.grpc,
            db.clone(),
        )),
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

    let rest_listener = TcpListener::bind(args.rest).await.context("bind REST")?;
    info!(addr = %args.rest, "REST listening");

    let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

    let rest_fut = async {
        axum::serve(rest_listener, app_router)
            .await
            .context("serve REST")
    };
    let grpc_fut = async {
        info!(addr = %args.grpc, "gRPC listening");
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve(args.grpc)
            .await
            .context("serve gRPC")
    };

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
        assert_eq!(cli.controller.db, "x.db");
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
