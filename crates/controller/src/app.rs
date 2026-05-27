use axum::Router;
use axum::routing::get;

use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .with_state(state)
}
