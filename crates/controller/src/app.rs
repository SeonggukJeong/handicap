use std::net::SocketAddr;
use std::path::PathBuf;

use axum::Router;
use axum::routing::{get, post};
use tower_http::services::{ServeDir, ServeFile};

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub worker_bin: String,
    pub grpc_addr: SocketAddr,
    pub ui_dir: Option<PathBuf>,
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
        .route("/runs/{id}/metrics", get(runs_api::metrics))
        .route("/runs/{id}/abort", post(runs_api::abort_run));

    let mut app = Router::new().nest("/api", api);

    if let Some(dir) = &state.ui_dir {
        // SPA fallback: serve static files from `dir`, and for any path that
        // doesn't resolve to a file (e.g. client-side routes like
        // `/scenarios/01ABC`) hand the request off to `index.html` so the SPA
        // router can take over.
        //
        // Use `ServeDir::fallback`, NOT `not_found_service`. Both wire the
        // same fallback service, but `not_found_service` wraps it in
        // `SetStatus<_, 404>` (see tower-http 0.6 ServeDir source), forcing
        // the response status to 404 regardless of what the inner service
        // returned. So `index.html` would still be served, but the browser
        // would observe HTTP 404 — breaking React Router on hard refresh
        // and lighting up any frontend error monitor watching for 4xx.
        // `fallback` preserves the inner ServeFile's 200, which is what an
        // SPA actually wants. (Captured in CLAUDE.md Slice 2 gotchas.)
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(index));
        app = app.fallback_service(serve);
    }

    app.with_state(state)
}
