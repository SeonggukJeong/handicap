use std::net::SocketAddr;

use axum::Router;
use axum::routing::{get, post};

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub worker_bin: String,
    pub grpc_addr: SocketAddr,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/scenarios",
            post(scenarios_api::create).get(scenarios_api::list),
        )
        .route(
            "/scenarios/{id}",
            get(scenarios_api::get).put(scenarios_api::update),
        )
        .route("/scenarios/{id}/runs", get(runs_api::list_for_scenario))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .route("/runs/{id}/metrics", get(runs_api::metrics));

    Router::new().nest("/api", api).with_state(state)
}
