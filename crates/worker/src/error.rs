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
}
