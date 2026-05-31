use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    /// A 409 carrying a structured JSON body (returned verbatim, not wrapped in
    /// {error}). Used by the dataset-delete soft guard to list referencing presets.
    #[error("conflict")]
    ConflictJson(serde_json::Value),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("scenario: {0}")]
    Scenario(#[from] handicap_engine::EngineError),
    #[error("internal: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // ConflictJson carries a ready-made body — return it as-is.
        if let ApiError::ConflictJson(body) = self {
            return (StatusCode::CONFLICT, Json(body)).into_response();
        }
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Scenario(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::ConflictJson(_) => unreachable!("handled above"),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
