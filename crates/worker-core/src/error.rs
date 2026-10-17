use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("invalid controller url: {0}")]
    InvalidUri(#[from] tonic::codegen::http::uri::InvalidUri),
    #[error("connect: {0}")]
    Connect(#[from] tonic::transport::Error),
    /// `tonic::Status`(176B)를 그대로 담으면 clippy `result_large_err`(임계 128B, Rust 1.99+)가
    /// 이 enum을 반환하는 모든 함수에서 발화한다 — Box로 줄인다(`tests/error_size.rs`).
    #[error("rpc: {0}")]
    Rpc(Box<tonic::Status>),
    #[error("engine: {0}")]
    Engine(#[from] handicap_engine::EngineError),
    #[error("send to controller stream failed")]
    SendFailed,
    #[error("missing assignment after register")]
    NoAssignment,
    /// Connect/backoff was cancelled before it could succeed — typically a
    /// SIGTERM arrived during the initial connect retry loop. The worker
    /// treats this as a clean shutdown (exit 0) rather than a failure.
    #[error("cancelled before connect")]
    Cancelled,
    /// The controller closed the stream before sending all expected dataset
    /// rows. Treated as a run failure (the engine never started).
    #[error("dataset stream ended early ({got}/{expected} rows)")]
    DatasetIncomplete { got: u64, expected: u64 },
}

// `#[from]`은 Box 필드에 못 쓴다 — `?`가 계속 `tonic::Status`를 받도록 수동 구현.
impl From<tonic::Status> for WorkerError {
    fn from(s: tonic::Status) -> Self {
        WorkerError::Rpc(Box::new(s))
    }
}
