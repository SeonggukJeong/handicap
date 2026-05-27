use std::net::SocketAddr;

use anyhow::Context;
use clap::Parser;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

use handicap_controller::{app, store};

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "./handicap.db")]
    db: String,
    #[arg(long, default_value = "127.0.0.1:8080")]
    rest: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:8081")]
    grpc: SocketAddr,
    /// Path to the worker binary. Used to spawn workers per run.
    #[arg(long, default_value = "target/debug/worker")]
    worker_bin: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let args = Args::parse();
    info!(?args, "controller starting");

    let db_url = store::url_from_path(&args.db);
    let db = store::connect(&db_url).await?;
    let state = app::AppState { db };
    let app = app::router(state);

    let listener = TcpListener::bind(args.rest).await.context("bind REST")?;
    info!(addr = %args.rest, "REST listening");
    axum::serve(listener, app).await.context("serve")?;
    Ok(())
}
