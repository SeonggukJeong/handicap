use clap::Parser;
use handicap_worker::WorkerArgs;

/// `worker` 바이너리 진입점. 인자는 lib의 `WorkerArgs`를 그대로 쓴다(K8s/subprocess
/// dispatcher가 `--controller/--run-id/--worker-id`로 호출 — A3a/A3c).
#[derive(Debug, Parser)]
struct Cli {
    #[command(flatten)]
    args: WorkerArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    handicap_worker::init_worker_tracing();
    let cli = Cli::parse();
    handicap_worker::run(cli.args).await
}
