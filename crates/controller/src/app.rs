use std::path::PathBuf;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use tower_http::services::{ServeDir, ServeFile};

use crate::api::{
    datasets as datasets_api, environments as environments_api, pool as pool_api,
    presets as presets_api, runs as runs_api, scenarios as scenarios_api,
    schedules as schedules_api, settings as settings_api, step_templates as step_templates_api,
    test_runs as test_runs_api,
};
use crate::dispatcher::SharedDispatcher;
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub dispatcher: SharedDispatcher,
    pub ui_dir: Option<PathBuf>,
    /// Runtime effective op-config limits (DB override ?? seed). Decision points
    /// read accessors (e.g. `settings.dataset_max_rows()`). The single authority
    /// for per-request limits incl. worker capacity. Spec §B2''.
    pub settings: crate::settings::SettingsState,
    /// IANA timezone for cron evaluation (spec §3). main.rs parses
    /// `--scheduler-timezone` once and injects it so the scheduler loop AND the
    /// REST handlers (next_run_at calc, preview-next) share one source of truth.
    pub scheduler_tz: chrono_tz::Tz,
}

/// 데이터셋 업로드 본문 상한(8b). 행 수 제한은 run-create 게이트(8c)에서 — 여기선 넉넉한 메모리 천장만.
const DATASET_UPLOAD_BODY_LIMIT: usize = 256 * 1024 * 1024; // 256 MiB

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
        .route(
            "/scenarios/{id}/runs/compare.csv",
            get(runs_api::compare_csv),
        )
        .route(
            "/scenarios/{id}/runs/compare.xlsx",
            get(runs_api::compare_xlsx),
        )
        .route(
            "/scenarios/{id}/runs/compare-insights.csv",
            get(runs_api::compare_insights_csv),
        )
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .route("/runs/{id}/metrics", get(runs_api::metrics))
        .route("/runs/{id}/report", get(runs_api::report))
        .route("/runs/{id}/report.csv", get(runs_api::report_csv))
        .route("/runs/{id}/report.xlsx", get(runs_api::report_xlsx))
        .route(
            "/runs/{id}/report-insights.csv",
            get(runs_api::report_insights_csv),
        )
        .route("/runs/{id}/abort", post(runs_api::abort_run))
        .route(
            "/datasets",
            post(datasets_api::upload)
                .get(datasets_api::list)
                .layer(DefaultBodyLimit::max(DATASET_UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/datasets/preview",
            post(datasets_api::preview).layer(DefaultBodyLimit::max(DATASET_UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/datasets/{id}",
            get(datasets_api::get).delete(datasets_api::delete),
        )
        .route(
            "/scenarios/{id}/presets",
            post(presets_api::create).get(presets_api::list),
        )
        .route(
            "/presets/{id}",
            get(presets_api::get)
                .put(presets_api::update)
                .delete(presets_api::delete),
        )
        .route(
            "/environments",
            post(environments_api::create).get(environments_api::list),
        )
        .route(
            "/environments/{id}",
            get(environments_api::get)
                .put(environments_api::update)
                .delete(environments_api::delete),
        )
        .route(
            "/schedules",
            post(schedules_api::create).get(schedules_api::list),
        )
        .route("/schedules/preview-next", post(schedules_api::preview_next))
        .route(
            "/schedules/{id}",
            get(schedules_api::get)
                .put(schedules_api::update)
                .delete(schedules_api::delete),
        )
        .route("/schedules/{id}/events", get(schedules_api::events))
        .route(
            "/step-templates",
            post(step_templates_api::create).get(step_templates_api::list),
        )
        .route(
            "/step-templates/{id}",
            get(step_templates_api::get)
                .put(step_templates_api::update)
                .delete(step_templates_api::delete),
        )
        .route("/settings", get(settings_api::list))
        .route(
            "/settings/{key}",
            put(settings_api::put).delete(settings_api::delete),
        )
        .route("/test-runs", post(test_runs_api::create))
        .route("/pool/workers", get(pool_api::list_workers));

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

    // bundle 빌드 + --ui-dir 미지정 → 임베드 UI를 fallback으로 서빙(SPA fallback 포함).
    #[cfg(feature = "bundle")]
    if state.ui_dir.is_none() {
        app = app.fallback(crate::bundle::serve_embedded_ui);
    }

    app.with_state(state)
}
