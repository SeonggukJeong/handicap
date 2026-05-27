use axum::Router;
use axum::routing::{get, post};

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create))
        .route("/scenarios/{id}", get(scenarios_api::get))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .with_state(state)
}
