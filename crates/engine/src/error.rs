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
    #[error("all VUs failed ({failed}/{total}){}", .cause.as_ref().map(|c| format!(": {c}")).unwrap_or_default())]
    AllVusFailed {
        failed: u32,
        total: u32,
        cause: Option<String>,
    },
    #[error("histogram: {0}")]
    Histogram(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("template: cannot cast {var} value {value:?} to {cast}")]
    CastFailed {
        var: String,
        cast: &'static str,
        value: String,
    },
    #[error("aborted")]
    Aborted,
}

pub type Result<T> = std::result::Result<T, EngineError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// `cause: None` is only reachable at the type level (the cancel path
    /// early-returns `Err(Aborted)` before `AllVusFailed` is ever constructed —
    /// see runner.rs, no runtime path can observe this variant with a live
    /// cancel). This asserts the `#[error]` attribute keeps the pre-Task-2
    /// message byte-identical when no cause was captured, so runs that fail
    /// without a sampled cause see zero regression in their message.
    #[test]
    fn all_vus_failed_display_without_cause_is_byte_identical_to_pre_cause_message() {
        let err = EngineError::AllVusFailed {
            failed: 2,
            total: 2,
            cause: None,
        };
        assert_eq!(err.to_string(), "all VUs failed (2/2)");
    }

    #[test]
    fn all_vus_failed_display_with_cause_appends_sampled_cause() {
        let err = EngineError::AllVusFailed {
            failed: 1,
            total: 1,
            cause: Some("template: unknown variable token".to_string()),
        };
        assert_eq!(
            err.to_string(),
            "all VUs failed (1/1): template: unknown variable token"
        );
    }
}
