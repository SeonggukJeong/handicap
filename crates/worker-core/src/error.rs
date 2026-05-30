use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("invalid controller url: {0}")]
    InvalidUri(#[from] tonic::codegen::http::uri::InvalidUri),
    #[error("connect: {0}")]
    Connect(#[from] tonic::transport::Error),
    #[error("rpc: {0}")]
    Rpc(#[from] tonic::Status),
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
