use std::sync::Arc;

use axum::Router;
use axum::routing::get;

#[derive(Clone)]
pub struct AppState {
    // populated in later tasks
    pub _placeholder: Arc<()>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}
