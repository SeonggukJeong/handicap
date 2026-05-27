use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("scenario parse: {0}")]
    ScenarioParse(#[from] serde_yaml::Error),
    #[error("template: unknown variable {0}")]
    UnknownVar(String),
    #[error("template: malformed expression near '{0}'")]
    MalformedTemplate(String),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("assert failed (step={step}, expected={expected}, got={got})")]
    AssertFailed {
        step: String,
        expected: String,
        got: String,
    },
    #[error("all VUs failed ({failed}/{total})")]
    AllVusFailed { failed: u32, total: u32 },
    #[error("histogram: {0}")]
    Histogram(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("aborted")]
    Aborted,
}

pub type Result<T> = std::result::Result<T, EngineError>;
