use clap::Parser;
use handicap_worker::WorkerArgs;

/// `worker` 바이너리 진입점. 인자는 lib의 `WorkerArgs`를 그대로 쓴다(K8s/subprocess
/// dispatcher가 `--controller/--run-id/--worker-id`로 호출 — A3a/A3c).
#[derive(Debug, Parser)]
#[command(version)]
struct Cli {
    #[command(flatten)]
    args: WorkerArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    handicap_worker::init_worker_tracing();
    let cli = Cli::parse();
    handicap_worker::run_dispatch(cli.args).await
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn cli_exposes_version_flag() {
        let rendered = Cli::command().render_version().to_string();
        assert!(
            rendered.contains(env!("CARGO_PKG_VERSION")),
            "--version은 크레이트 버전을 출력해야 한다: {rendered:?}"
        );
    }
}
